import type { BackupFileInfo, BackupSchedule } from "@codenine/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  backupsToPrune,
  needsAttention,
  nextAutomaticRunAt,
  nextScheduledAt,
  scheduleKey,
} from "./BackupSchedule.ts";

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number | null) =>
  ms === null ? null : DateTime.formatIso(DateTime.makeUnsafe(ms));

const daily: BackupSchedule = { frequency: "daily", time: "03:00", weekday: 0, timeZone: "UTC" };
// 2026-11-18 is a Wednesday; weekday 0 is Sunday.
const weekly: BackupSchedule = { ...daily, frequency: "weekly" };

it("finds the next scheduled time strictly after the given one", () => {
  assert.equal(iso(nextScheduledAt(daily, at("2026-11-18T02:00:00Z"))), "2026-11-18T03:00:00.000Z");
  assert.equal(iso(nextScheduledAt(daily, at("2026-11-18T03:00:00Z"))), "2026-11-19T03:00:00.000Z");
  assert.equal(
    iso(nextScheduledAt(weekly, at("2026-11-18T12:00:00Z"))),
    "2026-11-22T03:00:00.000Z",
  );
  assert.equal(
    iso(nextScheduledAt(weekly, at("2026-11-22T02:59:00Z"))),
    "2026-11-22T03:00:00.000Z",
  );
  assert.equal(nextScheduledAt({ ...daily, frequency: "off" }, at("2026-11-18T02:00:00Z")), null);
  // Wall-clock time: 03:00 in New York is 08:00 UTC in winter and 07:00 UTC in summer.
  const newYork: BackupSchedule = { ...daily, timeZone: "America/New_York" };
  assert.equal(
    iso(nextScheduledAt(newYork, at("2026-03-07T12:00:00Z"))),
    "2026-03-08T07:00:00.000Z",
  );
  assert.equal(
    iso(nextScheduledAt(newYork, at("2026-03-06T12:00:00Z"))),
    "2026-03-07T08:00:00.000Z",
  );
});

it("reads the time in the schedule's zone, else on this computer's clock", () => {
  const after = at("2026-11-18T02:00:00Z");
  // 03:00 picked in a London browser is 03:00 in London, whatever the server's clock.
  const london: BackupSchedule = { ...daily, timeZone: "Europe/London" };
  assert.equal(iso(nextScheduledAt(london, after)), "2026-11-18T03:00:00.000Z");
  assert.equal(
    iso(nextScheduledAt({ ...daily, timeZone: "America/Los_Angeles" }, after)),
    "2026-11-18T11:00:00.000Z",
  );
  const local = nextScheduledAt(
    { ...daily, timeZone: DateTime.zoneToString(DateTime.zoneMakeLocal()) },
    after,
  );
  assert.equal(nextScheduledAt({ ...daily, timeZone: null }, after), local);
  assert.equal(nextScheduledAt({ ...daily, timeZone: "Nowhere/Else" }, after), local);
  // A new zone is a new schedule, so it starts at its next time instead of owing a run.
  assert.notEqual(scheduleKey(london), scheduleKey(daily));
  // Schedules saved before zones existed keep their key.
  assert.equal(scheduleKey({ ...daily, timeZone: null }), "daily 03:00");
});

it("owes one backup for times missed while the computer was off, then waits for the next", () => {
  const scheduleSince = at("2026-11-01T00:00:00Z");
  // Last ran three days ago: the first time after that is long past, so one run is due now.
  const missed = nextAutomaticRunAt({
    schedule: daily,
    scheduleSince,
    lastAutomaticAt: at("2026-11-15T03:00:00Z"),
    lastAutomaticFailed: false,
  });
  assert.equal(iso(missed), "2026-11-16T03:00:00.000Z");
  // That catch-up run, at 10:00 on the 18th, moves the next one to the 19th.
  assert.equal(
    iso(
      nextAutomaticRunAt({
        schedule: daily,
        scheduleSince,
        lastAutomaticAt: at("2026-11-18T10:00:00Z"),
        lastAutomaticFailed: false,
      }),
    ),
    "2026-11-19T03:00:00.000Z",
  );
  // A failed run tries again within the hour.
  assert.equal(
    iso(
      nextAutomaticRunAt({
        schedule: weekly,
        scheduleSince,
        lastAutomaticAt: at("2026-11-18T10:00:00Z"),
        lastAutomaticFailed: true,
      }),
    ),
    "2026-11-18T11:00:00.000Z",
  );
  // A schedule set up today starts at its next time instead of running at once.
  assert.equal(
    iso(
      nextAutomaticRunAt({
        schedule: daily,
        scheduleSince: at("2026-11-18T10:00:00Z"),
        lastAutomaticAt: at("2026-11-10T03:00:00Z"),
        lastAutomaticFailed: true,
      }),
    ),
    "2026-11-19T03:00:00.000Z",
  );
});

it("needs attention after a failure, or when a scheduled backup has been owed for three days", () => {
  const base = {
    configured: true,
    schedule: weekly,
    scheduleSince: at("2026-11-01T00:00:00Z"),
    lastError: null,
    lastSuccessAt: at("2026-11-08T03:00:00Z"),
  };
  // Weekly backups go a week between successes; owed since the 15th, three days pass on the 18th.
  assert.isFalse(needsAttention({ ...base, nowMs: at("2026-11-14T12:00:00Z") }));
  assert.isFalse(needsAttention({ ...base, nowMs: at("2026-11-18T02:00:00Z") }));
  assert.isTrue(needsAttention({ ...base, nowMs: at("2026-11-18T04:00:00Z") }));
  assert.isTrue(
    needsAttention({ ...base, lastError: "Disk full", nowMs: at("2026-11-08T04:00:00Z") }),
  );
  assert.isFalse(
    needsAttention({
      ...base,
      configured: false,
      lastError: "Disk full",
      nowMs: at("2026-11-30T00:00:00Z"),
    }),
  );
  assert.isFalse(
    needsAttention({
      ...base,
      schedule: { ...weekly, frequency: "off" },
      nowMs: at("2026-11-30T00:00:00Z"),
    }),
  );
});

it("prunes only this computer's automatic backups past the limit, oldest first", () => {
  const backup = (
    name: string,
    createdAt: string,
    kind: BackupFileInfo["kind"],
    computerId: string,
  ) => ({
    file: {
      path: `/backups/${name}`,
      fileName: name,
      createdAt,
      computerName: computerId,
      codenineVersion: "0.1.7",
      kind,
      sizeBytes: 1,
    } satisfies BackupFileInfo,
    computerId,
  });
  const pruned = backupsToPrune(
    [
      backup("a1", "2026-11-14T03:00:00Z", "automatic", "this"),
      backup("a2", "2026-11-15T03:00:00Z", "automatic", "this"),
      backup("a3", "2026-11-16T03:00:00Z", "automatic", "this"),
      backup("a4", "2026-11-17T03:00:00Z", "automatic", "this"),
      backup("m1", "2026-11-01T03:00:00Z", "manual", "this"),
      backup("o1", "2026-11-02T03:00:00Z", "automatic", "other"),
      backup("o2", "2026-11-03T03:00:00Z", "automatic", "other"),
      backup("o3", "2026-11-04T03:00:00Z", "automatic", "other"),
    ],
    { keep: 2, computerId: "this" },
  );
  assert.deepEqual(
    pruned.map((file) => file.fileName),
    ["a2", "a1"],
  );
});
