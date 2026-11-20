import { BackupFileInfo, type BackupSchedule } from "@codenine/contracts";
import { writeFileStringAtomically } from "@codenine/shared/atomicWrite";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { BACKUP_STATE_FILE } from "./BackupArchive.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// A failed automatic backup tries again within the hour rather than at the next scheduled time.
const RETRY_AFTER_FAILURE_MS = HOUR_MS;
const ATTENTION_AFTER_MS = 3 * DAY_MS;

/** What this computer remembers about its backups; never part of a backup itself. */
export const BackupState = Schema.Struct({
  lastAttemptAt: Schema.NullOr(Schema.Number),
  lastSuccessAt: Schema.NullOr(Schema.Number),
  lastError: Schema.NullOr(Schema.String),
  lastFile: Schema.NullOr(BackupFileInfo),
  lastAutomaticAt: Schema.NullOr(Schema.Number),
  lastAutomaticFailed: Schema.Boolean,
  /** The schedule in force, and since when, so a new schedule starts at its next time. */
  scheduleKey: Schema.NullOr(Schema.String),
  scheduleSince: Schema.NullOr(Schema.Number),
});
export type BackupState = typeof BackupState.Type;

const EMPTY_BACKUP_STATE: BackupState = {
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastError: null,
  lastFile: null,
  lastAutomaticAt: null,
  lastAutomaticFailed: false,
  scheduleKey: null,
  scheduleSince: null,
};

const BackupStateJson = Schema.fromJsonString(BackupState);
const decodeState = Schema.decodeOption(BackupStateJson);
const encodeState = Schema.encodeEffect(BackupStateJson);

export const readBackupState = Effect.fn("BackupSchedule.readState")(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const raw = yield* fs.readFileString(path.join(stateDir, BACKUP_STATE_FILE)).pipe(Effect.option);
  return Option.isNone(raw)
    ? EMPTY_BACKUP_STATE
    : Option.getOrElse(decodeState(raw.value), () => EMPTY_BACKUP_STATE);
});

export const writeBackupState = Effect.fn("BackupSchedule.writeState")(function* (
  stateDir: string,
  state: BackupState,
) {
  const path = yield* Path.Path;
  yield* writeFileStringAtomically({
    filePath: path.join(stateDir, BACKUP_STATE_FILE),
    contents: yield* encodeState(state),
  });
});

export const scheduleKey = (schedule: BackupSchedule) =>
  schedule.frequency === "off"
    ? "off"
    : `${schedule.frequency} ${schedule.time}${schedule.frequency === "weekly" ? ` ${schedule.weekday}` : ""}`;

/** The first scheduled time strictly after `afterMs`, on the wall clock of `timeZone`. */
export const nextScheduledAt = (
  schedule: BackupSchedule,
  afterMs: number,
  timeZone: DateTime.TimeZone,
): number | null => {
  if (schedule.frequency === "off") return null;
  const [hour = 0, minute = 0] = schedule.time.split(":").map(Number);
  const start = DateTime.makeZonedUnsafe(afterMs, { timeZone });
  for (let days = 0; days <= 7; days++) {
    // Set the time on each day: a daylight saving change shifts wall-clock times otherwise.
    const candidate = DateTime.setParts(DateTime.add(start, { days }), {
      hour,
      minute,
      second: 0,
      millisecond: 0,
    });
    if (
      DateTime.toEpochMillis(candidate) > afterMs &&
      (schedule.frequency === "daily" ||
        DateTime.getPart(candidate, "weekDay") === schedule.weekday)
    ) {
      return DateTime.toEpochMillis(candidate);
    }
  }
  return null;
};

/**
 * When the next automatic backup is due. Scheduled times that passed while the computer was
 * off or asleep are owed once: the next run is the first time after the last one, which is
 * already in the past, and that run moves the next one past now.
 */
export const nextAutomaticRunAt = (input: {
  readonly schedule: BackupSchedule;
  readonly timeZone: DateTime.TimeZone;
  readonly scheduleSince: number;
  readonly lastAutomaticAt: number | null;
  readonly lastAutomaticFailed: boolean;
}): number | null => {
  const ranSinceSchedule =
    input.lastAutomaticAt !== null && input.lastAutomaticAt >= input.scheduleSince;
  const next = nextScheduledAt(
    input.schedule,
    ranSinceSchedule ? input.lastAutomaticAt! : input.scheduleSince,
    input.timeZone,
  );
  if (next === null || !ranSinceSchedule || !input.lastAutomaticFailed) return next;
  return Math.min(next, input.lastAutomaticAt! + RETRY_AFTER_FAILURE_MS);
};

/** The last backup failed, or a scheduled one has been owed for three days. */
export const needsAttention = (input: {
  readonly configured: boolean;
  readonly schedule: BackupSchedule;
  readonly timeZone: DateTime.TimeZone;
  readonly scheduleSince: number;
  readonly lastError: string | null;
  readonly lastSuccessAt: number | null;
  readonly nowMs: number;
}): boolean => {
  if (!input.configured) return false;
  if (input.lastError !== null) return true;
  const owedSince = nextScheduledAt(
    input.schedule,
    Math.max(input.scheduleSince, input.lastSuccessAt ?? Number.NEGATIVE_INFINITY),
    input.timeZone,
  );
  return owedSince !== null && input.nowMs - owedSince > ATTENTION_AFTER_MS;
};

/**
 * Automatic backups past `keep`, oldest first out. Only this computer's count, so a folder that
 * another computer also backs up to keeps that computer's backups.
 */
export const backupsToPrune = (
  backups: ReadonlyArray<{ readonly file: BackupFileInfo; readonly computerId: string | null }>,
  input: { readonly keep: number; readonly computerId: string },
): ReadonlyArray<BackupFileInfo> =>
  backups
    .filter(({ file, computerId }) => file.kind === "automatic" && computerId === input.computerId)
    .map(({ file }) => file)
    .toSorted((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .slice(input.keep);
