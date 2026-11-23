import {
  CommandId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Notification,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProjectId,
  type TeamAgent,
  type TeamPlan,
  type TeamPlanId,
  type TeamTask,
  type TeamTaskId,
  ThreadId,
} from "@codenine/contracts";
import { isAwaitingReview, teamTaskModelSelection } from "@codenine/shared/team";
import { formatThreadLink } from "@codenine/shared/threadLinks";
import { workspacePreset } from "@codenine/shared/workspacePreset";
import { subagentResultForRun } from "@codenine/provider-core/server/subagentProjection";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectService from "../project/ProjectService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import { TEAM_RESULT_CUT_NOTE, teamTaskThreadId } from "./TeamPlan.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import { userFacingDispatchErrorMessage } from "./UserFacingErrors.ts";

export class TeamTaskError extends Schema.TaggedError<TeamTaskError>()("TeamTaskError", {
  operation: Schema.Literals([
    "launch",
    "stop",
    "wake-lead",
    "settle-threads",
    "continue",
    "recover",
  ]),
  threadId: ThreadId,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Team task ${this.operation} failed for thread ${this.threadId}.`;
  }
}

const WORKSPACE_ERROR_MESSAGES = {
  "project-missing": "The lead thread's project no longer exists.",
  "head-unresolved": "The lead thread's checkout has no commit to start a worktree from.",
  "commit-outside-project":
    'The lead thread\'s checkout is another repository, so a worktree cannot start from its commit. Use workspace "shared" for this agent.',
} as const;

class TeamTaskWorkspaceError extends Schema.TaggedError<TeamTaskWorkspaceError>()(
  "TeamTaskWorkspaceError",
  {
    reason: Schema.Literals(["project-missing", "head-unresolved", "commit-outside-project"]),
    projectId: ProjectId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return WORKSPACE_ERROR_MESSAGES[this.reason];
  }
}

export class TeamTaskService extends Context.Service<
  TeamTaskService,
  {
    /** Starts the thread of a task its plan marked running. Stale requests do nothing. */
    readonly launchTask: (input: {
      readonly leadThreadId: ThreadId;
      readonly planId: TeamPlanId;
      readonly taskId: TeamTaskId;
      readonly attempt: number;
    }) => Effect.Effect<void, TeamTaskError>;
    readonly stopTask: (input: {
      readonly taskThreadId: ThreadId;
      readonly commandId: CommandId;
    }) => Effect.Effect<void, TeamTaskError>;
    /**
     * Tells the lead agent its plan finished or got stuck, or with `step`, that a workflow step's
     * result waits for its review in that round. Once per `commandId`.
     */
    readonly wakeLead: (input: {
      readonly leadThreadId: ThreadId;
      readonly planId: TeamPlanId;
      readonly commandId: CommandId;
      readonly step?: TeamStepRound;
    }) => Effect.Effect<void, TeamTaskError>;
    /** Sends a workflow step back into its own thread with the lead's notes, once per round. */
    readonly continueTask: (
      input: TeamStepRound & {
        readonly leadThreadId: ThreadId;
        readonly planId: TeamPlanId;
        readonly notes: string;
      },
    ) => Effect.Effect<void, TeamTaskError>;
    /** Settles the threads of every attempt of a completed or cancelled plan, never the lead. */
    readonly settleTaskThreads: (input: {
      readonly leadThreadId: ThreadId;
      readonly planId: TeamPlanId;
    }) => Effect.Effect<void, TeamTaskError>;
    /**
     * After a restart, wakes the lead again for each step whose review wake was lost, and resends
     * each send-back whose turn never started; restart recovery cancels both.
     */
    readonly recoverRun: (input: {
      readonly leadThreadId: ThreadId;
      readonly planId: TeamPlanId;
    }) => Effect.Effect<void, TeamTaskError>;
  }
>()("codenine/orchestration-v2/TeamTaskService") {}

interface TeamStepRound {
  readonly taskId: TeamTaskId;
  readonly attempt: number;
  readonly round: number;
}

interface LeadWake {
  readonly commandId: CommandId;
  readonly messageId: MessageId;
  readonly text: string;
  readonly notification: OrchestrationV2Notification;
}

interface EarlierResult {
  readonly task: TeamTask;
  /** Set when the task worked in a checkout of its own. */
  readonly checkout: Pick<OrchestrationV2AppThread, "branch" | "worktreePath"> | undefined;
  /** The task thread's own final result; the plan keeps a shorter copy. */
  readonly result: string;
}

const DEPENDENCY_RESULT_MAX_CHARS = 8_000;
const RESULT_SHORTENED = "\n\n[Result shortened to fit this message.]";

const shortened = (result: string, cap: number) =>
  result.length <= cap ? result : `${result.slice(0, cap).trimEnd()}${RESULT_SHORTENED}`;

const TEAM_TASK_SCOPE =
  "Do only your task; other members do the rest of the goal. Start no subagents; Codenine's tools for other chats are not available here. If you cannot finish, stop and say what blocks you instead of guessing.";

const teamHandOff = (doneWhen: string | undefined) =>
  `Your final message is the hand-off to the next agent, under 250 words: first ${doneWhen ? "whether Done when passed (the command and the last lines of its output)" : "what you checked and how it went"}, then the files you changed and the branch, then anything left open.`;

function taskBrief(input: {
  readonly plan: TeamPlan;
  readonly agent: TeamAgent;
  readonly task: TeamTask;
  readonly earlier: ReadonlyArray<EarlierResult>;
}): string {
  const { agent, task, plan } = input;
  const { run } = plan;
  const instructions = agent.agent === undefined ? agent.instructions?.trim() : undefined;
  const doneWhen = task.doneWhen?.trim();
  const opening =
    run === undefined
      ? [
          agent.role === "custom"
            ? `Act as "${agent.label}" on this team.`
            : `Act as the ${agent.role} agent "${agent.label}" on this team.`,
          ...(instructions ? [`Your instructions:\n${instructions}`] : []),
          `Team goal:\n${plan.goal}`,
          `Your task: ${task.title}\n${task.brief}`,
        ]
      : [
          `You do one step of the workflow "${run.title}".`,
          `Workflow goal:\n${plan.goal}`,
          ...(run.inputs.length === 0
            ? []
            : [
                [
                  "Inputs for this run:",
                  ...run.inputs.map((value) => `- ${value.name}: ${value.value}`),
                ].join("\n"),
              ]),
          `Your step: ${task.title}\n${task.brief}`,
        ];
  if (doneWhen) opening.push(`Done when: ${doneWhen}`);
  const closing =
    run === undefined
      ? [TEAM_TASK_SCOPE, teamHandOff(doneWhen)]
      : [
          "Your final message is your result. The lead checks it against the goal and Done when, and may send it back to you with notes. State what you did and where: files, links, and anything left open.",
        ];
  if (input.earlier.length === 0) return [...opening, ...closing].join("\n\n");
  const results = (cap: number) =>
    [
      run === undefined ? "Results from earlier tasks:" : "Results from earlier steps:",
      ...input.earlier.map(({ task: earlier, checkout, result }) => {
        const where =
          checkout === undefined
            ? ""
            : `\nIts work is on branch ${checkout.branch ?? "(detached)"} in worktree ${checkout.worktreePath}.`;
        return `### ${earlier.title}${where}\n${shortened(result, cap)}`;
      }),
    ].join("\n\n");
  // Each result gets an even share of what the provider takes in one message.
  const room =
    PROVIDER_SEND_TURN_MAX_INPUT_CHARS - [...opening, results(0), ...closing].join("\n\n").length;
  const cap = Math.max(
    0,
    Math.min(DEPENDENCY_RESULT_MAX_CHARS, Math.floor(room / input.earlier.length)),
  );
  return [...opening, results(cap), ...closing].join("\n\n");
}

const isWorkspaceError = Schema.is(TeamTaskWorkspaceError);

// A launch failure reads best from its deepest cause; a workspace failure already says what to do.
const startFailureReason = (failure: unknown): string =>
  isWorkspaceError(failure)
    ? failure.message
    : (userFacingDispatchErrorMessage(failure) ?? "its thread could not be launched.");

const WAKE_RESULT_BUDGET_CHARS = 16_000;

const memberOf = (plan: TeamPlan, task: TeamTask) => {
  const agent = plan.agents.find((candidate) => candidate.id === task.agentId);
  return agent === undefined
    ? task.agentId
    : `${agent.label} (${(teamTaskModelSelection(plan, task) ?? agent.modelSelection).model})`;
};

const threadOf = (task: TeamTask) =>
  task.threadId === null
    ? "not started"
    : formatThreadLink({ environmentId: null, threadId: task.threadId }, task.title);

const TEAM_WAKE_WORDS = {
  completed: "Your team finished: every task completed.",
  failed:
    "Your team is stuck: a task did not complete, so the tasks that depend on it cannot start.",
  list: "Tasks:",
  completedNext:
    "Write the user one final summary: what changed and in which main files, how it was verified (the tests or checks the agents ran, and their results), what is still open or untested, and how to run or try it. End with each task thread's link for detail.",
  failedNext:
    "Tell the user which task failed and which tasks it blocks. They decide whether to retry it; do not redo the work yourself unless they ask.",
} as const;

const RUN_WAKE_WORDS = {
  completed: "Your workflow run finished: every step was accepted.",
  failed:
    "Your workflow run is stuck: a step did not complete, so the steps that depend on it cannot start.",
  list: "Steps:",
  completedNext:
    "Write the user one final summary of this run: what was done, links to anything published or changed, and anything left open. Then call save_run_note with a one-line headline for the run history and a short note on what the next run should know.",
  failedNext:
    "Tell the user which step failed and which steps it blocks. They decide whether to retry it; do not redo the work yourself unless they ask.",
} as const;

function wakeText(plan: TeamPlan): string {
  const words = plan.run === undefined ? TEAM_WAKE_WORDS : RUN_WAKE_WORDS;
  // The final tasks, such as integration or review, report on the whole goal, so they come first.
  const dependedOn = new Set(plan.tasks.flatMap((task) => task.dependsOn));
  let budget = WAKE_RESULT_BUDGET_CHARS;
  const kept = new Set<TeamTaskId>();
  for (const task of [
    ...plan.tasks.filter((task) => !dependedOn.has(task.id)),
    ...plan.tasks.filter((task) => dependedOn.has(task.id)),
  ]) {
    if (task.result === null || task.result.length > budget) continue;
    budget -= task.result.length;
    kept.add(task.id);
  }
  const tasks = plan.tasks.map((task) => {
    const heading = `- ${task.title}: ${task.status}. Agent: ${memberOf(plan, task)}. Thread: ${threadOf(task)}`;
    if (task.result === null) return heading;
    return kept.has(task.id)
      ? `${heading}\n${task.result}`
      : `${heading}\n  Result left out to keep this message short. Read the thread.`;
  });
  return [
    plan.status === "completed" ? words.completed : words.failed,
    `Goal: ${plan.goal}`,
    [words.list, ...tasks].join("\n"),
    plan.status === "completed" ? words.completedNext : words.failedNext,
  ].join("\n\n");
}

/** Asks a workflow run's lead to review one step's result. */
function stepWakeText(plan: TeamPlan, task: TeamTask, round: number): string {
  const doneWhen = task.doneWhen?.trim();
  return [
    `Step "${task.title}" (\`${task.id}\`) is ready for your review, round ${round}.`,
    [
      `Agent: ${memberOf(plan, task)}. Thread: ${threadOf(task)}`,
      `Goal: ${plan.goal}`,
      ...(doneWhen ? [`Done when: ${doneWhen}`] : []),
    ].join("\n"),
    `Result:\n${task.result ?? "No result was recorded."}`,
    `Check it against the goal and Done when, then call review_step with step "${task.id}": accept, or revise with exactly what to fix. Then end your turn.`,
  ].join("\n\n");
}

const sendBackText = (notes: string) =>
  `The lead sent your work back:\n\n${notes}\n\nFix this and reply with your complete, updated result.`;

/** Each round of a step has one review wake on its way at a time; restart recovery finds them. */
const stepWakeMessagePrefix = (taskThreadId: ThreadId, round: number) =>
  `message:team-step-wake:${taskThreadId}:${round}:`;

/** The send-back that starts a step's round, so a replayed effect sends it once. */
const sendBackKey = (taskThreadId: ThreadId, round: number, delivery: SendBackDelivery) =>
  `team-task-continue:${taskThreadId}:${round}${delivery === "after-restart" ? ":after-restart" : ""}`;

type SendBackDelivery = "first" | "after-restart";

const STOP_SETTLE_WAIT_MS = 10 * 60 * 1_000;

const make = Effect.gen(function* () {
  const scope = yield* Effect.scope;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const launches = yield* ThreadLaunchService.ThreadLaunchService;
  const projects = yield* ProjectService.ProjectService;
  const git = yield* GitVcsDriver.GitVcsDriver;

  const workspaceFor = Effect.fn("TeamTaskService.workspaceFor")(function* (
    lead: OrchestrationV2AppThread,
    agent: TeamAgent,
  ): Effect.fn.Return<OrchestrationV2ThreadLaunchWorkspaceStrategy, TeamTaskWorkspaceError> {
    const branch = lead.branch === null ? {} : { branch: lead.branch };
    const shared: OrchestrationV2ThreadLaunchWorkspaceStrategy =
      lead.worktreePath === null
        ? { type: "root", ...branch }
        : { type: "existing_worktree", worktreePath: lead.worktreePath, ...branch };
    if (agent.workspace === "shared") return shared;
    const { projectId } = lead;
    const project = Option.getOrUndefined(
      yield* projects
        .getById(projectId)
        .pipe(
          Effect.mapError(
            (cause) => new TeamTaskWorkspaceError({ reason: "project-missing", projectId, cause }),
          ),
        ),
    );
    if (project === undefined) {
      return yield* new TeamTaskWorkspaceError({ reason: "project-missing", projectId });
    }
    // A workspace type without checkout controls gives its user no way to land a branch.
    if (!workspacePreset(project.kind).composerControls.checkout) return shared;
    const base = yield* git
      .resolveCommit({ cwd: lead.worktreePath ?? project.workspaceRoot, revision: "HEAD" })
      .pipe(
        Effect.mapError(
          (cause) => new TeamTaskWorkspaceError({ reason: "head-unresolved", projectId, cause }),
        ),
      );
    // Launch creates the worktree from the project root, which must hold the lead's commit.
    if (lead.worktreePath !== null) {
      yield* git.resolveCommit({ cwd: project.workspaceRoot, revision: base.commitSha }).pipe(
        Effect.mapError(
          (cause) =>
            new TeamTaskWorkspaceError({
              reason: "commit-outside-project",
              projectId,
              cause,
            }),
        ),
      );
    }
    return { type: "worktree", baseRef: base.commitSha, startFromOrigin: false };
  });

  /** What the task's own thread ended with, which the plan may keep only part of. */
  const ownResult = Effect.fn("TeamTaskService.ownResult")(
    function* (task: TeamTask) {
      const { threadId, resultRunId } = task;
      if (threadId === null || resultRunId === undefined) return undefined;
      const { runs } = yield* threads.getThreadRecords(threadId, ["runs"], {
        runIds: [resultRunId],
      });
      const run = runs.find((candidate) => candidate.id === resultRunId);
      if (run === undefined) return undefined;
      const output = yield* threads.getThreadRecords(
        threadId,
        ["messages", "turnItems", "providerTurns"],
        {
          messageRoles: ["assistant"],
          messageRunIds: [run.id],
          turnItemRunIds: [run.id],
          turnItemTypes: ["assistant_message", "error"],
        },
      );
      return subagentResultForRun(output, run).text;
    },
    Effect.orElseSucceed(() => undefined),
  );

  const earlierResults = Effect.fn("TeamTaskService.earlierResults")(function* (
    lead: OrchestrationV2AppThread,
    plan: TeamPlan,
    task: TeamTask,
  ) {
    return yield* Effect.forEach(task.dependsOn, (dependencyId) =>
      Effect.gen(function* () {
        const earlier = plan.tasks.find((candidate) => candidate.id === dependencyId);
        if (earlier === undefined) return [];
        const shell =
          earlier.threadId === null ? null : yield* threads.getThreadShell(earlier.threadId);
        const ownCheckout =
          shell !== null && shell.worktreePath !== null && shell.worktreePath !== lead.worktreePath;
        const stored = earlier.result?.replace(TEAM_RESULT_CUT_NOTE, RESULT_SHORTENED);
        return [
          {
            task: earlier,
            checkout: ownCheckout
              ? { branch: shell.branch, worktreePath: shell.worktreePath }
              : undefined,
            result: (yield* ownResult(earlier)) ?? stored ?? "No result was recorded.",
          } satisfies EarlierResult,
        ];
      }),
    ).pipe(Effect.map((results) => results.flat()));
  });

  const launchTask: TeamTaskService["Service"]["launchTask"] = Effect.fn(
    "TeamTaskService.launchTask",
  )(
    function* (input) {
      const { thread: lead } = yield* threads.getThreadRecords(input.leadThreadId, []);
      const plan = lead.team;
      const task =
        plan?.id === input.planId
          ? plan.tasks.find((candidate) => candidate.id === input.taskId)
          : undefined;
      // A cancel or a retry since this effect was written owns the task now.
      if (
        plan == null ||
        task === undefined ||
        task.status !== "running" ||
        task.attempt !== input.attempt ||
        task.threadId === null
      ) {
        return;
      }
      const taskThreadId = task.threadId;
      const agent = plan.agents.find((candidate) => candidate.id === task.agentId);
      const launched = yield* Effect.gen(function* () {
        if (agent === undefined) {
          return yield* Effect.fail(`The team has no agent "${task.agentId}".`);
        }
        yield* launches.launch({
          commandId: CommandId.make(`server:team-task-launch:${taskThreadId}`),
          threadId: taskThreadId,
          projectId: lead.projectId,
          title: task.title,
          modelSelection: teamTaskModelSelection(plan, task) ?? agent.modelSelection,
          // The lead's mode is the ceiling its user set; a team agent never gets a broader one.
          runtimeMode: lead.runtimeMode,
          interactionMode: "default",
          workspaceStrategy: yield* workspaceFor(lead, agent),
          initialMessage: {
            text: taskBrief({
              plan,
              agent,
              task,
              earlier: yield* earlierResults(lead, plan, task),
            }),
            attachments: [],
          },
          teamTask: {
            rootThreadId: lead.id,
            planId: plan.id,
            taskId: task.id,
            attempt: task.attempt,
          },
          // A member the lead defined reaches what the lead may; a saved agent brings its own.
          ...(agent.agent === undefined
            ? lead.connectors === undefined
              ? {}
              : { connectors: lead.connectors }
            : { agent: agent.agent }),
          createdBy: "system",
          creationSource: "server",
        });
      }).pipe(Effect.result);
      if (launched._tag === "Success") return;
      yield* threads.dispatch({
        type: "team.task.settle",
        commandId: CommandId.make(`server:team-task-launch-failed:${taskThreadId}`),
        threadId: lead.id,
        planId: plan.id,
        taskId: task.id,
        attempt: task.attempt,
        status: "failed",
        result: `This task could not start: ${startFailureReason(launched.failure)}`,
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new TeamTaskError({ operation: "launch", threadId: input.leadThreadId, cause }),
        ),
      ),
  );

  const stopTask: TeamTaskService["Service"]["stopTask"] = Effect.fn("TeamTaskService.stopTask")(
    function* (input) {
      // A task cancelled before its launch ran has no thread to stop.
      const shell = yield* threads.getThreadShell(input.taskThreadId);
      if (shell === null || shell.deletedAt !== null) return;
      yield* threads.dispatch({
        type: "thread.stop",
        commandId: CommandId.make(`${input.commandId}:team-task-stop:${input.taskThreadId}`),
        threadId: input.taskThreadId,
        reason: "The team was cancelled",
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) => new TeamTaskError({ operation: "stop", threadId: input.taskThreadId, cause }),
        ),
      ),
  );

  // A completed notification turns the lead's reply into a Task result, so only the plan's own is.
  const planWake = (plan: TeamPlan, commandId: CommandId): LeadWake | undefined => {
    // A retry since this effect was written set the plan running again.
    if (plan.status !== "completed" && plan.status !== "failed") return undefined;
    const subject = plan.run === undefined ? "team" : "run";
    return {
      commandId: CommandId.make(`${commandId}:team-lead-wake`),
      messageId: MessageId.make(`message:team-lead-wake:${commandId}`),
      text: wakeText(plan),
      notification: {
        source: { kind: "system" },
        outcome: plan.status,
        summary:
          plan.status === "completed" ? `The ${subject} finished` : `The ${subject} is stuck`,
      },
    };
  };

  const stepWake = Effect.fn("TeamTaskService.stepWake")(function* (
    leadThreadId: ThreadId,
    plan: TeamPlan,
    step: TeamStepRound,
    commandId: CommandId,
    afterRestart: boolean,
  ) {
    const task = plan.tasks.find((candidate) => candidate.id === step.taskId);
    // The lead reviewed this round already, or a hold, retry or cancel came first.
    if (
      plan.status !== "running" ||
      plan.hold !== undefined ||
      task === undefined ||
      task.threadId === null ||
      !isAwaitingReview(task) ||
      task.attempt !== step.attempt ||
      task.review?.round !== step.round
    ) {
      return undefined;
    }
    const prefix = stepWakeMessagePrefix(task.threadId, step.round);
    const { runs } = yield* threads.getThreadRecords(leadThreadId, ["runs"]);
    const earlier = runs.filter((run) => run.userMessageId.startsWith(prefix));
    // One wake per round waits in the lead's queue; one the lead read before a restart stays read.
    if (
      earlier.some(
        (run) =>
          !ThreadManagementService.isTerminalRunStatus(run.status) ||
          (afterRestart && run.status === "completed"),
      )
    ) {
      return undefined;
    }
    return {
      commandId: CommandId.make(`${commandId}:team-step-wake:${task.id}`),
      messageId: MessageId.make(`${prefix}${commandId}`),
      text: stepWakeText(plan, task, step.round),
      notification: {
        source: { kind: "system" },
        outcome: "updated",
        summary: `"${task.title}" is ready for review`,
      },
    } satisfies LeadWake;
  });

  const wakeLeadWith = Effect.fn("TeamTaskService.wakeLead")(
    function* (
      input: Parameters<TeamTaskService["Service"]["wakeLead"]>[0] & {
        readonly afterRestart: boolean;
      },
    ) {
      const { thread: lead } = yield* threads.getThreadRecords(input.leadThreadId, []);
      const plan = lead.team;
      if (plan?.id !== input.planId || lead.archivedAt !== null || lead.deletedAt !== null) return;
      const wake =
        input.step === undefined
          ? planWake(plan, input.commandId)
          : yield* stepWake(lead.id, plan, input.step, input.commandId, input.afterRestart);
      if (wake === undefined) return;
      yield* threads
        .dispatch({
          type: "message.dispatch",
          ...wake,
          threadId: lead.id,
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        })
        .pipe(
          // A lead whose provider was turned off cannot act on the results; the plan keeps them.
          Effect.catchTags({
            ThreadManagementProviderInstanceDisabledError: (error) =>
              Effect.logInfo("orchestration-v2.team.lead-wake.instance-disabled", {
                threadId: lead.id,
                instanceId: error.instanceId,
              }),
          }),
        );
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new TeamTaskError({ operation: "wake-lead", threadId: input.leadThreadId, cause }),
        ),
      ),
  );

  const wakeLead: TeamTaskService["Service"]["wakeLead"] = (input) =>
    wakeLeadWith({ ...input, afterRestart: false });

  const sendBack = Effect.fn("TeamTaskService.sendBack")(function* (input: {
    readonly leadThreadId: ThreadId;
    readonly planId: TeamPlanId;
    readonly task: TeamTask;
    readonly taskThreadId: ThreadId;
    readonly round: number;
    readonly text: string;
    readonly delivery: SendBackDelivery;
  }) {
    const key = sendBackKey(input.taskThreadId, input.round, input.delivery);
    // The same chat, on the same model and provider session as the result it fixes.
    const sent = yield* threads
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`server:${key}`),
        threadId: input.taskThreadId,
        messageId: MessageId.make(`message:${key}`),
        text: input.text,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        senderThreadId: input.leadThreadId,
        createdBy: "agent",
        creationSource: "server",
      })
      .pipe(Effect.result);
    if (sent._tag === "Success") return;
    // A step that cannot take the notes fails, so the user can retry it in a new thread.
    yield* threads.dispatch({
      type: "team.task.settle",
      commandId: CommandId.make(`server:${key}:failed`),
      threadId: input.leadThreadId,
      planId: input.planId,
      taskId: input.task.id,
      attempt: input.task.attempt,
      status: "failed",
      result: `The lead's notes could not reach this step: ${userFacingDispatchErrorMessage(sent.failure) ?? "its thread did not take them."}`,
    });
  });

  const continueTask: TeamTaskService["Service"]["continueTask"] = Effect.fn(
    "TeamTaskService.continueTask",
  )(
    function* (input) {
      const { thread: lead } = yield* threads.getThreadRecords(input.leadThreadId, []);
      const plan = lead.team;
      const task =
        plan?.id === input.planId
          ? plan.tasks.find((candidate) => candidate.id === input.taskId)
          : undefined;
      // A cancel, a retry or a later review since this effect was written owns the step now.
      if (
        plan == null ||
        plan.status !== "running" ||
        task === undefined ||
        task.status !== "running" ||
        task.threadId === null ||
        task.attempt !== input.attempt ||
        task.review === undefined ||
        task.review.awaiting ||
        task.review.round !== input.round
      ) {
        return;
      }
      yield* sendBack({
        leadThreadId: lead.id,
        planId: plan.id,
        task,
        taskThreadId: task.threadId,
        round: input.round,
        text: sendBackText(input.notes),
        delivery: "first",
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new TeamTaskError({ operation: "continue", threadId: input.leadThreadId, cause }),
        ),
      ),
  );

  const resendSendBack = Effect.fn("TeamTaskService.resendSendBack")(function* (input: {
    readonly leadThreadId: ThreadId;
    readonly planId: TeamPlanId;
    readonly task: TeamTask;
    readonly taskThreadId: ThreadId;
    readonly round: number;
  }) {
    const messageId = (delivery: SendBackDelivery) =>
      MessageId.make(`message:${sendBackKey(input.taskThreadId, input.round, delivery)}`);
    const { runs, messages } = yield* threads.getThreadRecords(
      input.taskThreadId,
      ["runs", "messages"],
      { messageIds: [messageId("first"), messageId("after-restart")] },
    );
    const sent = messages.find((message) => message.id === messageId("first"));
    const run = runs.find((candidate) => candidate.userMessageId === messageId("first"));
    // Restart recovery cancels a turn that never started, so the agent never read these notes.
    if (
      sent === undefined ||
      messages.some((message) => message.id === messageId("after-restart")) ||
      run?.status !== "cancelled" ||
      run.startedAt !== null
    ) {
      return;
    }
    yield* sendBack({ ...input, text: sent.text, delivery: "after-restart" });
  });

  const recoverRun: TeamTaskService["Service"]["recoverRun"] = Effect.fn(
    "TeamTaskService.recoverRun",
  )(
    function* (input) {
      const { thread: lead } = yield* threads.getThreadRecords(input.leadThreadId, []);
      const plan = lead.team;
      // A held run wakes nobody; resuming it wakes the lead for every step that waits.
      if (
        plan?.id !== input.planId ||
        plan.run === undefined ||
        plan.status !== "running" ||
        plan.hold !== undefined
      ) {
        return;
      }
      for (const task of plan.tasks) {
        const { threadId, review } = task;
        if (task.status !== "running" || threadId === null || review === undefined) continue;
        if (review.awaiting) {
          yield* wakeLeadWith({
            leadThreadId: lead.id,
            planId: plan.id,
            commandId: CommandId.make(`server:team-step-rewake:${threadId}:${review.round}`),
            step: { taskId: task.id, attempt: task.attempt, round: review.round },
            afterRestart: true,
          });
        } else if (review.round > 1) {
          yield* resendSendBack({
            leadThreadId: lead.id,
            planId: plan.id,
            task,
            taskThreadId: threadId,
            round: review.round,
          });
        }
      }
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new TeamTaskError({ operation: "recover", threadId: input.leadThreadId, cause }),
        ),
      ),
  );

  const settleTaskThread = Effect.fn("TeamTaskService.settleTaskThread")(function* (
    threadId: ThreadId,
  ) {
    const shell = yield* threads.getThreadShell(threadId);
    // An explicit "active" is the user keeping the thread out of Settled.
    if (
      shell === null ||
      shell.deletedAt !== null ||
      shell.archivedAt !== null ||
      shell.settledOverride !== null
    ) {
      return;
    }
    const settle = (attempt: "first" | "after-stop") =>
      threads
        .dispatch({
          type: "thread.settle",
          commandId: CommandId.make(`server:team-thread-settle:${attempt}:${threadId}`),
          threadId,
        })
        .pipe(
          Effect.as(true),
          // Settling refuses a thread that still runs, has a queued message or awaits an answer.
          Effect.catchTags({
            OrchestratorDispatchError: () => Effect.succeed(false),
            OrchestratorCommandPreviouslyRejectedError: () => Effect.succeed(false),
          }),
        );
    if (yield* settle("first")) return;
    if ((yield* threads.getThreadShell(threadId))?.activeRunId == null) return;
    // A cancelled team's thread settles once the Stop it was sent ends its run.
    yield* threads
      .waitForThread({ projectId: shell.projectId, threadId, timeoutMs: STOP_SETTLE_WAIT_MS })
      .pipe(Effect.andThen(settle("after-stop")), Effect.ignore, Effect.forkIn(scope));
  });

  const settleTaskThreads: TeamTaskService["Service"]["settleTaskThreads"] = Effect.fn(
    "TeamTaskService.settleTaskThreads",
  )(
    function* (input) {
      const plan = (yield* threads.getThreadRecords(input.leadThreadId, [])).thread.team;
      if (plan?.id !== input.planId || (plan.status !== "completed" && plan.status !== "cancelled"))
        return;
      // A retry replaced earlier attempts' threads; their ids are derived, so each is found here.
      yield* Effect.forEach(
        plan.tasks.flatMap((task) =>
          Array.from({ length: task.attempt }, (_, index) =>
            teamTaskThreadId(plan.id, task.id, index + 1),
          ),
        ),
        settleTaskThread,
        { discard: true },
      );
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new TeamTaskError({ operation: "settle-threads", threadId: input.leadThreadId, cause }),
        ),
      ),
  );

  return TeamTaskService.of({
    launchTask,
    stopTask,
    wakeLead,
    continueTask,
    settleTaskThreads,
    recoverRun,
  });
});

export const layer = Layer.effect(TeamTaskService, make);
