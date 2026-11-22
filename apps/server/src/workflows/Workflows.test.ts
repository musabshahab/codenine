import {
  AgentError,
  type AgentModel,
  type AgentSummary,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  type TeamPlan,
  TeamPlanId,
  ThreadId,
  type WorkflowDefinition,
  type WorkflowError,
  type WorkflowLimits,
  WorkflowStepId,
} from "@codenine/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";

import * as Agents from "../agents/Agents.ts";
import * as ServerConfig from "../config.ts";
import {
  OrchestratorCommandPreviouslyRejectedError,
  OrchestratorDispatchError,
  OrchestratorProjectionError,
  workflowRunItemId,
} from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { teamTaskThreadId } from "../orchestration-v2/TeamPlan.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as UsageService from "../usage/UsageService.ts";
import * as Workflows from "./Workflows.ts";

const claude = ProviderInstanceId.make("claude_work");
const model = (name: string): AgentModel => ({ instanceId: claude, model: name, effort: "high" });
const projectId = ProjectId.make("project-site");
const at = (value: string) => Date.parse(value);

const providers = [
  {
    instanceId: claude,
    enabled: true,
    models: ["claude-x", "claude-y"].map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: null,
    })),
  },
] as unknown as ReadonlyArray<ServerProvider>;

const agent = (name: string, title: string): AgentSummary => ({
  name,
  title,
  description: title,
  model: model("claude-x"),
  skills: [],
  connectors: [],
  abilities: { readFiles: true, editFiles: true, runCommands: true, searchWeb: false },
  path: `/agents/${name}`,
  updatedAt: "2026-11-01T00:00:00.000Z",
  modelStatus: "ready",
});

const step = (id: string, agentName: string, dependsOn: ReadonlyArray<string> = []) => ({
  id: WorkflowStepId.make(id),
  title: id.charAt(0).toUpperCase() + id.slice(1),
  agent: agentName,
  model: null,
  instructions: `Do the ${id}.`,
  doneWhen: "",
  dependsOn: dependsOn.map((dependency) => WorkflowStepId.make(dependency)),
  position: { x: 0, y: 0 },
});

// Mondays at 09:00 in London, which is 09:00 UTC in November.
const digest: WorkflowDefinition = {
  name: "weekly-digest",
  title: "Weekly digest",
  description: "Writes the week's digest.",
  enabled: true,
  trigger: {
    schedule: { days: ["mon"], time: "09:00", timeZone: "Europe/London" },
    missedRuns: "once",
    position: { x: 0, y: 0 },
  },
  inputs: [{ name: "Topic", value: "Agents" }],
  lead: {
    model: model("claude-x"),
    goal: "A digest our readers trust.",
    projectId,
    approvals: "review",
    limits: { spendUsd: null, minutes: null },
  },
  steps: [
    step("research", "researcher"),
    step("draft", "writer", ["research"]),
    { ...step("check", "writer", ["draft"]), model: model("claude-y") },
  ],
};

interface FakeThread {
  readonly id: ThreadId;
  readonly model: string;
  team: TeamPlan | null;
  updatedAt: number;
  turns: Array<Pick<OrchestrationV2ProviderTurn, "turnTokenUsage" | "model">>;
  runs: Array<{ readonly status: string; readonly queueHeld?: boolean }>;
  connectors?: ReadonlyArray<string>;
  skills?: ReadonlyArray<string>;
  savedWorkflow?: OrchestrationV2AppThread["savedWorkflow"];
  deleted?: boolean;
  latestRunId?: RunId;
  messages?: Array<{ readonly role: "user" | "assistant"; readonly text: string }>;
  /** Where the thread's own latest turn stands. */
  status?: OrchestrationV2ThreadShell["status"];
}

const fakeThread = (id: ThreadId, model: string): FakeThread => ({
  id,
  model,
  team: null,
  updatedAt: 0,
  turns: [],
  runs: [],
});

type TeamStart = Extract<OrchestrationV2ServerCommand, { readonly type: "team.start" }>;

const makeWorld = () => ({
  agents: [agent("researcher", "Researcher"), agent("writer", "Writer")],
  agentsUnreadable: false as boolean,
  threads: new Map<ThreadId, FakeThread>(),
  launched: [] as Array<{
    readonly input: ThreadLaunch.ThreadLaunchInput;
    /** What the thread already held when its first message was sent. */
    readonly thread:
      | {
          readonly connectors: ReadonlyArray<string> | undefined;
          readonly skills: ReadonlyArray<string> | undefined;
        }
      | undefined;
  }>,
  dispatched: [] as Array<OrchestrationV2ServerCommand>,
  /** Every command sent, including those that failed. */
  attempted: [] as Array<OrchestrationV2ServerCommand>,
  /** Command types the fake orchestrator refuses. */
  refused: new Set<OrchestrationV2ServerCommand["type"]>(),
  /** Command types that fail without a refusal, as when the database is busy. */
  failing: new Set<OrchestrationV2ServerCommand["type"]>(),
  /** Command ids whose refusal the orchestrator recorded earlier. */
  rejected: new Set<string>(),
  /** The workflow run cards each chat holds, by thread and item id. */
  cards: new Map<string, OrchestrationV2TurnItem>(),
  priced: [] as Array<{ readonly tokens: number; readonly download: boolean }>,
  /** Dollars per token; null for a model nobody has a price for. */
  pricePerToken: 0.001 as number | null,
});
type World = ReturnType<typeof makeWorld>;

const shellOf = (thread: FakeThread) =>
  ({
    id: thread.id,
    deletedAt: thread.deleted === true ? DateTime.makeUnsafe(0) : null,
    updatedAt: DateTime.makeUnsafe(thread.updatedAt),
    latestRunId: thread.latestRunId ?? null,
    activeRunId: null,
    status: thread.status ?? "idle",
    ...(thread.team === null
      ? {}
      : {
          // As teamPlanSummary makes it: a run is found by its lead thread's id, not its summary.
          teamSummary: {
            planId: thread.team.id,
            status: thread.team.status,
            ...(thread.team.run === undefined ? {} : { run: thread.team.run }),
          },
        }),
  }) as unknown as OrchestrationV2ThreadShell;

const appThreadOf = (thread: FakeThread) =>
  ({
    id: thread.id,
    modelSelection: { instanceId: claude, model: thread.model },
    team: thread.team,
    savedWorkflow: thread.savedWorkflow,
    deletedAt: thread.deleted === true ? DateTime.makeUnsafe(0) : null,
  }) as unknown as OrchestrationV2AppThread;

/** What the orchestrator does with the commands under test, as far as these tests look. */
function apply(world: World, command: OrchestrationV2ServerCommand) {
  if (command.type === "thread.create") {
    world.threads.set(command.threadId, fakeThread(command.threadId, command.modelSelection.model));
    return;
  }
  if (command.type === "thread.metadata.update") {
    const thread = world.threads.get(command.threadId);
    if (thread !== undefined && command.connectors != null) thread.connectors = command.connectors;
    if (thread !== undefined && command.skills !== undefined) thread.skills = command.skills;
    return;
  }
  if (command.type === "workflow.run.report") {
    const { type: _type, commandId: _commandId, threadId, ...card } = command;
    const id = workflowRunItemId(command.workflowId, command.run);
    world.cards.set(`${threadId}|${id}`, {
      ...card,
      id,
      type: "workflow_run",
    } as unknown as OrchestrationV2TurnItem);
    return;
  }
  if (command.type === "workflow.draft.saved") {
    const thread = world.threads.get(command.threadId);
    if (thread !== undefined) {
      thread.savedWorkflow = { id: command.workflowId, proposedAt: command.proposedAt };
    }
    return;
  }
  if (
    command.type !== "team.start" &&
    command.type !== "team.run.update" &&
    command.type !== "team.hold" &&
    command.type !== "team.cancel"
  ) {
    return;
  }
  const lead = world.threads.get(command.threadId);
  if (lead === undefined) return;
  const plan = lead.team;
  if (command.type === "team.cancel") {
    if (plan !== null) lead.team = { ...plan, status: "cancelled" };
    return;
  }
  if (command.type === "team.start") {
    lead.team = {
      id: TeamPlanId.make(`team-plan:${command.commandId}`),
      revision: 1,
      status: "running",
      goal: command.goal,
      agents: command.agents,
      tasks: command.tasks.map((task) => ({
        ...task,
        status: "pending",
        attempt: 1,
        threadId: null,
        result: null,
        startedAt: null,
        completedAt: null,
      })),
      maxParallelPerProvider: 2,
      proposedAt: command.run.startedAt,
      updatedAt: command.run.startedAt,
      run: command.run,
    };
  } else if (plan?.run === undefined) {
    return;
  } else if (command.type === "team.run.update") {
    lead.team = { ...plan, run: { ...plan.run, costUsd: command.costUsd ?? plan.run.costUsd } };
  } else {
    lead.team = { ...plan, hold: { reason: command.reason, at: "2026-11-18T10:00:00.000Z" } };
  }
}

const fakes = (baseDir: string, world: World) => {
  const notFound = (threadId: ThreadId) =>
    new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId });
  const find = (
    threadId: ThreadId,
  ): Effect.Effect<FakeThread, ProjectionStore.ProjectionStoreThreadNotFoundError> => {
    const thread = world.threads.get(threadId);
    return thread === undefined ? Effect.fail(notFound(threadId)) : Effect.succeed(thread);
  };
  const getThreadRecords = (
    threadId: ThreadId,
    _fields: ReadonlyArray<string>,
    filter?: {
      readonly runStatuses?: ReadonlyArray<string>;
      readonly messageRoles?: ReadonlyArray<string>;
    },
  ) =>
    find(threadId).pipe(
      Effect.map((thread) => ({
        thread: appThreadOf(thread),
        messages: (thread.messages ?? []).filter(
          (message) =>
            filter?.messageRoles === undefined || filter.messageRoles.includes(message.role),
        ),
        providerTurns: thread.turns,
        runs: thread.runs.filter(
          (run) => filter?.runStatuses === undefined || filter.runStatuses.includes(run.status),
        ),
      })),
    );
  return Layer.mergeAll(
    ServerConfig.layerTest(baseDir, baseDir),
    Layer.mock(Agents.Agents)({
      list: Effect.suspend(() =>
        world.agentsUnreadable
          ? Effect.fail(new AgentError({ reason: "failed", detail: "Could not read agents." }))
          : Effect.succeed({ agents: world.agents }),
      ),
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed(providers) }),
    Layer.mock(ProjectStore.ProjectStoreV2)({
      list: (options) =>
        Effect.succeed(
          (options?.projectIds ?? [])
            .filter((id) => id === projectId)
            .map((id) => ({ projectId: id }) as unknown as ProjectStore.ProjectRow),
        ),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadShell: (threadId) =>
        Effect.sync(() => {
          const thread = world.threads.get(threadId);
          return thread === undefined ? null : shellOf(thread);
        }),
      getThread: (threadId) => find(threadId).pipe(Effect.map(appThreadOf)),
      getTurnItem: ({ threadId, itemId }) =>
        Effect.sync(() => world.cards.get(`${threadId}|${itemId}`) ?? null),
      findThreadBySavedWorkflow: (workflowId) =>
        Effect.sync(
          () =>
            [...world.threads.values()]
              .filter(
                (thread) => thread.deleted !== true && thread.savedWorkflow?.id === workflowId,
              )
              .sort((left, right) =>
                right.savedWorkflow!.proposedAt.localeCompare(left.savedWorkflow!.proposedAt),
              )[0]?.id ?? null,
        ),
      getThreadRecords:
        getThreadRecords as unknown as ProjectionStore.ProjectionStoreV2["Service"]["getThreadRecords"],
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      dispatch: (command) =>
        Effect.suspend(
          (): Effect.Effect<
            { readonly sequence: number; readonly storedEvents: ReadonlyArray<never> },
            | OrchestratorCommandPreviouslyRejectedError
            | OrchestratorDispatchError
            | OrchestratorProjectionError
          > => {
            world.attempted.push(command);
            if (world.rejected.has(command.commandId)) {
              return Effect.fail(
                new OrchestratorCommandPreviouslyRejectedError({
                  commandId: command.commandId,
                  commandType: command.type,
                  detail: "Refused before.",
                }),
              );
            }
            if (world.refused.has(command.type)) {
              return Effect.fail(
                new OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                }),
              );
            }
            if (world.failing.has(command.type)) {
              return Effect.fail(
                new OrchestratorProjectionError({ threadId: ThreadId.make("thread-busy") }),
              );
            }
            world.dispatched.push(command);
            apply(world, command);
            return Effect.succeed({ sequence: world.dispatched.length, storedEvents: [] });
          },
        ),
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      launch: (input) =>
        Effect.sync(() => {
          const threadId = input.threadId ?? ThreadId.make(`thread-chat-${world.launched.length}`);
          const existing = world.threads.get(threadId);
          world.launched.push({
            input,
            thread:
              existing === undefined
                ? undefined
                : { connectors: existing.connectors, skills: existing.skills },
          });
          if (existing === undefined) {
            world.threads.set(threadId, fakeThread(threadId, input.modelSelection.model));
          }
          return { threadId, projection: {} as never, resumed: false };
        }),
    }),
    Layer.mock(UsageService.UsageService)({
      priceTokenUsage: ({ usage, download }) =>
        Effect.sync(() => {
          const tokens = usage.reduce(
            (sum, entry) =>
              sum +
              entry.totals.uncachedInputTokens +
              entry.totals.cachedInputTokens +
              entry.totals.cacheCreationTokens +
              entry.totals.outputTokens,
            0,
          );
          world.priced.push({ tokens, download });
          return world.pricePerToken === null ? null : tokens * world.pricePerToken;
        }),
    }),
    Layer.mock(Scheduler.Scheduler)({ register: () => Effect.void }),
  );
};

const turn = (tokens: number) => ({
  model: "claude-x",
  turnTokenUsage: {
    usageScope: "main_agent",
    usageStatus: "complete",
    hasSubagents: false,
    inputTokens: tokens,
    outputTokens: 0,
  } as const,
});

const failure = <A>(effect: Effect.Effect<A, WorkflowError>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );

const teamStarts = (world: World) =>
  world.dispatched.filter((command): command is TeamStart => command.type === "team.start");

const sentOfType = <T extends OrchestrationV2ServerCommand["type"]>(
  commands: ReadonlyArray<OrchestrationV2ServerCommand>,
  type: T,
) =>
  commands.filter(
    (command): command is Extract<OrchestrationV2ServerCommand, { readonly type: T }> =>
      command.type === type,
  );

it.layer(NodeServices.layer)("Workflows", (it) => {
  const withWorkflows = <A, E>(
    test: (
      world: World,
      /** A fresh service on the same files and threads, as after a restart. */
      restarted: Effect.Effect<
        Workflows.Workflows["Service"],
        PlatformError.PlatformError,
        FileSystem.FileSystem | Path.Path
      >,
    ) => Effect.Effect<A, E, Workflows.Workflows | FileSystem.FileSystem | Path.Path>,
  ) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.realPath(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "codenine-workflows-" }),
      );
      const world = makeWorld();
      const fakeLayer = fakes(baseDir, world);
      // Fresh, or the memoized service and what it holds in memory would come back.
      const restarted = Effect.service(Workflows.Workflows).pipe(
        Effect.provide(Layer.fresh(Workflows.layer).pipe(Layer.provide(fakeLayer))),
      );
      return yield* test(world, restarted).pipe(
        Effect.provide(Workflows.layer.pipe(Layer.provide(fakeLayer))),
      );
    }).pipe(Effect.scoped);

  it.effect("creates, lists by title, renames keeping the id, and deletes workflows", () =>
    withWorkflows(() =>
      Effect.gen(function* () {
        yield* TestClock.setTime(at("2026-11-18T10:00:00Z"));
        const workflows = yield* Workflows.Workflows;
        const saved = yield* workflows.save({ workflow: digest, notes: "- Keep it short." });
        expect(saved).toMatchObject({
          name: "weekly-digest",
          problems: [],
          notes: "- Keep it short.",
          nextRunAt: "2026-11-23T09:00:00.000Z",
          skipped: [],
        });
        yield* workflows.save({
          workflow: {
            ...digest,
            name: "archive",
            title: "Archive",
            enabled: false,
            lead: { ...digest.lead, model: null },
          },
        });
        expect(yield* failure(workflows.save({ workflow: digest }))).toBe("exists");
        expect(
          yield* failure(
            workflows.save({
              workflow: { ...digest, steps: [step("draft", "writer", ["draft"])] },
              previousName: "weekly-digest",
            }),
          ),
        ).toBe("invalid");

        const listed = (yield* workflows.list).workflows;
        expect(
          listed.map((workflow) => [
            workflow.name,
            workflow.nextRunAt,
            workflow.problems.map((problem) => problem.message),
          ]),
        ).toEqual([
          ["archive", null, ["Choose a model for the lead."]],
          ["weekly-digest", "2026-11-23T09:00:00.000Z", []],
        ]);
        expect("instructions" in listed[1]!.steps[0]!).toBe(false);

        const { enabled: _enabled, nextRunAt: _nextRunAt, updatedAt: _updatedAt, ...kept } = saved;
        expect(
          yield* workflows.setEnabled({ name: "weekly-digest", enabled: false }),
        ).toMatchObject({ ...kept, enabled: false, nextRunAt: null });
        expect(
          (yield* workflows.setEnabled({ name: "weekly-digest", enabled: true })).nextRunAt,
        ).toBe("2026-11-23T09:00:00.000Z");
        expect(yield* failure(workflows.setEnabled({ name: "missing", enabled: true }))).toBe(
          "not-found",
        );

        const renamed = yield* workflows.save({
          workflow: { ...digest, name: "digest", title: "Digest" },
          previousName: "weekly-digest",
        });
        expect(renamed).toMatchObject({ id: saved.id, title: "Digest", notes: "- Keep it short." });
        expect(yield* failure(workflows.read({ name: "weekly-digest" }))).toBe("not-found");
        expect(
          yield* failure(
            workflows.save({ workflow: { ...digest, name: "archive" }, previousName: "digest" }),
          ),
        ).toBe("exists");
        const cleared = yield* workflows.save({
          workflow: { ...digest, name: "digest" },
          previousName: "digest",
          notes: "",
        });
        expect(cleared.notes).toBe("");

        yield* workflows.remove({ name: "digest" });
        expect(yield* failure(workflows.read({ name: "digest" }))).toBe("not-found");
        expect(yield* failure(workflows.remove({ name: "digest" }))).toBe("not-found");
      }),
    ),
  );

  it.effect("links a workflow saved from a chat draft, and refuses a second copy", () =>
    withWorkflows((world) =>
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        const fileSystem = yield* FileSystem.FileSystem;
        const chat = ThreadId.make("thread-chat");
        world.threads.set(chat, fakeThread(chat, "claude-x"));
        const fromDraft = { threadId: chat, proposedAt: "2026-11-18T10:00:00.000Z" };
        // Two tabs save one draft at once under different names: only one becomes a workflow.
        const raced = yield* Effect.all(
          [
            workflows.save({ workflow: digest, fromDraft }),
            workflows.save({ workflow: { ...digest, name: "digest-race" }, fromDraft }),
          ],
          { concurrency: 2, mode: "result" },
        );
        const [saved, ...others] = raced.filter(Result.isSuccess).map((result) => result.success);
        expect(others).toEqual([]);
        expect(raced.filter(Result.isFailure).map((result) => result.failure.reason)).toEqual([
          "exists",
        ]);
        expect(
          world.dispatched.filter((command) => command.type === "workflow.draft.saved"),
        ).toEqual([
          expect.objectContaining({
            threadId: chat,
            workflowId: saved!.id,
            proposedAt: fromDraft.proposedAt,
          }),
        ]);
        const { name } = saved!;

        const copy = { ...digest, name: "digest-copy" };
        const copyFolder = saved!.path.replace(new RegExp(`${name}$`), "digest-copy");
        expect(yield* Effect.flip(workflows.save({ workflow: copy, fromDraft }))).toMatchObject({
          reason: "exists",
          detail:
            "This chat's draft is already saved as Weekly digest. Open it from the chat's Workflow tab.",
        });
        expect(yield* fileSystem.exists(copyFolder)).toBe(false);

        const newer = { threadId: chat, proposedAt: "2026-11-18T11:00:00.000Z" };
        yield* workflows.save({
          workflow: { ...digest, name },
          previousName: name,
          fromDraft: newer,
        });
        expect(world.dispatched.at(-1)).toMatchObject({
          type: "workflow.draft.saved",
          workflowId: saved!.id,
          proposedAt: newer.proposedAt,
        });

        // Deleted, so the chat's draft can be saved again; a failed link does not undo the save.
        yield* workflows.remove({ name });
        world.refused.add("workflow.draft.saved");
        const again = yield* workflows.save({ workflow: copy, fromDraft: newer });
        expect(again.name).toBe("digest-copy");
        expect(yield* fileSystem.exists(copyFolder)).toBe(true);
        expect(world.threads.get(chat)?.savedWorkflow?.id).toBe(saved!.id);

        // A read that fails after the write still links, so the chat does not offer the draft again.
        world.refused.clear();
        world.agentsUnreadable = true;
        const latest = { threadId: chat, proposedAt: "2026-11-18T12:00:00.000Z" };
        expect(yield* failure(workflows.save({ workflow: digest, fromDraft: latest }))).toBe(
          "failed",
        );
        world.agentsUnreadable = false;
        expect(world.threads.get(chat)?.savedWorkflow).toEqual({
          id: (yield* workflows.list).workflows.find((entry) => entry.name === digest.name)?.id,
          proposedAt: latest.proposedAt,
        });
      }),
    ),
  );

  it.effect("leaves a workflow.json it cannot read out of the list, and still deletes it", () =>
    withWorkflows(() =>
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const saved = yield* workflows.save({ workflow: digest });
        const folder = path.join(path.dirname(saved.path), "broken");
        yield* fileSystem.makeDirectory(folder);
        yield* fileSystem.writeFileString(path.join(folder, "workflow.json"), "{ not json");
        yield* fileSystem.writeFileString(path.join(path.dirname(saved.path), "notes.txt"), "");

        expect((yield* workflows.list).workflows.map((workflow) => workflow.name)).toEqual([
          "weekly-digest",
        ]);
        expect(yield* failure(workflows.read({ name: "broken" }))).toBe("invalid");
        expect(yield* failure(workflows.run({ name: "broken" }))).toBe("invalid");
        expect(yield* failure(workflows.setEnabled({ name: "broken", enabled: true }))).toBe(
          "invalid",
        );
        expect(yield* fileSystem.readFileString(path.join(folder, "workflow.json"))).toBe(
          "{ not json",
        );
        yield* workflows.remove({ name: "broken" });
        expect(yield* fileSystem.exists(folder)).toBe(false);
      }),
    ),
  );

  it.effect.each([
    [
      "broke",
      (fileSystem: FileSystem.FileSystem, file: string) =>
        fileSystem.writeFileString(file, "{ not json"),
    ],
    ["is gone", (fileSystem: FileSystem.FileSystem, file: string) => fileSystem.remove(file)],
  ] as const)("still holds a run whose workflow.json %s, and stops it when deleted", ([, lose]) =>
    withWorkflows((world) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(at("2026-11-18T10:00:00Z"));
        const workflows = yield* Workflows.Workflows;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const saved = yield* workflows.save({
          workflow: {
            ...digest,
            lead: { ...digest.lead, limits: { spendUsd: null, minutes: 60 } },
          },
        });
        const { threadId } = yield* workflows.run({ name: "weekly-digest" });
        const plan = () => world.threads.get(threadId)!.team!;
        const chat = teamStarts(world)[0]!.run.chatThreadId!;
        const lead = world.threads.get(threadId)!;
        lead.latestRunId = RunId.make("run-lead-last");
        lead.messages = [
          { role: "user", text: "Stop." },
          { role: "assistant", text: "Stopped before the draft." },
        ];
        yield* lose(fileSystem, path.join(saved.path, "workflow.json"));

        yield* TestClock.setTime(at("2026-11-18T11:00:00Z"));
        yield* workflows.superviseRuns;
        expect(plan().hold?.reason).toBe("time");

        // The lead and the chat are both mid-turn when the workflow is deleted.
        lead.runs = [{ status: "running" }];
        world.threads.get(chat)!.status = "running";
        yield* workflows.remove({ name: "weekly-digest" });
        // The folder and its supervision go away, so the stopped run reports to its chat now. The
        // lead's last message may still be streaming, so it is not the result, and it stays unread.
        expect(world.dispatched.slice(-2)).toMatchObject([
          { type: "team.cancel", threadId },
          {
            type: "workflow.run.report",
            threadId: chat,
            run: 1,
            leadThreadId: threadId,
            status: "cancelled",
            result: null,
          },
        ]);
        expect(sentOfType(world.dispatched, "thread.visit")).toEqual([]);
        expect(plan().status).toBe("cancelled");
        expect(yield* fileSystem.exists(saved.path)).toBe(false);
      }),
    ),
  );

  it.effect("starts a run as a lead thread, then its team, numbering runs without reuse", () =>
    withWorkflows((world) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(at("2026-11-18T10:00:00Z"));
        const workflows = yield* Workflows.Workflows;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // Saved from a chat, so its runs report to that chat.
        const chat = ThreadId.make("thread-chat");
        world.threads.set(chat, fakeThread(chat, "claude-x"));
        const saved = yield* workflows.save({
          workflow: digest,
          fromDraft: { threadId: chat, proposedAt: "2026-11-18T09:00:00.000Z" },
        });
        const leadOf = (run: number) => ThreadId.make(`thread:workflow:${saved.id}:${run}`);
        const chatOfState = () =>
          fileSystem
            .readFileString(path.join(saved.path, "state.json"))
            .pipe(Effect.map((contents) => JSON.parse(contents).chatThreadId));

        expect(yield* workflows.run({ name: "weekly-digest" })).toEqual({
          threadId: leadOf(1),
          run: 1,
        });
        const lead = {
          threadId: leadOf(1),
          projectId,
          title: "Weekly digest · run 1",
          modelSelection: { instanceId: claude, model: "claude-x" },
          runtimeMode: "auto",
          interactionMode: "default",
          createdBy: "system",
          creationSource: "server",
        };
        const created = world.dispatched.find((command) => command.type === "thread.create")!;
        expect(created).toMatchObject({
          type: "thread.create",
          commandId: `server:workflow-lead:${saved.id}:1`,
          ...lead,
        });
        expect("agent" in created).toBe(false);
        // The lead reaches none of the user's apps or skills, from its first turn on.
        const launch = world.launched[0]!;
        expect(launch.thread).toEqual({ connectors: [], skills: [] });
        expect(launch.input).toMatchObject({
          ...lead,
          commandId: `server:workflow-launch:${saved.id}:1`,
          reuseExistingThread: true,
          workspaceStrategy: { type: "root" },
        });
        expect(launch.input.initialMessage?.text).toMatch(
          /^You lead run 1 of the workflow 'Weekly digest'\./u,
        );
        const start = teamStarts(world)[0]!;
        expect(start).toMatchObject({
          commandId: `server:workflow-start:${saved.id}:1`,
          threadId: leadOf(1),
          goal: "A digest our readers trust.",
          run: {
            workflowId: saved.id,
            workflowName: "weekly-digest",
            title: "Weekly digest",
            run: 1,
            trigger: "manual",
            scheduledFor: null,
            inputs: digest.inputs,
            approvals: "review",
            limits: digest.lead.limits,
            startedAt: "2026-11-18T10:00:00.000Z",
            costUsd: null,
            headline: null,
            note: null,
            chatThreadId: chat,
          },
        });
        expect(yield* chatOfState()).toBe(chat);
        expect(start.agents.map((member) => member.id)).toEqual([
          "researcher",
          "writer",
          "writer:2",
        ]);

        yield* workflows.save({
          workflow: { ...digest, lead: { ...digest.lead, approvals: "ask" } },
          previousName: "weekly-digest",
        });
        const override = [{ name: "Topic", value: "Robots" }];
        expect((yield* workflows.run({ name: "weekly-digest", inputs: override })).run).toBe(2);
        expect(world.launched[1]?.input.runtimeMode).toBe("full-access");
        expect(teamStarts(world)[1]?.run.inputs).toEqual(override);

        // A state file that went missing must not hand out a number whose lead exists.
        yield* fileSystem.remove(path.join(saved.path, "state.json"));
        expect((yield* workflows.run({ name: "weekly-digest" })).run).toBe(3);
        expect(teamStarts(world)[2]?.run.chatThreadId).toBe(chat);
        expect(yield* chatOfState()).toBe(chat);

        // Its chat was deleted, so the next run starts a new chat named after the workflow.
        world.threads.get(chat)!.deleted = true;
        yield* workflows.run({ name: "weekly-digest" });
        const madeChat = world.launched.at(-2)!;
        expect(madeChat.input).toEqual({
          commandId: expect.stringMatching(`^server:workflow-chat:${saved.id}:`),
          projectId,
          title: "Weekly digest",
          modelSelection: { instanceId: claude, model: "claude-x" },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdBy: "system",
          creationSource: "server",
          workspaceStrategy: { type: "root" },
        });
        const newChat = teamStarts(world)[3]!.run.chatThreadId!;
        expect(newChat).not.toBe(chat);
        expect(world.threads.get(newChat)?.savedWorkflow?.id).toBe(saved.id);
        expect(yield* chatOfState()).toBe(newChat);

        // An editor-made workflow gets one chat on its first run, and keeps it.
        const briefing = yield* workflows.save({
          workflow: { ...digest, name: "briefing", title: "Briefing" },
        });
        const launchedBefore = world.launched.length;
        yield* workflows.run({ name: "briefing" });
        yield* workflows.run({ name: "briefing" });
        expect(world.launched.slice(launchedBefore).map(({ input }) => input.title)).toEqual([
          "Briefing",
          "Briefing · run 1",
          "Briefing · run 2",
        ]);
        const briefingChat = teamStarts(world)[4]!.run.chatThreadId!;
        expect(teamStarts(world)[5]!.run.chatThreadId).toBe(briefingChat);
        expect(
          sentOfType(world.dispatched, "workflow.draft.saved").filter(
            (command) => command.workflowId === briefing.id,
          ),
        ).toEqual([expect.objectContaining({ threadId: briefingChat })]);

        // A chat whose link failed still takes its run's result, and when state.json lost it too,
        // the next run finds it through the run before.
        const standup = yield* workflows.save({
          workflow: { ...digest, name: "standup", title: "Standup" },
        });
        world.refused.add("workflow.draft.saved");
        yield* workflows.run({ name: "standup" });
        world.refused.clear();
        const standupChat = teamStarts(world)[6]!.run.chatThreadId;
        expect(world.threads.has(standupChat!)).toBe(true);
        yield* fileSystem.remove(path.join(standup.path, "state.json"));
        yield* workflows.run({ name: "standup" });
        expect(teamStarts(world)[7]!.run.chatThreadId).toBe(standupChat);
        expect(world.launched.filter(({ input }) => input.title === "Standup")).toHaveLength(1);

        world.agents = [agent("researcher", "Researcher")];
        const launchedBeforeRefusal = world.launched.length;
        const refused = yield* Effect.flip(workflows.run({ name: "weekly-digest" }));
        expect(refused.reason).toBe("cannot-run");
        expect(refused.detail).toContain('The agent "writer" no longer exists.');
        expect(world.launched).toHaveLength(launchedBeforeRefusal);
      }),
    ),
  );

  it.effect("runs on schedule one run at a time, and makes up for missed times once", () =>
    withWorkflows((world) =>
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        const started = () =>
          teamStarts(world).map(({ run }) => [run.run, run.trigger, run.scheduledFor]);
        const finish = (run: number) => {
          const lead = world.threads.get(teamStarts(world)[run - 1]!.threadId)!;
          lead.team = { ...lead.team!, status: "completed" };
        };

        yield* TestClock.setTime(at("2026-11-16T08:00:00Z"));
        yield* workflows.save({ workflow: digest });
        yield* workflows.runDue;
        yield* TestClock.setTime(at("2026-11-16T09:00:05Z"));
        yield* workflows.runDue;
        expect(started()).toEqual([[1, "schedule", "2026-11-16T09:00:00.000Z"]]);

        // A week later run 1 has not ended, so the next run waits for it.
        yield* TestClock.setTime(at("2026-11-23T09:00:03Z"));
        yield* workflows.runDue;
        expect(started()).toHaveLength(1);
        finish(1);
        yield* TestClock.setTime(at("2026-11-23T09:10:00Z"));
        yield* workflows.runDue;
        expect(started()[1]).toEqual([2, "schedule", "2026-11-23T09:00:00.000Z"]);
        finish(2);

        // Codenine was off on the next two Mondays.
        yield* TestClock.setTime(at("2026-12-09T12:00:00Z"));
        yield* workflows.runDue;
        yield* workflows.runDue;
        expect(started().slice(2)).toEqual([[3, "missed", "2026-12-07T09:00:00.000Z"]]);
        expect((yield* workflows.read({ name: "weekly-digest" })).skipped).toEqual([]);
      }),
    ),
  );

  it.effect("skips missed times when told to, and times that cannot run, newest first", () =>
    withWorkflows((world) =>
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        yield* TestClock.setTime(at("2026-11-16T08:00:00Z"));
        yield* workflows.save({
          workflow: { ...digest, trigger: { ...digest.trigger, missedRuns: "skip" } },
        });
        yield* workflows.runDue;
        yield* TestClock.setTime(at("2026-12-09T12:00:00Z"));
        yield* workflows.runDue;
        world.agents = [];
        yield* TestClock.setTime(at("2026-12-14T09:00:30Z"));
        yield* workflows.runDue;

        expect(teamStarts(world)).toEqual([]);
        expect((yield* workflows.read({ name: "weekly-digest" })).skipped).toEqual(
          ["12-14", "12-07", "11-30", "11-23", "11-16"].map((day) => ({
            scheduledFor: `2026-${day}T09:00:00.000Z`,
          })),
        );
      }),
    ),
  );

  it.effect("prices a running run, holds it at each limit, and adds its note once", () =>
    withWorkflows((world, restarted) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(at("2026-11-18T10:00:00Z"));
        const workflows = yield* Workflows.Workflows;
        yield* workflows.save({
          workflow: { ...digest, lead: { ...digest.lead, limits: { spendUsd: 1, minutes: 60 } } },
        });
        const { threadId } = yield* workflows.run({ name: "weekly-digest" });
        const lead = world.threads.get(threadId)!;
        const plan = () => lead.team!;
        const research = teamTaskThreadId(plan().id, plan().tasks[0]!.id, 1);
        world.threads.set(research, {
          id: research,
          model: "claude-x",
          team: null,
          updatedAt: 0,
          turns: [turn(300)],
          runs: [],
        });
        lead.turns.push(turn(200));
        const sent = () =>
          world.dispatched
            .filter((command) => command.type === "team.run.update" || command.type === "team.hold")
            .map((command) => command.commandId);
        const planId = plan().id;
        const resume = (limits: WorkflowLimits, tasks = plan().tasks) => {
          const { hold: _hold, ...held } = plan();
          lead.team = { ...held, tasks, run: { ...held.run!, limits } };
        };

        yield* workflows.superviseRuns;
        expect(world.priced).toEqual([{ tokens: 500, download: true }]);
        expect(plan().run?.costUsd).toBe(0.5);

        // Prices are checked again only after a while; the run then passes its spending limit.
        lead.turns.push(turn(700));
        yield* workflows.superviseRuns;
        expect(world.priced).toHaveLength(1);
        yield* TestClock.adjust("30 seconds");
        yield* workflows.superviseRuns;
        expect(sent()).toEqual([
          `server:workflow-cost:${planId}:50`,
          `server:workflow-cost:${planId}:120`,
          `server:workflow-hold:${planId}:spend:1`,
        ]);

        // Held, it is still priced; a price nobody knows leaves the estimate as it was.
        world.pricePerToken = null;
        lead.turns.push(turn(5_000));
        yield* TestClock.adjust("30 seconds");
        yield* workflows.superviseRuns;
        expect(world.priced).toHaveLength(3);
        expect(sent()).toHaveLength(3);

        // The user raised the limit and went on, but the run can no longer be priced against it.
        resume({ spendUsd: 5, minutes: 60 });
        yield* TestClock.adjust("30 seconds");
        yield* workflows.superviseRuns;
        expect(sent().at(-1)).toBe(`server:workflow-hold:${planId}:unpriced:5`);

        // They went on without a spending limit; then the run reaches its time limit.
        resume({ spendUsd: null, minutes: 60 });
        yield* TestClock.setTime(at("2026-11-18T11:00:00Z"));
        yield* workflows.superviseRuns;
        expect(sent().at(-1)).toBe(`server:workflow-hold:${planId}:time:60`);

        // A result has waited two minutes for the lead, which still has a turn queued for it.
        const review = { round: 2, awaiting: true, awaitingSince: "2026-11-18T11:00:00.000Z" };
        resume(
          { spendUsd: null, minutes: 120 },
          plan().tasks.map((task, index) =>
            index === 1 ? { ...task, status: "running", review } : task,
          ),
        );
        lead.runs = [{ status: "queued" }];
        yield* TestClock.setTime(at("2026-11-18T11:02:00Z"));
        yield* workflows.superviseRuns;
        expect(sent().at(-1)).toBe(`server:workflow-hold:${planId}:time:60`);
        lead.runs = [{ status: "queued", queueHeld: true }];
        yield* workflows.superviseRuns;
        expect(sent().at(-1)).toBe(`server:workflow-hold:${planId}:review:draft:1:2`);

        lead.team = {
          ...plan(),
          status: "completed",
          tasks: plan().tasks.map((task) => ({
            ...task,
            status: "completed",
            result: `${task.title} done.`,
          })),
          run: {
            ...plan().run!,
            headline: "Sent the digest",
            note: "Readers liked\n  the charts.",
          },
        };
        // The lead's last turn comes after the plan ends: its note and cost wait for it.
        lead.runs = [{ status: "running" }];
        lead.updatedAt = 1;
        yield* workflows.superviseRuns;
        expect((yield* workflows.read({ name: "weekly-digest" })).notes).toBe("");
        world.pricePerToken = 0.001;
        lead.turns.push(turn(1_000));
        lead.runs = [];
        lead.updatedAt = 2;
        // The chat has a turn going, which a card posted now would split; the result waits for it.
        const chat = world.threads.get(teamStarts(world)[0]!.run.chatThreadId!)!;
        chat.status = "running";
        yield* TestClock.adjust("2 minutes");
        yield* workflows.superviseRuns;
        expect(sent().at(-1)).toBe(`server:workflow-cost:${planId}:final:72000`);
        expect(plan().run?.costUsd).toBe(7.2);
        expect(sentOfType(world.attempted, "workflow.run.report")).toEqual([]);
        // The result is reported before the note is kept, so a refused report keeps both for later.
        chat.status = "completed";
        world.refused.add("workflow.run.report");
        yield* TestClock.adjust("2 minutes");
        yield* workflows.superviseRuns;
        expect((yield* workflows.read({ name: "weekly-digest" })).notes).toBe("");
        const [report] = sentOfType(world.attempted, "workflow.run.report");
        expect(report).toMatchObject({
          threadId: teamStarts(world)[0]!.run.chatThreadId,
          title: "Weekly digest",
          run: 1,
          leadThreadId: threadId,
          status: "completed",
          headline: "Sent the digest",
          // Only the last step's result: the others fed into it.
          result: "Check done.",
        });
        expect(sentOfType(world.dispatched, "thread.visit")).toEqual([]);

        // After a restart the same report goes out under the same id. Its refusal was recorded while
        // the chat is live, so it goes out once more under a new id; then the lead is marked read.
        world.refused.clear();
        world.rejected.add(report!.commandId);
        yield* (yield* restarted).superviseRuns;
        const retryId = expect.stringMatching(new RegExp(`^${report!.commandId}:retry:`, "u"));
        expect(sentOfType(world.attempted, "workflow.run.report").map((c) => c.commandId)).toEqual([
          report!.commandId,
          report!.commandId,
          retryId,
        ]);
        expect(world.dispatched.slice(-2)).toMatchObject([
          { type: "workflow.run.report", commandId: retryId },
          {
            type: "thread.visit",
            commandId: `server:workflow-run-read:${threadId}:1970-01-01T00:00:00.002Z`,
            threadId,
          },
        ]);
        expect((yield* workflows.read({ name: "weekly-digest" })).notes).toBe(
          "- 2026-11-18 run 1: Readers liked the charts.",
        );
      }),
    ),
  );

  it.effect(
    "keeps a posted result when the run's lead talks on, and posts none to a gone chat",
    () =>
      withWorkflows((world) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(at("2026-11-18T10:00:00Z"));
          const workflows = yield* Workflows.Workflows;
          yield* workflows.save({ workflow: digest });
          const { threadId } = yield* workflows.run({ name: "weekly-digest" });
          const chat = teamStarts(world)[0]!.run.chatThreadId!;
          const lead = world.threads.get(threadId)!;
          const reports = () => sentOfType(world.attempted, "workflow.run.report");
          // It failed before any step finished, so the lead's last message is its result.
          lead.team = { ...lead.team!, status: "failed" };
          lead.latestRunId = RunId.make("run-lead-1");
          lead.messages = [
            { role: "assistant", text: "The research step could not reach the site." },
          ];
          lead.updatedAt = 1;
          yield* workflows.superviseRuns;
          expect(reports().map((report) => report.result)).toEqual([
            "The research step could not reach the site.",
          ]);

          // The user asks the lead why; its answer is not the run's result, but a new headline is news.
          lead.latestRunId = RunId.make("run-lead-2");
          lead.messages = [{ role: "assistant", text: "The site was down for maintenance." }];
          lead.team = { ...lead.team, run: { ...lead.team.run!, headline: "Site unreachable" } };
          lead.updatedAt = 2;
          yield* TestClock.adjust("2 minutes");
          yield* workflows.superviseRuns;
          expect(reports().map(({ headline, result }) => [headline, result])).toEqual([
            [null, "The research step could not reach the site."],
            ["Site unreachable", "The research step could not reach the site."],
          ]);

          // Its chat was deleted, so nothing is posted and the run counts as reported.
          world.threads.get(chat)!.deleted = true;
          lead.team = { ...lead.team, run: { ...lead.team.run!, headline: "Site down" } };
          lead.updatedAt = 3;
          yield* TestClock.adjust("2 minutes");
          yield* workflows.superviseRuns;
          expect(reports()).toHaveLength(2);
          expect(sentOfType(world.dispatched, "thread.visit").at(-1)?.commandId).toBe(
            `server:workflow-run-read:${threadId}:1970-01-01T00:00:00.003Z`,
          );
        }),
      ),
  );
});
