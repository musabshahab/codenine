import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { AgentName, AgentSuggestion } from "./agents.ts";
import { ModelSelection } from "./modelSelection.ts";
import {
  WorkflowApprovals,
  WorkflowId,
  WorkflowInput,
  WorkflowLimits,
  WorkflowName,
  WorkflowRunTrigger,
  WorkflowTitle,
} from "./workflows.ts";

export const TEAM_MAX_AGENTS = 8;
export const TEAM_MAX_TASKS = 16;
export const TEAM_LABEL_MAX_CHARS = 120;
export const TEAM_BRIEF_MAX_CHARS = 6_000;
export const TEAM_RESULT_MAX_CHARS = 4_000;
const TEAM_DONE_WHEN_MAX_CHARS = 1_000;
export const TEAM_REVIEW_NOTES_MAX_CHARS = 4_000;
export const TEAM_RUN_HEADLINE_MAX_CHARS = 160;
export const TEAM_RUN_NOTE_MAX_CHARS = 500;
export const TEAM_DEFAULT_MAX_PARALLEL_PER_PROVIDER = 2;

export const TeamPlanId = TrimmedNonEmptyString.pipe(Schema.brand("TeamPlanId"));
export type TeamPlanId = typeof TeamPlanId.Type;

// The lead agent chooses these, and a task's thread id is derived from them.
const TeamSlug = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export const TeamAgentId = TeamSlug.pipe(Schema.brand("TeamAgentId"));
export type TeamAgentId = typeof TeamAgentId.Type;
export const TeamTaskId = TeamSlug.pipe(Schema.brand("TeamTaskId"));
export type TeamTaskId = typeof TeamTaskId.Type;

export const TeamAgentRole = Schema.Literals([
  "plan",
  "research",
  "implement",
  "test",
  "review",
  "integrate",
  "custom",
]);
export type TeamAgentRole = typeof TeamAgentRole.Type;

/** `shared` works in the lead's checkout; `worktree` gets its own, cut from the lead's HEAD. */
export const TeamWorkspace = Schema.Literals(["shared", "worktree"]);
export type TeamWorkspace = typeof TeamWorkspace.Type;

/**
 * A member runs as the user's `agent`, on `modelSelection`, which starts as that agent's model.
 * A member the lead suggested has `suggestion` and no `agent` until the user picks or creates one,
 * and the team cannot start before then. Members of plans from before agents have neither.
 */
export const TeamAgent = Schema.Struct({
  id: TeamAgentId,
  label: TrimmedNonEmptyString,
  role: TeamAgentRole,
  modelSelection: ModelSelection,
  workspace: TeamWorkspace,
  agent: Schema.optional(AgentName),
  suggestion: Schema.optional(AgentSuggestion),
});
export type TeamAgent = typeof TeamAgent.Type;

export const TeamTaskDraft = Schema.Struct({
  id: TeamTaskId,
  title: TrimmedNonEmptyString,
  brief: TrimmedNonEmptyString,
  agentId: TeamAgentId,
  dependsOn: Schema.Array(TeamTaskId),
  /** A workflow step's "Done when" line, which the lead checks before it accepts the result. */
  doneWhen: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(TEAM_DONE_WHEN_MAX_CHARS))),
});
export type TeamTaskDraft = typeof TeamTaskDraft.Type;

/** What a proposal or an edit carries: the plan without its runtime state. */
export const TeamDraft = Schema.Struct({
  agents: Schema.Array(TeamAgent),
  tasks: Schema.Array(TeamTaskDraft),
});
export type TeamDraft = typeof TeamDraft.Type;

export const TeamTaskStatus = Schema.Literals([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type TeamTaskStatus = typeof TeamTaskStatus.Type;

export const TeamTaskUsage = Schema.Struct({
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
});
export type TeamTaskUsage = typeof TeamTaskUsage.Type;

/**
 * On a workflow run's task: the lead reviews every result. `awaiting` means the step's run ended and
 * the lead must accept it or send it back; a send-back continues the same thread as the next round.
 */
export const TeamTaskReview = Schema.Struct({
  round: PositiveInt,
  awaiting: Schema.Boolean,
  awaitingSince: Schema.NullOr(IsoDateTime),
});
export type TeamTaskReview = typeof TeamTaskReview.Type;

export const TeamTask = Schema.Struct({
  ...TeamTaskDraft.fields,
  status: TeamTaskStatus,
  /** Counts from 1. A retry starts the next attempt in a new thread. */
  attempt: PositiveInt,
  threadId: Schema.NullOr(ThreadId),
  result: Schema.NullOr(Schema.String),
  usage: Schema.optional(TeamTaskUsage),
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  review: Schema.optionalKey(TeamTaskReview),
  /** The run whose result is stored, so the same thread can settle again after a send-back. */
  resultRunId: Schema.optionalKey(RunId),
});
export type TeamTask = typeof TeamTask.Type;

export const TeamPlanStatus = Schema.Literals([
  "proposed",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type TeamPlanStatus = typeof TeamPlanStatus.Type;

/**
 * Why a workflow run waits for the user: it reached its spending or time limit, or the lead ended
 * its turn without deciding on a step. Nothing new starts while it waits; running turns finish.
 */
export const TeamPlanHoldReason = Schema.Literals(["spend", "time", "review"]);
export type TeamPlanHoldReason = typeof TeamPlanHoldReason.Type;

export const TeamPlanHold = Schema.Struct({ reason: TeamPlanHoldReason, at: IsoDateTime });
export type TeamPlanHold = typeof TeamPlanHold.Type;

/** A plan with `run` is a workflow run: its lead reviews every step before dependents start. */
export const TeamPlanRun = Schema.Struct({
  workflowId: WorkflowId,
  workflowName: WorkflowName,
  title: WorkflowTitle,
  run: PositiveInt,
  trigger: WorkflowRunTrigger,
  /** The scheduled time this run is for; null when the user started it. */
  scheduledFor: Schema.NullOr(IsoDateTime),
  inputs: Schema.Array(WorkflowInput).check(Schema.isMaxLength(12)),
  approvals: WorkflowApprovals,
  limits: WorkflowLimits,
  startedAt: IsoDateTime,
  /** Estimated so far; null when the models' prices are unknown. */
  costUsd: Schema.NullOr(Schema.Finite),
  /** The lead's one-line outcome, such as what was published; null until it writes one. */
  headline: Schema.NullOr(Schema.String.check(Schema.isMaxLength(TEAM_RUN_HEADLINE_MAX_CHARS))),
  /** What the next run should know; the server adds it to the workflow's notes once. */
  note: Schema.NullOr(Schema.String.check(Schema.isMaxLength(TEAM_RUN_NOTE_MAX_CHARS))),
});
export type TeamPlanRun = typeof TeamPlanRun.Type;

export const TeamPlan = Schema.Struct({
  id: TeamPlanId,
  /** Counts edits while the plan is proposed; approval names the revision it accepts. */
  revision: PositiveInt,
  status: TeamPlanStatus,
  goal: TrimmedNonEmptyString,
  agents: Schema.Array(TeamAgent),
  tasks: Schema.Array(TeamTask),
  maxParallelPerProvider: PositiveInt,
  proposedAt: IsoDateTime,
  updatedAt: IsoDateTime,
  run: Schema.optionalKey(TeamPlanRun),
  hold: Schema.optionalKey(TeamPlanHold),
});
export type TeamPlan = typeof TeamPlan.Type;

/** Where a lead's plan stands, for thread lists. Pending tasks are `total` less the other counts. */
export const TeamPlanSummary = Schema.Struct({
  planId: TeamPlanId,
  status: TeamPlanStatus,
  revision: PositiveInt,
  total: NonNegativeInt,
  completed: NonNegativeInt,
  failed: NonNegativeInt,
  running: NonNegativeInt,
  cancelled: NonNegativeInt,
  /** Workflow runs only; lists show runs from this without the plan. */
  run: Schema.optionalKey(
    TeamPlanRun.mapFields(({ inputs: _inputs, limits: _limits, note: _note, ...rest }) => rest),
  ),
  hold: Schema.optionalKey(TeamPlanHold),
  /** Steps whose result waits for the lead's review. */
  awaitingReview: Schema.optionalKey(NonNegativeInt),
});
export type TeamPlanSummary = typeof TeamPlanSummary.Type;

/** A plan this build cannot read becomes null instead of failing the whole thread. */
export const StoredTeamPlan = Schema.NullOr(TeamPlan).pipe(
  Schema.catchDecoding(() => Effect.succeedSome(null)),
);

/** On a team agent's thread: the task it runs for the plan on `rootThreadId`. */
export const TeamTaskRef = Schema.Struct({
  rootThreadId: ThreadId,
  planId: TeamPlanId,
  taskId: TeamTaskId,
  attempt: PositiveInt,
});
export type TeamTaskRef = typeof TeamTaskRef.Type;
