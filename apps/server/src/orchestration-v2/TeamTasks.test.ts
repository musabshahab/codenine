import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ConnectionId,
  EventId,
  GitCommandError,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type RunId,
  type TeamAgent,
  TeamAgentId,
  type TeamPlanRun,
  type TeamPlanStatus,
  type TeamTaskDraft,
  TeamTaskId,
  ThreadId,
  TurnItemId,
  WorkflowId,
  WorkflowStepId,
} from "@codenine/contracts";
import * as IdAllocator from "@codenine/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@codenine/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { subscribeOrchestrationV2Shell } from "../ws.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as TeamTaskReactor from "./TeamTaskReactor.ts";
import * as TeamTaskService from "./TeamTaskService.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const projectId = ProjectId.make("project:team");
const leadThreadId = ThreadId.make("thread:team-lead");
const leadCheckout = "/repo/lead";
const instanceId = ProviderInstanceId.make("codex");
const fast = { instanceId, model: "gpt-fast" };
const strong = { instanceId, model: "gpt-strong" };

const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Team agents here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const project = {
  id: projectId,
  title: "Team",
  workspaceRoot: "/repo",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: fast,
  defaultThreadEnvMode: null,
  scripts: [],
  pinnedAt: null,
  archivedAt: null,
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z",
  deletedAt: null,
} as const;

const agent = (
  id: string,
  modelSelection: TeamAgent["modelSelection"],
  workspace: TeamAgent["workspace"] = "shared",
): TeamAgent => ({
  id: TeamAgentId.make(id),
  label: id,
  role: "implement",
  modelSelection,
  workspace,
});
const builder = agent("builder", fast);
const reviewer = agent("reviewer", strong);

const task = (id: string, dependsOn: ReadonlyArray<string> = [], by = builder): TeamTaskDraft => ({
  id: TeamTaskId.make(id),
  title: `Task ${id}`,
  brief: `Do ${id}.`,
  agentId: by.id,
  dependsOn: dependsOn.map((dependency) => TeamTaskId.make(dependency)),
});

/**
 * The real orchestrator, effect worker, thread launch and team services. Each launched thread
 * stays in workspace setup, which reports its thread id to `launched`, so a test decides how its
 * run ends.
 */
const layerTeam = (
  launched: Queue.Queue<ThreadId>,
  options: { readonly headResolves?: boolean } = {},
) => {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerServerSettings = ServerSettings.layerTest();
  const layerReceipts = CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase));
  const layerThreadManagement = ThreadManagement.layer.pipe(
    Layer.provide(layerServerSettings),
    Layer.provide(layerReceipts),
  );
  const layerProjects = Layer.mock(ProjectService.ProjectService)({
    getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
  });
  const layerLaunchDependencies = Layer.mergeAll(
    WorktreeSetupTracker.layer,
    Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
    Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
    layerProjects,
    Layer.mock(GitWorkflow.GitWorkflowService)({
      hasCommit: () => Effect.succeed(false),
      createWorktree: (input) =>
        Effect.succeed({
          worktree: { path: `/repo-worktrees/${input.newRefName}`, refName: input.newRefName },
        } as never),
      removeWorktree: () => Effect.void,
      deleteLocalBranch: () => Effect.void,
    }),
    Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
      runForThread: (input) =>
        Queue.offer(launched, ThreadId.make(input.threadId)).pipe(Effect.andThen(Effect.never)),
    }),
    // Renaming a worktree branch runs beside setup; these tests read the branch setup recorded.
    Layer.mock(TextGeneration.TextGeneration)({ generateBranchName: () => Effect.never }),
    layerServerSettings,
    ProviderRegistryMock.layer(),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      isScratchProject: () => Effect.succeed(false),
      folderForThread: () => Effect.succeedNone,
    }),
  );
  const layerTeamTasks = TeamTaskService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ThreadLaunch.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              layerLaunchDependencies,
              layerThreadManagement,
              layerReceipts,
              IdAllocator.layer,
            ),
          ),
        ),
        layerThreadManagement,
        layerProjects,
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          resolveCommit: (input) =>
            options.headResolves === false
              ? Effect.fail(
                  new GitCommandError({
                    operation: "resolveCommit",
                    command: "git rev-parse",
                    cwd: input.cwd,
                    detail: "unknown revision",
                  }),
                )
              : Effect.succeed({ commitSha: "abc1234" }),
        }),
      ),
    ),
    Layer.orDie,
  );
  const layerHarness = ProviderReplayHarness.layerWithRegistry(
    { name: "team-tasks" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false, teamTasks: layerTeamTasks },
  );
  return Layer.mergeAll(
    TeamTaskReactor.layer.pipe(
      Layer.provide(ProjectionStore.layer.pipe(Layer.provide(layerDatabase))),
      Layer.provide(layerTeamTasks),
    ),
    layerTeamTasks,
    // A shell subscription reads these from the same database; see `streamedShell`.
    layerThreadManagement,
    OrchestrationEventStore.layer.pipe(Layer.provideMerge(layerDatabase)),
  ).pipe(Layer.provideMerge(layerHarness));
};

const dispatch = (command: OrchestrationV2ServerCommand) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) => orchestrator.dispatch(command));

const thread = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.getThreadProjection(threadId),
  );

const team = thread(leadThreadId).pipe(Effect.map((projection) => projection.thread.team!));

const taskStates = team.pipe(
  Effect.map((plan) =>
    Object.fromEntries(
      plan.tasks.map((candidate) => [candidate.id, `${candidate.status}#${candidate.attempt}`]),
    ),
  ),
);

/** The last shell a client resuming the shell stream after `afterSequence` receives for a thread. */
const streamedShell = (threadId: ThreadId, afterSequence: number) =>
  subscribeOrchestrationV2Shell({ afterSequence, requestCompletionMarker: true }).pipe(
    Effect.flatMap((stream) =>
      stream.pipe(
        Stream.takeUntil((item) => item.kind === "synchronized"),
        Stream.runCollect,
      ),
    ),
    Effect.map((items) =>
      items
        .flatMap((item) =>
          item.kind === "thread.updated" && item.thread.id === threadId ? [item.thread] : [],
        )
        .at(-1),
    ),
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([]) }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({
          subscribeChanges: Effect.flatMap(
            PubSub.unbounded<ProjectEnrichmentService.ProjectEnrichmentChange>(),
            PubSub.subscribe,
          ),
        }),
      ),
    ),
  );

const settledOverrides = (threadIds: ReadonlyArray<ThreadId>) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    Effect.forEach(threadIds, (threadId) =>
      orchestrator.getThreadShell(threadId).pipe(Effect.map((shell) => shell?.settledOverride)),
    ),
  );

const taskThreadId = (id: string) =>
  team.pipe(Effect.map((plan) => plan.tasks.find((candidate) => candidate.id === id)!.threadId!));

const createLead = dispatch({
  type: "thread.create",
  commandId: CommandId.make("create-lead"),
  threadId: leadThreadId,
  projectId,
  title: "Lead",
  modelSelection: fast,
  runtimeMode: "auto-accept-edits",
  interactionMode: "default",
  branch: "main",
  worktreePath: leadCheckout,
  createdBy: "user",
  creationSource: "web",
});

const proposeOnLead = (
  tasks: ReadonlyArray<TeamTaskDraft>,
  agents: ReadonlyArray<TeamAgent> = [builder, reviewer],
) =>
  dispatch({
    type: "team.propose",
    commandId: CommandId.make("propose"),
    threadId: leadThreadId,
    goal: "Ship the feature",
    agents,
    tasks,
  });

const propose = (...args: Parameters<typeof proposeOnLead>) =>
  createLead.pipe(Effect.andThen(proposeOnLead(...args)));

const approve = (expectedRevision = 1) =>
  dispatch({
    type: "team.approve",
    commandId: CommandId.make(`approve:${expectedRevision}`),
    threadId: leadThreadId,
    expectedRevision,
  });

/** Runs the team's pending effects and returns the threads they launched, once each reached setup. */
const runEffects = (launched: Queue.Queue<ThreadId>, expectedLaunches: number) =>
  Effect.gen(function* () {
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    yield* worker.drain();
    return yield* Queue.takeN(launched, expectedLaunches);
  });

/** Ends a team agent's latest run as its provider would, then lets the reactor see it unless `unheard`. */
const endRun = (
  threadId: ThreadId,
  status: "completed" | "failed" | "interrupted",
  result?: string,
  unheard = false,
) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const reactor = yield* TeamTaskReactor.TeamTaskReactor;
    const run = (yield* thread(threadId)).runs.at(-1)!;
    const now = yield* DateTime.now;
    const ended = {
      id: EventId.make(`event:${run.id}:ended`),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status, startedAt: run.startedAt ?? now, completedAt: now },
    } satisfies OrchestrationV2DomainEvent;
    yield* sink.write({
      events: [
        ...(result === undefined
          ? []
          : [
              {
                id: EventId.make(`event:${run.id}:result`),
                type: "turn-item.updated" as const,
                threadId,
                runId: run.id,
                occurredAt: now,
                payload: {
                  id: TurnItemId.make(`item:${run.id}:result`),
                  threadId,
                  runId: run.id,
                  nodeId: null,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 2,
                  status: "completed" as const,
                  title: null,
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                  type: "assistant_message" as const,
                  messageId: MessageId.make(`message:${run.id}:result`),
                  text: result,
                  streaming: false,
                },
              },
            ]),
        ended,
      ],
    });
    if (!unheard) yield* reactor.handle(ended);
    return ended;
  });

/** Restart recovery cancels a run that never started, and no reactor listens yet. */
const cancelUnstartedRun = (threadId: ThreadId, runId: RunId) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const run = (yield* thread(threadId)).runs.find((candidate) => candidate.id === runId)!;
    const now = yield* DateTime.now;
    yield* sink.write({
      events: [
        {
          id: EventId.make(`event:${run.id}:cancelled`),
          type: "run.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: { ...run, status: "cancelled", startedAt: null, completedAt: now },
        },
      ],
    });
  });

const withTeam = <A, E>(
  test: (
    launched: Queue.Queue<ThreadId>,
  ) => Effect.Effect<A, E, Layer.Success<ReturnType<typeof layerTeam>> | Scope.Scope>,
  options?: Parameters<typeof layerTeam>[1],
) =>
  Effect.gen(function* () {
    const launched = yield* Queue.unbounded<ThreadId>();
    return yield* test(launched).pipe(Effect.provide(layerTeam(launched, options)));
  });

const rejection = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? JSON.stringify(exit.cause) : "accepted";

const writer: TeamAgent = { ...agent("writer", fast), agent: "writer" };

const workflowRun: TeamPlanRun = {
  workflowId: WorkflowId.make("workflow:digest"),
  workflowName: "weekly-digest",
  title: "Weekly digest",
  run: 1,
  trigger: "manual",
  scheduledFor: null,
  inputs: [{ name: "Topic", value: "AI tooling" }],
  approvals: "ask",
  limits: { spendUsd: null, minutes: null },
  startedAt: "2026-11-18T10:00:00.000Z",
  costUsd: null,
  headline: null,
  note: null,
};

/**
 * The lead's own first turn stays in preparation, as no provider runs here, so the lead's wakes
 * queue behind it and none starts a turn on the lead's effect lane.
 */
const startWorkflowRun = (tasks: ReadonlyArray<TeamTaskDraft>) =>
  Effect.gen(function* () {
    yield* createLead;
    yield* dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("lead-instructions"),
      threadId: leadThreadId,
      messageId: MessageId.make("message:lead-instructions"),
      text: "Lead this run of the workflow.",
      attachments: [],
      dispatchMode: { type: "defer_start" },
      createdBy: "system",
      creationSource: "server",
    });
    yield* dispatch({
      type: "team.start",
      commandId: CommandId.make("start-run"),
      threadId: leadThreadId,
      goal: "Publish a weekly digest",
      agents: [writer],
      tasks: tasks.map((draft) => ({ ...draft, agentId: writer.id })),
      run: workflowRun,
    });
  });

const reviewStep = (taskId: string, round: number, verdict: "accept" | "revise", notes?: string) =>
  team.pipe(
    Effect.flatMap((plan) =>
      dispatch({
        type: "team.task.review",
        commandId: CommandId.make(`review:${taskId}:${round}`),
        threadId: leadThreadId,
        planId: plan.id,
        taskId: TeamTaskId.make(taskId),
        attempt: 1,
        round,
        verdict,
        ...(notes === undefined ? {} : { notes }),
      }),
    ),
  );

const leadWakes = thread(leadThreadId).pipe(
  Effect.map((projection) =>
    projection.messages.filter((message) => message.notification?.source.kind === "system"),
  ),
);

it.effect("a proposed team starts nothing, and only the revision the user saw can change it", () =>
  withTeam(() =>
    Effect.gen(function* () {
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* propose([task("build"), task("review", ["build"], reviewer)]);
      assert.equal(yield* worker.drain(), 0);
      const proposed = yield* team;
      assert.deepInclude(proposed, { status: "proposed", revision: 1 });

      const edit = (expectedRevision: number, commandId: string) =>
        dispatch({
          type: "team.edit",
          commandId: CommandId.make(commandId),
          threadId: leadThreadId,
          expectedRevision,
          agents: [builder],
          tasks: [task("build")],
        });
      assert.include(
        rejection(yield* Effect.exit(edit(2, "stale-edit"))),
        "team_revision_conflict",
      );
      assert.deepEqual(yield* team, proposed);

      yield* edit(1, "edit");
      assert.include(rejection(yield* Effect.exit(approve(1))), "team_revision_conflict");
      assert.deepEqual(yield* taskStates, { build: "pending#1" });
      assert.equal(yield* worker.drain(), 0);
    }),
  ),
);

it.effect(
  "a team waits for an agent for every suggested member; a member the lead defined runs on the lead's connectors",
  () =>
    withTeam((launched) =>
      Effect.gen(function* () {
        const suggested: TeamAgent = {
          ...agent("writer", fast),
          label: "Copywriter",
          suggestion: {
            title: "Copywriter",
            description: "Writes product copy.",
            instructions: "Write short, plain copy.",
            connectors: [],
          },
        };
        const planner: TeamAgent = {
          ...agent("planner", strong),
          label: "Planner",
          instructions: "Keep every plan under ten lines.",
        };
        const tasks = [
          task("copy", [], suggested),
          { ...task("plan", [], planner), doneWhen: "vp test run plan.test.ts passes" },
        ];
        yield* createLead;
        yield* dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("lead-connectors"),
          threadId: leadThreadId,
          connectors: [ConnectionId.make("github")],
        });
        yield* proposeOnLead(tasks, [suggested, planner]);
        assert.include(
          rejection(yield* Effect.exit(approve(1))),
          "team_agent_needed: Create or choose an agent for Copywriter first.",
        );

        // The user creates the agent from the suggestion, and the client saves the whole draft.
        const { suggestion: _suggestion, ...member } = suggested;
        const withAgent = { ...member, agent: "copywriter" };
        yield* dispatch({
          type: "team.edit",
          commandId: CommandId.make("edit"),
          threadId: leadThreadId,
          expectedRevision: 1,
          agents: [withAgent, planner],
          tasks,
        });
        assert.deepEqual((yield* team).agents, [withAgent, planner]);
        yield* approve(2);
        yield* runEffects(launched, 2);
        const copy = yield* thread(yield* taskThreadId("copy"));
        assert.deepInclude(copy.thread, { agent: "copywriter", modelSelection: fast });
        assert.isUndefined(copy.thread.connectors);
        assert.notInclude(copy.messages[0]!.text, "Your instructions:");

        const plan = yield* thread(yield* taskThreadId("plan"));
        assert.isUndefined(plan.thread.agent);
        assert.deepInclude(plan.thread, {
          modelSelection: strong,
          connectors: [ConnectionId.make("github")],
        });
        assert.equal(
          plan.messages[0]!.text,
          [
            'Act as the implement agent "Planner" on this team.',
            "Your instructions:\nKeep every plan under ten lines.",
            "Team goal:\nShip the feature",
            "Your task: Task plan\nDo plan.",
            "Done when: vp test run plan.test.ts passes",
            "Do only your task; other members do the rest of the goal. Start no subagents; Codenine's tools for other chats are not available here. If you cannot finish, stop and say what blocks you instead of guessing.",
            "Your final message is the hand-off to the next agent, under 250 words: first whether Done when passed (the command and the last lines of its output), then the files you changed and the branch, then anything left open.",
          ].join("\n\n"),
        );
      }),
    ),
);

it.effect(
  "approval starts what the cap allows, and a finished task hands its result to the tasks it unblocks",
  () =>
    withTeam((launched) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
        const listed = (threadId: ThreadId, location: "active" | "archive") =>
          orchestrator
            .getShellSnapshot({ location })
            .pipe(
              Effect.map((snapshot) =>
                [...snapshot.threads, ...snapshot.archivedThreads].find(
                  (shell) => shell.id === threadId,
                ),
              ),
            );
        // Thread lists read where a lead's plan stands from its shell alone, and the shell
        // stream resends the lead when the plan changes.
        const expectLeadSummaryAfter = <E, R>(
          change: Effect.Effect<unknown, E, R>,
          status: TeamPlanStatus,
          counts: { readonly running: number; readonly completed: number },
        ) =>
          Effect.gen(function* () {
            const since = yield* applicationEvents.latestApplicationSequence;
            yield* change;
            const expected = {
              planId: (yield* team).id,
              status,
              revision: 1,
              total: 4,
              failed: 0,
              cancelled: 0,
              ...counts,
            };
            for (const shell of [
              yield* orchestrator.getThreadShell(leadThreadId),
              yield* listed(leadThreadId, "active"),
              ProjectionStore.threadShellFromProjection(yield* thread(leadThreadId)),
              yield* streamedShell(leadThreadId, since),
            ]) {
              assert.deepEqual(shell?.teamSummary, expected);
            }
            return expected;
          });

        yield* createLead;
        assert.isUndefined((yield* orchestrator.getThreadShell(leadThreadId))?.teamSummary);
        yield* expectLeadSummaryAfter(
          proposeOnLead([task("a"), task("b"), task("c"), task("d", ["a"], reviewer)]),
          "proposed",
          { running: 0, completed: 0 },
        );
        yield* expectLeadSummaryAfter(approve(), "running", { running: 2, completed: 0 });
        const first = yield* runEffects(launched, 2);
        assert.sameMembers(first, [yield* taskThreadId("a"), yield* taskThreadId("b")]);
        assert.deepEqual(yield* taskStates, {
          a: "running#1",
          b: "running#1",
          c: "pending#1",
          d: "pending#1",
        });
        assert.include(
          rejection(
            yield* Effect.exit(
              dispatch({
                type: "team.propose",
                commandId: CommandId.make("propose-again"),
                threadId: leadThreadId,
                goal: "Another",
                agents: [builder],
                tasks: [task("x")],
              }),
            ),
          ),
          "team_plan_running",
        );

        // `c` comes first in the plan, so it takes the slot `a` frees; `d` waits for `b`. The plan
        // keeps a shorter copy of a long result; a dependent reads it from the task's thread.
        const aResult = `Wrote src/a.ts on main.\n${"Checked the edge cases. ".repeat(300)}`;
        yield* endRun(yield* taskThreadId("a"), "completed", aResult);
        assert.deepEqual(yield* runEffects(launched, 1), [yield* taskThreadId("c")]);
        assert.deepInclude(yield* taskStates, { a: "completed#1", d: "pending#1" });

        yield* endRun(yield* taskThreadId("b"), "completed", "Wrote src/b.ts.");
        const dThreadId = yield* taskThreadId("d");
        assert.deepEqual(yield* runEffects(launched, 1), [dThreadId]);
        const d = yield* thread(dThreadId);
        assert.deepInclude(d.thread, {
          title: "Task d",
          modelSelection: strong,
          runtimeMode: "auto-accept-edits",
          worktreePath: leadCheckout,
          createdBy: "system",
        });
        assert.deepEqual(d.thread.teamTask, {
          rootThreadId: leadThreadId,
          planId: (yield* team).id,
          taskId: TeamTaskId.make("d"),
          attempt: 1,
        });
        const brief = d.messages[0]!.text;
        assert.include(brief, 'Act as the implement agent "reviewer" on this team.');
        assert.include(brief, "Ship the feature");
        assert.include(brief, `### Task a\n${aResult}`);
        assert.notInclude(brief, "Wrote src/b.ts.");
        assert.include(
          brief,
          "Your final message is the hand-off to the next agent, under 250 words: first what you checked and how it went, then the files you changed and the branch, then anything left open.",
        );

        // Thread lists group a task thread under its lead from the shell alone.
        for (const shell of [
          yield* orchestrator.getThreadShell(dThreadId),
          yield* listed(dThreadId, "active"),
          ProjectionStore.threadShellFromProjection(d),
        ]) {
          assert.deepEqual(shell?.teamTask, d.thread.teamTask);
          assert.isUndefined(shell?.teamSummary);
        }
        assert.isUndefined((yield* orchestrator.getThreadShell(leadThreadId))?.teamTask);

        // The lead wakes and settles the team once it completes; neither is under test here.
        const completed = yield* expectLeadSummaryAfter(
          Effect.andThen(
            endRun(yield* taskThreadId("c"), "completed", "Wrote src/c.ts."),
            endRun(dThreadId, "completed", "Reviewed it."),
          ),
          "completed",
          { running: 0, completed: 4 },
        );
        for (const threadId of [dThreadId, leadThreadId]) {
          yield* dispatch({
            type: "thread.archive",
            commandId: CommandId.make(`archive:${threadId}`),
            threadId,
          });
        }
        assert.deepEqual((yield* listed(dThreadId, "archive"))?.teamTask, d.thread.teamTask);
        assert.deepEqual((yield* listed(leadThreadId, "archive"))?.teamSummary, completed);
      }),
    ),
);

it.effect(
  "a failed task leaves its dependents pending, fails the plan, and wakes the lead once",
  () =>
    withTeam((launched) =>
      Effect.gen(function* () {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const reactor = yield* TeamTaskReactor.TeamTaskReactor;
        yield* propose([task("build"), task("review", ["build"], reviewer)]);
        yield* approve();
        const [buildThreadId] = yield* runEffects(launched, 1);
        const ended = yield* endRun(buildThreadId!, "failed");
        // The wake starts a lead turn; only the wake itself is under test.
        assert.equal(yield* worker.drain(1), 1);
        yield* reactor.handle(ended);

        const plan = yield* team;
        assert.equal(plan.status, "failed");
        assert.deepEqual(yield* taskStates, { build: "failed#1", review: "pending#1" });
        assert.isNull(plan.tasks[1]!.threadId);
        const wakes = (yield* thread(leadThreadId)).messages.filter(
          (message) => message.notification?.source.kind === "system",
        );
        assert.lengthOf(wakes, 1);
        assert.include(wakes[0]!.text, "Your team is stuck");
        assert.include(wakes[0]!.text, "- Task build: failed. Agent: builder (gpt-fast).");
        assert.include(wakes[0]!.text, "- Task review: pending. Agent: reviewer (gpt-strong).");

        // A failed team keeps its threads for the user to read and retry. A settle the plan
        // queued would run next on the lead's lane, ahead of the turn the wake started.
        assert.equal(yield* worker.drain(1), 1);
        const teamTasks = yield* TeamTaskService.TeamTaskService;
        yield* teamTasks.settleTaskThreads({ leadThreadId, planId: plan.id });
        assert.deepEqual(yield* settledOverrides([leadThreadId, buildThreadId!]), [null, null]);
      }),
    ),
);

it.effect(
  "retrying a task on another agent starts a new thread and leaves the first thread's model alone",
  () =>
    withTeam((launched) =>
      Effect.gen(function* () {
        yield* propose([task("build"), task("docs")]);
        yield* approve();
        yield* runEffects(launched, 2);
        const firstThreadId = yield* taskThreadId("build");
        yield* endRun(firstThreadId, "failed");
        assert.equal((yield* team).status, "running");

        yield* dispatch({
          type: "team.task.retry",
          commandId: CommandId.make("retry"),
          threadId: leadThreadId,
          taskId: TeamTaskId.make("build"),
          agentId: reviewer.id,
        });
        const [retryThreadId] = yield* runEffects(launched, 1);
        assert.notEqual(retryThreadId, firstThreadId);
        assert.equal(retryThreadId, yield* taskThreadId("build"));
        assert.deepEqual(yield* taskStates, { build: "running#2", docs: "running#1" });
        assert.deepEqual((yield* thread(retryThreadId!)).thread.modelSelection, strong);
        assert.deepEqual((yield* thread(firstThreadId)).thread.modelSelection, fast);

        // Completing the team settles every attempt's thread, and never the lead.
        const docsThreadId = yield* taskThreadId("docs");
        yield* endRun(docsThreadId, "completed", "Wrote the docs.");
        yield* endRun(retryThreadId!, "completed", "Built it.");
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        // The wake, then the settle; the lead turn the wake starts is not under test.
        assert.equal(yield* worker.drain(2), 2);
        const plan = yield* team;
        assert.equal(plan.status, "completed");
        const taskThreads = [firstThreadId, retryThreadId!, docsThreadId];
        assert.deepEqual(yield* settledOverrides([leadThreadId, ...taskThreads]), [
          null,
          "settled",
          "settled",
          "settled",
        ]);
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sequences = Effect.forEach(taskThreads, orchestrator.getThreadEventSequence);
        const before = yield* sequences;
        const teamTasks = yield* TeamTaskService.TeamTaskService;
        yield* teamTasks.settleTaskThreads({ leadThreadId, planId: plan.id });
        assert.deepEqual(yield* sequences, before);
      }),
    ),
);

it.effect(
  "retrying a task on another model runs it there and leaves its member's model alone",
  () =>
    withTeam((launched) =>
      Effect.gen(function* () {
        yield* propose([task("build")]);
        yield* approve();
        yield* runEffects(launched, 1);
        yield* endRun(yield* taskThreadId("build"), "failed");

        yield* dispatch({
          type: "team.task.retry",
          commandId: CommandId.make("retry"),
          threadId: leadThreadId,
          taskId: TeamTaskId.make("build"),
          modelSelection: strong,
        });
        const [retryThreadId] = yield* runEffects(launched, 1);
        assert.deepEqual((yield* thread(retryThreadId!)).thread.modelSelection, strong);
        assert.deepEqual((yield* team).agents, [builder, reviewer]);
      }),
    ),
);

it.effect(
  "recovery settles once a task whose run ended unheard, and the task it unblocks starts once",
  () =>
    withTeam((launched) =>
      Effect.gen(function* () {
        const reactor = yield* TeamTaskReactor.TeamTaskReactor;
        const sink = yield* EventSink.EventSinkV2;
        yield* propose([task("build"), task("review", ["build"], reviewer)]);
        yield* approve();
        const [buildThreadId] = yield* runEffects(launched, 1);
        const ended = yield* endRun(buildThreadId!, "completed", "Built it.", true);
        assert.deepEqual(yield* taskStates, { build: "running#1", review: "pending#1" });

        yield* reactor.recover();
        yield* reactor.recover();
        yield* reactor.handle(ended);
        assert.deepEqual(yield* taskStates, { build: "completed#1", review: "running#1" });
        const settles = yield* sink
          .readByCommandId({
            commandId: CommandId.make(`server:team-task-settle:${buildThreadId}:${ended.runId}`),
          })
          .pipe(Stream.runCollect);
        assert.lengthOf(settles, 1);
        const [reviewThreadId] = yield* runEffects(launched, 1);
        assert.equal(reviewThreadId, yield* taskThreadId("review"));
        assert.equal(yield* Queue.size(launched), 0);
        assert.include((yield* thread(reviewThreadId!)).messages[0]!.text, "Built it.");
      }),
    ),
);

it.effect(
  "recovery leaves an unlaunched task and a working one, and the reactor settles the latter",
  () =>
    withTeam((launched) =>
      Effect.gen(function* () {
        const reactor = yield* TeamTaskReactor.TeamTaskReactor;
        yield* propose([task("build")]);
        yield* approve();
        // The plan names the task's thread before its launch effect has created it.
        yield* reactor.recover();
        assert.deepEqual(yield* taskStates, { build: "running#1" });

        const [buildThreadId] = yield* runEffects(launched, 1);
        yield* reactor.recover();
        assert.deepEqual(yield* taskStates, { build: "running#1" });

        yield* endRun(buildThreadId!, "completed", "Built it.");
        assert.deepEqual(yield* taskStates, { build: "completed#1" });
        assert.equal((yield* team).status, "completed");
      }),
    ),
);

it.effect("cancelling a team stops its running threads and leaves nothing to start", () =>
  withTeam((launched) =>
    Effect.gen(function* () {
      yield* propose([task("build"), task("docs"), task("review", ["build"], reviewer)]);
      yield* approve();
      const running = yield* runEffects(launched, 2);
      yield* dispatch({
        type: "team.cancel",
        commandId: CommandId.make("cancel"),
        threadId: leadThreadId,
      });
      yield* runEffects(launched, 0);

      assert.equal((yield* team).status, "cancelled");
      assert.deepEqual(yield* taskStates, {
        build: "cancelled#1",
        docs: "cancelled#1",
        review: "pending#1",
      });
      for (const threadId of running) {
        assert.notInclude(
          ["preparing", "starting", "running"],
          (yield* thread(threadId)).runs[0]!.status,
        );
      }
      assert.deepEqual(yield* settledOverrides([leadThreadId, ...running]), [
        null,
        "settled",
        "settled",
      ]);
    }),
  ),
);

it.effect("a task whose worktree cannot be cut fails with the reason", () =>
  withTeam(
    (launched) =>
      Effect.gen(function* () {
        const isolated = agent("isolated", fast, "worktree");
        yield* propose([task("build", [], isolated)], [isolated]);
        yield* approve();
        yield* runEffects(launched, 0);
        const plan = yield* team;
        assert.equal(plan.status, "failed");
        assert.equal(
          plan.tasks[0]!.result,
          "This task could not start: The lead thread's checkout has no commit to start a worktree from.",
        );
      }),
    { headResolves: false },
  ),
);

it.effect("a task that worked in its own worktree tells its dependents where", () =>
  withTeam((launched) =>
    Effect.gen(function* () {
      const isolated = agent("isolated", fast, "worktree");
      yield* propose(
        [task("build", [], isolated), task("review", ["build"], reviewer)],
        [isolated, reviewer],
      );
      yield* approve();
      const [buildThreadId] = yield* runEffects(launched, 1);
      const build = yield* thread(buildThreadId!);
      assert.deepInclude(build.runs[0]!.workspacePreparation, {
        type: "worktree",
        baseRef: "abc1234",
      });
      const buildResult = `Built it.\n${"x".repeat(9_000)}`;
      yield* endRun(buildThreadId!, "completed", buildResult);
      const [reviewThreadId] = yield* runEffects(launched, 1);
      const brief = (yield* thread(reviewThreadId!)).messages[0]!.text;
      assert.include(
        brief,
        `### Task build\nIts work is on branch ${build.thread.branch} in worktree ${build.thread.worktreePath}.\n${buildResult.slice(0, 8_000)}\n\n[Result shortened to fit this message.]`,
      );
      assert.notInclude(brief, buildResult.slice(0, 8_001));
      assert.notInclude(brief, "Read the task's thread");
    }),
  ),
);

it.effect(
  "neither a delegated child nor a fork takes over a thread's team, team task, workflow draft, saved workflow or workflow results",
  () =>
    withTeam((launched) =>
      Effect.gen(function* () {
        yield* propose([task("build")]);
        yield* approve();
        const [buildThreadId] = yield* runEffects(launched, 1);
        const setDraft = (threadId: ThreadId) =>
          dispatch({
            type: "workflow.draft.set",
            commandId: CommandId.make(`draft:${threadId}`),
            threadId,
            draft: {
              title: "Weekly digest",
              description: "",
              goal: "Publish a weekly digest",
              schedule: null,
              inputs: [],
              steps: [
                {
                  id: WorkflowStepId.make("draft"),
                  title: "Draft",
                  agent: "writer",
                  instructions: "Draft it.",
                  doneWhen: "",
                  dependsOn: [],
                },
              ],
              proposedAt: "2026-11-18T10:00:00.000Z",
            },
          });
        yield* setDraft(leadThreadId);
        assert.equal((yield* thread(leadThreadId)).thread.workflowDraft?.title, "Weekly digest");
        assert.include(
          rejection(yield* Effect.exit(setDraft(buildThreadId!))),
          "workflow_task_thread",
        );
        const markSaved = (threadId: ThreadId) =>
          dispatch({
            type: "workflow.draft.saved",
            commandId: CommandId.make(`saved:${threadId}`),
            threadId,
            workflowId: WorkflowId.make("workflow-digest"),
            proposedAt: "2026-11-18T10:00:00.000Z",
          });
        yield* markSaved(leadThreadId);
        assert.deepEqual((yield* thread(leadThreadId)).thread.savedWorkflow, {
          id: WorkflowId.make("workflow-digest"),
          proposedAt: "2026-11-18T10:00:00.000Z",
        });
        assert.include(
          rejection(yield* Effect.exit(markSaved(buildThreadId!))),
          "workflow_task_thread",
        );
        const fork = (sourceThreadId: ThreadId, targetThreadId: ThreadId) =>
          dispatch({
            type: "thread.fork",
            commandId: CommandId.make(`fork:${targetThreadId}`),
            sourceThreadId,
            targetThreadId,
            sourcePoint: { type: "latest_stable" },
            sideChat: true,
            createdBy: "user",
            creationSource: "web",
          }).pipe(Effect.andThen(thread(targetThreadId)));
        yield* dispatch({
          type: "workflow.run.report",
          commandId: CommandId.make("report-to-lead"),
          threadId: leadThreadId,
          workflowId: WorkflowId.make("workflow-digest"),
          run: 1,
          title: "Weekly digest",
          leadThreadId: ThreadId.make("thread:workflow:workflow-digest:1"),
          status: "completed",
          headline: null,
          result: "The digest.",
        });
        assert.lengthOf((yield* thread(leadThreadId)).thread.pendingWorkflowResults ?? [], 1);
        const leadFork = yield* fork(leadThreadId, ThreadId.make("thread:lead-fork"));
        assert.notExists(leadFork.thread.team);
        assert.notExists(leadFork.thread.workflowDraft);
        assert.notExists(leadFork.thread.savedWorkflow);
        assert.notExists(leadFork.thread.workflowResultAt);
        assert.notExists(leadFork.thread.pendingWorkflowResults);
        const taskFork = yield* fork(buildThreadId!, ThreadId.make("thread:task-fork"));
        assert.notExists(taskFork.thread.teamTask);

        yield* dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("start-lead"),
          threadId: leadThreadId,
          messageId: MessageId.make("message:start-lead"),
          text: "Delegate a check",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const leadRun = (yield* thread(leadThreadId)).runs.at(-1)!;
        yield* dispatch({
          type: "delegated_task.request",
          commandId: CommandId.make("delegate"),
          parentThreadId: leadThreadId,
          parentRunId: leadRun.id,
          parentNodeId: leadRun.rootNodeId!,
          task: "Check the build",
          modelSelection: fast,
          runtimeMode: "auto-accept-edits",
          interactionMode: "default",
          completionWake: "always",
          createdBy: "agent",
          creationSource: "mcp",
        });
        const lead = yield* thread(leadThreadId);
        assert.exists(lead.thread.team);
        const child = yield* thread(lead.subagents[0]!.childThreadId!);
        assert.notExists(child.thread.team);
      }),
    ),
);

it.effect(
  "a workflow run's result is a card in its chat, and only a new ending is news to the chat",
  () =>
    withTeam(() =>
      Effect.gen(function* () {
        const workflowId = WorkflowId.make("workflow:digest");
        const report = (
          key: string,
          run: number,
          status: "completed" | "failed" | "cancelled",
          headline: string | null = "Sent the digest",
        ) =>
          dispatch({
            type: "workflow.run.report",
            commandId: CommandId.make(`report:${key}`),
            threadId: leadThreadId,
            workflowId,
            run,
            title: "Weekly digest",
            leadThreadId: ThreadId.make(`thread:workflow:${workflowId}:${run}`),
            status,
            headline,
            result: `Digest ${run}`,
          });
        const cardOf = (run: number) =>
          thread(leadThreadId).pipe(
            Effect.map(({ turnItems }) =>
              turnItems.find((item) => item.id === `workflow-run:${workflowId}:${run}`),
            ),
          );
        yield* createLead;
        yield* dispatch({
          type: "thread.settle",
          commandId: CommandId.make("settle-chat"),
          threadId: leadThreadId,
        });
        assert.isNull((yield* thread(leadThreadId)).thread.lastVisitedAt);

        yield* TestClock.adjust("1 minute");
        const reportedAt = yield* DateTime.now;
        yield* report("first", 1, "completed");
        const first = (yield* thread(leadThreadId)).thread;
        assert.deepInclude(yield* cardOf(1), {
          type: "workflow_run",
          runId: null,
          status: "completed",
          title: "Weekly digest",
          run: 1,
          headline: "Sent the digest",
          result: "Digest 1",
          startedAt: reportedAt,
          completedAt: reportedAt,
        });
        assert.deepEqual(first.workflowResultAt, reportedAt);
        assert.deepEqual(first.pendingWorkflowResults, [
          TurnItemId.make(`workflow-run:${workflowId}:1`),
        ]);
        // Unread on every client, and back from Done.
        assert.deepEqual(first.lastVisitedAt, DateTime.subtract(reportedAt, { milliseconds: 1 }));
        assert.include(first, { settledOverride: null, settledAt: null });
        assert.deepEqual(first.unsettledAt, reportedAt);

        // The same report again changes nothing.
        yield* TestClock.adjust("1 minute");
        assert.lengthOf((yield* report("repeat", 1, "completed")).storedEvents, 0);

        // A new headline updates the card but is not news.
        yield* report("headline", 1, "completed", "Sent a shorter digest");
        assert.include(yield* cardOf(1), { headline: "Sent a shorter digest" });
        assert.deepEqual((yield* cardOf(1))?.startedAt, reportedAt);
        assert.deepInclude((yield* thread(leadThreadId)).thread, {
          workflowResultAt: reportedAt,
          pendingWorkflowResults: first.pendingWorkflowResults,
        });

        // A new ending is.
        const failedAt = yield* DateTime.now;
        yield* report("failed", 1, "failed");
        assert.include(yield* cardOf(1), { status: "failed" });
        assert.deepEqual((yield* thread(leadThreadId)).thread.workflowResultAt, failedAt);

        // The agent is given at most the five newest.
        for (const run of [2, 3, 4, 5, 6]) yield* report(`run-${run}`, run, "completed");
        assert.deepEqual(
          (yield* thread(leadThreadId)).thread.pendingWorkflowResults,
          [2, 3, 4, 5, 6].map((run) => TurnItemId.make(`workflow-run:${workflowId}:${run}`)),
        );

        // A chat with results and no run of its own can be marked unread.
        yield* dispatch({
          type: "thread.visit",
          commandId: CommandId.make("visit-chat"),
          threadId: leadThreadId,
          visitedAt: DateTime.formatIso(yield* DateTime.now),
        });
        yield* dispatch({
          type: "thread.mark-unread",
          commandId: CommandId.make("mark-chat-unread"),
          threadId: leadThreadId,
        });
        assert.deepEqual(
          (yield* thread(leadThreadId)).thread.lastVisitedAt,
          DateTime.subtract(failedAt, { milliseconds: 1 }),
        );

        yield* dispatch({
          type: "thread.delete",
          commandId: CommandId.make("delete-chat"),
          threadId: leadThreadId,
        });
        assert.include(rejection(yield* Effect.exit(report("deleted", 7, "completed"))), "deleted");
      }),
    ),
);

it.effect(
  "a workflow run's lead reviews each step, a send-back continues the step's own thread, and the last review asks for a run note",
  () =>
    withTeam((launched) =>
      Effect.gen(function* () {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* startWorkflowRun([
          { ...task("draft"), doneWhen: "It cites three sources." },
          task("publish", ["draft"]),
        ]);
        const [draftThreadId] = yield* runEffects(launched, 1);
        const brief = (yield* thread(draftThreadId!)).messages[0]!.text;
        assert.include(brief, 'You do one step of the workflow "Weekly digest".');
        assert.include(brief, "Inputs for this run:\n- Topic: AI tooling");
        assert.include(brief, "Done when: It cites three sources.");

        yield* endRun(draftThreadId!, "completed", "A draft without sources.");
        yield* worker.drain();
        assert.deepEqual(yield* taskStates, { draft: "running#1", publish: "pending#1" });
        const [wake] = yield* leadWakes;
        // A completed notification would turn the lead's reply into a Task result.
        assert.deepInclude(wake!.notification, { outcome: "updated" });
        assert.include(
          wake!.text,
          'Step "Task draft" (`draft`) is ready for your review, round 1.',
        );
        assert.include(wake!.text, "Done when: It cites three sources.");
        assert.include(wake!.text, "Result:\nA draft without sources.");
        assert.include(wake!.text, 'then call review_step with step "draft"');

        yield* reviewStep("draft", 1, "revise", "Cite three sources.");
        yield* worker.drain();
        const draft = yield* thread(draftThreadId!);
        const sentBack = draft.messages.filter((message) => message.createdBy === "agent");
        assert.lengthOf(sentBack, 1);
        assert.deepInclude(sentBack[0]!, {
          text: "The lead sent your work back:\n\nCite three sources.\n\nFix this and reply with your complete, updated result.",
          senderThreadId: leadThreadId,
        });
        assert.deepEqual(draft.thread.modelSelection, fast);
        assert.lengthOf(draft.runs, 2);

        // Its thread's next run settles too, as the next round's result.
        yield* endRun(draftThreadId!, "completed", "A draft citing three sources.");
        yield* worker.drain();
        const wakes = yield* leadWakes;
        assert.lengthOf(wakes, 2);
        const secondRound = wakes.find((message) => message.text.includes("round 2."));
        assert.include(secondRound?.text, "A draft citing three sources.");

        yield* reviewStep("draft", 2, "accept");
        const [publishThreadId] = yield* runEffects(launched, 1);
        assert.include(
          (yield* thread(publishThreadId!)).messages[0]!.text,
          "Results from earlier steps:\n\n### Task draft\nA draft citing three sources.",
        );
        yield* endRun(publishThreadId!, "completed", "Published.");
        yield* worker.drain();
        yield* reviewStep("publish", 1, "accept");
        yield* worker.drain();
        assert.equal((yield* team).status, "completed");
        const finished = (yield* leadWakes).filter(
          (message) => message.notification?.outcome === "completed",
        );
        assert.lengthOf(finished, 1);
        assert.include(finished[0]!.text, "Your workflow run finished: every step was accepted.");
        assert.include(finished[0]!.text, "call save_run_note");
      }),
    ),
);

it.effect(
  "after a restart, recovery wakes the lead again for a result it never read, and resends lost notes, once",
  () =>
    withTeam((launched) =>
      Effect.gen(function* () {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const reactor = yield* TeamTaskReactor.TeamTaskReactor;
        yield* startWorkflowRun([task("a"), task("b")]);
        const [aThreadId, bThreadId] = yield* runEffects(launched, 2);
        yield* endRun(aThreadId!, "completed", "A's result.");
        yield* endRun(bThreadId!, "completed", "B's result.");
        yield* reviewStep("b", 1, "revise", "Fix b.");
        yield* worker.drain();

        // The restart cancelled the lead's turn for a's wake and b's turn for its notes before
        // either started.
        const wakesFor = (id: string) =>
          leadWakes.pipe(
            Effect.map((wakes) => wakes.filter((wake) => wake.text.includes(`(\`${id}\`)`))),
          );
        const [lostWake] = yield* wakesFor("a");
        const leadRuns = (yield* thread(leadThreadId)).runs;
        yield* cancelUnstartedRun(
          leadThreadId,
          leadRuns.find((run) => run.userMessageId === lostWake!.id)!.id,
        );
        yield* cancelUnstartedRun(bThreadId!, (yield* thread(bThreadId!)).runs.at(-1)!.id);

        yield* reactor.recover();
        yield* reactor.recover();
        const wakes = yield* wakesFor("a");
        assert.lengthOf(wakes, 2);
        assert.include(wakes[1]!.text, "A's result.");
        const notes = (yield* thread(bThreadId!)).messages.filter(
          (message) => message.senderThreadId === leadThreadId,
        );
        assert.lengthOf(notes, 2);
        assert.equal(notes[1]!.text, notes[0]!.text);
        assert.deepEqual(yield* taskStates, { a: "running#1", b: "running#1" });
      }),
    ),
);
