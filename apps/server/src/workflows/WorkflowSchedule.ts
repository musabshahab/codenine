import type {
  WorkflowMissedRuns,
  WorkflowSchedule,
  WorkflowSkippedRun,
  WorkflowTrigger,
  WorkflowWeekday,
} from "@codenine/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import type { QueuedWorkflowRun, WorkflowState } from "./WorkflowFile.ts";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** The scheduler ticks every few seconds, so a time found later than this passed while Codenine was off. */
const ON_TIME_MS = 2 * MINUTE_MS;
// What Codenine was off for longer than this is not owed: neither run nor listed as skipped.
const LOOKBACK_MS = 366 * DAY_MS;
/** Scheduled runs waiting for the previous run of their workflow; older ones count as skipped. */
const QUEUE_MAX = 20;
const SKIPPED_KEPT = 20;

const WEEKDAY_INDEX: Readonly<Record<WorkflowWeekday, number>> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

export const scheduleZone = (schedule: WorkflowSchedule): DateTime.TimeZone | undefined =>
  Option.getOrUndefined(DateTime.zoneMakeNamed(schedule.timeZone));

/** Names the schedule in force, so a change to it is noticed; null while scheduled runs are off. */
export const scheduleKey = (enabled: boolean, schedule: WorkflowSchedule | null): string | null => {
  if (!enabled || schedule === null) return null;
  const days = [...new Set(schedule.days)].toSorted(
    (left, right) => WEEKDAY_INDEX[left] - WEEKDAY_INDEX[right],
  );
  return `${days.join(",")} ${schedule.time} ${schedule.timeZone}`;
};

interface LocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

const wallClock = (ms: number, zone: DateTime.TimeZone) =>
  DateTime.toParts(DateTime.makeZonedUnsafe(ms, { timeZone: zone }));

const dateOf = (ms: number, zone: DateTime.TimeZone): LocalDate => {
  const { year, month, day } = wallClock(ms, zone);
  return { year, month, day };
};

// Calendar days, counted in UTC where every day is 24 hours long.
const utcDay = (date: LocalDate) => Date.UTC(date.year, date.month - 1, date.day);
const utcParts = (ms: number) => DateTime.toPartsUtc(DateTime.makeUnsafe(ms));

const addDays = (date: LocalDate, days: number): LocalDate => {
  const { year, month, day } = utcParts(utcDay(date) + days * DAY_MS);
  return { year, month, day };
};

const weekdayOf = (date: LocalDate) => utcParts(utcDay(date)).weekDay;

const minuteKey = (parts: LocalDate & { readonly hour: number; readonly minute: number }) =>
  (((parts.year * 13 + parts.month) * 32 + parts.day) * 24 + parts.hour) * 60 + parts.minute;

/**
 * When `hour:minute` on `date` happens in `zone`. A time a clock change repeats runs at its first
 * occurrence; a time it skips runs at the first minute after the gap.
 */
function wallClockInstant(
  date: LocalDate,
  hour: number,
  minute: number,
  zone: DateTime.TimeZone,
): number | undefined {
  const wanted = minuteKey({ ...date, hour, minute });
  const earlier = DateTime.makeZoned(
    { ...date, hour, minute, second: 0, millisecond: 0 },
    { timeZone: zone, adjustForTimeZone: true, disambiguation: "earlier" },
  );
  if (Option.isNone(earlier)) return undefined;
  let ms = DateTime.toEpochMillis(earlier.value);
  // Inside a gap, the earlier reading lands before it; walk to the minute the clock jumps to.
  for (let step = 0; step < 24 * 60 && minuteKey(wallClock(ms, zone)) < wanted; step++) {
    ms += MINUTE_MS;
  }
  return ms;
}

const occursOn = (schedule: WorkflowSchedule, date: LocalDate) =>
  schedule.days.some((day) => WEEKDAY_INDEX[day] === weekdayOf(date));

const timeOf = (schedule: WorkflowSchedule) => {
  const [hour = 0, minute = 0] = schedule.time.split(":").map(Number);
  return { hour, minute };
};

/** The first scheduled time strictly after `afterMs`; null when the time zone is unknown. */
export function nextOccurrence(schedule: WorkflowSchedule, afterMs: number): number | null {
  const zone = scheduleZone(schedule);
  if (zone === undefined) return null;
  const { hour, minute } = timeOf(schedule);
  const start = dateOf(afterMs, zone);
  for (let offset = 0; offset <= 8; offset++) {
    const date = addDays(start, offset);
    if (!occursOn(schedule, date)) continue;
    const at = wallClockInstant(date, hour, minute, zone);
    if (at !== undefined && at > afterMs) return at;
  }
  return null;
}

/** The newest `limit` scheduled times in (afterMs, untilMs], oldest first. */
export function occurrencesBetween(
  schedule: WorkflowSchedule,
  afterMs: number,
  untilMs: number,
  limit: number,
): ReadonlyArray<number> {
  const zone = scheduleZone(schedule);
  const from = Math.max(afterMs, untilMs - LOOKBACK_MS);
  if (zone === undefined || untilMs <= from) return [];
  const { hour, minute } = timeOf(schedule);
  const last = dateOf(untilMs, zone);
  const days = Math.round((utcDay(last) - utcDay(dateOf(from, zone))) / DAY_MS);
  const found: Array<number> = [];
  for (let offset = 0; offset <= days && found.length < limit; offset++) {
    const date = addDays(last, -offset);
    if (!occursOn(schedule, date)) continue;
    const at = wallClockInstant(date, hour, minute, zone);
    if (at !== undefined && at > from && at <= untilMs) found.push(at);
  }
  return found.toSorted((left, right) => left - right);
}

interface DueRuns {
  readonly queue: ReadonlyArray<QueuedWorkflowRun>;
  readonly skipped: ReadonlyArray<number>;
}

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/**
 * What scheduled times that just passed become. A time found within two minutes is on time;
 * older ones fell while Codenine was off and follow `missedRuns`. One run on time also makes up
 * for the missed ones when the workflow runs missed times once.
 */
export function dueRuns(
  occurrences: ReadonlyArray<number>,
  nowMs: number,
  missedRuns: WorkflowMissedRuns,
): DueRuns {
  const onTime: ReadonlyArray<QueuedWorkflowRun> = occurrences
    .filter((at) => nowMs - at <= ON_TIME_MS)
    .map((at) => ({ trigger: "schedule", scheduledFor: iso(at) }));
  const missed = occurrences.filter((at) => nowMs - at > ON_TIME_MS);
  const late = (at: number): QueuedWorkflowRun => ({ trigger: "missed", scheduledFor: iso(at) });
  switch (missedRuns) {
    case "each":
      return { queue: [...missed.map(late), ...onTime], skipped: [] };
    case "once": {
      const latest = missed.at(-1);
      return {
        queue: onTime.length > 0 || latest === undefined ? onTime : [late(latest)],
        skipped: [],
      };
    }
    case "skip":
      return { queue: onTime, skipped: missed };
  }
}

/** Newest first, without repeats, at most `SKIPPED_KEPT`. */
export function withSkipped(
  skipped: ReadonlyArray<WorkflowSkippedRun>,
  added: ReadonlyArray<string>,
): ReadonlyArray<WorkflowSkippedRun> {
  const times = new Set([...skipped.map((run) => run.scheduledFor), ...added]);
  return [...times]
    .toSorted((left, right) => Date.parse(right) - Date.parse(left))
    .slice(0, SKIPPED_KEPT)
    .map((scheduledFor) => ({ scheduledFor }));
}

/**
 * Brings a workflow's schedule up to `nowMs`: queues the runs now due and lists the skipped ones.
 * A new schedule, or one just turned on, starts at its next time and drops runs the old one queued.
 * Returns `state` itself when nothing changed, so the caller writes only on a change.
 */
export function advanceSchedule(
  state: WorkflowState,
  input: { readonly enabled: boolean; readonly trigger: WorkflowTrigger; readonly nowMs: number },
): WorkflowState {
  const { trigger, nowMs } = input;
  const key = scheduleKey(input.enabled, trigger.schedule);
  if (state.scheduleKey !== key) {
    const since = key === null ? null : iso(nowMs);
    return { ...state, scheduleKey: key, scheduleSince: since, handledThrough: since, queue: [] };
  }
  if (trigger.schedule === null || key === null) return state;
  const handledThrough = Date.parse(state.handledThrough ?? state.scheduleSince ?? iso(nowMs));
  const occurrences = occurrencesBetween(
    trigger.schedule,
    handledThrough,
    nowMs,
    QUEUE_MAX + SKIPPED_KEPT,
  );
  if (occurrences.length === 0) return state;
  const due = dueRuns(occurrences, nowMs, trigger.missedRuns);
  const queue = [...state.queue, ...due.queue];
  const overflow = queue.slice(0, Math.max(0, queue.length - QUEUE_MAX));
  return {
    ...state,
    handledThrough: iso(nowMs),
    queue: queue.slice(overflow.length),
    skipped: withSkipped(state.skipped, [
      ...overflow.map((run) => run.scheduledFor),
      ...due.skipped.map(iso),
    ]),
  };
}
