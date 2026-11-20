import type { WorkflowSchedule, WorkflowWeekday } from "@codenine/contracts";

const WEEKDAYS: ReadonlyArray<readonly [WorkflowWeekday, string]> = [
  ["mon", "Monday"],
  ["tue", "Tuesday"],
  ["wed", "Wednesday"],
  ["thu", "Thursday"],
  ["fri", "Friday"],
  ["sat", "Saturday"],
  ["sun", "Sunday"],
];
const WORKING_DAYS = new Set<WorkflowWeekday>(["mon", "tue", "wed", "thu", "fri"]);

/** When a workflow runs, in words: "Every Monday at 9:00 · Europe/London". */
/** "Etc/GMT" and "Etc/UTC" are the zone database's names for plain GMT and UTC. */
function timeZoneLabel(timeZone: string): string {
  return /^Etc\/(GMT|UTC)$/.test(timeZone) ? timeZone.slice(4) : timeZone;
}

export function workflowScheduleText(schedule: WorkflowSchedule | null): string {
  if (schedule === null) return "When you start it";
  const days = new Set(schedule.days);
  const names = WEEKDAYS.flatMap(([day, name]) => (days.has(day) ? [name] : []));
  const when =
    names.length === WEEKDAYS.length
      ? "Every day"
      : days.size === WORKING_DAYS.size && [...days].every((day) => WORKING_DAYS.has(day))
        ? "Every weekday"
        : `Every ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`}`;
  return `${when} at ${schedule.time.replace(/^0(?=\d)/, "")} · ${timeZoneLabel(schedule.timeZone)}`;
}
