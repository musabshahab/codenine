import {
  ProviderInstanceId,
  TeamAgentId,
  TeamPlanId,
  TeamTaskId,
  type TeamAgent,
  type TeamPlanRun,
  type TeamTask,
  type TeamTaskStatus,
  WorkflowId,
} from "@codenine/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  settledTeamPlanStatus,
  startableTeamTasks,
  teamPlanSummary,
  teamResultCap,
  validateTeamDraft,
  workflowStepsIssue,
} from "./team.ts";

const agent = (id: string, instanceId = "codex", instructions?: string): TeamAgent => ({
  id: TeamAgentId.make(id),
  label: id,
  role: "implement",
  modelSelection: { instanceId: ProviderInstanceId.make(instanceId), model: "model" },
  workspace: "shared",
  ...(instructions === undefined ? {} : { instructions }),
});

const task = (
  id: string,
  options: {
    readonly agent?: string;
    readonly dependsOn?: ReadonlyArray<string>;
    readonly status?: TeamTaskStatus;
    readonly brief?: string;
    readonly doneWhen?: string;
    readonly instanceId?: string;
  } = {},
): TeamTask => ({
  id: TeamTaskId.make(id),
  title: id,
  brief: options.brief ?? `Do ${id}`,
  agentId: TeamAgentId.make(options.agent ?? "a"),
  dependsOn: (options.dependsOn ?? []).map((dependency) => TeamTaskId.make(dependency)),
  status: options.status ?? "pending",
  attempt: 1,
  threadId: null,
  result: null,
  startedAt: null,
  completedAt: null,
  ...(options.doneWhen === undefined ? {} : { doneWhen: options.doneWhen }),
  ...(options.instanceId === undefined
    ? {}
    : {
        modelSelection: {
          instanceId: ProviderInstanceId.make(options.instanceId),
          model: "other-model",
        },
      }),
});

const step = (id: string, dependsOn: ReadonlyArray<string> = []) => ({ id, dependsOn });

const plan = (
  tasks: ReadonlyArray<TeamTask>,
  agents: ReadonlyArray<TeamAgent> = [agent("a")],
  maxParallelPerProvider = 2,
) => ({ agents, tasks, maxParallelPerProvider });

const startable = (...args: Parameters<typeof plan>) =>
  startableTeamTasks(plan(...args)).map((candidate) => candidate.id);

// Ten full briefs: 60,000 characters of the 64,000 a plan's text may have.
const fullBriefs = Array.from({ length: 10 }, (_, index) =>
  task(`t${index}`, { brief: "x".repeat(6_000) }),
);

describe("validateTeamDraft", () => {
  it.each([
    ["a valid chain", [agent("a")], [task("one"), task("two", { dependsOn: ["one"] })], null],
    ["no tasks", [agent("a")], [], "empty"],
    [
      "more agents than the limit",
      Array.from({ length: 13 }, (_, index) => agent(`a${index}`)),
      [task("one", { agent: "a0" })],
      "too_large",
    ],
    [
      "more tasks than the limit",
      [agent("a")],
      Array.from({ length: 33 }, (_, index) => task(`t${index}`)),
      "too_large",
    ],
    ["a repeated agent id", [agent("a"), agent("a")], [task("one")], "duplicate_id"],
    ["a repeated task id", [agent("a")], [task("one"), task("one")], "duplicate_id"],
    [
      "a brief over the limit",
      [agent("a")],
      [task("one", { brief: "x".repeat(6_001) })],
      "text_too_long",
    ],
    [
      "a done-when line over the limit",
      [agent("a")],
      [task("one", { doneWhen: "x".repeat(1_001) })],
      "text_too_long",
    ],
    [
      "member instructions over the limit",
      [agent("a", "codex", "x".repeat(2_001))],
      [task("one")],
      "text_too_long",
    ],
    ["the plan's text at its limit", [agent("a")], fullBriefs, null, "x".repeat(4_000)],
    [
      "the plan's text over its limit by the goal",
      [agent("a")],
      fullBriefs,
      "too_large",
      "x".repeat(4_001),
    ],
    [
      "the plan's text over its limit by instructions and done-when lines",
      [agent("a", "codex", "x".repeat(2_000))],
      [
        ...fullBriefs.slice(0, 9),
        task("t9", { brief: "x".repeat(3_000), doneWhen: "x".repeat(1_000) }),
      ],
      "too_large",
      "x".repeat(4_001),
    ],
    [
      "a task for an agent not on the team",
      [agent("a")],
      [task("one", { agent: "b" })],
      "unknown_agent",
    ],
    [
      "a dependency that is not a task",
      [agent("a")],
      [task("one", { dependsOn: ["missing"] })],
      "unknown_dependency",
    ],
    [
      "a task that depends on itself",
      [agent("a")],
      [task("one", { dependsOn: ["one"] })],
      "dependency_cycle",
    ],
    [
      "a cycle through three tasks",
      [agent("a")],
      [
        task("one", { dependsOn: ["three"] }),
        task("two", { dependsOn: ["one"] }),
        task("three", { dependsOn: ["two"] }),
      ],
      "dependency_cycle",
    ],
  ] as const)("reports %s", (_name, agents, tasks, reason, goal?: string) => {
    expect(validateTeamDraft({ goal, agents, tasks })?.reason ?? null).toBe(reason);
  });

  it("says how long the plan's text is", () => {
    expect(
      validateTeamDraft({ goal: "x".repeat(4_001), agents: [agent("a")], tasks: fullBriefs })
        ?.message,
    ).toBe(
      "The team's text is 64,001 characters; the most is 64,000. Shorten the briefs or combine tasks.",
    );
  });

  it("names the tasks of a cycle in dependency order", () => {
    const issue = validateTeamDraft({
      agents: [agent("a")],
      tasks: [task("one", { dependsOn: ["two"] }), task("two", { dependsOn: ["one"] })],
    });
    expect(issue?.message).toBe("Tasks depend on each other in a cycle: one -> two -> one.");
  });
});

describe("startableTeamTasks", () => {
  it("starts a task only once every dependency completed", () => {
    const tasks = (first: TeamTaskStatus, second: TeamTaskStatus) => [
      task("first", { status: first }),
      task("second", { status: second }),
      task("third", { dependsOn: ["first", "second"] }),
    ];
    expect(startable(tasks("completed", "running"))).toEqual([]);
    expect(startable(tasks("completed", "failed"))).toEqual([]);
    expect(startable(tasks("completed", "completed"))).toEqual(["third"]);
  });

  it("caps running tasks per provider instance, counting those already running, in plan order", () => {
    const agents = [agent("a"), agent("b"), agent("c", "claude")];
    const tasks = [
      task("running", { agent: "a", status: "running" }),
      task("second", { agent: "b" }),
      task("over-cap", { agent: "a" }),
      task("other-provider", { agent: "c" }),
    ];
    expect(startable(tasks, agents)).toEqual(["second", "other-provider"]);
    expect(startable(tasks, agents, 1)).toEqual(["other-provider"]);
  });

  it("counts a task a retry moved to another model on that model's provider instance", () => {
    const agents = [agent("a")];
    const tasks = [
      task("running", { status: "running", instanceId: "claude" }),
      task("moved", { instanceId: "claude" }),
      task("own-model"),
    ];
    expect(startable(tasks, agents, 1)).toEqual(["own-model"]);
  });
});

describe("teamResultCap", () => {
  it.each([
    [0, 4_000],
    [1, 4_000],
    [16, 4_000],
    [20, 3_200],
    [32, 2_000],
  ])("gives each of %i tasks %i characters", (taskCount, cap) => {
    expect(teamResultCap(taskCount)).toBe(cap);
  });
});

describe("settledTeamPlanStatus", () => {
  it.each([
    ["every task completed", ["completed", "completed"], "completed"],
    ["a task still runs", ["failed", "running"], "running"],
    ["a pending task can still start", ["completed", "pending"], "running"],
    ["a failed task blocks the rest", ["failed", "pending"], "failed"],
    ["a cancelled task blocks the rest", ["cancelled", "pending"], "failed"],
  ] as const)("is decided when %s", (_name, [first, second], status) => {
    const tasks = [
      task("first", { status: first }),
      task("second", { status: second, dependsOn: ["first"] }),
    ];
    expect(settledTeamPlanStatus(plan(tasks))).toBe(status);
  });
});

describe("workflowStepsIssue", () => {
  it.each([
    ["a valid chain", [step("one"), step("two", ["one"])], null],
    ["a repeated id", [step("one"), step("one")], 'Step id "one" is used twice.'],
    [
      "a dependency that is not a step",
      [step("one", ["missing"])],
      'Step "one" depends on "missing", which is not a step of this workflow.',
    ],
    [
      "a cycle",
      [step("one", ["two"]), step("two", ["one"])],
      "Steps depend on each other in a cycle: one -> two -> one.",
    ],
  ] as const)("reports %s", (_name, steps, issue) => {
    expect(workflowStepsIssue(steps)).toBe(issue);
  });
});

describe("teamPlanSummary", () => {
  const statuses = ["completed", "pending", "running", "failed", "cancelled", "completed"] as const;
  const counts = {
    planId: "plan",
    status: "running",
    revision: 2,
    total: 6,
    completed: 2,
    failed: 1,
    running: 1,
    cancelled: 1,
  };

  it("counts the tasks in each status but pending", () => {
    expect(
      teamPlanSummary({
        id: TeamPlanId.make("plan"),
        status: "running",
        revision: 2,
        tasks: statuses.map((status, index) => task(`t${index}`, { status })),
      }),
    ).toEqual(counts);
  });

  it("shows a workflow run, its hold and the steps awaiting review, without its inputs, limits or note", () => {
    const run: TeamPlanRun = {
      workflowId: WorkflowId.make("workflow-1"),
      workflowName: "weekly-digest",
      title: "Weekly digest",
      run: 3,
      trigger: "schedule",
      scheduledFor: "2026-11-16T09:00:00.000Z",
      inputs: [{ name: "Topic", value: "AI tooling" }],
      approvals: "review",
      limits: { spendUsd: 5, minutes: 60 },
      startedAt: "2026-11-16T09:00:01.000Z",
      costUsd: 1.25,
      headline: null,
      note: "Covered agents last week.",
    };
    const hold = { reason: "review", at: "2026-11-16T09:30:00.000Z" } as const;
    const reviewed = (status: TeamTaskStatus, awaiting: boolean): TeamTask => ({
      ...task("t", { status }),
      review: { round: 1, awaiting, awaitingSince: awaiting ? "2026-11-16T09:20:00.000Z" : null },
    });
    const { inputs: _inputs, limits: _limits, note: _note, ...listed } = run;
    expect(
      teamPlanSummary({
        id: TeamPlanId.make("plan"),
        status: "running",
        revision: 2,
        tasks: [
          ...statuses.map((status, index) => task(`t${index}`, { status })),
          reviewed("running", true),
          // A step that failed while its result waited is no longer awaiting review.
          reviewed("failed", true),
        ],
        run,
        hold,
      }),
    ).toEqual({
      ...counts,
      total: 8,
      running: 2,
      failed: 2,
      run: listed,
      hold,
      awaitingReview: 1,
    });
  });
});
