import type { WorkflowSchedule, WorkflowTrigger } from "@codenine/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { EMPTY_WORKFLOW_STATE } from "./WorkflowFile.ts";
import {
  advanceSchedule,
  dueRuns,
  nextOccurrence,
  occurrencesBetween,
  scheduleKey,
} from "./WorkflowSchedule.ts";

const at = (value: string) => Date.parse(value);
const iso = (ms: number | null) =>
  ms === null ? null : DateTime.formatIso(DateTime.makeUnsafe(ms));
const every = (
  days: WorkflowSchedule["days"],
  time: string,
  timeZone: string,
): WorkflowSchedule => ({ days, time, timeZone });
const allWeek = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

// 2026-11-18 is a Wednesday. New York's clocks went forward at 02:00 on 2026-03-08 and back at
// 02:00 on 2026-11-01; London's went back on 2026-10-25.
describe("scheduled times", () => {
  it("falls on the chosen days at the wall-clock time of the schedule's time zone", () => {
    const tokyo = every(["mon", "fri"], "18:00", "Asia/Tokyo");
    expect(iso(nextOccurrence(tokyo, at("2026-11-18T00:00:00Z")))).toBe("2026-11-20T09:00:00.000Z");
    expect(iso(nextOccurrence(tokyo, at("2026-11-20T09:00:00Z")))).toBe("2026-11-23T09:00:00.000Z");
    // Thursday morning in Auckland is still Wednesday in UTC.
    expect(
      iso(nextOccurrence(every(["thu"], "07:00", "Pacific/Auckland"), at("2026-11-18T00:00:00Z"))),
    ).toBe("2026-11-18T18:00:00.000Z");
    const london = every(["wed"], "09:00", "Europe/London");
    expect(iso(nextOccurrence(london, at("2026-07-01T00:00:00Z")))).toBe(
      "2026-07-01T08:00:00.000Z",
    );
    expect(iso(nextOccurrence(london, at("2026-11-18T00:00:00Z")))).toBe(
      "2026-11-18T09:00:00.000Z",
    );
    expect(nextOccurrence(every(["wed"], "09:00", "Mars/Olympus_Mons"), 0)).toBeNull();
  });

  it("runs a time a clock change skips at the first minute after it, and a repeated time once", () => {
    const newYork = (time: string) => every([...allWeek], time, "America/New_York");
    // 02:30 does not exist on 2026-03-08; the clock jumps from 02:00 EST to 03:00 EDT.
    expect(iso(nextOccurrence(newYork("02:30"), at("2026-03-08T00:00:00Z")))).toBe(
      "2026-03-08T07:00:00.000Z",
    );
    expect(iso(nextOccurrence(newYork("02:30"), at("2026-03-08T07:00:00Z")))).toBe(
      "2026-03-09T06:30:00.000Z",
    );
    // 01:30 happens twice on 2026-11-01: it runs at the first, then the next day.
    const repeated = nextOccurrence(newYork("01:30"), at("2026-11-01T00:00:00Z"));
    expect(iso(repeated)).toBe("2026-11-01T05:30:00.000Z");
    expect(iso(nextOccurrence(newYork("01:30"), repeated!))).toBe("2026-11-02T06:30:00.000Z");
    expect(
      occurrencesBetween(
        newYork("01:30"),
        at("2026-10-31T12:00:00Z"),
        at("2026-11-02T12:00:00Z"),
        10,
      ).map(iso),
    ).toEqual(["2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z"]);
  });

  it("lists the newest times in a window, oldest first", () => {
    const daily = every([...allWeek], "09:00", "Europe/London");
    const window = [at("2026-11-14T12:00:00Z"), at("2026-11-18T12:00:00Z")] as const;
    expect(occurrencesBetween(daily, ...window, 10).map(iso)).toEqual([
      "2026-11-15T09:00:00.000Z",
      "2026-11-16T09:00:00.000Z",
      "2026-11-17T09:00:00.000Z",
      "2026-11-18T09:00:00.000Z",
    ]);
    expect(occurrencesBetween(daily, ...window, 2).map(iso)).toEqual([
      "2026-11-17T09:00:00.000Z",
      "2026-11-18T09:00:00.000Z",
    ]);
    // The window opens after its start: a time exactly at the start was handled already.
    expect(
      occurrencesBetween(daily, at("2026-11-18T09:00:00Z"), at("2026-11-18T12:00:00Z"), 10),
    ).toEqual([]);
  });

  it("names a schedule by what it runs, so reordered days are the same schedule", () => {
    expect(scheduleKey(true, every(["fri", "mon"], "09:00", "UTC"))).toBe(
      scheduleKey(true, every(["mon", "fri", "mon"], "09:00", "UTC")),
    );
    expect(scheduleKey(false, every(["mon"], "09:00", "UTC"))).toBeNull();
    expect(scheduleKey(true, null)).toBeNull();
  });
});

describe("missed runs", () => {
  const daily = every([...allWeek], "09:00", "UTC");
  const days = (from: string, until: string) => occurrencesBetween(daily, at(from), at(until), 40);
  const offWhileMissed = days("2026-11-14T12:00:00Z", "2026-11-18T09:01:00Z");
  const offThroughToday = days("2026-11-14T12:00:00Z", "2026-11-18T12:00:00Z");
  const queued = (runs: ReturnType<typeof dueRuns>) =>
    runs.queue.map((run) => [run.trigger, run.scheduledFor.slice(0, 10)]);

  it("runs a time found within two minutes on time, and makes up missed ones per the workflow", () => {
    const now = at("2026-11-18T09:01:00Z");
    expect(queued(dueRuns(offWhileMissed, now, "each"))).toEqual([
      ["missed", "2026-11-15"],
      ["missed", "2026-11-16"],
      ["missed", "2026-11-17"],
      ["schedule", "2026-11-18"],
    ]);
    // The run on time makes up for the missed ones.
    expect(queued(dueRuns(offWhileMissed, now, "once"))).toEqual([["schedule", "2026-11-18"]]);
    const skipping = dueRuns(offWhileMissed, now, "skip");
    expect(queued(skipping)).toEqual([["schedule", "2026-11-18"]]);
    expect(skipping.skipped.map(iso)).toEqual([
      "2026-11-15T09:00:00.000Z",
      "2026-11-16T09:00:00.000Z",
      "2026-11-17T09:00:00.000Z",
    ]);
  });

  it("makes up for a whole stretch with one run of the latest time when missed runs run once", () => {
    const now = at("2026-11-18T12:00:00Z");
    expect(queued(dueRuns(offThroughToday, now, "once"))).toEqual([["missed", "2026-11-18"]]);
    expect(queued(dueRuns(offThroughToday, now, "each"))).toHaveLength(4);
    expect(dueRuns(offThroughToday, now, "skip")).toMatchObject({ queue: [] });
    expect(dueRuns(offThroughToday, now, "skip").skipped).toHaveLength(4);
  });
});

describe("advanceSchedule", () => {
  const trigger = (missedRuns: WorkflowTrigger["missedRuns"]): WorkflowTrigger => ({
    schedule: every([...allWeek], "09:00", "Europe/London"),
    missedRuns,
    position: { x: 0, y: 0 },
  });

  it("starts a new schedule at its next time, queues it then, and drops runs when it is off", () => {
    const turnedOn = advanceSchedule(EMPTY_WORKFLOW_STATE, {
      enabled: true,
      trigger: trigger("once"),
      nowMs: at("2026-11-18T10:00:00Z"),
    });
    // 09:00 today passed before the schedule existed, so nothing is owed.
    expect(turnedOn).toMatchObject({
      scheduleSince: "2026-11-18T10:00:00.000Z",
      handledThrough: "2026-11-18T10:00:00.000Z",
      queue: [],
    });
    const quiet = { enabled: true, trigger: trigger("once"), nowMs: at("2026-11-19T08:00:00Z") };
    expect(advanceSchedule(turnedOn, quiet)).toBe(turnedOn);
    const due = advanceSchedule(turnedOn, { ...quiet, nowMs: at("2026-11-19T09:00:05Z") });
    expect(due.queue).toEqual([{ trigger: "schedule", scheduledFor: "2026-11-19T09:00:00.000Z" }]);
    expect(advanceSchedule(due, { ...quiet, nowMs: at("2026-11-19T09:00:10Z") })).toBe(due);

    const off = advanceSchedule(due, { ...quiet, enabled: false });
    expect(off).toMatchObject({ scheduleKey: null, queue: [] });
    const moved = advanceSchedule(due, {
      ...quiet,
      trigger: { ...trigger("once"), schedule: every(["mon"], "07:00", "Europe/London") },
    });
    expect(moved).toMatchObject({ scheduleSince: "2026-11-19T08:00:00.000Z", queue: [] });
  });

  it("keeps at most twenty runs waiting and lists the older ones as skipped", () => {
    const lastHandled = {
      ...EMPTY_WORKFLOW_STATE,
      scheduleKey: scheduleKey(true, trigger("each").schedule),
      scheduleSince: "2026-10-01T00:00:00.000Z",
      handledThrough: "2026-10-19T10:00:00.000Z",
    };
    const caughtUp = advanceSchedule(lastHandled, {
      enabled: true,
      trigger: trigger("each"),
      nowMs: at("2026-11-18T10:00:00Z"),
    });
    // Thirty times passed while Codenine was off.
    expect(caughtUp.queue).toHaveLength(20);
    expect(caughtUp.queue[0]?.scheduledFor).toBe("2026-10-30T09:00:00.000Z");
    expect(caughtUp.queue.at(-1)?.scheduledFor).toBe("2026-11-18T09:00:00.000Z");
    expect(caughtUp.skipped).toHaveLength(10);
    expect(caughtUp.skipped[0]?.scheduledFor).toBe("2026-10-29T09:00:00.000Z");
    expect(caughtUp.skipped.at(-1)?.scheduledFor).toBe("2026-10-20T08:00:00.000Z");
  });
});
