import type { TeamPlanSummary } from "@codenine/contracts";

export type TeamThreadSection = "pinned" | "active" | "working" | "snoozed" | "settled";

/** The short status a task's lead row shows for its team. */
export function teamTaskStatusLabel(
  summary: Pick<TeamPlanSummary, "status" | "total" | "completed" | "failed">,
): string {
  switch (summary.status) {
    case "proposed":
      return "Review";
    case "running":
      return `Running ${summary.completed}/${summary.total}`;
    case "completed":
      return "Done";
    case "failed":
      // A task whose run was stopped counts as cancelled, so a plan can fail with none failed.
      return summary.failed > 0 ? `Failed ${summary.failed}` : "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

/** What a row shows when it needs a look, most urgent first. */
export type TeamThreadAttention = "attention" | "failed" | "unread" | "working";

const SECTIONS: ReadonlyArray<TeamThreadSection> = [
  "pinned",
  "active",
  "working",
  "snoozed",
  "settled",
];

const ATTENTION_ORDER: ReadonlyArray<TeamThreadAttention> = [
  "attention",
  "failed",
  "unread",
  "working",
];

export interface TeamThreadGroup<T> {
  /** Every thread nested under the lead: team tasks oldest first, then workflow runs newest first. */
  readonly tasks: ReadonlyArray<T>;
  /**
   * The rows drawn under the lead: when expanded, the team tasks, the newest runs and the open
   * thread; else only the open one.
   */
  readonly shown: ReadonlyArray<T>;
  readonly expanded: boolean;
  /** The most urgent state among the tasks a collapsed group hides, for the lead row to show. */
  readonly attention: TeamThreadAttention | null;
  /** How many of `tasks` are workflow runs. */
  readonly runs: number;
}

export interface TeamThreadGrouping<T> {
  /** Each section without the task threads drawn under a lead. */
  readonly sections: Readonly<Record<TeamThreadSection, ReadonlyArray<T>>>;
  /** Keyed by lead. */
  readonly groups: ReadonlyMap<string, TeamThreadGroup<T>>;
  readonly leadKeyByTaskKey: ReadonlyMap<string, string>;
  /** Workflow runs left out of every section because their chat is not listed. */
  readonly droppedRunKeys: ReadonlySet<string>;
  /** The top-level row holding the open thread: its lead's when the open thread is nested. */
  readonly openRowKey: string | null;
}

/**
 * A settled task follows its lead anywhere, as the server settles a finished team's tasks. An
 * active task nests only under a lead the sidebar always draws (pinned or active), so no closed
 * shelf hides it; a task the user pinned or snoozed, or whose lead is not listed, stands alone.
 */
function followsLead(task: TeamThreadSection, lead: TeamThreadSection): boolean {
  if (task === "settled") return true;
  return (task === "active" || task === "working") && (lead === "pinned" || lead === "active");
}

/** How many runs an expanded chat draws; older ones are on the workflow's runs page. */
const SHOWN_RUNS_MAX = 10;

export type TeamThreadRunState = "running" | "ended";

export function groupTeamThreads<T extends { readonly createdAt: string }>(input: {
  readonly sections: Readonly<Record<TeamThreadSection, ReadonlyArray<T>>>;
  readonly keyOf: (thread: T) => string;
  /** The key of the lead a team task thread runs for, or of the chat a workflow run reports to. */
  readonly leadKeyOf: (thread: T) => string | null;
  /** Whether the thread leads a workflow run; null on every other thread. */
  readonly runOf?: (thread: T) => TeamThreadRunState | null;
  /** The thread on screen, which a collapsed group still shows under its lead. */
  readonly openKey: string | null;
  /** The user's own choice per lead, which wins over the default. */
  readonly expandedByLead: ReadonlyMap<string, boolean>;
  readonly attentionOf: (thread: T) => TeamThreadAttention | null;
}): TeamThreadGrouping<T> {
  const { keyOf, leadKeyOf } = input;
  const runOf = input.runOf ?? (() => null);
  const sectionByKey = new Map<string, TeamThreadSection>();
  const threadByKey = new Map<string, T>();
  for (const section of SECTIONS) {
    for (const thread of input.sections[section]) {
      sectionByKey.set(keyOf(thread), section);
      threadByKey.set(keyOf(thread), thread);
    }
  }

  const leadKeyByTaskKey = new Map<string, string>();
  // A run whose chat is not drawn lives on the Workflows pages, never as a stray top-level row.
  const droppedRuns = new Set<string>();
  const tasksByLead = new Map<string, T[]>();
  for (const [taskKey, task] of threadByKey) {
    const leadKey = leadKeyOf(task);
    if (leadKey === null) continue;
    const lead = threadByKey.get(leadKey);
    const run = runOf(task);
    if (lead === undefined && run !== null) droppedRuns.add(taskKey);
    // Teams do not nest, so a lead that is itself a team task holds no rows.
    if (lead === undefined || leadKeyOf(lead) !== null) continue;
    if (run !== "ended" && !followsLead(sectionByKey.get(taskKey)!, sectionByKey.get(leadKey)!))
      continue;
    leadKeyByTaskKey.set(taskKey, leadKey);
    const tasks = tasksByLead.get(leadKey);
    if (tasks === undefined) tasksByLead.set(leadKey, [task]);
    else tasks.push(task);
  }

  const byCreatedAt = (left: T, right: T) =>
    left.createdAt.localeCompare(right.createdAt) || keyOf(left).localeCompare(keyOf(right));
  const groups = new Map<string, TeamThreadGroup<T>>();
  for (const [leadKey, members] of tasksByLead) {
    const teamTasks = members.filter((task) => runOf(task) === null).toSorted(byCreatedAt);
    const runs = members
      .filter((task) => runOf(task) !== null)
      .toSorted((left, right) => byCreatedAt(right, left));
    const tasks = runs.length === 0 ? teamTasks : [...teamTasks, ...runs];
    const expanded =
      input.expandedByLead.get(leadKey) ??
      tasks.some((task) => {
        const run = runOf(task);
        return run === null ? sectionByKey.get(keyOf(task)) !== "settled" : run === "running";
      });
    const shown = expanded
      ? tasks.filter(
          (task, index) =>
            index < teamTasks.length + SHOWN_RUNS_MAX || keyOf(task) === input.openKey,
        )
      : tasks.filter((task) => keyOf(task) === input.openKey);
    const hidden = new Set(tasks.filter((task) => !shown.includes(task)).map(input.attentionOf));
    groups.set(leadKey, {
      tasks,
      shown,
      expanded,
      attention: ATTENTION_ORDER.find((attention) => hidden.has(attention)) ?? null,
      runs: runs.length,
    });
  }

  const topLevel = (threads: ReadonlyArray<T>) =>
    leadKeyByTaskKey.size === 0 && droppedRuns.size === 0
      ? threads
      : threads.filter(
          (thread) => !leadKeyByTaskKey.has(keyOf(thread)) && !droppedRuns.has(keyOf(thread)),
        );
  return {
    sections: {
      pinned: topLevel(input.sections.pinned),
      active: topLevel(input.sections.active),
      working: topLevel(input.sections.working),
      snoozed: topLevel(input.sections.snoozed),
      settled: topLevel(input.sections.settled),
    },
    groups,
    leadKeyByTaskKey,
    droppedRunKeys: droppedRuns,
    openRowKey:
      input.openKey === null ? null : (leadKeyByTaskKey.get(input.openKey) ?? input.openKey),
  };
}

interface WorkflowRunMember {
  readonly environmentId: string;
  readonly id: string;
  readonly source: {
    readonly teamTask?: { readonly rootThreadId: string } | undefined;
    readonly teamSummary?:
      | { readonly run?: { readonly chatThreadId?: string | undefined } | undefined }
      | undefined;
  };
}

/**
 * The threads without the parts of workflow runs that live on the Workflows pages: every step
 * thread of a run, and a run's lead when the run has no chat to nest under. Returns `threads`
 * itself when it holds no run.
 */
export function withoutUnlinkedWorkflowRuns<T extends WorkflowRunMember>(
  threads: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const leads = new Set(
    threads.flatMap((thread) =>
      thread.source.teamSummary?.run === undefined ? [] : [`${thread.environmentId}:${thread.id}`],
    ),
  );
  if (leads.size === 0) return threads;
  return threads.filter((thread) => {
    const run = thread.source.teamSummary?.run;
    if (run !== undefined) return run.chatThreadId !== undefined;
    const lead = thread.source.teamTask?.rootThreadId;
    return lead === undefined || !leads.has(`${thread.environmentId}:${lead}`);
  });
}

/** The rows in the order the sidebar draws them: each lead followed by its shown task rows. */
export function withTeamTaskRows<T>(
  rows: ReadonlyArray<T>,
  grouping: Pick<TeamThreadGrouping<T>, "groups">,
  keyOf: (thread: T) => string,
): ReadonlyArray<T> {
  if (grouping.groups.size === 0) return rows;
  return rows.flatMap((row) => [row, ...(grouping.groups.get(keyOf(row))?.shown ?? [])]);
}
