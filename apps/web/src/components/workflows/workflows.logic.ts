import type { EnvironmentThreadShell } from "@codenine/client-runtime/state/models";
import type {
  AgentModel,
  AgentSummary,
  EnvironmentId,
  OrchestrationV2ThreadShell,
  ProjectId,
  TeamAgent,
  TeamPlan,
  TeamPlanHold,
  TeamPlanStatus,
  TeamTask,
  ThreadId,
  WorkflowDefinition,
  WorkflowDetail,
  WorkflowDraft,
  WorkflowDraftRef,
  WorkflowId,
  WorkflowInput,
  WorkflowLimits,
  WorkflowPosition,
  WorkflowProblem,
  WorkflowRunTrigger,
  WorkflowSchedule,
  WorkflowStep,
  WorkflowStepId,
  WorkflowSummary,
  WorkflowWeekday,
} from "@codenine/contracts";

import { draftStepsOver } from "../chat/workflowDraft.logic";
import { skillNameFromTitle } from "../skills/skills.logic";

/** The contract's limits, which it checks without exporting. */
export const WORKFLOW_STEP_LIMIT = 12;
export const WORKFLOW_INPUT_LIMIT = 12;
const TITLE_MAX = 80;
const DESCRIPTION_MAX = 1024;
const GOAL_MAX = 2_000;
const INSTRUCTIONS_MAX = 4_000;
const DONE_WHEN_MAX = 1_000;
const INPUT_NAME_MAX = 60;
const INPUT_VALUE_MAX = 1_000;
export const WORKFLOW_NOTES_MAX = 8_000;
const NAME_MAX = 64;

// Canvas sizes: the lead is drawn as a frame around the steps, and the trigger sits left of it.
export const STEP_WIDTH = 176;
export const STEP_HEIGHT = 96;
const TRIGGER_WIDTH = 160;
const TRIGGER_HEIGHT = 96;
const COLUMN = STEP_WIDTH + 72;
const ROW = STEP_HEIGHT + 40;
const FRAME_PADDING = 28;
const FRAME_HEADER = 64;
const TRIGGER_GAP = 72;

type StepLink = Pick<WorkflowStep, "id" | "dependsOn">;

/** Each step's depth: 0 without known dependencies, else one more than its deepest dependency. */
function stepLayers(steps: ReadonlyArray<StepLink>): Map<WorkflowStepId, number> {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const layers = new Map<WorkflowStepId, number>();
  const layerOf = (id: WorkflowStepId, visiting: ReadonlySet<WorkflowStepId>): number => {
    const known = layers.get(id);
    if (known !== undefined) return known;
    let layer = 0;
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      // A loop never runs; lay its steps out instead of recursing forever.
      if (visiting.has(dependency) || !byId.has(dependency)) continue;
      layer = Math.max(layer, layerOf(dependency, new Set([...visiting, dependency])) + 1);
    }
    layers.set(id, layer);
    return layer;
  };
  for (const step of steps) layerOf(step.id, new Set([step.id]));
  return layers;
}

/** Steps laid out left to right by what they wait for, each column centred on the first row. */
export function layoutSteps(
  steps: ReadonlyArray<StepLink>,
): ReadonlyMap<WorkflowStepId, WorkflowPosition> {
  const layers = stepLayers(steps);
  const columns = new Map<number, WorkflowStepId[]>();
  for (const step of steps) {
    const layer = layers.get(step.id) ?? 0;
    columns.set(layer, [...(columns.get(layer) ?? []), step.id]);
  }
  const positions = new Map<WorkflowStepId, WorkflowPosition>();
  for (const [layer, ids] of columns) {
    ids.forEach((id, row) => {
      positions.set(id, { x: layer * COLUMN, y: (row - (ids.length - 1) / 2) * ROW });
    });
  }
  return positions;
}

export interface CanvasBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The lead's frame: the steps' box with room for the lead's header, or a placeholder box. */
export function leadFrameBounds(positions: ReadonlyArray<WorkflowPosition>): CanvasBounds {
  const xs = positions.map((position) => position.x);
  const ys = positions.map((position) => position.y);
  const minX = xs.length === 0 ? 0 : Math.min(...xs);
  const minY = ys.length === 0 ? 0 : Math.min(...ys);
  const maxX = xs.length === 0 ? STEP_WIDTH : Math.max(...xs) + STEP_WIDTH;
  const maxY = ys.length === 0 ? STEP_HEIGHT : Math.max(...ys) + STEP_HEIGHT;
  const width = Math.max(maxX - minX, STEP_WIDTH * 2) + FRAME_PADDING * 2;
  return {
    x: minX - FRAME_PADDING,
    y: minY - FRAME_PADDING - FRAME_HEADER,
    width,
    height: maxY - minY + FRAME_PADDING * 2 + FRAME_HEADER,
  };
}

/** Where the trigger goes: left of the lead's frame, level with the steps' middle. */
function triggerPositionFor(positions: ReadonlyArray<WorkflowPosition>): WorkflowPosition {
  const frame = leadFrameBounds(positions);
  const middle = frame.y + FRAME_HEADER + (frame.height - FRAME_HEADER) / 2;
  return { x: frame.x - TRIGGER_GAP - TRIGGER_WIDTH, y: middle - TRIGGER_HEIGHT / 2 };
}

/** A new step's place: a column right of the rightmost step, on its row. */
function nextStepPosition(steps: ReadonlyArray<Pick<WorkflowStep, "position">>) {
  const rightmost = steps.reduce<WorkflowPosition | null>(
    (best, step) => (best === null || step.position.x > best.x ? step.position : best),
    null,
  );
  return rightmost === null ? { x: 0, y: 0 } : { x: rightmost.x + COLUMN, y: rightmost.y };
}

/** `desired`, moved down a row at a time until it covers no other step. */
export function freeStepPosition(
  desired: WorkflowPosition,
  taken: ReadonlyArray<WorkflowPosition>,
): WorkflowPosition {
  const snap = (value: number) => Math.round(value / 8) * 8;
  let position = { x: snap(desired.x), y: snap(desired.y) };
  for (let tries = 0; tries < WORKFLOW_STEP_LIMIT; tries++) {
    const overlaps = taken.some(
      (other) =>
        Math.abs(other.x - position.x) < STEP_WIDTH + 16 &&
        Math.abs(other.y - position.y) < STEP_HEIGHT + 16,
    );
    if (!overlaps) return position;
    position = { x: position.x, y: position.y + ROW };
  }
  return position;
}

/** Whether `stepId` waits for `ancestorId`, directly or through other steps. */
function waitsFor(
  steps: ReadonlyArray<StepLink>,
  stepId: WorkflowStepId,
  ancestorId: WorkflowStepId,
): boolean {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const seen = new Set<WorkflowStepId>();
  const pending = [...(byId.get(stepId)?.dependsOn ?? [])];
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || seen.has(id)) continue;
    if (id === ancestorId) return true;
    seen.add(id);
    pending.push(...(byId.get(id)?.dependsOn ?? []));
  }
  return false;
}

/** Whether `to` waiting for `from` would make steps wait for each other in a loop. */
export function wouldCreateCycle(
  steps: ReadonlyArray<StepLink>,
  from: WorkflowStepId,
  to: WorkflowStepId,
): boolean {
  return from === to || waitsFor(steps, from, to);
}

/** The steps of a loop, in order, or null when the steps have none. */
export function findCycle(steps: ReadonlyArray<StepLink>): ReadonlyArray<WorkflowStepId> | null {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const done = new Set<WorkflowStepId>();
  const visit = (
    id: WorkflowStepId,
    path: ReadonlyArray<WorkflowStepId>,
  ): ReadonlyArray<WorkflowStepId> | null => {
    const loopStart = path.indexOf(id);
    if (loopStart !== -1) return path.slice(loopStart);
    if (done.has(id)) return null;
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dependency)) continue;
      const loop = visit(dependency, [...path, id]);
      if (loop !== null) return loop;
    }
    done.add(id);
    return null;
  };
  for (const step of steps) {
    const loop = visit(step.id, []);
    if (loop !== null) return loop;
  }
  return null;
}

function uniqueSlug(base: string, taken: ReadonlySet<string>, fallback: string): string {
  const root = skillNameFromTitle(base).slice(0, NAME_MAX).replace(/-+$/u, "") || fallback;
  for (let number = 1; ; number++) {
    const suffix = number === 1 ? "" : `-${number}`;
    const candidate = `${root.slice(0, NAME_MAX - suffix.length).replace(/-+$/u, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * The folder name a workflow saves under, from its title. `new` names the page that makes one,
 * so a workflow never takes it.
 */
export function workflowNameFor(title: string, taken: ReadonlyArray<string>): string {
  const slug = skillNameFromTitle(title);
  return uniqueSlug(slug === "new" ? "new-workflow" : slug, new Set([...taken, "new"]), "workflow");
}

/** Whether a saved name still matches the title, numbered or not, so saving keeps it. */
function nameFitsTitle(name: string, title: string): boolean {
  if (name === "") return false;
  const base = workflowNameFor(title, []);
  return name === base || new RegExp(`^${base}-\\d+$`, "u").test(name);
}

/** The name the workflow saves under: its own while the title fits it; null without a title. */
export function workflowSaveName(
  definition: Pick<WorkflowDefinition, "name" | "title">,
  takenNames: ReadonlyArray<string>,
): string | null {
  const title = definition.title.trim();
  if (skillNameFromTitle(title) === "") return null;
  return nameFitsTitle(definition.name, title)
    ? definition.name
    : workflowNameFor(
        title,
        takenNames.filter((taken) => taken !== definition.name),
      );
}

function newStepId(title: string, steps: ReadonlyArray<Pick<WorkflowStep, "id">>): WorkflowStepId {
  return uniqueSlug(title, new Set(steps.map((step) => step.id)), "step") as WorkflowStepId;
}

const NO_LIMITS: WorkflowLimits = { spendUsd: null, minutes: null };

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

/** Positions every step by its dependencies and puts the trigger left of them. */
function withLayout(definition: WorkflowDefinition): WorkflowDefinition {
  const positions = layoutSteps(definition.steps);
  const steps = definition.steps.map((step) => ({
    ...step,
    position: positions.get(step.id) ?? step.position,
  }));
  return {
    ...definition,
    steps,
    trigger: {
      ...definition.trigger,
      position: triggerPositionFor(steps.map((step) => step.position)),
    },
  };
}

export function blankWorkflow(): WorkflowDefinition {
  return {
    name: "",
    title: "",
    description: "",
    enabled: false,
    trigger: { schedule: null, missedRuns: "once", position: triggerPositionFor([]) },
    inputs: [],
    lead: { model: null, goal: "", projectId: null, approvals: "ask", limits: NO_LIMITS },
    steps: [],
  };
}

export interface WorkflowLeadStart {
  readonly model: AgentModel | null;
  readonly projectId: ProjectId | null;
}

/** A workflow made from what a lead drafted in a chat; it is off until the user turns it on. */
export function workflowFromDraft(
  draft: WorkflowDraft,
  lead: WorkflowLeadStart,
): WorkflowDefinition {
  const ids = new Set(draft.steps.map((step) => step.id));
  return withLayout({
    ...blankWorkflow(),
    title: clip(draft.title, TITLE_MAX),
    description: draft.description,
    trigger: { schedule: draft.schedule, missedRuns: "once", position: { x: 0, y: 0 } },
    inputs: draft.inputs,
    lead: {
      ...blankWorkflow().lead,
      model: lead.model,
      projectId: lead.projectId,
      goal: draft.goal,
    },
    steps: draft.steps.map((step) => ({
      ...step,
      model: null,
      dependsOn: step.dependsOn.filter((id) => ids.has(id) && id !== step.id),
      position: { x: 0, y: 0 },
    })),
  });
}

/**
 * A saved workflow with a newer draft from its chat applied: the draft's description, goal,
 * schedule, inputs and steps, and the user's own choices kept, so saving updates it in place.
 */
export function workflowWithDraft(
  saved: WorkflowDefinition,
  draft: WorkflowDraft,
  agents: ReadonlyArray<Pick<AgentSummary, "name">>,
): WorkflowDefinition {
  const drafted = draftStepsOver(draft, saved.steps);
  const ids = new Set(drafted.map((step) => step.id));
  const savedById = new Map(saved.steps.map((step) => [step.id, step]));
  // New steps go where no kept step already sits.
  const placed = drafted.flatMap((step) => savedById.get(step.id)?.position ?? []);
  const steps = drafted.map((step): WorkflowStep => {
    const kept = savedById.get(step.id);
    const dependsOn = step.dependsOn.filter((id) => ids.has(id) && id !== step.id);
    if (kept !== undefined) {
      return { ...step, dependsOn, model: kept.model, position: kept.position };
    }
    const position = freeStepPosition(
      nextStepPosition(placed.map((at) => ({ position: at }))),
      placed,
    );
    placed.push(position);
    return { ...step, dependsOn, model: null, position };
  });
  return withMadeAgents(
    {
      ...saved,
      description: draft.description,
      trigger: { ...saved.trigger, schedule: draft.schedule },
      inputs: draft.inputs,
      lead: { ...saved.lead, goal: draft.goal },
      steps,
    },
    agents,
  );
}

/**
 * A workflow made from a team that did the job: a step per task for the same agents, and the
 * team's goal as the outcome the lead checks against.
 */
export function workflowFromTeamPlan(
  plan: Pick<TeamPlan, "goal" | "agents" | "tasks">,
  options: WorkflowLeadStart & {
    readonly title: string;
    /** The step's model as a workflow saves it: null when the member runs on its agent's own. */
    readonly stepModel: (member: TeamAgent) => AgentModel | null;
  },
): WorkflowDefinition {
  const stepIds = new Map<string, WorkflowStepId>();
  const taken: Array<Pick<WorkflowStep, "id">> = [];
  for (const task of plan.tasks) {
    const id = newStepId(task.id, taken);
    stepIds.set(task.id, id);
    taken.push({ id });
  }
  const steps = plan.tasks.map((task): WorkflowStep => {
    const member = plan.agents.find((candidate) => candidate.id === task.agentId);
    const id = stepIds.get(task.id) ?? newStepId(task.title, taken);
    return {
      id,
      title: clip(task.title.trim(), TITLE_MAX),
      agent: member?.agent ?? null,
      ...(member?.agent === undefined && member?.suggestion !== undefined
        ? { suggestion: member.suggestion }
        : {}),
      model: member === undefined ? null : options.stepModel(member),
      instructions: clip(task.brief, INSTRUCTIONS_MAX),
      doneWhen: clip(task.doneWhen ?? "", DONE_WHEN_MAX),
      dependsOn: [
        ...new Set(task.dependsOn.flatMap((dependency) => stepIds.get(dependency) ?? [])),
      ].filter((dependency) => dependency !== id),
      position: { x: 0, y: 0 },
    };
  });
  return withLayout({
    ...blankWorkflow(),
    title: clip(options.title.trim(), TITLE_MAX),
    lead: {
      ...blankWorkflow().lead,
      model: options.model,
      projectId: options.projectId,
      goal: clip(plan.goal, GOAL_MAX),
    },
    steps,
  });
}

/** The editable part of a saved workflow. */
export function definitionOf(detail: WorkflowDetail): WorkflowDefinition {
  return {
    name: detail.name,
    title: detail.title,
    description: detail.description,
    enabled: detail.enabled,
    trigger: detail.trigger,
    inputs: detail.inputs,
    lead: detail.lead,
    steps: detail.steps,
  };
}

export function addStep(
  definition: WorkflowDefinition,
  position: WorkflowPosition = nextStepPosition(definition.steps),
): { readonly definition: WorkflowDefinition; readonly id: WorkflowStepId } {
  const title = "New step";
  const id = newStepId(title, definition.steps);
  const step: WorkflowStep = {
    id,
    title,
    agent: null,
    model: null,
    instructions: "",
    doneWhen: "",
    dependsOn: [],
    position,
  };
  return { definition: { ...definition, steps: [...definition.steps, step] }, id };
}

/** Removes a step and every wait on it. */
export function removeStep(definition: WorkflowDefinition, id: WorkflowStepId): WorkflowDefinition {
  return {
    ...definition,
    steps: definition.steps.flatMap((step) =>
      step.id === id
        ? []
        : step.dependsOn.includes(id)
          ? [{ ...step, dependsOn: step.dependsOn.filter((dependency) => dependency !== id) }]
          : [step],
    ),
  };
}

export function updateStep(
  definition: WorkflowDefinition,
  id: WorkflowStepId,
  change: (step: WorkflowStep) => WorkflowStep,
): WorkflowDefinition {
  return {
    ...definition,
    steps: definition.steps.map((step) => (step.id === id ? change(step) : step)),
  };
}

/**
 * Gives a step one of the user's agents. The lead's suggestion is settled, and a model the step
 * kept for it goes once the agent runs on that model itself.
 */
export function assignStepAgent(
  definition: WorkflowDefinition,
  id: WorkflowStepId,
  agent: { readonly name: string; readonly model: AgentModel | null },
): WorkflowDefinition {
  return updateStep(definition, id, ({ suggestion: _suggestion, ...step }) => ({
    ...step,
    agent: agent.name,
    model:
      step.model !== null &&
      agent.model !== null &&
      step.model.instanceId === agent.model.instanceId &&
      step.model.model === agent.model.model &&
      step.model.effort === agent.model.effort
        ? null
        : step.model,
  }));
}

/** `to` waits for `from` and gets its result; unchanged when that would make a loop. */
export function connectSteps(
  definition: WorkflowDefinition,
  from: WorkflowStepId,
  to: WorkflowStepId,
): WorkflowDefinition {
  const target = definition.steps.find((step) => step.id === to);
  if (
    target === undefined ||
    target.dependsOn.includes(from) ||
    !definition.steps.some((step) => step.id === from) ||
    wouldCreateCycle(definition.steps, from, to)
  ) {
    return definition;
  }
  return updateStep(definition, to, (step) => ({ ...step, dependsOn: [...step.dependsOn, from] }));
}

export function disconnectSteps(
  definition: WorkflowDefinition,
  from: WorkflowStepId,
  to: WorkflowStepId,
): WorkflowDefinition {
  return updateStep(definition, to, (step) => ({
    ...step,
    dependsOn: step.dependsOn.filter((dependency) => dependency !== from),
  }));
}

/**
 * Why the workflow as drawn could not run yet. The server's list is the authority once saved; this
 * one covers the edits it has not seen.
 */
/**
 * A problem as a list of the whole workflow's problems shows it. The server words a step's
 * problem as "this step", which says nothing beside another step's, so its step is named first.
 */
export function problemLine(
  problem: WorkflowProblem,
  steps: ReadonlyArray<Pick<WorkflowStep, "id" | "title">>,
): string {
  const title = steps.find((step) => step.id === problem.step)?.title.trim() ?? "";
  return title === "" || problem.message.includes(title)
    ? problem.message
    : `${title}: ${problem.message}`;
}

/**
 * What keeps unsaved edits from running, as the server will say once they are saved. `agents` is
 * the user's agents once loaded; without it the checks that need them wait.
 */
export function draftProblems(
  definition: WorkflowDefinition,
  agents?: ReadonlyArray<Pick<AgentSummary, "name" | "title" | "model">>,
): ReadonlyArray<WorkflowProblem> {
  const problems: WorkflowProblem[] = [];
  if (definition.steps.length === 0) problems.push({ step: null, message: "Add a step." });
  if (definition.lead.model === null) {
    problems.push({ step: null, message: "Choose a model for the lead." });
  }
  if (definition.lead.projectId === null) {
    problems.push({ step: null, message: "Choose the workspace the steps work in." });
  }
  for (const step of definition.steps) {
    const title = step.title.trim() || "a step";
    if (step.agent !== null) {
      const agent = agents?.find((candidate) => candidate.name === step.agent);
      if (agents !== undefined && agent === undefined) {
        problems.push({
          step: step.id,
          message: `The agent for ${title} no longer exists. Choose another.`,
        });
      } else if (agent !== undefined && step.model === null && agent.model === null) {
        problems.push({
          step: step.id,
          message: `Choose a model for ${title}. ${agent.title} has no model of its own.`,
        });
      }
      continue;
    }
    problems.push({
      step: step.id,
      message:
        step.suggestion === undefined
          ? `Choose an agent for ${title}.`
          : `Create the ${step.suggestion.title} agent for ${title}, or choose one of yours.`,
    });
  }
  return problems;
}

/**
 * A suggested agent the user already made, such as before a reload dropped the unsaved edits,
 * does the step: offering to create it again would only fail on its taken name.
 */
export function withMadeAgents(
  definition: WorkflowDefinition,
  agents: ReadonlyArray<Pick<AgentSummary, "name">>,
): WorkflowDefinition {
  return {
    ...definition,
    steps: definition.steps.map((step) => {
      if (step.agent !== null || step.suggestion === undefined) return step;
      const name = skillNameFromTitle(step.suggestion.title);
      const made = agents.find((agent) => agent.name === name);
      return made === undefined ? step : { ...step, agent: made.name };
    }),
  };
}

export interface WorkflowSaveIssue {
  /** The step it is about; null for the whole workflow. */
  readonly step: WorkflowStepId | null;
  readonly message: string;
}

function trimmedInputs(inputs: ReadonlyArray<WorkflowInput>): ReadonlyArray<WorkflowInput> {
  return inputs.map((input) => ({ name: input.name.trim(), value: input.value }));
}

function isTimeZone(timeZone: string): boolean {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone !== "";
  } catch {
    return false;
  }
}

/** The workflow to save, named after its title, or what keeps it from saving. */
export function checkWorkflow(
  definition: WorkflowDefinition,
  takenNames: ReadonlyArray<string>,
):
  | { readonly workflow: WorkflowDefinition; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<WorkflowSaveIssue> } {
  const issues: WorkflowSaveIssue[] = [];
  const whole = (message: string) => issues.push({ step: null, message });
  const title = definition.title.trim();
  if (title === "") whole("Give the workflow a name.");
  else if (title.length > TITLE_MAX) whole("Use a shorter name.");
  else if (skillNameFromTitle(title) === "") whole("Use letters or numbers in the name.");
  if (definition.description.length > DESCRIPTION_MAX) whole("Shorten the description.");
  if (definition.lead.goal.length > GOAL_MAX) {
    whole(`Keep the outcome under ${GOAL_MAX.toLocaleString("en-US")} characters.`);
  }
  if (definition.steps.length > WORKFLOW_STEP_LIMIT) {
    whole(`A workflow has at most ${WORKFLOW_STEP_LIMIT} steps.`);
  }
  for (const step of definition.steps) {
    const name = step.title.trim();
    if (name === "") issues.push({ step: step.id, message: "Give every step a name." });
    else if (name.length > TITLE_MAX) {
      issues.push({ step: step.id, message: `Use a shorter name for ${name}.` });
    }
    if (step.instructions.length > INSTRUCTIONS_MAX) {
      issues.push({ step: step.id, message: `Shorten what ${name || "the step"} does each run.` });
    }
    if (step.doneWhen.length > DONE_WHEN_MAX) {
      issues.push({ step: step.id, message: `Shorten the Done when line of ${name || "a step"}.` });
    }
  }
  const loop = findCycle(definition.steps);
  if (loop !== null) {
    const titles = loop.map(
      (id) => definition.steps.find((step) => step.id === id)?.title.trim() || id,
    );
    whole(`${titles.join(", ")} wait for each other. Remove one of the arrows between them.`);
  }
  const schedule = definition.trigger.schedule;
  if (schedule !== null) {
    if (schedule.days.length === 0) whole("Choose at least one day for the schedule.");
    if (!/^([01]\d|2[0-3]):[0-5]\d$/u.test(schedule.time)) whole("Set a time for the schedule.");
    if (!isTimeZone(schedule.timeZone)) whole("Choose a time zone for the schedule.");
  }
  const inputs = trimmedInputs(definition.inputs);
  if (inputs.length > WORKFLOW_INPUT_LIMIT) {
    whole(`A workflow has at most ${WORKFLOW_INPUT_LIMIT} inputs.`);
  }
  if (inputs.some((input) => input.name === "")) whole("Give every input a name.");
  if (inputs.some((input) => input.name.length > INPUT_NAME_MAX)) whole("Shorten an input's name.");
  if (inputs.some((input) => input.value.length > INPUT_VALUE_MAX)) {
    whole("Shorten an input's value.");
  }
  const names = inputs.map((input) => input.name.toLowerCase());
  if (new Set(names).size !== names.length) whole("Give each input its own name.");
  const { spendUsd, minutes } = definition.lead.limits;
  if (spendUsd !== null && !(spendUsd > 0)) whole("Set a spending limit above $0, or none.");
  if (minutes !== null && !(Number.isInteger(minutes) && minutes > 0)) {
    whole("Set a time limit in whole minutes, or none.");
  }
  const name = workflowSaveName(definition, takenNames);
  if (issues.length > 0 || name === null) return { issues };
  return {
    workflow: {
      ...definition,
      name,
      title,
      inputs,
      steps: definition.steps.map((step) => ({ ...step, title: step.title.trim() })),
    },
  };
}

/** What the user changed and what it started from, kept while they leave the editor and return. */
export interface WorkflowEdit {
  readonly definition: WorkflowDefinition;
  readonly notes: string;
  readonly base: {
    readonly definition: WorkflowDefinition;
    readonly notes: string;
    /** The saved workflow's `updatedAt`; null for a workflow not saved yet. */
    readonly updatedAt: string | null;
  };
  /** The chat draft these edits apply; saving records it on the chat. */
  readonly fromDraft?: WorkflowDraftRef;
}

export interface ResolvedWorkflowEdit {
  readonly definition: WorkflowDefinition;
  readonly notes: string;
  readonly dirty: boolean;
  /** The workflow was saved elsewhere since these edits began; saving replaces that version. */
  readonly overtaken: boolean;
}

// Definitions are bounded by the contract's limits, so comparing their JSON stays cheap.
function sameJson(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The edits over the saved workflow, or over a new one's start; clean edits give way to a newer
 * saved version, or to a newer draft from the chat `start` was made from.
 */
export function resolveWorkflowEdit(
  saved: {
    readonly definition: WorkflowDefinition;
    readonly notes: string;
    readonly updatedAt: string;
  } | null,
  start: WorkflowDefinition,
  edit: WorkflowEdit | null,
  draft: WorkflowDraftRef | null = null,
): ResolvedWorkflowEdit {
  const base = saved ?? { definition: start, notes: "", updatedAt: null };
  if (edit === null) {
    return { definition: base.definition, notes: base.notes, dirty: false, overtaken: false };
  }
  const dirty = !sameJson(edit.definition, edit.base.definition) || edit.notes !== edit.base.notes;
  const moved =
    saved !== null
      ? edit.base.updatedAt !== saved.updatedAt
      : draft !== null && edit.fromDraft?.proposedAt !== draft.proposedAt;
  if (moved && !dirty) {
    return { definition: base.definition, notes: base.notes, dirty: false, overtaken: false };
  }
  return { definition: edit.definition, notes: edit.notes, dirty, overtaken: moved };
}

/**
 * The chat draft a save records. Edits that changed something, or gave way to a newer version,
 * record only the draft they began on, so a newer draft is never marked saved.
 */
export function workflowSaveDraft(
  shown: ResolvedWorkflowEdit,
  edit: WorkflowEdit | null,
  draft: WorkflowDraftRef | null,
): WorkflowDraftRef | null {
  return shown.dirty || shown.overtaken
    ? (edit?.fromDraft ?? null)
    : (draft ?? edit?.fromDraft ?? null);
}

/**
 * Applies a change to the edits, starting them from what is shown when there are none yet. Edits
 * begun on a chat's draft keep naming that draft, so saving them never marks a newer one saved.
 */
export function changeWorkflowEdit(
  shown: ResolvedWorkflowEdit,
  saved: { readonly updatedAt: string } | null,
  edit: WorkflowEdit | null,
  change: { readonly definition?: WorkflowDefinition; readonly notes?: string },
  draft: WorkflowDraftRef | null = null,
): WorkflowEdit {
  const keep = edit !== null && (shown.dirty || shown.overtaken);
  const base = keep
    ? edit.base
    : {
        definition: shown.definition,
        notes: shown.notes,
        updatedAt: saved?.updatedAt ?? null,
      };
  const fromDraft = keep ? edit.fromDraft : (draft ?? edit?.fromDraft);
  return {
    definition: change.definition ?? shown.definition,
    notes: change.notes ?? shown.notes,
    base,
    ...(fromDraft === undefined ? {} : { fromDraft }),
  };
}

export const WEEKDAYS = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
] as const satisfies ReadonlyArray<WorkflowWeekday>;

export const WEEKDAY_NAMES: Record<WorkflowWeekday, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

export const WEEKDAY_SHORT: Record<WorkflowWeekday, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

function joinWords(words: ReadonlyArray<string>): string {
  return words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** "9:00", or "9:00 AM" on a 12-hour clock. */
function formatClock(hours: number, minutes: number, hour12: boolean): string {
  const mm = String(minutes).padStart(2, "0");
  if (!hour12) return `${hours}:${mm}`;
  return `${hours % 12 === 0 ? 12 : hours % 12}:${mm} ${hours < 12 ? "AM" : "PM"}`;
}

interface ZonedParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function zonedParts(instantMs: number, timeZone: string): ZonedParts {
  let formatter = partsFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    partsFormatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(instantMs);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((entry) => entry.type === type)?.value ?? 0);
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour") % 24,
    minute: part("minute"),
  };
}

function offsetAt(instantMs: number, timeZone: string): number {
  const parts = zonedParts(instantMs, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return asUtc - Math.floor(instantMs / MINUTE_MS) * MINUTE_MS;
}

/**
 * When a wall-clock time happens in a time zone, as the server's scheduler decides: a time a clock
 * change repeats at its first occurrence, a time it skips at the first minute after the gap.
 */
function zonedInstant(
  date: { readonly year: number; readonly month: number; readonly day: number },
  hours: number,
  minutes: number,
  timeZone: string,
): number {
  const wall = Date.UTC(date.year, date.month - 1, date.day, hours, minutes);
  const wallOf = (instantMs: number) => instantMs + offsetAt(instantMs, timeZone);
  // A clock change shifts the offset at most once a day, so the offsets half a day either side
  // give every reading the wall time can have.
  const readings = [
    wall - offsetAt(wall - DAY_MS / 2, timeZone),
    wall - offsetAt(wall + DAY_MS / 2, timeZone),
  ].toSorted((a, b) => a - b);
  const exact = readings.find((reading) => wallOf(reading) === wall);
  if (exact !== undefined) return exact;
  let instant = readings[0] ?? wall;
  for (let step = 0; step < 24 * 60 && wallOf(instant) < wall; step++) instant += MINUTE_MS;
  return instant;
}

const WEEKDAY_BY_UTC_DAY: ReadonlyArray<WorkflowWeekday> = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
];

/** The next `count` scheduled runs after `fromMs`, as epoch milliseconds. */
export function upcomingRuns(
  schedule: WorkflowSchedule,
  fromMs: number,
  count: number,
): ReadonlyArray<number> {
  if (schedule.days.length === 0 || !isTimeZone(schedule.timeZone)) return [];
  const [hours = 0, minutes = 0] = schedule.time.split(":").map(Number);
  const today = zonedParts(fromMs, schedule.timeZone);
  const runs: number[] = [];
  for (let offset = 0; runs.length < count && offset <= 7 * count + 7; offset++) {
    // Calendar days counted in UTC, so a 23- or 25-hour day never skips or repeats a date.
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    const weekday = WEEKDAY_BY_UTC_DAY[date.getUTCDay()];
    if (weekday === undefined || !schedule.days.includes(weekday)) continue;
    const instant = zonedInstant(
      { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() },
      hours,
      minutes,
      schedule.timeZone,
    );
    if (instant > fromMs) runs.push(instant);
  }
  return runs;
}

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

/** "Mon 23 Nov", with the year when it is not this year's. */
export function formatDay(instantMs: number, options: FormatOptions): string {
  const timeZone = options.timeZone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const withYear =
    zonedParts(instantMs, timeZone).year !== zonedParts(options.nowMs, timeZone).year;
  const key = `${timeZone}:${withYear}`;
  let formatter = dayFormatters.get(key);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      weekday: "short",
      day: "numeric",
      month: "short",
      ...(withYear ? { year: "numeric" } : {}),
    });
    dayFormatters.set(key, formatter);
  }
  return formatter.format(instantMs).replace(",", "");
}

export interface FormatOptions {
  readonly nowMs: number;
  readonly hour12: boolean;
  /** Defaults to the browser's. */
  readonly timeZone?: string | undefined;
}

export function formatTime(instantMs: number, options: FormatOptions): string {
  const timeZone = options.timeZone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = zonedParts(instantMs, timeZone);
  return formatClock(parts.hour, parts.minute, options.hour12);
}

/** "today", "tomorrow", "yesterday", or "Mon 23 Nov". */
function relativeDay(instantMs: number, options: FormatOptions): string {
  const timeZone = options.timeZone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dayIndex = (ms: number) => {
    const parts = zonedParts(ms, timeZone);
    return Date.UTC(parts.year, parts.month - 1, parts.day) / DAY_MS;
  };
  const difference = dayIndex(instantMs) - dayIndex(options.nowMs);
  if (difference === 0) return "today";
  if (difference === 1) return "tomorrow";
  if (difference === -1) return "yesterday";
  return formatDay(instantMs, options);
}

/** "today at 8:06", "Mon 9 Nov at 9:00". */
export function formatWhen(instantMs: number, options: FormatOptions): string {
  return `${relativeDay(instantMs, options)} at ${formatTime(instantMs, options)}`;
}

/** "today at 8:06" near now, else the day alone: "Mon 9 Nov". */
export function formatRecent(instantMs: number, options: FormatOptions): string {
  const day = relativeDay(instantMs, options);
  return day === "today" || day === "yesterday" || day === "tomorrow"
    ? `${day} at ${formatTime(instantMs, options)}`
    : day;
}

/**
 * "Next: Mon 23 Nov, Mon 30 Nov, Mon 7 Dec, all at 9:00." in the schedule's own time zone, its
 * time written as the schedule's wording writes it.
 */
export function upcomingRunsLine(
  schedule: WorkflowSchedule,
  nowMs: number,
  hour12: boolean,
): string | null {
  const runs = upcomingRuns(schedule, nowMs, 3);
  if (runs.length === 0) return null;
  const options = { nowMs, hour12, timeZone: schedule.timeZone };
  if (runs.length === 1) return `Next: ${formatWhen(runs[0] ?? nowMs, options)}.`;
  const clock = schedule.time.replace(/^0(?=\d)/u, "");
  return `Next: ${runs.map((run) => relativeDay(run, options)).join(", ")}, all at ${clock}.`;
}

/** "21 min", "1 h 5 min", "under a minute". */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / MINUTE_MS);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatCost(costUsd: number): string {
  return usd.format(costUsd);
}

/** "$0.34 of $2.00", or the cost alone without a limit; null while the cost is unknown. */
export function costLine(costUsd: number | null, limitUsd: number | null): string | null {
  if (costUsd === null) return limitUsd === null ? null : `Limit ${formatCost(limitUsd)}`;
  return limitUsd === null
    ? formatCost(costUsd)
    : `${formatCost(costUsd)} of ${formatCost(limitUsd)}`;
}

export type WorkflowRunStatus = "running" | "waiting" | "done" | "failed" | "stopped";

export const RUN_STATUS_LABELS: Record<WorkflowRunStatus, string> = {
  running: "Running",
  waiting: "Waiting for you",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

/** Where a run stands; it waits for the user on a hold or when one of its steps asks something. */
export function workflowRunStatus(
  plan: { readonly status: TeamPlanStatus; readonly hold?: TeamPlanHold | undefined },
  stepWaitsForUser: boolean,
): WorkflowRunStatus {
  switch (plan.status) {
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "stopped";
    case "proposed":
    case "running":
      return plan.hold !== undefined || stepWaitsForUser ? "waiting" : "running";
  }
}

export type WorkflowCardStatus = "on" | "off" | "manual" | "running" | "waiting" | "failed";

export const CARD_STATUS_LABELS: Record<WorkflowCardStatus, string> = {
  on: "On",
  off: "Off",
  manual: "When you start it",
  running: "Running",
  waiting: "Waiting for you",
  failed: "Last run failed",
};

/** What a workflow's card leads with: its latest run while it needs watching, else its schedule. */
export function workflowCardStatus(
  workflow: Pick<WorkflowSummary, "enabled" | "trigger">,
  latestRun: WorkflowRunStatus | null,
): WorkflowCardStatus {
  if (latestRun === "running" || latestRun === "waiting") return latestRun;
  if (latestRun === "failed") return "failed";
  if (workflow.trigger.schedule === null) return "manual";
  return workflow.enabled ? "on" : "off";
}

/** How a run started: "You started it", "On schedule", or that it ran late. */
export function runStartLine(
  run: { readonly trigger: WorkflowRunTrigger; readonly scheduledFor: string | null },
  options: FormatOptions,
): string {
  switch (run.trigger) {
    case "manual":
      return "You started it";
    case "schedule":
      return "On schedule";
    case "missed": {
      const scheduled = run.scheduledFor === null ? Number.NaN : Date.parse(run.scheduledFor);
      return Number.isNaN(scheduled)
        ? "Ran late, when Codenine was back"
        : `Missed ${formatWhen(scheduled, options)}, ran when Codenine was back`;
    }
  }
}

export type StepRunKind =
  | "waiting"
  | "not-started"
  | "working"
  | "checking"
  | "needs-you"
  | "done"
  | "failed"
  | "stopped";

export interface StepRunState {
  readonly kind: StepRunKind;
  readonly label: string;
  /** How many times the lead sent the step back. */
  readonly sentBack: number;
}

function sentBackLine(times: number): string {
  return times === 1 ? "sent back once" : `sent back ${times} times`;
}

/** A run's step as the canvas shows it. */
export function stepRunState(
  planStatus: TeamPlanStatus,
  task: Pick<TeamTask, "status" | "review" | "startedAt" | "completedAt">,
  waitsForUser: boolean,
): StepRunState {
  const sentBack = Math.max(0, (task.review?.round ?? 1) - 1);
  const state = (kind: StepRunKind, label: string): StepRunState => ({
    kind,
    label: sentBack === 0 ? label : `${label} · ${sentBackLine(sentBack)}`,
    sentBack,
  });
  if (task.status === "failed") return state("failed", "Failed");
  if (task.status === "cancelled") return state("stopped", "Stopped");
  if (waitsForUser && (task.status === "running" || task.review?.awaiting === true)) {
    return state("needs-you", "Waiting for you");
  }
  if (task.review?.awaiting === true) return state("checking", "The lead is checking");
  if (task.status === "completed") {
    const started = task.startedAt === null ? Number.NaN : Date.parse(task.startedAt);
    const completed = task.completedAt === null ? Number.NaN : Date.parse(task.completedAt);
    return state(
      "done",
      Number.isNaN(started) || Number.isNaN(completed)
        ? "Done"
        : `Done · ${formatDuration(completed - started)}`,
    );
  }
  if (task.status === "running") return state("working", "Working");
  return planStatus === "running"
    ? state("waiting", "Waiting")
    : state("not-started", "Not started");
}

/** What the lead is doing, for the frame around a run's steps. */
export function leadActivity(
  plan: Pick<TeamPlan, "status" | "hold" | "tasks">,
  titleOf: (task: TeamTask) => string,
): string {
  const checking = plan.tasks.filter((task) => task.review?.awaiting === true).map(titleOf);
  switch (plan.status) {
    case "completed":
      return "finished the run";
    case "failed":
      return "the run failed";
    case "cancelled":
      return "the run was stopped";
    case "proposed":
    case "running":
      break;
  }
  switch (plan.hold?.reason) {
    case "spend":
      return "stopped at the spending limit, waiting for you";
    case "unpriced":
      return "stopped because the run's cost can't be estimated, waiting for you";
    case "time":
      return "stopped at the time limit, waiting for you";
    case "review":
      return checking.length === 0
        ? "waiting for you"
        : `waiting for you to decide on ${joinWords(checking)}`;
    case undefined:
      return checking.length === 0
        ? "hands out the steps"
        : `checking ${joinWords(checking.map((title) => `${title}'s result`))}`;
  }
}

/**
 * The limits a run goes on with after stopping at one: what it has used so far plus the amount it
 * started with (the workflow's own when it has one). A step already working when the run stopped
 * can finish past the limit, so raising the limit itself could leave the run stopped again. A run
 * that cannot be priced goes on without its spending limit, which could not stop it anyway.
 */
export function raisedLimits(
  run: WorkflowLimits,
  workflow: WorkflowLimits | null,
  reason: "spend" | "unpriced" | "time",
  used: { readonly costUsd: number | null; readonly minutes: number },
): WorkflowLimits {
  if (reason === "unpriced") return { ...run, spendUsd: null };
  if (reason === "spend") {
    const current = run.spendUsd;
    if (current === null) return run;
    const step = workflow?.spendUsd ?? current;
    const from = Math.max(current, used.costUsd ?? current);
    return { ...run, spendUsd: Math.ceil((from + step) * 100) / 100 };
  }
  const current = run.minutes;
  if (current === null) return run;
  return {
    ...run,
    minutes: Math.max(current, Math.ceil(used.minutes)) + (workflow?.minutes ?? current),
  };
}

/** What going on changes, for its button: "up to $2.00", "up to 1 h", "without a spending limit". */
export function raisedLimitLine(
  run: WorkflowLimits,
  raised: WorkflowLimits,
  reason: "spend" | "unpriced" | "time",
): string | null {
  if (reason === "unpriced") return "without a spending limit";
  if (reason === "spend") {
    return run.spendUsd === null || raised.spendUsd === null
      ? null
      : `up to ${formatCost(raised.spendUsd)}`;
  }
  return run.minutes === null || raised.minutes === null
    ? null
    : `up to ${formatDuration(raised.minutes * MINUTE_MS)}`;
}

/** A workflow run as thread lists know it, from the lead's shell without its plan. */
export interface WorkflowRun {
  readonly threadId: ThreadId;
  readonly workflowId: WorkflowId;
  readonly workflowName: string;
  readonly title: string;
  readonly run: number;
  readonly trigger: WorkflowRunTrigger;
  readonly scheduledFor: string | null;
  readonly startedAt: string;
  readonly costUsd: number | null;
  readonly headline: string | null;
  readonly status: WorkflowRunStatus;
  readonly hold: TeamPlanHold | null;
  /** When it finished; null while it runs. */
  readonly endedAt: string | null;
  /** The chat the run reports to; null on runs started before runs had a chat. */
  readonly chatThreadId: ThreadId | null;
}

type RunShell = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "deletedAt"
  | "updatedAt"
  | "latestRun"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
> & {
  readonly source: Pick<
    OrchestrationV2ThreadShell,
    "teamSummary" | "teamTask" | "pendingConnectorApproval"
  >;
};

/** Whether a thread waits for the user: a provider's approval or question, or a connector's. */
export function threadWaitsForUser(
  shell: Pick<RunShell, "hasPendingApprovals" | "hasPendingUserInput" | "source">,
): boolean {
  return (
    shell.hasPendingApprovals ||
    shell.hasPendingUserInput ||
    shell.source.pendingConnectorApproval === true
  );
}

/** A machine's workflow runs, newest first, read from thread shells only. */
export function workflowRunsOf(
  shells: ReadonlyArray<RunShell>,
  environmentId: EnvironmentId,
): ReadonlyArray<WorkflowRun> {
  const waiting = new Set<ThreadId>();
  for (const shell of shells) {
    const task = shell.source.teamTask;
    if (shell.environmentId === environmentId && task !== undefined && threadWaitsForUser(shell)) {
      waiting.add(task.rootThreadId);
    }
  }
  return shells
    .flatMap((shell): WorkflowRun[] => {
      const summary = shell.source.teamSummary;
      const run = summary?.run;
      if (
        shell.environmentId !== environmentId ||
        shell.deletedAt !== null ||
        summary === undefined ||
        run === undefined
      ) {
        return [];
      }
      const status = workflowRunStatus(summary, waiting.has(shell.id));
      const finished = status === "done" || status === "failed" || status === "stopped";
      return [
        {
          threadId: shell.id,
          workflowId: run.workflowId,
          workflowName: run.workflowName,
          title: run.title,
          run: run.run,
          trigger: run.trigger,
          scheduledFor: run.scheduledFor,
          startedAt: run.startedAt,
          costUsd: run.costUsd,
          headline: run.headline,
          status,
          hold: summary.hold ?? null,
          endedAt: finished ? (shell.latestRun?.completedAt ?? shell.updatedAt) : null,
          chatThreadId: run.chatThreadId ?? null,
        },
      ];
    })
    .toSorted((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || b.run - a.run);
}

/** Where a run's steps sit: as on the workflow's canvas while it still has them all, else laid out. */
export function runStepPositions(
  tasks: ReadonlyArray<Pick<TeamTask, "id" | "dependsOn">>,
  steps: ReadonlyArray<Pick<WorkflowStep, "id" | "position">>,
): ReadonlyMap<string, WorkflowPosition> {
  const saved = new Map<string, WorkflowPosition>(steps.map((step) => [step.id, step.position]));
  if (tasks.every((task) => saved.has(task.id))) return saved;
  // A task's id is its step's id, so a run lays out like the workflow it came from.
  return layoutSteps(
    tasks.map((task) => ({
      id: task.id as string as WorkflowStepId,
      dependsOn: task.dependsOn.map((dependency) => dependency as string as WorkflowStepId),
    })),
  );
}

/** How long a run took, or has taken so far. */
export function runDurationMs(
  run: Pick<WorkflowRun, "startedAt" | "endedAt">,
  nowMs: number,
): number | null {
  const started = Date.parse(run.startedAt);
  const ended = run.endedAt === null ? nowMs : Date.parse(run.endedAt);
  return Number.isNaN(started) || Number.isNaN(ended) ? null : Math.max(0, ended - started);
}

export type WorkflowHistoryRow =
  | { readonly kind: "run"; readonly run: WorkflowRun }
  | { readonly kind: "skipped"; readonly scheduledFor: string };

/** Runs and the scheduled runs Codenine skipped, newest first. */
export function workflowHistoryRows(
  runs: ReadonlyArray<WorkflowRun>,
  skipped: ReadonlyArray<{ readonly scheduledFor: string }>,
): ReadonlyArray<WorkflowHistoryRow> {
  const rows: Array<{ readonly at: number; readonly row: WorkflowHistoryRow }> = [
    ...runs.map((run) => ({ at: Date.parse(run.startedAt), row: { kind: "run", run } as const })),
    ...skipped.map((entry) => ({
      at: Date.parse(entry.scheduledFor),
      row: { kind: "skipped", scheduledFor: entry.scheduledFor } as const,
    })),
  ];
  return rows.toSorted((a, b) => b.at - a.at).map((entry) => entry.row);
}

/** "12 runs since 31 Aug · $6.22 spent". */
export function runsSummaryLine(
  runs: ReadonlyArray<Pick<WorkflowRun, "startedAt" | "costUsd">>,
  options: FormatOptions,
): string | null {
  const first = runs.reduce<number | null>((earliest, run) => {
    const at = Date.parse(run.startedAt);
    return Number.isNaN(at) || (earliest !== null && earliest <= at) ? earliest : at;
  }, null);
  if (first === null) return null;
  const spent = runs.reduce((total, run) => total + (run.costUsd ?? 0), 0);
  const count = runs.length === 1 ? "1 run" : `${runs.length} runs`;
  const since = formatDay(first, options).replace(/^\w+ /u, "");
  return spent > 0
    ? `${count} since ${since} · ${formatCost(spent)} spent`
    : `${count} since ${since}`;
}
