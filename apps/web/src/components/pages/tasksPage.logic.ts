import type { TeamPlanStatus, TeamPlanSummary } from "@codenine/contracts";

const TASK_GROUPS: ReadonlyArray<{
  readonly label: string;
  readonly statuses: ReadonlyArray<TeamPlanStatus>;
}> = [
  { label: "Needs you", statuses: ["proposed", "failed"] },
  { label: "Running", statuses: ["running"] },
  { label: "Done", statuses: ["completed", "cancelled"] },
];

/** Tasks under Needs you, Running, and Done, in their given order; empty groups drop out. */
export function groupTeamTasks<T>(
  tasks: ReadonlyArray<T>,
  statusOf: (task: T) => TeamPlanStatus | null,
): Array<{ readonly label: string; readonly tasks: T[] }> {
  return TASK_GROUPS.map((group) => ({
    label: group.label,
    tasks: tasks.filter((task) => {
      const status = statusOf(task);
      return status !== null && group.statuses.includes(status);
    }),
  })).filter((group) => group.tasks.length > 0);
}

/** A task's progress in words, from its team plan. */
export function teamTaskProgress(summary: TeamPlanSummary | null | undefined): string {
  if (!summary) return "";
  const agents = `${summary.total} agent${summary.total === 1 ? "" : "s"}`;
  const done = `${summary.completed} of ${summary.total} done`;
  switch (summary.status) {
    case "proposed":
      return `Proposed · ${agents}`;
    case "cancelled":
      return "Cancelled";
    case "running":
    case "failed":
    case "completed":
      return summary.failed > 0 ? `${done} · ${summary.failed} failed` : done;
  }
}
