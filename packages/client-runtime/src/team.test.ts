import {
  CommandId,
  OrchestrationV2DispatchCommandError,
  ProviderInstanceId,
  type TeamAgent,
  TeamAgentId,
  type TeamPlan,
  TeamPlanId,
  type TeamTask,
  TeamTaskId,
  ThreadId,
} from "@codenine/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canRetryTeamTask,
  canReviewTeamTask,
  changeTeamDraft,
  editTeamDraft,
  isTeamFinishedNotification,
  resolveTeamDraft,
  savedTeamDraftEdit,
  teamAgentHeader,
  teamApproveBlock,
  teamApproveCommands,
  teamAssignment,
  teamCommandFailure,
  teamDraftChangeCount,
  teamDraftIssue,
  teamDraftOf,
  teamMemberLeadDefined,
  teamResultHandoff,
  teamRetryCommand,
  teamRunsInSequence,
  teamStatusText,
  teamStepFlows,
  teamTaskOfThread,
  teamTaskReviewCommand,
  teamTaskWaitsFor,
  threadTeam,
} from "./team.ts";

const threadId = ThreadId.make("thread:lead");
const codex = ProviderInstanceId.make("codex");
const agent = (id: string, model = "gpt-fast"): TeamAgent => ({
  id: TeamAgentId.make(id),
  label: id,
  role: "implement",
  modelSelection: { instanceId: codex, model },
  workspace: "shared",
});
/** A member the lead defined for this team, with its own instructions. */
const inlineAgent = (id: string): TeamAgent => ({
  ...agent(id, "gpt-mini"),
  label: "Fact checker",
  role: "review",
  instructions: "Check every claim against its source.",
});
/** A member the lead suggested for an agent the user does not have. */
const suggestedAgent = (id: string): TeamAgent => ({
  ...agent(id),
  suggestion: {
    title: "Fact checker",
    description: "Checking claims against their sources.",
    instructions: "Check every claim.",
    connectors: [],
  },
});
const task = (id: string, by: string, dependsOn: ReadonlyArray<string> = []): TeamTask => ({
  id: TeamTaskId.make(id),
  title: `Task ${id}`,
  brief: `Do ${id}.`,
  agentId: TeamAgentId.make(by),
  dependsOn: dependsOn.map((dependency) => TeamTaskId.make(dependency)),
  status: "pending",
  attempt: 1,
  threadId: null,
  result: null,
  startedAt: null,
  completedAt: null,
});
const plan = (overrides: Partial<TeamPlan> = {}): TeamPlan => ({
  id: TeamPlanId.make("plan-1"),
  revision: 1,
  status: "proposed",
  goal: "Ship it",
  agents: [agent("builder"), agent("reviewer", "gpt-strong")],
  tasks: [task("a", "builder"), task("b", "builder", ["a"]), task("c", "reviewer", ["a", "b"])],
  maxParallelPerProvider: 2,
  proposedAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z",
  ...overrides,
});
const commandIds = () => {
  let next = 0;
  return () => CommandId.make(`command-${(next += 1)}`);
};

describe("changeTeamDraft", () => {
  const draft = teamDraftOf(plan());

  it("drops a removed task from the tasks that depended on it", () => {
    const next = changeTeamDraft(draft, { type: "task.remove", taskId: TeamTaskId.make("a") });
    expect(next.tasks.map((candidate) => [candidate.id, candidate.dependsOn])).toEqual([
      ["b", []],
      ["c", ["b"]],
    ]);
  });

  it("keeps an agent that a task still uses", () => {
    const reviewer = TeamAgentId.make("reviewer");
    expect(changeTeamDraft(draft, { type: "agent.remove", agentId: reviewer })).toBe(draft);
    const reassigned = changeTeamDraft(draft, {
      type: "task.assign",
      taskId: TeamTaskId.make("c"),
      agentId: TeamAgentId.make("builder"),
    });
    expect(
      changeTeamDraft(reassigned, { type: "agent.remove", agentId: reviewer }).agents.map(
        (candidate) => candidate.id,
      ),
    ).toEqual(["builder"]);
  });

  it("gives an added agent an id from its label that no agent has", () => {
    const add = (label: string) =>
      ({
        type: "agent.add",
        agent: "code-reviewer",
        label,
        role: "review",
        modelSelection: { instanceId: codex, model: "gpt-strong" },
        workspace: "worktree",
      }) as const;
    const once = changeTeamDraft(draft, add("  Reviewer "));
    const twice = changeTeamDraft(once, add("reviewer!"));
    const blank = changeTeamDraft(twice, { ...add("???"), assign: TeamTaskId.make("b") });
    const inline = changeTeamDraft(blank, {
      type: "member.add",
      label: " Reviewer ",
      role: "review",
      modelSelection: { instanceId: codex, model: "gpt-mini" },
      workspace: "shared",
      instructions: "  Read only.  ",
    });
    const bare = changeTeamDraft(inline, {
      type: "member.add",
      label: "Docs",
      role: "custom",
      modelSelection: { instanceId: codex, model: "gpt-mini" },
      workspace: "shared",
      instructions: " ",
      assign: TeamTaskId.make("a"),
    });
    expect(bare.agents.slice(5)).toEqual([
      {
        id: "reviewer-4",
        label: "Reviewer",
        role: "review",
        modelSelection: { instanceId: codex, model: "gpt-mini" },
        workspace: "shared",
        instructions: "Read only.",
      },
      {
        id: "docs",
        label: "Docs",
        role: "custom",
        modelSelection: { instanceId: codex, model: "gpt-mini" },
        workspace: "shared",
      },
    ]);
    expect(bare.tasks[0]?.agentId).toBe("docs");
    expect(blank.agents.slice(2)).toMatchObject([
      {
        id: "reviewer-2",
        agent: "code-reviewer",
        label: "Reviewer",
        role: "review",
        workspace: "worktree",
      },
      { id: "reviewer-3", label: "reviewer!" },
      { id: "agent" },
    ]);
    expect(blank.tasks.map((candidate) => candidate.agentId)).toEqual([
      "builder",
      "agent",
      "reviewer",
    ]);
  });

  it("runs a suggested member as the agent the user chose, which settles the suggestion", () => {
    const suggested = teamDraftOf(plan({ agents: [agent("builder"), suggestedAgent("checker")] }));
    expect(teamApproveBlock(suggested)).not.toBeNull();
    const assigned = changeTeamDraft(suggested, {
      type: "agent.assign",
      agentId: TeamAgentId.make("checker"),
      agent: "fact-checker",
      label: " Fact checker ",
      modelSelection: { instanceId: codex, model: "gpt-strong" },
    });
    expect(assigned.agents[0]).toBe(suggested.agents[0]);
    expect(assigned.agents[1]).toEqual({
      id: "checker",
      label: "Fact checker",
      role: "implement",
      modelSelection: { instanceId: codex, model: "gpt-strong" },
      workspace: "shared",
      agent: "fact-checker",
    });
    expect(assigned.agents[1]).not.toHaveProperty("suggestion");
    expect(teamApproveBlock(assigned)).toBeNull();
  });

  it("runs a member the lead defined as a saved agent on the lead's pick, and back again", () => {
    const defined = teamDraftOf(plan({ agents: [agent("builder"), inlineAgent("checker")] }));
    expect(teamApproveBlock(defined)).toBeNull();
    const checker = TeamAgentId.make("checker");
    const assigned = changeTeamDraft(defined, {
      type: "agent.assign",
      agentId: checker,
      agent: "fact-checker",
      label: "Source checker",
      modelSelection: { instanceId: codex, model: "gpt-strong" },
    });
    expect(assigned.agents[1]).toEqual({ ...inlineAgent("checker"), agent: "fact-checker" });
    const back = changeTeamDraft(assigned, { type: "agent.unassign", agentId: checker });
    expect(back.agents[1]).toEqual(inlineAgent("checker"));
    // A saved agent's member has no definition of the lead's to go back to.
    const saved = changeTeamDraft(back, {
      type: "agent.unassign",
      agentId: TeamAgentId.make("builder"),
    });
    expect(saved).toBe(back);
    // The lead gives most members no instructions; the edit's base still shows it defined them.
    const { instructions: _instructions, ...plain } = inlineAgent("checker");
    const plainBase = teamDraftOf(plan({ agents: [agent("builder"), plain] }));
    const plainAssigned = changeTeamDraft(
      plainBase,
      {
        type: "agent.assign",
        agentId: checker,
        agent: "fact-checker",
        label: "Source checker",
        modelSelection: { instanceId: codex, model: "gpt-strong" },
      },
      plainBase,
    );
    const swapped = { ...plain, agent: "fact-checker" };
    expect(plainAssigned.agents[1]).toEqual(swapped);
    expect(teamMemberLeadDefined(plainBase, swapped)).toBe(true);
    expect(teamMemberLeadDefined(teamDraftOf(plan({ agents: [swapped] })), swapped)).toBe(false);
    const plainBack = changeTeamDraft(
      plainAssigned,
      { type: "agent.unassign", agentId: checker },
      plainBase,
    );
    expect(plainBack.agents[1]).toEqual(plain);
  });

  it("edits a member's name, role, workspace and instructions, trimmed", () => {
    const defined = teamDraftOf(plan({ agents: [agent("builder"), inlineAgent("checker")] }));
    const checker = TeamAgentId.make("checker");
    const edited = changeTeamDraft(defined, {
      type: "member.edit",
      agentId: checker,
      label: " Checker ",
      role: "research",
      workspace: "worktree",
      instructions: "  Cite every source.\n",
    });
    expect(edited.agents[1]).toEqual({
      ...inlineAgent("checker"),
      label: "Checker",
      role: "research",
      workspace: "worktree",
      instructions: "Cite every source.",
    });
    const cleared = changeTeamDraft(edited, {
      type: "member.edit",
      agentId: checker,
      instructions: "  ",
    });
    expect(cleared.agents[1]).not.toHaveProperty("instructions");
    expect(cleared.agents[1]?.label).toBe("Checker");
  });

  it("runs 1 to 6 tasks at a time per account", () => {
    expect(draft.maxParallelPerProvider).toBe(2);
    for (const [asked, kept] of [
      [4, 4],
      [0, 1],
      [9, 6],
      [2.6, 3],
    ] as const) {
      expect(
        changeTeamDraft(draft, { type: "parallel.set", maxParallelPerProvider: asked })
          .maxParallelPerProvider,
      ).toBe(kept);
    }
  });

  it("counts each choice a draft changed, once", () => {
    const edited = [
      {
        type: "agent.model",
        agentId: TeamAgentId.make("builder"),
        modelSelection: { instanceId: codex, model: "gpt-strong" },
      },
      {
        type: "agent.model",
        agentId: TeamAgentId.make("builder"),
        modelSelection: { instanceId: codex, model: "gpt-max" },
      },
      { type: "task.brief", taskId: TeamTaskId.make("b"), brief: "Do b well." },
      { type: "task.remove", taskId: TeamTaskId.make("a") },
      {
        type: "agent.assign",
        agentId: TeamAgentId.make("reviewer"),
        agent: "code-reviewer",
        label: "Code reviewer",
        modelSelection: { instanceId: codex, model: "gpt-max" },
      },
      { type: "member.edit", agentId: TeamAgentId.make("checker"), role: "research" },
      { type: "member.edit", agentId: TeamAgentId.make("checker"), instructions: "Cite." },
      { type: "parallel.set", maxParallelPerProvider: 4 },
    ] as const satisfies ReadonlyArray<Parameters<typeof changeTeamDraft>[1]>;
    const base = teamDraftOf(plan({ agents: [...plan().agents, inlineAgent("checker")] }));
    const next = edited.reduce<ReturnType<typeof teamDraftOf>>(
      (draft, change) => changeTeamDraft(draft, change),
      base,
    );
    expect(teamDraftChangeCount(base, base)).toBe(0);
    expect(teamDraftChangeCount(base, next)).toBe(6);
    const renamed = changeTeamDraft(base, {
      type: "member.edit",
      agentId: TeamAgentId.make("checker"),
      label: "Checker",
    });
    expect(teamDraftChangeCount(base, renamed)).toBe(1);
  });
});

describe("resolveTeamDraft", () => {
  const current = plan();
  const strongBuilder = {
    type: "agent.model",
    agentId: TeamAgentId.make("builder"),
    modelSelection: { instanceId: codex, model: "gpt-strong" },
  } as const;

  it("shows unsaved edits against the revision they were made on", () => {
    const edit = editTeamDraft(current, null, strongBuilder);
    expect(resolveTeamDraft(current, edit)).toMatchObject({
      revision: 1,
      dirty: true,
      overtaken: false,
      draft: { agents: [{ modelSelection: { model: "gpt-strong" } }, {}] },
      base: { agents: [{ modelSelection: { model: "gpt-fast" } }, {}] },
    });
  });

  it("keeps a saved draft on screen until the thread delivers its revision", () => {
    const edit = editTeamDraft(current, null, strongBuilder);
    const saved = savedTeamDraftEdit(current, resolveTeamDraft(current, edit));
    expect(resolveTeamDraft(current, saved)).toMatchObject({
      revision: 2,
      dirty: false,
      draft: saved.draft,
    });
    const delivered = plan({ revision: 2, agents: saved.draft.agents });
    expect(resolveTeamDraft(delivered, saved)).toMatchObject({ revision: 2, dirty: false });
  });

  it("reads a delivered plan as saved whatever order the server keeps its fields in", () => {
    const defined = plan({ agents: [agent("builder"), inlineAgent("checker")] });
    const edit = editTeamDraft(defined, null, {
      type: "agent.assign",
      agentId: TeamAgentId.make("checker"),
      agent: "fact-checker",
      label: "Fact checker",
      modelSelection: { instanceId: codex, model: "gpt-strong" },
    });
    const saved = savedTeamDraftEdit(defined, resolveTeamDraft(defined, edit));
    // The server decodes members field by field, so `agent` comes back before `instructions`.
    const { instructions: _instructions, ...checker } = inlineAgent("checker");
    const delivered = plan({
      revision: 2,
      agents: [
        agent("builder"),
        {
          ...checker,
          agent: "fact-checker",
          instructions: "Check every claim against its source.",
        },
      ],
    });
    expect(resolveTeamDraft(delivered, saved)).toMatchObject({ revision: 2, dirty: false });
  });

  it("reports unsaved edits that a newer plan replaced", () => {
    const edit = editTeamDraft(current, null, strongBuilder);
    for (const newer of [
      plan({ revision: 2 }),
      plan({ id: TeamPlanId.make("plan-2") }),
      plan({ status: "running" }),
    ]) {
      expect(resolveTeamDraft(newer, edit)).toEqual({
        draft: teamDraftOf(newer),
        base: teamDraftOf(newer),
        revision: newer.revision,
        dirty: false,
        overtaken: true,
      });
    }
    const undone = editTeamDraft(current, edit, {
      ...strongBuilder,
      modelSelection: { instanceId: codex, model: "gpt-fast" },
    });
    expect(resolveTeamDraft(plan({ revision: 2 }), undone).overtaken).toBe(false);
  });

  it("starts a new edit from the newer plan", () => {
    const stale = editTeamDraft(current, null, strongBuilder);
    const newer = plan({ revision: 2, tasks: [task("a", "builder")] });
    const edit = editTeamDraft(newer, stale, {
      type: "task.brief",
      taskId: TeamTaskId.make("a"),
      brief: "Do it well.",
    });
    expect(edit).toMatchObject({ revision: 2, base: teamDraftOf(newer) });
    expect(edit.draft.agents[0]?.modelSelection.model).toBe("gpt-fast");
  });
});

describe("teamApproveCommands", () => {
  it("approves the revision on screen when nothing changed", () => {
    const resolved = resolveTeamDraft(plan({ revision: 3 }), null);
    expect(teamApproveCommands({ threadId, resolved, newCommandId: commandIds() })).toEqual([
      { type: "team.approve", commandId: "command-1", threadId, expectedRevision: 3 },
    ]);
  });

  it("saves edits first and approves the revision the save creates", () => {
    const current = plan({
      revision: 3,
      tasks: plan().tasks.map((candidate) => ({
        ...candidate,
        doneWhen: `${candidate.id} passes`,
      })),
    });
    const edit = editTeamDraft(current, null, {
      type: "task.brief",
      taskId: TeamTaskId.make("a"),
      brief: "  Do a, carefully.\n",
    });
    const commands = teamApproveCommands({
      threadId,
      resolved: resolveTeamDraft(current, edit),
      newCommandId: commandIds(),
    });
    expect(commands).toMatchObject([
      {
        type: "team.edit",
        commandId: "command-1",
        expectedRevision: 3,
        tasks: [
          { id: "a", brief: "Do a, carefully.", doneWhen: "a passes" },
          { id: "b", doneWhen: "b passes" },
          { id: "c" },
        ],
        maxParallelPerProvider: 2,
      },
      { type: "team.approve", commandId: "command-2", expectedRevision: 4 },
    ]);
    expect(commands[0]).not.toHaveProperty("goal");
    expect(commands[0]).not.toHaveProperty("tasks.0.status");
  });
});

describe("teamDraftIssue", () => {
  const draft = teamDraftOf(plan());

  it("names the problem the server would reject", () => {
    const blank = changeTeamDraft(draft, {
      type: "task.brief",
      taskId: TeamTaskId.make("b"),
      brief: "  ",
    });
    expect(teamDraftIssue(blank)).toBe('Task "Task b" needs a brief.');
    const empty = ["a", "b", "c"].reduce(
      (next, id) => changeTeamDraft(next, { type: "task.remove", taskId: TeamTaskId.make(id) }),
      draft,
    );
    expect(teamDraftIssue(empty)).toBe("A team needs at least one agent and one task.");
    expect(teamDraftIssue(draft)).toBeNull();
    const briefs = draft.tasks.reduce((sum, candidate) => sum + candidate.brief.length, 0);
    expect(teamDraftIssue(draft, "g".repeat(64_000 - briefs))).toBeNull();
    expect(teamDraftIssue(draft, "g".repeat(64_001 - briefs))).toBe(
      "The team's text is 64,001 characters; the most is 64,000. Shorten the briefs or combine tasks.",
    );
  });
});

describe("canRetryTeamTask", () => {
  it.each([
    ["running", "failed", true],
    ["failed", "cancelled", true],
    ["running", "completed", false],
    ["cancelled", "failed", false],
    ["completed", "cancelled", false],
  ] as const)("plan %s, task %s: %s", (planStatus, taskStatus, retryable) => {
    expect(canRetryTeamTask({ status: planStatus }, { status: taskStatus })).toBe(retryable);
  });
});

it("retries on another agent only when one is named", () => {
  const failed = task("a", "builder");
  const retry = (agentId?: string) =>
    teamRetryCommand({
      threadId,
      task: failed,
      ...(agentId === undefined ? {} : { agentId: TeamAgentId.make(agentId) }),
      commandId: CommandId.make("retry"),
    });
  expect(retry()).not.toHaveProperty("agentId");
  expect(retry("builder")).not.toHaveProperty("agentId");
  expect(retry("reviewer")).toMatchObject({
    type: "team.task.retry",
    taskId: "a",
    agentId: "reviewer",
  });
  const strong = { instanceId: codex, model: "gpt-strong" };
  expect(
    teamRetryCommand({
      threadId,
      task: failed,
      modelSelection: strong,
      commandId: CommandId.make("retry"),
    }),
  ).toEqual({
    type: "team.task.retry",
    commandId: "retry",
    threadId,
    taskId: "a",
    modelSelection: strong,
  });
});

it("reviews the round the step is on, with trimmed notes only when there are some", () => {
  const review = (notes?: string) =>
    teamTaskReviewCommand({
      threadId,
      planId: TeamPlanId.make("plan-1"),
      task: {
        ...task("a", "builder"),
        attempt: 2,
        review: { round: 3, awaiting: true, awaitingSince: null },
      },
      verdict: notes === undefined ? "accept" : "revise",
      notes,
      commandId: CommandId.make("review"),
    });
  expect(review()).toMatchObject({ taskId: "a", attempt: 2, round: 3, verdict: "accept" });
  expect(review()).not.toHaveProperty("notes");
  expect(review("   ")).not.toHaveProperty("notes");
  expect(review("  Under 800 words. ")).toMatchObject({
    verdict: "revise",
    notes: "Under 800 words.",
  });

  // The server takes a review while the run runs, and not while it waits at a limit.
  const awaiting = { review: { round: 1, awaiting: true, awaitingSince: null } };
  const at = "2026-11-18T10:00:00.000Z";
  expect(canReviewTeamTask({ status: "running" }, awaiting)).toBe(true);
  expect(canReviewTeamTask({ status: "running", hold: { reason: "review", at } }, awaiting)).toBe(
    true,
  );
  expect(canReviewTeamTask({ status: "running", hold: { reason: "spend", at } }, awaiting)).toBe(
    false,
  );
  expect(canReviewTeamTask({ status: "completed" }, awaiting)).toBe(false);
});

describe("teamCommandFailure", () => {
  const rejected = (message: string) =>
    new OrchestrationV2DispatchCommandError({
      commandId: CommandId.make("command-1"),
      commandType: "team.approve",
      message,
      detail: message,
    });

  it("tells a stale revision from other rejections", () => {
    expect(
      teamCommandFailure(
        rejected("team_revision_conflict: The team is at revision 2, not 1. Read it again."),
      ),
    ).toEqual({ conflict: true, message: "The team is at revision 2, not 1. Read it again." });
    expect(
      teamCommandFailure(rejected("team_plan_not_proposed: Only a proposed team can be approved.")),
    ).toEqual({ conflict: false, message: "Only a proposed team can be approved." });
    expect(teamCommandFailure(new Error("Socket closed"))).toEqual({
      conflict: false,
      message: "Socket closed",
    });
  });
});

describe("teamStepFlows", () => {
  it("says which results a step starts with, and which steps start with the same ones", () => {
    const flows = teamStepFlows([
      task("plan", "builder"),
      task("build", "builder", ["plan"]),
      task("test", "builder", ["build"]),
      task("docs", "builder", ["build"]),
      task("review", "builder", ["docs", "test", "docs"]),
    ]);
    expect([...flows]).toEqual([
      ["build", "Starts with step 1's result"],
      ["test", "Starts with step 2's result, alongside step 4"],
      ["docs", "Starts with step 2's result, alongside step 3"],
      ["review", "Starts with the results of steps 3 and 4"],
    ]);
  });

  it("pairs steps that start at once, and skips results from steps the plan no longer has", () => {
    const flows = teamStepFlows([
      task("a", "builder"),
      task("b", "builder"),
      task("c", "builder", ["a", "gone"]),
    ]);
    expect([...flows]).toEqual([
      ["a", "Runs alongside step 2"],
      ["b", "Runs alongside step 1"],
      ["c", "Starts with step 1's result"],
    ]);
  });
});

it.each([
  ["a chain", [task("a", "x"), task("b", "x", ["a"]), task("c", "x", ["b"])], true],
  [
    "a step that waits through another",
    [task("a", "x"), task("b", "x", ["a"]), task("c", "x", ["b", "a"])],
    true,
  ],
  ["two steps after one", [task("a", "x"), task("b", "x", ["a"]), task("c", "x", ["a"])], false],
  ["two first steps", [task("a", "x"), task("b", "x"), task("c", "x", ["a", "b"])], false],
] as const)("teamRunsInSequence: %s is %s", (_name, tasks, expected) => {
  expect(teamRunsInSequence(tasks)).toBe(expected);
});

it("names the failed steps a waiting step needs, while the plan can still run them", () => {
  const tasks = [
    { ...task("plan", "builder"), status: "completed" as const },
    { ...task("test", "builder", ["plan"]), status: "failed" as const },
    { ...task("docs", "builder", ["plan"]), status: "running" as const },
    task("review", "builder", ["test", "docs"]),
    task("ship", "builder", ["review"]),
  ];
  const ship = tasks[4]!;
  expect(teamTaskWaitsFor(plan({ status: "running", tasks }), tasks[3]!)).toEqual([2]);
  expect(teamTaskWaitsFor(plan({ status: "failed", tasks }), ship)).toEqual([2]);
  expect(teamTaskWaitsFor(plan({ status: "cancelled", tasks }), ship)).toEqual([]);
  expect(teamTaskWaitsFor(plan({ status: "running", tasks }), tasks[2]!)).toEqual([]);
});

describe("teamStatusText", () => {
  const summary = (status: TeamPlan["status"], completed = 1, failed = 0) => ({
    status,
    total: 3,
    completed,
    failed,
  });

  it.each([
    [summary("proposed", 0), "Waiting for your approval", null],
    [summary("running"), "Running · 1 of 3 done", "1 of 3 done"],
    [summary("failed", 1, 1), "Failed · 1 of 3 done, 1 failed", "1 of 3 done, 1 failed"],
    [summary("completed", 3), "Done", "3 of 3 done"],
    [summary("cancelled"), "Cancelled", "1 of 3 done"],
  ] as const)("%j reads %s", (input, line, progress) => {
    expect(teamStatusText(input)).toMatchObject({ line, progress });
  });
});

describe("threadTeam", () => {
  const teamSummary = {
    planId: TeamPlanId.make("plan-1"),
    status: "running",
    revision: 2,
    total: 3,
    completed: 1,
    failed: 0,
    running: 1,
    cancelled: 0,
  } as const;
  const teamTask = {
    rootThreadId: threadId,
    planId: TeamPlanId.make("plan-1"),
    taskId: TeamTaskId.make("b"),
    attempt: 1,
  };

  it("reads a lead's own summary and an agent's from its lead, for the plan it ran", () => {
    expect(threadTeam({ id: threadId, teamSummary }, null)).toEqual({
      role: "lead",
      leadThreadId: threadId,
      planId: "plan-1",
      summary: teamSummary,
    });
    const agentThread = { id: ThreadId.make("thread:agent"), teamTask };
    expect(threadTeam(agentThread, { teamSummary })).toMatchObject({
      role: "agent",
      leadThreadId: threadId,
      summary: teamSummary,
    });
    const replaced = { ...teamSummary, planId: TeamPlanId.make("plan-2") };
    expect(threadTeam(agentThread, { teamSummary: replaced })?.summary).toBeNull();
    expect(threadTeam(agentThread, null)?.summary).toBeNull();
    expect(threadTeam({ id: threadId }, null)).toBeNull();
  });
});

it("finds an agent thread's task, and whether a retry replaced its attempt", () => {
  const current = plan({ tasks: [task("z", "builder"), { ...task("a", "reviewer"), attempt: 2 }] });
  const ref = { planId: current.id, taskId: TeamTaskId.make("a") };
  expect(teamTaskOfThread(current, { ...ref, attempt: 2 })).toMatchObject({
    agent: { id: "reviewer" },
    position: 2,
    total: 2,
    superseded: false,
  });
  expect(teamTaskOfThread(current, { ...ref, attempt: 1 })?.superseded).toBe(true);
  expect(
    teamTaskOfThread(current, { ...ref, planId: TeamPlanId.make("plan-2"), attempt: 2 }),
  ).toBeNull();
});

describe("teamAgentHeader", () => {
  const ref = { planId: TeamPlanId.make("plan-1"), taskId: TeamTaskId.make("b"), attempt: 1 };

  it.each([
    ["running", "pending", 1, "Waiting", "pending"],
    ["failed", "pending", 1, "Not started", "not_started"],
    ["running", "completed", 1, "Done", "completed"],
    ["running", "pending", 2, "Retried", null],
  ] as const)(
    "in a %s plan, a %s task on attempt %i reads %s",
    (planStatus, status, attempt, label, taskStatus) => {
      const current = plan({
        status: planStatus,
        tasks: [task("a", "builder"), { ...task("b", "reviewer", ["a"]), status, attempt }],
      });
      expect(teamAgentHeader(current, ref)).toEqual({
        label: "reviewer",
        position: "Agent 2 of 2",
        modelSelection: { instanceId: codex, model: "gpt-strong" },
        status: label,
        taskStatus,
      });
    },
  );

  it("shows the model a retry moved the task to", () => {
    const moved = { instanceId: ProviderInstanceId.make("claude"), model: "sonnet" };
    const current = plan({
      status: "running",
      tasks: [task("a", "builder"), { ...task("b", "reviewer"), modelSelection: moved }],
    });
    expect(teamAgentHeader(current, ref)?.modelSelection).toEqual(moved);
  });

  it("falls back to the task's title for an agent the plan does not have", () => {
    const current = plan({ tasks: [task("a", "builder"), task("b", "ghost")] });
    expect(teamAgentHeader(current, ref)).toMatchObject({
      label: "Task b",
      modelSelection: null,
    });
  });
});

describe("teamAssignment", () => {
  const teamTask = { planId: TeamPlanId.make("plan-1"), taskId: TeamTaskId.make("c"), attempt: 1 };
  const brief = { id: "message-1", text: "Act as reviewer.", createdBy: "system" } as const;
  const current = plan({
    tasks: [
      { ...task("a", "builder"), status: "completed", result: "Built it.", threadId },
      { ...task("b", "ghost"), status: "completed", result: "Tested it." },
      task("c", "reviewer", ["b", "a"]),
    ],
  });

  it("shows the task's brief and the results it started from, in its order", () => {
    expect(teamAssignment({ teamTask, firstUserMessage: brief, plan: current })).toEqual({
      messageId: "message-1",
      brief: "Do c.",
      received: [
        { taskId: "b", from: "Task b", result: "Tested it.", threadId: null },
        { taskId: "a", from: "builder", result: "Built it.", threadId },
      ],
      fullText: "Act as reviewer.",
    });
  });

  it("falls back to the message the agent received while the plan is unknown", () => {
    const other = plan({ id: TeamPlanId.make("plan-2") });
    for (const unknown of [null, other]) {
      expect(teamAssignment({ teamTask, firstUserMessage: brief, plan: unknown })).toEqual({
        messageId: "message-1",
        brief: null,
        received: [],
        fullText: "Act as reviewer.",
      });
    }
  });

  it("finds nothing when the first user message is not the system's brief", () => {
    // History windowing can leave out the brief, so a later message comes first.
    const user = { id: "message-3", text: "Also check docs.", createdBy: "user" } as const;
    expect(teamAssignment({ teamTask, firstUserMessage: user, plan: current })).toBeNull();
    expect(teamAssignment({ teamTask, firstUserMessage: undefined, plan: current })).toBeNull();
    expect(
      teamAssignment({ teamTask: undefined, firstUserMessage: brief, plan: current }),
    ).toBeNull();
  });
});

describe("teamResultHandoff", () => {
  const ref = { planId: TeamPlanId.make("plan-1"), taskId: TeamTaskId.make("a"), attempt: 1 };
  const agents = [agent("builder"), agent("tester"), agent("reviewer")];
  const done = { ...task("a", "builder"), status: "completed" } as const;

  it.each([
    [
      "running",
      [done, { ...task("b", "tester", ["a"]), status: "running" }, task("c", "reviewer", ["a"])],
      "This result was passed to tester and goes to reviewer",
    ],
    [
      "completed",
      [
        done,
        { ...task("b", "reviewer", ["a"]), status: "completed" },
        { ...task("c", "reviewer", ["a"]), status: "completed" },
      ],
      "This result was passed to reviewer",
    ],
    ["running", [done, task("b", "tester", ["a"])], "This result goes to tester"],
    ["failed", [done, task("b", "tester", ["a"])], null],
    ["running", [done, task("b", "tester")], null],
    ["running", [task("a", "builder"), task("b", "tester", ["a"])], null],
  ] as const)("in a %s plan reads %s", (status, tasks, line) => {
    expect(teamResultHandoff(plan({ status, agents, tasks }), ref)).toBe(line);
  });

  it("says nothing on an attempt a retry replaced", () => {
    const tasks: ReadonlyArray<TeamTask> = [
      { ...done, attempt: 2 },
      { ...task("b", "tester", ["a"]), status: "running" },
    ];
    expect(teamResultHandoff(plan({ status: "running", agents, tasks }), ref)).toBeNull();
  });
});

it("tells the team-finished wake from other system notifications", () => {
  expect(isTeamFinishedNotification({ source: { kind: "system" }, outcome: "completed" })).toBe(
    true,
  );
  expect(isTeamFinishedNotification({ source: { kind: "system" }, outcome: "failed" })).toBe(false);
  expect(isTeamFinishedNotification({ source: { kind: "system" }, outcome: "updated" })).toBe(
    false,
  );
  expect(
    isTeamFinishedNotification({ source: { kind: "background_task" }, outcome: "completed" }),
  ).toBe(false);
});
