import {
  TEAM_BRIEF_MAX_CHARS,
  TEAM_LABEL_MAX_CHARS,
  TEAM_MAX_AGENTS,
  TEAM_MAX_TASKS,
  type TeamAgent,
  type TeamDraft,
  type TeamPlan,
  type TeamPlanSummary,
  type TeamTask,
} from "@codenine/contracts";

export interface TeamDraftIssue {
  readonly reason:
    | "empty"
    | "too_large"
    | "text_too_long"
    | "duplicate_id"
    | "unknown_agent"
    | "unknown_dependency"
    | "dependency_cycle";
  readonly message: string;
}

function duplicate(ids: ReadonlyArray<string>): string | undefined {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) return id;
    seen.add(id);
  }
  return undefined;
}

interface DependencyNode<Id extends string> {
  readonly id: Id;
  readonly dependsOn: ReadonlyArray<Id>;
}

function dependencyCycle<Id extends string>(
  tasks: ReadonlyArray<DependencyNode<Id>>,
): ReadonlyArray<Id> | undefined {
  const dependencies = new Map(tasks.map((task) => [task.id, task.dependsOn]));
  const settled = new Set<Id>();
  const path: Array<Id> = [];
  const visit = (id: Id): ReadonlyArray<Id> | undefined => {
    if (settled.has(id)) return undefined;
    const start = path.indexOf(id);
    if (start !== -1) return [...path.slice(start), id];
    path.push(id);
    for (const dependency of dependencies.get(id) ?? []) {
      const cycle = visit(dependency);
      if (cycle !== undefined) return cycle;
    }
    path.pop();
    settled.add(id);
    return undefined;
  };
  for (const task of tasks) {
    const cycle = visit(task.id);
    if (cycle !== undefined) return cycle;
  }
  return undefined;
}

/** The first problem that keeps a draft from becoming a plan, or null when it can. */
export function validateTeamDraft(draft: TeamDraft): TeamDraftIssue | null {
  const { agents, tasks } = draft;
  if (agents.length === 0 || tasks.length === 0) {
    return { reason: "empty", message: "A team needs at least one agent and one task." };
  }
  if (agents.length > TEAM_MAX_AGENTS) {
    return {
      reason: "too_large",
      message: `A team has at most ${TEAM_MAX_AGENTS} agents; this one has ${agents.length}.`,
    };
  }
  if (tasks.length > TEAM_MAX_TASKS) {
    return {
      reason: "too_large",
      message: `A team has at most ${TEAM_MAX_TASKS} tasks; this one has ${tasks.length}.`,
    };
  }
  const duplicateAgent = duplicate(agents.map((agent) => agent.id));
  if (duplicateAgent !== undefined) {
    return { reason: "duplicate_id", message: `Agent id "${duplicateAgent}" is used twice.` };
  }
  const duplicateTask = duplicate(tasks.map((task) => task.id));
  if (duplicateTask !== undefined) {
    return { reason: "duplicate_id", message: `Task id "${duplicateTask}" is used twice.` };
  }
  for (const agent of agents) {
    if (agent.label.length > TEAM_LABEL_MAX_CHARS) {
      return {
        reason: "text_too_long",
        message: `The label of agent "${agent.id}" is longer than ${TEAM_LABEL_MAX_CHARS} characters.`,
      };
    }
  }
  const agentIds = new Set<string>(agents.map((agent) => agent.id));
  const taskIds = new Set<string>(tasks.map((task) => task.id));
  for (const task of tasks) {
    if (task.title.length > TEAM_LABEL_MAX_CHARS) {
      return {
        reason: "text_too_long",
        message: `The title of task "${task.id}" is longer than ${TEAM_LABEL_MAX_CHARS} characters.`,
      };
    }
    if (task.brief.length > TEAM_BRIEF_MAX_CHARS) {
      return {
        reason: "text_too_long",
        message: `The brief of task "${task.id}" is ${task.brief.length} characters; the limit is ${TEAM_BRIEF_MAX_CHARS}.`,
      };
    }
    if (!agentIds.has(task.agentId)) {
      return {
        reason: "unknown_agent",
        message: `Task "${task.id}" names agent "${task.agentId}", which is not on the team.`,
      };
    }
    const missing = task.dependsOn.find((dependency) => !taskIds.has(dependency));
    if (missing !== undefined) {
      return {
        reason: "unknown_dependency",
        message: `Task "${task.id}" depends on "${missing}", which is not a task in this plan.`,
      };
    }
  }
  const cycle = dependencyCycle(tasks);
  if (cycle !== undefined) {
    return {
      reason: "dependency_cycle",
      message: `Tasks depend on each other in a cycle: ${cycle.join(" -> ")}.`,
    };
  }
  return null;
}

/** The first duplicate id, unknown dependency or cycle among a workflow's steps, or null. */
export function workflowStepsIssue<Id extends string>(
  steps: ReadonlyArray<DependencyNode<Id>>,
): string | null {
  const duplicateStep = duplicate(steps.map((step) => step.id));
  if (duplicateStep !== undefined) return `Step id "${duplicateStep}" is used twice.`;
  const stepIds = new Set<string>(steps.map((step) => step.id));
  for (const step of steps) {
    const missing = step.dependsOn.find((dependency) => !stepIds.has(dependency));
    if (missing !== undefined) {
      return `Step "${step.id}" depends on "${missing}", which is not a step of this workflow.`;
    }
  }
  const cycle = dependencyCycle(steps);
  return cycle === undefined
    ? null
    : `Steps depend on each other in a cycle: ${cycle.join(" -> ")}.`;
}

/** What a lead proposes work for: a team's member or a workflow's step. */
type ProposedPart = "member" | "step";

/** For a lead whose proposed member or step is not exactly one of the user's agents or a suggestion. */
export function teamMemberChoiceMessage(id: string, part: ProposedPart = "member"): string {
  return `${part === "member" ? "Member" : "Step"} "${id}" needs exactly one of \`agent\` (one of the user's agents, from \`orchestrator_capabilities\` \`agents\`) or \`suggestion\` (an agent for the user to create when none of theirs fits).`;
}

/** For a lead whose proposed member or step names an agent the user does not have. */
export function unknownTeamAgentMessage(
  id: string,
  name: string,
  part: ProposedPart = "member",
): string {
  return `The user has no agent named "${name}". Use a \`name\` from \`orchestrator_capabilities\` \`agents\`, or give ${part} "${id}" a \`suggestion\` for the user to create.`;
}

/** Members the lead suggested whose agent the user has not created or chosen; the team waits for them. */
export function teamMembersWithoutAgent(
  draft: Pick<TeamDraft, "agents">,
): ReadonlyArray<TeamAgent> {
  return draft.agents.filter(
    (agent) => agent.suggestion !== undefined && agent.agent === undefined,
  );
}

type SchedulablePlan = Pick<TeamPlan, "agents" | "tasks" | "maxParallelPerProvider">;

/**
 * Pending tasks whose dependencies are all completed, in plan order, as many as fit under
 * `maxParallelPerProvider` running tasks per provider instance.
 */
export function startableTeamTasks(plan: SchedulablePlan): ReadonlyArray<TeamTask> {
  const instanceByAgent = new Map(
    plan.agents.map((agent) => [agent.id, agent.modelSelection.instanceId]),
  );
  const completed = new Set(
    plan.tasks.filter((task) => task.status === "completed").map((task) => task.id),
  );
  const running = new Map<string, number>();
  for (const task of plan.tasks) {
    const instanceId = instanceByAgent.get(task.agentId);
    if (task.status !== "running" || instanceId === undefined) continue;
    running.set(instanceId, (running.get(instanceId) ?? 0) + 1);
  }
  const startable: Array<TeamTask> = [];
  for (const task of plan.tasks) {
    const instanceId = instanceByAgent.get(task.agentId);
    if (
      task.status !== "pending" ||
      instanceId === undefined ||
      !task.dependsOn.every((dependency) => completed.has(dependency))
    ) {
      continue;
    }
    const count = running.get(instanceId) ?? 0;
    if (count >= plan.maxParallelPerProvider) continue;
    running.set(instanceId, count + 1);
    startable.push(task);
  }
  return startable;
}

/** Where an approved plan stands: done, still able to progress, or stuck on a task that did not complete. */
export function settledTeamPlanStatus(plan: SchedulablePlan): "running" | "completed" | "failed" {
  if (plan.tasks.every((task) => task.status === "completed")) return "completed";
  if (plan.tasks.some((task) => task.status === "running")) return "running";
  return startableTeamTasks(plan).length > 0 ? "running" : "failed";
}

/** A workflow step whose run ended and whose result waits for the lead to accept or send back. */
export function isAwaitingReview(task: Pick<TeamTask, "status" | "review">): boolean {
  return task.status === "running" && task.review?.awaiting === true;
}

/**
 * What a thread list shows of a plan: its state and how many tasks reached each status. A step
 * awaiting review still counts as running.
 */
export function teamPlanSummary(
  plan: Pick<TeamPlan, "id" | "status" | "revision" | "tasks" | "run" | "hold">,
): TeamPlanSummary {
  const counts = { completed: 0, failed: 0, running: 0, cancelled: 0 };
  for (const task of plan.tasks) {
    if (task.status !== "pending") counts[task.status] += 1;
  }
  const summary = {
    planId: plan.id,
    status: plan.status,
    revision: plan.revision,
    total: plan.tasks.length,
    ...counts,
  };
  if (plan.run === undefined) return summary;
  const { inputs: _inputs, limits: _limits, note: _note, ...run } = plan.run;
  return {
    ...summary,
    run,
    ...(plan.hold === undefined ? {} : { hold: plan.hold }),
    awaitingReview: plan.tasks.filter(isAwaitingReview).length,
  };
}
