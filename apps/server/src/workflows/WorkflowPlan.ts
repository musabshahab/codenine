import {
  type AgentModel,
  type AgentModelStatus,
  type AgentSummary,
  type ModelSelection,
  type OrchestrationV2ProviderTurn,
  type ServerProvider,
  TEAM_BRIEF_MAX_CHARS,
  TEAM_MAX_AGENTS,
  type TeamAgent,
  TeamAgentId,
  type TeamPlan,
  type TeamPlanRun,
  type TeamTask,
  type TeamTaskDraft,
  TeamTaskId,
  ThreadId,
  type UsageTokenTotals,
  type WorkflowDefinition,
  type WorkflowId,
  type WorkflowInput,
  type WorkflowProblem,
  type WorkflowStep,
} from "@codenine/contracts";
import { agentModelSelection } from "@codenine/shared/agentModel";
import * as DateTime from "effect/DateTime";

import { agentModelStatus } from "../agents/Agents.ts";

/** What a workflow needs to know of one of the user's agents. */
export type WorkflowAgent = Pick<AgentSummary, "title" | "model">;
type ProviderSnapshot = Pick<ServerProvider, "instanceId" | "enabled" | "models">;

/** A run's lead thread. The web app derives the same id to find a workflow's runs. */
export const workflowRunThreadId = (workflowId: WorkflowId, run: number) =>
  ThreadId.make(`thread:workflow:${workflowId}:${run}`);

const LEAD_MODEL_PROBLEMS: Readonly<Record<Exclude<AgentModelStatus, "ready">, string>> = {
  "no-model": "Choose a model for the lead.",
  "account-off": "The lead's model is on an account that is turned off or removed. Choose another.",
  "model-missing": "The lead's model is no longer offered by its account. Choose another.",
};

const STEP_MODEL_PROBLEMS: Readonly<Record<"account-off" | "model-missing", string>> = {
  "account-off": "This step's model is on an account that is turned off or removed.",
  "model-missing": "This step's model is no longer offered by its account.",
};

const stepModel = (step: WorkflowStep, agent: WorkflowAgent): AgentModel | null =>
  step.model ?? agent.model;

const memberKey = (agent: string, model: AgentModel) =>
  JSON.stringify([agent, model.instanceId, model.model, model.effort]);

/** What a chat runs on for `model`, at its effort as that account offers it. */
export const workflowModelSelection = (
  model: AgentModel,
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "models">>,
): ModelSelection =>
  agentModelSelection(
    model,
    providers
      .find((provider) => provider.instanceId === model.instanceId)
      ?.models.find((candidate) => candidate.slug === model.model)?.capabilities,
  );

/** Why the workflow cannot run now, each about one step or the whole workflow. */
export function workflowProblems(input: {
  readonly workflow: WorkflowDefinition;
  readonly agents: ReadonlyMap<string, WorkflowAgent>;
  readonly providers: ReadonlyArray<ProviderSnapshot>;
  /** Whether the workflow's workspace still exists; ignored while it has none. */
  readonly projectExists: boolean;
}): ReadonlyArray<WorkflowProblem> {
  const { workflow, agents, providers } = input;
  const problems: Array<WorkflowProblem> = [];
  const aboutWorkflow = (message: string) => problems.push({ step: null, message });
  if (workflow.lead.goal.trim() === "") {
    aboutWorkflow("Describe the outcome you want. The lead checks every result against it.");
  }
  const leadStatus = agentModelStatus(workflow.lead.model, providers);
  if (leadStatus !== "ready") aboutWorkflow(LEAD_MODEL_PROBLEMS[leadStatus]);
  if (workflow.lead.projectId === null) aboutWorkflow("Choose the workspace the steps work in.");
  else if (!input.projectExists) {
    aboutWorkflow("The workspace this workflow works in no longer exists. Choose another.");
  }
  if (workflow.steps.length === 0) aboutWorkflow("Add a step for one of your agents to do.");
  const pairs = new Set<string>();
  for (const step of workflow.steps) {
    const aboutStep = (message: string) => problems.push({ step: step.id, message });
    if (step.agent === null) {
      aboutStep(
        step.suggestion === undefined
          ? "Choose an agent for this step."
          : `Create the suggested agent "${step.suggestion.title}", or choose one of yours.`,
      );
      continue;
    }
    const agent = agents.get(step.agent);
    if (agent === undefined) {
      aboutStep(`The agent "${step.agent}" no longer exists. Choose another.`);
      continue;
    }
    const model = stepModel(step, agent);
    const status = agentModelStatus(model, providers);
    if (status === "no-model") {
      aboutStep(`Choose a model for this step. ${agent.title} has no model of its own.`);
    } else if (status !== "ready") aboutStep(STEP_MODEL_PROBLEMS[status]);
    if (model !== null) pairs.add(memberKey(step.agent, model));
  }
  if (pairs.size > TEAM_MAX_AGENTS) {
    aboutWorkflow(
      `A run can use at most ${TEAM_MAX_AGENTS} pairs of agent and model; this workflow uses ${pairs.size}. Give some steps the same agent and model.`,
    );
  }
  return problems;
}

const BRIEF_CUT = "\n\n[Cut short to fit.]";

// The step's agent gets this run's inputs from the run itself, when its brief is composed.
function stepBrief(step: WorkflowStep): string {
  const brief = step.instructions.trim();
  if (brief === "") return step.title;
  return brief.length <= TEAM_BRIEF_MAX_CHARS
    ? brief
    : `${brief.slice(0, TEAM_BRIEF_MAX_CHARS - BRIEF_CUT.length)}${BRIEF_CUT}`;
}

/**
 * The team a run starts with: one member per pair of agent and model, each working in the
 * workspace's checkout, and one task per step. Null while a step has no agent or model to run on.
 */
export function workflowTeam(input: {
  readonly workflow: WorkflowDefinition;
  readonly agents: ReadonlyMap<string, WorkflowAgent>;
  readonly providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "models">>;
}): {
  readonly agents: ReadonlyArray<TeamAgent>;
  readonly tasks: ReadonlyArray<TeamTaskDraft>;
} | null {
  const memberIds = new Map<string, TeamAgentId>();
  const pairsPerAgent = new Map<string, number>();
  const members: Array<TeamAgent> = [];
  const tasks: Array<TeamTaskDraft> = [];
  for (const step of input.workflow.steps) {
    const agent = step.agent === null ? undefined : input.agents.get(step.agent);
    const model = agent === undefined ? null : stepModel(step, agent);
    if (step.agent === null || agent === undefined || model === null) return null;
    const key = memberKey(step.agent, model);
    let memberId = memberIds.get(key);
    if (memberId === undefined) {
      const count = (pairsPerAgent.get(step.agent) ?? 0) + 1;
      pairsPerAgent.set(step.agent, count);
      // An agent name cannot hold a colon, so a second model's member never takes another's id.
      memberId = TeamAgentId.make(count === 1 ? step.agent : `${step.agent.slice(0, 60)}:${count}`);
      memberIds.set(key, memberId);
      members.push({
        id: memberId,
        label: agent.title,
        role: "custom",
        modelSelection: workflowModelSelection(model, input.providers),
        workspace: "shared",
        agent: step.agent,
      });
    }
    tasks.push({
      id: TeamTaskId.make(step.id),
      title: step.title,
      brief: stepBrief(step),
      agentId: memberId,
      dependsOn: step.dependsOn.map((dependency) => TeamTaskId.make(dependency)),
      ...(step.doneWhen.trim() === "" ? {} : { doneWhen: step.doneWhen.trim() }),
    });
  }
  return { agents: members, tasks };
}

/** The lead's first message: what it leads, how it reviews, and what it reports at the end. */
export function workflowRunBrief(input: {
  readonly workflow: WorkflowDefinition;
  readonly run: number;
  readonly inputs: ReadonlyArray<WorkflowInput>;
  readonly notes: string;
  readonly agents: ReadonlyMap<string, WorkflowAgent>;
}): string {
  const { workflow } = input;
  const titles = new Map(workflow.steps.map((step) => [step.id, step.title]));
  const steps = workflow.steps.map((step) => {
    const agent = step.agent === null ? undefined : input.agents.get(step.agent);
    const parts = [`- ${step.title} (step "${step.id}"), by ${agent?.title ?? step.agent}.`];
    if (step.doneWhen.trim() !== "") parts.push(`Done when: ${step.doneWhen.trim()}`);
    if (step.dependsOn.length > 0) {
      parts.push(`Depends on: ${step.dependsOn.map((id) => titles.get(id) ?? id).join(", ")}.`);
    }
    return parts.join(" ");
  });
  const sections = [
    `You lead run ${input.run} of the workflow '${workflow.title}'. You don't do the steps yourself: each is done by its agent in its own chat, and you check every result.`,
    `Goal:\n${workflow.lead.goal.trim()}`,
  ];
  if (input.inputs.length > 0) {
    sections.push(
      [
        "This run's inputs:",
        ...input.inputs.map((value) => `- ${value.name}: ${value.value}`),
      ].join("\n"),
    );
  }
  sections.push(["Steps:", ...steps].join("\n"));
  const notes = input.notes.trim();
  if (notes !== "") sections.push(`Notes from past runs:\n${notes}`);
  sections.push(
    "When a step finishes you get its result. Check it against the goal and the step's Done when, then call review_step: accept, or revise with exactly what to fix. When every step is accepted you'll be asked for a final summary; then call save_run_note with a one-line headline and a short note for future runs. Now reply in one or two sentences: what you'll watch for in this run.",
  );
  return sections.join("\n\n");
}

/** The limit a run has reached, spending first; null while it is within both. */
export function reachedLimit(
  run: Pick<TeamPlanRun, "limits" | "startedAt">,
  costUsd: number | null,
  nowMs: number,
): "spend" | "time" | null {
  const { spendUsd, minutes } = run.limits;
  if (spendUsd !== null && costUsd !== null && costUsd >= spendUsd) return "spend";
  if (minutes !== null && nowMs - Date.parse(run.startedAt) >= minutes * 60_000) return "time";
  return null;
}

// A lead woken with a result starts its review well within this.
const REVIEW_WAIT_MS = 60_000;

/** A step whose result has waited longer than a lead takes to start reviewing it. */
export const staleReview = (plan: Pick<TeamPlan, "tasks">, nowMs: number): TeamTask | undefined =>
  plan.tasks.find(
    (task) =>
      task.review?.awaiting === true &&
      task.review.awaitingSince !== null &&
      nowMs - Date.parse(task.review.awaitingSince) > REVIEW_WAIT_MS,
  );

/** A provider turn's tokens as the Usage page counts them, and the model they are priced at. */
export function turnUsage(
  turn: Pick<OrchestrationV2ProviderTurn, "turnTokenUsage" | "model">,
  threadModel: string,
): { readonly model: string; readonly totals: UsageTokenTotals } | undefined {
  const usage = turn.turnTokenUsage;
  if (usage === undefined || usage.localCommand === true) return undefined;
  const cached = usage.cachedInputTokens ?? 0;
  const created = usage.cacheCreationTokens ?? 0;
  // Input counts cache reads and writes too; work beyond the main agent is priced at its model.
  return {
    model: turn.model ?? usage.models?.[0] ?? threadModel,
    totals: {
      uncachedInputTokens:
        Math.max(0, (usage.inputTokens ?? 0) - cached - created) +
        (usage.otherUsage?.inputTokens ?? 0),
      cachedInputTokens: cached,
      cacheCreationTokens: created,
      outputTokens: (usage.outputTokens ?? 0) + (usage.otherUsage?.outputTokens ?? 0),
      reasoningTokens: usage.reasoningTokens ?? 0,
    },
  };
}

/** The line a run's note adds to the workflow's notes, dated in `zone`. */
export function noteLine(
  run: Pick<TeamPlanRun, "run" | "scheduledFor" | "startedAt">,
  note: string,
  zone: DateTime.TimeZone,
): string {
  const { year, month, day } = DateTime.toParts(
    DateTime.makeZonedUnsafe(Date.parse(run.scheduledFor ?? run.startedAt), { timeZone: zone }),
  );
  const date = [year, month, day].map((part, index) =>
    String(part).padStart(index === 0 ? 4 : 2, "0"),
  );
  return `- ${date.join("-")} run ${run.run}: ${note.replace(/\s+/gu, " ").trim()}`;
}
