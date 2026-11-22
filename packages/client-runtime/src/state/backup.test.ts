import type { BackupJobSnapshot } from "@codenine/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { backupListRevision, restoreAfterLostRequest } from "./backup.ts";

const job = (
  phase: BackupJobSnapshot["phase"],
  kind: BackupJobSnapshot["kind"] = "before-restore",
): BackupJobSnapshot => ({
  phase,
  kind,
  percent: null,
  detail: null,
  error: phase === "failed" ? "That password does not open this backup." : null,
  startedAt: "2026-11-16T03:00:00.000Z",
  endedAt: null,
  file: null,
});

describe("restoreAfterLostRequest", () => {
  it.effect("follows a restore whose request lost its connection", () =>
    Effect.gen(function* () {
      const outcome = (input: {
        readonly running: ReadonlyArray<BackupJobSnapshot | null>;
        readonly restoredAt?: string | null;
        readonly refused?: boolean;
      }) =>
        restoreAfterLostRequest({
          statuses: Stream.fromIterable(input.running.map((running) => ({ running }))).pipe(
            Stream.concat(Stream.never),
          ),
          refused: input.refused === true ? Effect.void : Effect.never,
          restoredAt: Effect.succeed(input.restoredAt ?? "before"),
          lastRestoredAt: "before",
        });

      // Still unpacking on reconnect: wait for it, then for the restart.
      expect(yield* outcome({ running: [job("running"), job("running"), job("done")] })).toEqual({
        outcome: "restarting",
      });
      expect(yield* outcome({ running: [job("running"), job("failed")] })).toEqual({
        outcome: "failed",
        detail: "That password does not open this backup.",
      });
      // No restore job: the server restarted while this client was away, or never heard.
      expect(yield* outcome({ running: [null], restoredAt: "after" })).toEqual({
        outcome: "restarted",
      });
      expect(yield* outcome({ running: [job("running", "manual")] })).toEqual({
        outcome: "notStarted",
      });
      // The restored server signed this client out, so its status never arrives.
      expect(yield* outcome({ running: [], refused: true })).toEqual({ outcome: "restarted" });
    }),
  );
});

describe("backupListRevision", () => {
  it("changes when the folder changes", () => {
    const status = { folderPath: "/backups/old", lastSuccessAt: null, lastFile: null };
    expect(backupListRevision(0, status)).not.toBe(
      backupListRevision(0, { ...status, folderPath: "/backups/new" }),
    );
  });
});
