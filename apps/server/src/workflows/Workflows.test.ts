import {
  type AgentModel,
  type AgentSummary,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
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
import * as TestClock from "effect/testing/TestClock";

import * as Agents from "../agents/Agents.ts";
import * as ServerConfig from "../config.ts";
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
  priced: [] as Array<{ readonly tokens: number; readonly download: boolean }>,
  /** Dollars per token; null for a model nobody has a price for. */
  pricePerToken: 0.001 as number | null,
});
type World = ReturnType<typeof makeWorld>;

const shellOf = (thread: FakeThread) =>
  ({
    id: thread.id,
    deletedAt: null,
    updatedAt: DateTime.makeUnsafe(thread.updatedAt),
    ...(thread.team === null
      ? {}
      : {
          // As teamPlanSummary makes it: a run is found by its lead thread's id, not its summary.
          teamSummary: { planId: thread.team.id, status: thread.team.status },
        }),
  }) as unknown as OrchestrationV2ThreadShell;

const appThreadOf = (thread: FakeThread) =>
  ({
    id: thread.id,
    modelSelection: { instanceId: claude, model: thread.model },
    team: thread.team,
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
    filter?: { readonly runStatuses?: ReadonlyArray<string> },
  ) =>
    find(threadId).pipe(
      Effect.map((thread) => ({
        thread: appThreadOf(thread),
        providerTurns: thread.turns,
        runs: thread.runs.filter(
          (run) => filter?.runStatuses === undefined || filter.runStatuses.includes(run.status),
        ),
      })),
    );
  return Layer.mergeAll(
    ServerConfig.layerTest(baseDir, baseDir),
    Layer.mock(Agents.Agents)({ list: Effect.sync(() => ({ agents: world.agents })) }),
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
      getThreadRecords:
        getThreadRecords as unknown as ProjectionStore.ProjectionStoreV2["Service"]["getThreadRecords"],
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      dispatch: (command) =>
        Effect.sync(() => {
          world.dispatched.push(command);
          apply(world, command);
          return { sequence: world.dispatched.length, storedEvents: [] };
        }),
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      launch: (input) =>
        Effect.sync(() => {
          const threadId = input.threadId!;
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

it.layer(NodeServices.layer)("Workflows", (it) => {
  const withWorkflows = <A, E>(
    test: (
      world: World,
    ) => Effect.Effect<A, E, Workflows.Workflows | FileSystem.FileSystem | Path.Path>,
  ) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.realPath(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "codenine-workflows-" }),
      );
      const world = makeWorld();
      return yield* test(world).pipe(
        Effect.provide(Workflows.layer.pipe(Layer.provide(fakes(baseDir, world)))),
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
        yield* lose(fileSystem, path.join(saved.path, "workflow.json"));

        yield* TestClock.setTime(at("2026-11-18T11:00:00Z"));
        yield* workflows.superviseRuns;
        expect(plan().hold?.reason).toBe("time");

        yield* workflows.remove({ name: "weekly-digest" });
        expect(world.dispatched.at(-1)).toMatchObject({ type: "team.cancel", threadId });
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
        const saved = yield* workflows.save({ workflow: digest });
        const leadOf = (run: number) => ThreadId.make(`thread:workflow:${saved.id}:${run}`);

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
        const created = world.dispatched[0]!;
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
          },
        });
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

        world.agents = [agent("researcher", "Researcher")];
        const refused = yield* Effect.flip(workflows.run({ name: "weekly-digest" }));
        expect(refused.reason).toBe("cannot-run");
        expect(refused.detail).toContain('The agent "writer" no longer exists.');
        expect(world.launched).toHaveLength(3);
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
    withWorkflows((world) =>
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
          run: { ...plan().run!, note: "Readers liked\n  the charts." },
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
        yield* TestClock.adjust("2 minutes");
        yield* workflows.superviseRuns;
        expect(sent().at(-1)).toBe(`server:workflow-cost:${planId}:final:72000`);
        expect(plan().run?.costUsd).toBe(7.2);
        expect((yield* workflows.read({ name: "weekly-digest" })).notes).toBe(
          "- 2026-11-18 run 1: Readers liked the charts.",
        );
      }),
    ),
  );
});
