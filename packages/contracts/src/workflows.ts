import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { AgentModel, AgentModelStatus, AgentName, AgentSuggestion } from "./agents.ts";

const WORKFLOW_MAX_STEPS = 12;
const WORKFLOW_MAX_INPUTS = 12;
const WORKFLOW_GOAL_MAX_CHARS = 2_000;
const WORKFLOW_STEP_INSTRUCTIONS_MAX_CHARS = 4_000;
const WORKFLOW_DONE_WHEN_MAX_CHARS = 1_000;
const WORKFLOW_INPUT_VALUE_MAX_CHARS = 1_000;
/** The lead reads its notes at every review, so they stay short; older lines drop off first. */
const WORKFLOW_NOTES_MAX_CHARS = 8_000;

const Slug = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  Schema.isMaxLength(64),
);

/** A workflow's folder name under `<Codenine folder>/workflows`; renaming changes it. */
export const WorkflowName = Slug;
export type WorkflowName = typeof WorkflowName.Type;

/** Set by the server when a workflow is created and kept across renames; run threads derive from it. */
export const WorkflowId = TrimmedNonEmptyString.check(Schema.isMaxLength(64)).pipe(
  Schema.brand("WorkflowId"),
);
export type WorkflowId = typeof WorkflowId.Type;

export const WorkflowRunTrigger = Schema.Literals(["manual", "schedule", "missed"]);
export type WorkflowRunTrigger = typeof WorkflowRunTrigger.Type;

/** A step's id; it is also the id of the step's task in a run's team plan. */
export const WorkflowStepId = Slug.pipe(Schema.brand("WorkflowStepId"));
export type WorkflowStepId = typeof WorkflowStepId.Type;

export const WorkflowTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(80));

/** Where a box sits on the canvas. */
export const WorkflowPosition = Schema.Struct({ x: Schema.Finite, y: Schema.Finite });
export type WorkflowPosition = typeof WorkflowPosition.Type;

export const WorkflowStep = Schema.Struct({
  id: WorkflowStepId,
  title: WorkflowTitle,
  /** Null until the user picks one; a step without an agent cannot run. */
  agent: Schema.NullOr(AgentName),
  /** What the lead suggested where none of the user's agents fit; Codenine never creates the agent. */
  suggestion: Schema.optionalKey(AgentSuggestion),
  /** Null runs the step on its agent's own model. */
  model: Schema.NullOr(AgentModel),
  /** "What it does each run". */
  instructions: Schema.String.check(Schema.isMaxLength(WORKFLOW_STEP_INSTRUCTIONS_MAX_CHARS)),
  /** What the lead checks before it accepts the step's result. */
  doneWhen: Schema.String.check(Schema.isMaxLength(WORKFLOW_DONE_WHEN_MAX_CHARS)),
  /** A step starts once every step it depends on is accepted, and gets their results. */
  dependsOn: Schema.Array(WorkflowStepId),
  position: WorkflowPosition,
});
export type WorkflowStep = typeof WorkflowStep.Type;

export const WorkflowWeekday = Schema.Literals(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
export type WorkflowWeekday = typeof WorkflowWeekday.Type;

export const WorkflowSchedule = Schema.Struct({
  days: Schema.Array(WorkflowWeekday).check(Schema.isMinLength(1)),
  /** 24-hour "HH:MM" in `timeZone`. */
  time: Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/)),
  /** An IANA time zone, such as "Europe/London". */
  timeZone: TrimmedNonEmptyString,
});
export type WorkflowSchedule = typeof WorkflowSchedule.Type;

/** Scheduled runs that fell while Codenine was off: one run when it is back, each of them, or none. */
export const WorkflowMissedRuns = Schema.Literals(["once", "each", "skip"]);
export type WorkflowMissedRuns = typeof WorkflowMissedRuns.Type;

export const WorkflowTrigger = Schema.Struct({
  /** Null: it runs only when the user starts it. */
  schedule: Schema.NullOr(WorkflowSchedule),
  missedRuns: WorkflowMissedRuns,
  position: WorkflowPosition,
});
export type WorkflowTrigger = typeof WorkflowTrigger.Type;

/** A value each run starts with, such as a topic area; Run now can change it for one run. */
export const WorkflowInput = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(60)),
  value: Schema.String.check(Schema.isMaxLength(WORKFLOW_INPUT_VALUE_MAX_CHARS)),
});
export type WorkflowInput = typeof WorkflowInput.Type;

/**
 * When a step's agent wants an action its own settings would ask about: `ask` waits for the user,
 * `review` lets a reviewer model allow what fits the goal and ask about the rest, `never` goes
 * ahead. What the user always allowed for the agent goes ahead in every mode.
 */
export const WorkflowApprovals = Schema.Literals(["ask", "review", "never"]);
export type WorkflowApprovals = typeof WorkflowApprovals.Type;

export const WorkflowLimits = Schema.Struct({
  /** Estimated US dollars a run may spend before it stops to ask; null for no limit. */
  spendUsd: Schema.NullOr(Schema.Finite.check(Schema.isGreaterThan(0))),
  /** Minutes a run may take before it stops to ask; null for no limit. */
  minutes: Schema.NullOr(PositiveInt),
});
export type WorkflowLimits = typeof WorkflowLimits.Type;

export const WorkflowLead = Schema.Struct({
  /** Null until one is chosen; the workflow cannot run before then. */
  model: Schema.NullOr(AgentModel),
  /** "The outcome you want": what the lead checks every result against. */
  goal: Schema.String.check(Schema.isMaxLength(WORKFLOW_GOAL_MAX_CHARS)),
  /** The workspace whose folder the steps work in; null until one is chosen. */
  projectId: Schema.NullOr(ProjectId),
  approvals: WorkflowApprovals,
  limits: WorkflowLimits,
});
export type WorkflowLead = typeof WorkflowLead.Type;

export const WorkflowDefinition = Schema.Struct({
  name: WorkflowName,
  title: WorkflowTitle,
  description: Schema.String.check(Schema.isMaxLength(1024)),
  /** Scheduled runs happen only while it is on; Run now works either way. */
  enabled: Schema.Boolean,
  trigger: WorkflowTrigger,
  inputs: Schema.Array(WorkflowInput).check(Schema.isMaxLength(WORKFLOW_MAX_INPUTS)),
  lead: WorkflowLead,
  steps: Schema.Array(WorkflowStep).check(Schema.isMaxLength(WORKFLOW_MAX_STEPS)),
});
export type WorkflowDefinition = typeof WorkflowDefinition.Type;

/** Why a workflow cannot run now, in words shown to the user as they are. */
export const WorkflowProblem = Schema.Struct({
  /** The step it is about; null when it is about the whole workflow. */
  step: Schema.NullOr(WorkflowStepId),
  message: TrimmedNonEmptyString,
});
export type WorkflowProblem = typeof WorkflowProblem.Type;

/** A scheduled run Codenine skipped because it was off and the workflow skips missed runs. */
export const WorkflowSkippedRun = Schema.Struct({ scheduledFor: IsoDateTime });
export type WorkflowSkippedRun = typeof WorkflowSkippedRun.Type;

const WorkflowFileFields = {
  id: WorkflowId,
  /** The workflow's folder on the server's computer. */
  path: Schema.String,
  updatedAt: IsoDateTime,
  /** Empty when it can run. */
  problems: Schema.Array(WorkflowProblem),
  /** The next scheduled run; null when it is off or has no schedule. */
  nextRunAt: Schema.NullOr(IsoDateTime),
  /** Newest first, at most 20. */
  skipped: Schema.Array(WorkflowSkippedRun),
};

export const WorkflowDetail = Schema.Struct({
  ...WorkflowDefinition.fields,
  ...WorkflowFileFields,
  /** The lead's notes from past runs; the user may edit them. */
  notes: Schema.String,
});
export type WorkflowDetail = typeof WorkflowDetail.Type;

/** A step as lists show it; instructions stay on the workflow's own page. */
export const WorkflowStepSummary = WorkflowStep.mapFields(
  ({ instructions: _instructions, doneWhen: _doneWhen, suggestion: _suggestion, ...rest }) => rest,
);
export type WorkflowStepSummary = typeof WorkflowStepSummary.Type;

export const WorkflowSummary = Schema.Struct({
  name: WorkflowName,
  title: WorkflowTitle,
  description: Schema.String,
  enabled: Schema.Boolean,
  trigger: WorkflowTrigger,
  leadModel: Schema.NullOr(AgentModel),
  leadModelStatus: AgentModelStatus,
  projectId: Schema.NullOr(ProjectId),
  steps: Schema.Array(WorkflowStepSummary),
  ...WorkflowFileFields,
});
export type WorkflowSummary = typeof WorkflowSummary.Type;

export const WorkflowsEmptyInput = Schema.Struct({});
export const WorkflowsEmptyResult = Schema.Struct({});
export const WorkflowsListResult = Schema.Struct({ workflows: Schema.Array(WorkflowSummary) });
export const WorkflowNameInput = Schema.Struct({ name: WorkflowName });

/** A chat's draft as a save names it: the chat, and which of its drafts. */
export const WorkflowDraftRef = Schema.Struct({ threadId: ThreadId, proposedAt: IsoDateTime });
export type WorkflowDraftRef = typeof WorkflowDraftRef.Type;

export const WorkflowSaveInput = Schema.Struct({
  workflow: WorkflowDefinition,
  /** Editing: the workflow's current name. Leave out to create; taken names fail. */
  previousName: Schema.optionalKey(WorkflowName),
  /** Replaces the lead's notes; leave out to keep them. */
  notes: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(WORKFLOW_NOTES_MAX_CHARS))),
  /** The chat draft this saves; the chat then shows the saved workflow. */
  fromDraft: Schema.optionalKey(WorkflowDraftRef),
});
export type WorkflowSaveInput = typeof WorkflowSaveInput.Type;

/** Turns scheduled runs on or off without touching the rest of the workflow. */
export const WorkflowSetEnabledInput = Schema.Struct({
  name: WorkflowName,
  enabled: Schema.Boolean,
});
export type WorkflowSetEnabledInput = typeof WorkflowSetEnabledInput.Type;

export const WorkflowRunInput = Schema.Struct({
  name: WorkflowName,
  /** This run's values; leave out to use the workflow's own. */
  inputs: Schema.optionalKey(
    Schema.Array(WorkflowInput).check(Schema.isMaxLength(WORKFLOW_MAX_INPUTS)),
  ),
});
export type WorkflowRunInput = typeof WorkflowRunInput.Type;

export const WorkflowRunStarted = Schema.Struct({
  /** The run's lead thread. */
  threadId: ThreadId,
  run: PositiveInt,
});
export type WorkflowRunStarted = typeof WorkflowRunStarted.Type;

/** A step as a lead drafts it in a chat; the editor places it on the canvas. */
export const WorkflowDraftStep = WorkflowStep.mapFields(
  ({ position: _position, model: _model, ...rest }) => rest,
);
export type WorkflowDraftStep = typeof WorkflowDraftStep.Type;

/** What `propose_workflow` leaves on a chat; nothing is saved until the user saves it. */
export const WorkflowDraft = Schema.Struct({
  title: WorkflowTitle,
  description: Schema.String.check(Schema.isMaxLength(1024)),
  goal: Schema.String.check(Schema.isMaxLength(WORKFLOW_GOAL_MAX_CHARS)),
  schedule: Schema.NullOr(WorkflowSchedule),
  inputs: Schema.Array(WorkflowInput).check(Schema.isMaxLength(WORKFLOW_MAX_INPUTS)),
  steps: Schema.Array(WorkflowDraftStep).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(WORKFLOW_MAX_STEPS),
  ),
  proposedAt: IsoDateTime,
});
export type WorkflowDraft = typeof WorkflowDraft.Type;

/** A draft this build cannot read becomes null instead of failing the whole thread. */
export const StoredWorkflowDraft = Schema.NullOr(WorkflowDraft).pipe(
  Schema.catchDecoding(() => Effect.succeedSome(null)),
);

/** The workflow a chat's draft was saved as; `proposedAt` names the draft that was saved. */
export const SavedWorkflowLink = Schema.Struct({ id: WorkflowId, proposedAt: IsoDateTime });
export type SavedWorkflowLink = typeof SavedWorkflowLink.Type;

/** A link this build cannot read becomes null instead of failing the whole thread. */
export const StoredSavedWorkflowLink = Schema.NullOr(SavedWorkflowLink).pipe(
  Schema.catchDecoding(() => Effect.succeedSome(null)),
);

export class WorkflowError extends Schema.TaggedError<WorkflowError>()("WorkflowError", {
  reason: Schema.Literals(["not-found", "invalid", "exists", "cannot-run", "failed"]),
  /** Shown to the user as is. */
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
