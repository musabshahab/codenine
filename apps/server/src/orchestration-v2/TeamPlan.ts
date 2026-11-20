import {
  TEAM_BRIEF_MAX_CHARS,
  TEAM_DEFAULT_MAX_PARALLEL_PER_PROVIDER,
  TEAM_RESULT_MAX_CHARS,
  type OrchestrationV2AppThread,
  type OrchestrationV2ServerCommand,
  type TeamAgent,
  type TeamDraft,
  type TeamPlan,
  type TeamPlanId,
  type TeamTask,
  type TeamTaskId,
  type TeamTaskReview,
  ThreadId,
} from "@codenine/contracts";
import {
  isAwaitingReview,
  settledTeamPlanStatus,
  startableTeamTasks,
  teamMembersWithoutAgent,
  validateTeamDraft,
} from "@codenine/shared/team";

export type TeamCommand = Extract<
  OrchestrationV2ServerCommand,
  { readonly type: `team.${string}` }
>;

interface TeamEffects {
  /** Tasks this command set running; each needs its thread launched. */
  readonly launch: ReadonlyArray<TeamTask>;
  readonly stop: ReadonlyArray<ThreadId>;
  /** The plan just finished or got stuck, so the lead has results to act on. */
  readonly wakeLead: boolean;
  /** Workflow steps whose result the lead must review now, one wake each. */
  readonly reviewSteps: ReadonlyArray<TeamTask>;
  /** A step the lead sent back, to continue in its own thread with these notes. */
  readonly sendBack: { readonly task: TeamTask; readonly notes: string } | null;
  /** The plan just completed or was cancelled, so its task threads are done with. */
  readonly settleTaskThreads: boolean;
}

export type TeamDecision =
  | { readonly type: "rejected"; readonly reason: string }
  /** The command arrived too late to matter, such as a result for a task that was retried. */
  | { readonly type: "unchanged" }
  | ({ readonly type: "updated"; readonly plan: TeamPlan } & TeamEffects);

/** One thread per attempt: a retry on another model never continues the earlier session. */
export const teamTaskThreadId = (planId: TeamPlanId, taskId: TeamTaskId, attempt: number) =>
  ThreadId.make(
    ["thread", "team", planId, taskId, attempt]
      .map((part) => encodeURIComponent(String(part)))
      .join(":"),
  );

const RESULT_TRUNCATED = "\n\n[Result cut short. Read the task's thread for the rest.]";

function truncatedResult(result: string): string {
  const characters = Array.from(result);
  return characters.length <= TEAM_RESULT_MAX_CHARS
    ? result
    : `${characters.slice(0, TEAM_RESULT_MAX_CHARS).join("")}${RESULT_TRUNCATED}`;
}

const rejected = (code: string, message: string): TeamDecision => ({
  type: "rejected",
  reason: `${code}: ${message}`,
});

const NO_EFFECTS: TeamEffects = {
  launch: [],
  stop: [],
  wakeLead: false,
  reviewSteps: [],
  sendBack: null,
  settleTaskThreads: false,
};

const updated = (plan: TeamPlan, effects: Partial<TeamEffects> = {}): TeamDecision => ({
  type: "updated",
  plan,
  ...NO_EFFECTS,
  ...effects,
});

const FIRST_REVIEW: TeamTaskReview = { round: 1, awaiting: false, awaitingSince: null };

/** A workflow run's tasks start their review at round one. */
const pendingTasks = (draft: TeamDraft, reviewed: boolean): ReadonlyArray<TeamTask> =>
  draft.tasks.map((task) => ({
    ...task,
    status: "pending",
    attempt: 1,
    threadId: null,
    result: null,
    startedAt: null,
    completedAt: null,
    ...(reviewed ? { review: FIRST_REVIEW } : {}),
  }));

const withTask = (plan: TeamPlan, task: TeamTask): TeamPlan => ({
  ...plan,
  tasks: plan.tasks.map((candidate) => (candidate.id === task.id ? task : candidate)),
});

const revisionConflict = (plan: TeamPlan, expectedRevision: number) =>
  rejected(
    "team_revision_conflict",
    `The team is at revision ${plan.revision}, not ${expectedRevision}. Read it again before changing it.`,
  );

const agentNeeded = (members: ReadonlyArray<TeamAgent>) =>
  rejected(
    "team_agent_needed",
    `Create or choose an agent for ${new Intl.ListFormat("en", { type: "conjunction" }).format(
      members.map((member) => member.label),
    )} first.`,
  );

export function decideTeamCommand(input: {
  readonly thread: Pick<OrchestrationV2AppThread, "team" | "teamTask">;
  readonly command: TeamCommand;
  readonly now: string;
  /** The id a plan proposed or started by this command gets. */
  readonly newPlanId: TeamPlanId;
}): TeamDecision {
  const { command, now } = input;
  const current = input.thread.team ?? null;

  // Ends a task's attempt; a step that waited for review no longer does.
  const ended = (task: TeamTask, status: "completed" | "failed" | "cancelled"): TeamTask => ({
    ...task,
    status,
    completedAt: now,
    ...(task.review === undefined
      ? {}
      : { review: { ...task.review, awaiting: false, awaitingSince: null } }),
  });

  /**
   * Starts every task that may run now and settles the plan's status on what is left. A held run
   * starts nothing; a review hold lifts once no step awaits review, and any hold once the plan stops.
   */
  const advance = (
    plan: TeamPlan,
    wakeWhenSettled: boolean,
    effects: Partial<TeamEffects> = {},
  ): TeamDecision => {
    const { hold: currentHold, ...unheld } = plan;
    const hold =
      currentHold?.reason === "review" && !plan.tasks.some(isAwaitingReview)
        ? undefined
        : currentHold;
    const starting = new Set(
      hold === undefined ? startableTeamTasks(plan).map((task) => task.id) : [],
    );
    const tasks = plan.tasks.map((task): TeamTask =>
      starting.has(task.id)
        ? {
            ...task,
            status: "running",
            threadId: teamTaskThreadId(plan.id, task.id, task.attempt),
            startedAt: now,
            completedAt: null,
          }
        : task,
    );
    const status = settledTeamPlanStatus({ ...plan, tasks });
    return updated(
      {
        ...unheld,
        ...(hold === undefined || status !== "running" ? {} : { hold }),
        tasks,
        status,
        updatedAt: now,
      },
      {
        ...effects,
        launch: tasks.filter((task) => starting.has(task.id)),
        wakeLead: wakeWhenSettled && status !== "running",
        settleTaskThreads: status === "completed",
      },
    );
  };

  switch (command.type) {
    case "team.propose":
    case "team.start": {
      if (input.thread.teamTask !== undefined) {
        return rejected(
          "team_task_thread",
          command.type === "team.propose"
            ? "A team agent's thread cannot propose a team."
            : "A team agent's thread cannot run a workflow.",
        );
      }
      if (current?.status === "running") {
        return rejected(
          "team_plan_running",
          "A team is running on this thread. Cancel it before proposing another.",
        );
      }
      if (command.goal.length > TEAM_BRIEF_MAX_CHARS) {
        return rejected(
          "team_invalid",
          `The goal is longer than ${TEAM_BRIEF_MAX_CHARS} characters.`,
        );
      }
      const issue = validateTeamDraft(command);
      if (issue !== null) return rejected("team_invalid", issue.message);
      const plan: TeamPlan = {
        id: input.newPlanId,
        revision: 1,
        status: "proposed",
        goal: command.goal,
        agents: command.agents,
        tasks: pendingTasks(command, command.type === "team.start"),
        maxParallelPerProvider: TEAM_DEFAULT_MAX_PARALLEL_PER_PROVIDER,
        proposedAt: now,
        updatedAt: now,
      };
      if (command.type === "team.propose") return updated(plan);
      // A workflow run is approved as it starts, so it never reads as waiting for approval.
      const unassigned = command.agents.filter((member) => member.agent === undefined);
      if (unassigned.length > 0) return agentNeeded(unassigned);
      return advance(
        {
          ...plan,
          status: "running",
          maxParallelPerProvider: command.maxParallelPerProvider ?? plan.maxParallelPerProvider,
          run: command.run,
        },
        false,
      );
    }
    case "team.edit": {
      if (current?.status !== "proposed") {
        return rejected("team_plan_not_proposed", "Only a proposed team can be edited.");
      }
      if (current.revision !== command.expectedRevision) {
        return revisionConflict(current, command.expectedRevision);
      }
      const issue = validateTeamDraft(command);
      if (issue !== null) return rejected("team_invalid", issue.message);
      return updated({
        ...current,
        revision: current.revision + 1,
        agents: command.agents,
        tasks: pendingTasks(command, false),
        maxParallelPerProvider: command.maxParallelPerProvider ?? current.maxParallelPerProvider,
        updatedAt: now,
      });
    }
    case "team.approve": {
      if (current?.status !== "proposed") {
        return rejected("team_plan_not_proposed", "Only a proposed team can be approved.");
      }
      if (current.revision !== command.expectedRevision) {
        return revisionConflict(current, command.expectedRevision);
      }
      const waiting = teamMembersWithoutAgent(current);
      if (waiting.length > 0) return agentNeeded(waiting);
      return advance({ ...current, status: "running" }, false);
    }
    case "team.cancel": {
      if (current?.status !== "proposed" && current?.status !== "running") {
        return rejected("team_plan_not_active", "There is no proposed or running team to cancel.");
      }
      const running = current.tasks.filter((task) => task.status === "running");
      const { hold: _hold, ...unheld } = current;
      return updated(
        {
          ...unheld,
          status: "cancelled",
          tasks: current.tasks.map((task) =>
            task.status === "running" ? ended(task, "cancelled") : task,
          ),
          updatedAt: now,
        },
        {
          stop: running.flatMap((task) => (task.threadId === null ? [] : [task.threadId])),
          // A proposed team has no threads yet.
          settleTaskThreads: current.status === "running",
        },
      );
    }
    case "team.task.retry": {
      if (current?.status !== "running" && current?.status !== "failed") {
        return rejected(
          "team_plan_not_retryable",
          "A task can be retried only while its team is running or has failed.",
        );
      }
      const task = current.tasks.find((candidate) => candidate.id === command.taskId);
      if (task === undefined) {
        return rejected("team_task_unknown", `The team has no task "${command.taskId}".`);
      }
      if (task.status !== "failed" && task.status !== "cancelled") {
        return rejected(
          "team_task_not_retryable",
          `Task "${task.id}" is ${task.status}. Only a failed or cancelled task can be retried.`,
        );
      }
      const agentId = command.agentId ?? task.agentId;
      if (!current.agents.some((agent) => agent.id === agentId)) {
        return rejected("team_agent_unknown", `The team has no agent "${agentId}".`);
      }
      const { usage: _usage, resultRunId: _resultRunId, ...settled } = task;
      return advance(
        withTask(current, {
          ...settled,
          agentId,
          status: "pending",
          attempt: task.attempt + 1,
          threadId: null,
          result: null,
          startedAt: null,
          completedAt: null,
          ...(task.review === undefined ? {} : { review: FIRST_REVIEW }),
        }),
        false,
      );
    }
    case "team.task.settle": {
      const task =
        current?.id === command.planId && current.status === "running"
          ? current.tasks.find((candidate) => candidate.id === command.taskId)
          : undefined;
      if (
        current === null ||
        task === undefined ||
        task.status !== "running" ||
        task.attempt !== command.attempt ||
        // A step continues in the same thread, so each run reports once.
        (command.runId !== undefined && task.resultRunId === command.runId)
      ) {
        return { type: "unchanged" };
      }
      const reported: TeamTask = {
        ...task,
        result: truncatedResult(command.result),
        ...(command.usage === undefined ? {} : { usage: command.usage }),
        ...(command.runId === undefined ? {} : { resultRunId: command.runId }),
      };
      if (current.run === undefined || command.status !== "completed") {
        return advance(withTask(current, ended(reported, command.status)), true);
      }
      // A workflow step stays running, so its dependents wait, until the lead accepts its result.
      const awaiting: TeamTask = {
        ...reported,
        review: { round: task.review?.round ?? 1, awaiting: true, awaitingSince: now },
      };
      return advance(withTask(current, awaiting), true, {
        reviewSteps: current.hold === undefined ? [awaiting] : [],
      });
    }
    case "team.task.review": {
      if (current?.id !== command.planId || current.run === undefined) {
        return rejected("team_not_workflow_run", "Only a workflow run's steps are reviewed.");
      }
      if (current.status !== "running") {
        return rejected("team_plan_not_running", `The run is ${current.status}.`);
      }
      // The user answers a review hold; a spend or time limit waits for them to resume first.
      if (current.hold !== undefined && current.hold.reason !== "review") {
        return rejected(
          "team_run_waiting",
          current.hold.reason === "unpriced"
            ? "The run's cost cannot be estimated against its spending limit, and it waits for the user to resume it."
            : `The run reached its ${current.hold.reason} limit and waits for the user to resume it.`,
        );
      }
      const task = current.tasks.find((candidate) => candidate.id === command.taskId);
      if (task === undefined) {
        return rejected("team_task_unknown", `The run has no step "${command.taskId}".`);
      }
      const review = task.review;
      if (
        task.status !== "running" ||
        review?.awaiting !== true ||
        task.attempt !== command.attempt ||
        review.round !== command.round
      ) {
        return rejected(
          "team_task_not_awaiting_review",
          `Step "${task.id}" has no result waiting for review in round ${command.round}.`,
        );
      }
      if (command.verdict === "accept") {
        return advance(withTask(current, ended(task, "completed")), true);
      }
      if (command.notes === undefined) {
        return rejected(
          "team_review_notes_required",
          "Sending a step back needs notes on what to fix.",
        );
      }
      // Notes travel in the send-back effect: every event on the lead carries the whole plan.
      const sentBack: TeamTask = {
        ...task,
        review: { round: review.round + 1, awaiting: false, awaitingSince: null },
      };
      return advance(withTask(current, sentBack), false, {
        sendBack: { task: sentBack, notes: command.notes },
      });
    }
    case "team.hold": {
      if (
        current?.id !== command.planId ||
        current.run === undefined ||
        current.status !== "running"
      ) {
        return { type: "unchanged" };
      }
      // A review hold lifts itself, so it never replaces a limit's hold and needs a step to review.
      if (
        current.hold?.reason === command.reason ||
        (command.reason === "review" &&
          (current.hold !== undefined || !current.tasks.some(isAwaitingReview)))
      ) {
        return { type: "unchanged" };
      }
      return updated({ ...current, hold: { reason: command.reason, at: now }, updatedAt: now });
    }
    case "team.resume": {
      if (current?.id !== command.planId || current.run === undefined) {
        return rejected("team_not_workflow_run", "Only a workflow run can be resumed.");
      }
      if (current.status !== "running" || current.hold === undefined) {
        return rejected("team_run_not_waiting", "The run is not waiting for the user.");
      }
      const { hold: _hold, ...resumed } = current;
      const plan: TeamPlan =
        command.limits === undefined
          ? resumed
          : { ...resumed, run: { ...current.run, limits: command.limits } };
      return advance(plan, false, { reviewSteps: plan.tasks.filter(isAwaitingReview) });
    }
    case "team.run.update": {
      if (current?.id !== command.planId || current.run === undefined) {
        return { type: "unchanged" };
      }
      const run = {
        ...current.run,
        ...(command.costUsd === undefined ? {} : { costUsd: command.costUsd }),
        ...(command.headline === undefined ? {} : { headline: command.headline }),
        ...(command.note === undefined ? {} : { note: command.note }),
      };
      if (
        run.costUsd === current.run.costUsd &&
        run.headline === current.run.headline &&
        run.note === current.run.note
      ) {
        return { type: "unchanged" };
      }
      return updated({ ...current, run, updatedAt: now });
    }
  }
}
