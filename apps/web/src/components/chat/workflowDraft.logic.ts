import type {
  SavedWorkflowLink,
  WorkflowDetail,
  WorkflowDraft,
  WorkflowDraftStep,
  WorkflowSchedule,
  WorkflowStepSummary,
  WorkflowSummary,
  WorkflowWeekday,
} from "@codenine/contracts";
import type { AsyncResult } from "effect/reactivity";

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

/** What a chat's Workflow tab shows: its draft, or the workflow the draft was saved as. */
export type WorkflowDraftStatus =
  | { readonly kind: "unsaved"; readonly deleted: boolean }
  | { readonly kind: "checking" }
  | { readonly kind: "saved"; readonly workflow: WorkflowSummary }
  | { readonly kind: "changed"; readonly workflow: WorkflowSummary };

export function workflowDraftStatus(input: {
  readonly draft: WorkflowDraft | null;
  readonly link: SavedWorkflowLink | null;
  /** null while the list has not loaded. */
  readonly workflows: ReadonlyArray<WorkflowSummary> | null;
  /** A list answer arrived that was asked for after this client saw this link. */
  readonly listedAfterLink: boolean;
}): WorkflowDraftStatus {
  const { draft, link, workflows } = input;
  if (link === null) return { kind: "unsaved", deleted: false };
  if (workflows === null) return { kind: "checking" };
  const workflow = workflows.find((entry) => entry.id === link.id);
  if (workflow === undefined) {
    return input.listedAfterLink ? { kind: "unsaved", deleted: true } : { kind: "checking" };
  }
  return draft === null || draft.proposedAt === link.proposedAt
    ? { kind: "saved", workflow }
    : { kind: "changed", workflow };
}

/**
 * Whether the list answered after `before`, the result seen when it was asked again. Timestamps can
 * tie with the ask, so this goes by the result itself: any later settled success is the answer.
 */
export function listAnsweredSince(
  result: AsyncResult.AsyncResult<unknown, unknown>,
  before: AsyncResult.AsyncResult<unknown, unknown>,
): boolean {
  return result !== before && result._tag === "Success" && !result.waiting;
}

/** What Turn on or off answered for a workflow. */
export type SwitchedWorkflow = Pick<WorkflowDetail, "id" | "enabled" | "nextRunAt" | "updatedAt">;

/** The listed workflow, showing what Turn on or off answered until the list is as new as that. */
export function switchedWorkflow(
  listed: WorkflowSummary,
  switched: SwitchedWorkflow | null,
): { readonly workflow: WorkflowSummary; readonly settling: boolean } {
  if (
    switched === null ||
    switched.id !== listed.id ||
    Date.parse(listed.updatedAt) >= Date.parse(switched.updatedAt)
  ) {
    return { workflow: listed, settling: false };
  }
  return {
    workflow: { ...listed, enabled: switched.enabled, nextRunAt: switched.nextRunAt },
    settling: true,
  };
}

/** The draft's steps, each keeping the agent the saved workflow gave it where the draft has none. */
export function draftStepsOver(
  draft: Pick<WorkflowDraft, "steps">,
  savedSteps: ReadonlyArray<Pick<WorkflowStepSummary, "id" | "agent">>,
): ReadonlyArray<WorkflowDraftStep> {
  return draft.steps.map((step) => {
    if (step.agent !== null) return step;
    const agent = savedSteps.find((saved) => saved.id === step.id)?.agent ?? null;
    if (agent === null) return step;
    const { suggestion: _suggestion, ...rest } = step;
    return { ...rest, agent };
  });
}

/**
 * The runs a chat's Workflow tab lists: while the chat links a workflow, only that workflow's, as
 * an earlier workflow saved from the chat still names it on its runs.
 */
export function chatWorkflowRuns<
  T extends { readonly workflowId: string; readonly chatThreadId: string | null },
>(runs: ReadonlyArray<T>, chatThreadId: string, link: SavedWorkflowLink | null): ReadonlyArray<T> {
  return runs.filter((run) =>
    link !== null ? run.workflowId === link.id : run.chatThreadId === chatThreadId,
  );
}
