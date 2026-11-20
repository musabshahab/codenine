import {
  AgentName,
  EnvironmentId,
  ProviderInstanceId,
  type TeamAgent,
  TeamAgentId,
  type TeamPlan,
  TeamPlanId,
  type TeamPlanSummary,
  type TeamTask,
  TeamTaskId,
  ThreadId,
  type WorkflowDefinition,
  WorkflowId,
  type WorkflowDraft,
  type WorkflowStep,
  type WorkflowStepId,
} from "@codenine/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  assignStepAgent,
  blankWorkflow,
  changeWorkflowEdit,
  checkWorkflow,
  connectSteps,
  draftProblems,
  findCycle,
  layoutSteps,
  raisedLimits,
  removeStep,
  resolveWorkflowEdit,
  runStartLine,
  runStepPositions,
  STEP_WIDTH,
  stepRunState,
  upcomingRuns,
  upcomingRunsLine,
  withMadeAgents,
  workflowCardStatus,
  workflowFromDraft,
  workflowFromTeamPlan,
  workflowHistoryRows,
  workflowNameFor,
  workflowRunsOf,
  workflowRunStatus,
} from "./workflows.logic";

const id = (value: string) => value as WorkflowStepId;
const step = (stepId: string, dependsOn: ReadonlyArray<string> = []): WorkflowStep => ({
  id: id(stepId),
  title: stepId.toUpperCase(),
  agent: "writer",
  model: null,
  instructions: "",
  doneWhen: "",
  dependsOn: dependsOn.map(id),
  position: { x: 0, y: 0 },
});
const workflow = (steps: ReadonlyArray<WorkflowStep>): WorkflowDefinition => ({
  ...blankWorkflow(),
  title: "Weekly blog post",
  steps,
});

describe("layoutSteps", () => {
  it("lays steps out left to right by what they wait for, each column centred", () => {
    const positions = layoutSteps([
      step("research"),
      step("write", ["research"]),
      step("images", ["research"]),
      step("publish", ["write", "images"]),
    ]);
    const write = positions.get(id("write"));
    const images = positions.get(id("images"));
    const publish = positions.get(id("publish"));
    expect(positions.get(id("research"))).toEqual({ x: 0, y: 0 });
    expect(write?.x).toBe(images?.x);
    expect(write?.x).toBeGreaterThan(STEP_WIDTH);
    expect((write?.y ?? 0) + (images?.y ?? 0)).toBe(0);
    expect(publish).toEqual({ x: (write?.x ?? 0) * 2, y: 0 });
  });

  it("still places steps that wait for each other in a loop", () => {
    const positions = layoutSteps([step("a", ["b"]), step("b", ["a"]), step("c", ["missing"])]);
    expect([...positions.keys()]).toEqual(["a", "b", "c"]);
  });
});

describe("dependencies", () => {
  const steps = [step("a"), step("b", ["a"]), step("c", ["b"])];

  it("connects a step to another only when no loop follows", () => {
    const definition = workflow(steps);
    expect(connectSteps(definition, id("a"), id("c")).steps[2]?.dependsOn).toEqual(["b", "a"]);
    expect(connectSteps(definition, id("c"), id("a"))).toBe(definition);
    expect(connectSteps(definition, id("b"), id("b"))).toBe(definition);
    expect(connectSteps(definition, id("a"), id("b"))).toBe(definition);
  });

  it("gives a step an agent, settling the suggestion and a model the agent now has", () => {
    const model = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt",
      effort: "high",
    } as const;
    const suggested = {
      ...step("publish"),
      agent: null,
      model,
      suggestion: {
        title: "Publisher",
        description: "Publishes.",
        instructions: "",
        connectors: [],
      },
    };
    const [same] = assignStepAgent(workflow([suggested]), id("publish"), {
      name: "publisher",
      model,
    }).steps;
    expect(same).toMatchObject({ agent: "publisher", model: null });
    expect(same).not.toHaveProperty("suggestion");
    const [other] = assignStepAgent(workflow([suggested]), id("publish"), {
      name: "publisher",
      model: null,
    }).steps;
    expect(other?.model).toEqual(model);
  });

  it("lays a run out as its workflow while the workflow has all its steps", () => {
    const tasks = [
      { id: TeamTaskId.make("a"), dependsOn: [] },
      { id: TeamTaskId.make("b"), dependsOn: [TeamTaskId.make("a")] },
    ];
    const drawn = [
      { id: id("a"), position: { x: 5, y: 5 } },
      { id: id("b"), position: { x: 9, y: 9 } },
    ];
    expect(runStepPositions(tasks, drawn).get("b")).toEqual({ x: 9, y: 9 });
    expect(runStepPositions(tasks, drawn.slice(0, 1)).get("a")).toEqual({ x: 0, y: 0 });
  });

  it("finds a loop, and removing a step removes the waits on it", () => {
    expect(findCycle(steps)).toBeNull();
    expect(findCycle([step("a", ["c"]), step("b", ["a"]), step("c", ["b"])])).toEqual([
      "a",
      "c",
      "b",
    ]);
    expect(removeStep(workflow(steps), id("b")).steps).toEqual([step("a"), step("c")]);
  });
});

describe("workflowFromDraft", () => {
  it("lays the drafted steps out, off, on the agents' own models", () => {
    const draft: WorkflowDraft = {
      title: "Weekly blog post",
      description: "Writes a post.",
      goal: "A new post every Monday.",
      schedule: { days: ["mon"], time: "09:00", timeZone: "Europe/London" },
      inputs: [{ name: "Topic area", value: "Gardening" }],
      steps: [
        {
          id: id("research"),
          title: "Research",
          agent: "researcher",
          instructions: "Find a topic.",
          doneWhen: "",
          dependsOn: [],
        },
        {
          id: id("publish"),
          title: "Publish",
          agent: null,
          suggestion: {
            title: "Publisher",
            description: "Publishes posts.",
            instructions: "",
            connectors: [],
          },
          instructions: "Publish it.",
          doneWhen: "The post is live.",
          dependsOn: [id("research"), id("gone"), id("publish")],
        },
      ],
      proposedAt: "2026-11-18T09:00:00.000Z",
    };
    const definition = workflowFromDraft(draft, { model: null, projectId: null });
    expect(definition.enabled).toBe(false);
    expect(definition.lead.goal).toBe("A new post every Monday.");
    expect(definition.trigger.schedule).toEqual(draft.schedule);
    expect(definition.steps.map((candidate) => candidate.model)).toEqual([null, null]);
    expect(definition.steps[1]?.dependsOn).toEqual(["research"]);
    expect(definition.steps[1]?.suggestion?.title).toBe("Publisher");
    expect(definition.steps[1]?.position.x).toBeGreaterThan(definition.steps[0]?.position.x ?? 0);
    expect(definition.trigger.position.x).toBeLessThan(definition.steps[0]?.position.x ?? 0);

    // Before any agent exists, both steps wait: one for its missing agent, one to be created.
    const agent = (name: string, model: boolean) => ({
      name: AgentName.make(name),
      title: name,
      model: model
        ? {
            instanceId: ProviderInstanceId.make("claude"),
            model: "haiku",
            effort: "medium" as const,
          }
        : null,
    });
    const aboutSteps = (problems: ReturnType<typeof draftProblems>) =>
      problems.filter((problem) => problem.step !== null);
    expect(aboutSteps(draftProblems(definition, [])).map((problem) => problem.step)).toEqual([
      "research",
      "publish",
    ]);
    // A suggested agent the user already made does the step instead of being offered again.
    const made = withMadeAgents(definition, [agent("researcher", true), agent("publisher", false)]);
    expect(made.steps[1]?.agent).toBe("publisher");
    // It has no model and neither has the step, which the server would refuse to run.
    expect(
      aboutSteps(draftProblems(made, [agent("researcher", true), agent("publisher", false)])),
    ).toEqual([
      {
        step: "publish",
        message: "Choose a model for Publish. publisher has no model of its own.",
      },
    ]);
    expect(
      aboutSteps(draftProblems(made, [agent("researcher", true), agent("publisher", true)])),
    ).toEqual([]);
  });
});

describe("workflowFromTeamPlan", () => {
  const codex = ProviderInstanceId.make("codex");
  const member = (memberId: string, overrides: Partial<TeamAgent> = {}): TeamAgent => ({
    id: TeamAgentId.make(memberId),
    label: memberId,
    role: "implement",
    modelSelection: { instanceId: codex, model: "gpt-fast" },
    workspace: "shared",
    ...overrides,
  });
  const task = (taskId: string, by: string, dependsOn: ReadonlyArray<string> = []): TeamTask => ({
    id: TeamTaskId.make(taskId),
    title: `Task ${taskId}`,
    brief: `Do ${taskId}.`,
    agentId: TeamAgentId.make(by),
    dependsOn: dependsOn.map((dependency) => TeamTaskId.make(dependency)),
    status: "completed",
    attempt: 1,
    threadId: null,
    result: "Done.",
    startedAt: null,
    completedAt: null,
  });
  const plan: Pick<TeamPlan, "goal" | "agents" | "tasks"> = {
    goal: "Ship the release notes",
    agents: [
      member("writer", { agent: "writer" }),
      member("fact-checker", {
        modelSelection: { instanceId: codex, model: "gpt-strong" },
        suggestion: {
          title: "Fact checker",
          description: "Checks claims.",
          instructions: "",
          connectors: [],
        },
      }),
    ],
    tasks: [
      task("Draft Notes", "writer"),
      {
        ...task("draft notes", "fact-checker", ["Draft Notes"]),
        doneWhen: "Every claim has a source.",
      },
    ],
  };

  it("makes a step per task for the same agents, with slug ids and mapped waits", () => {
    const definition = workflowFromTeamPlan(plan, {
      title: "Release notes",
      model: null,
      projectId: null,
      stepModel: (candidate) =>
        candidate.agent === undefined
          ? {
              instanceId: candidate.modelSelection.instanceId,
              model: candidate.modelSelection.model,
              effort: "medium",
            }
          : null,
    });
    expect(definition.title).toBe("Release notes");
    expect(definition.lead.goal).toBe("Ship the release notes");
    expect(definition.steps.map((candidate) => candidate.id)).toEqual([
      "draft-notes",
      "draft-notes-2",
    ]);
    const [first, second] = definition.steps;
    expect(first).toMatchObject({ agent: "writer", model: null, instructions: "Do Draft Notes." });
    expect(second).toMatchObject({
      agent: null,
      suggestion: { title: "Fact checker" },
      model: { model: "gpt-strong" },
      doneWhen: "Every claim has a source.",
      dependsOn: ["draft-notes"],
    });
  });
});

describe("names", () => {
  it("names a workflow after its title, never `new`, and apart from taken names", () => {
    expect(workflowNameFor("Weekly blog post", [])).toBe("weekly-blog-post");
    expect(workflowNameFor("Weekly blog post", ["weekly-blog-post"])).toBe("weekly-blog-post-2");
    expect(workflowNameFor("New", [])).toBe("new-workflow");
    expect(workflowNameFor("!!!", [])).toBe("workflow");
  });

  it("keeps a saved name while the title fits it, and renames when the title changes", () => {
    const saved = { ...workflow([step("a")]), name: "weekly-blog-post-2" };
    expect(checkWorkflow(saved, ["weekly-blog-post", "weekly-blog-post-2"])).toMatchObject({
      workflow: { name: "weekly-blog-post-2" },
    });
    expect(checkWorkflow({ ...saved, title: " Monday post " }, ["monday-post"])).toMatchObject({
      workflow: { name: "monday-post-2", title: "Monday post" },
    });
  });

  it("says what keeps a workflow from saving", () => {
    const result = checkWorkflow(
      {
        ...workflow([{ ...step("a"), title: " " }]),
        title: "",
        inputs: [
          { name: "Topic", value: "" },
          { name: "topic", value: "" },
        ],
        trigger: {
          ...blankWorkflow().trigger,
          schedule: { days: [], time: "9:00", timeZone: "Nowhere/Else" },
        },
      },
      [],
    );
    expect(result.issues?.map((issue) => issue.message)).toEqual([
      "Give the workflow a name.",
      "Give every step a name.",
      "Choose at least one day for the schedule.",
      "Set a time for the schedule.",
      "Choose a time zone for the schedule.",
      "Give each input its own name.",
    ]);
    expect(result.issues?.[1]?.step).toBe("a");
  });
});

describe("resolveWorkflowEdit", () => {
  const saved = { definition: workflow([step("a")]), notes: "", updatedAt: "2026-11-18T09:00:00Z" };
  const start = blankWorkflow();

  it("keeps edits across a newer save only while they change something", () => {
    const shown = resolveWorkflowEdit(saved, start, null);
    const edit = changeWorkflowEdit(shown, saved, null, {
      definition: { ...saved.definition, title: "Renamed" },
    });
    expect(resolveWorkflowEdit(saved, start, edit)).toMatchObject({
      dirty: true,
      overtaken: false,
    });
    const newer = { ...saved, updatedAt: "2026-11-18T10:00:00Z" };
    expect(resolveWorkflowEdit(newer, start, edit)).toMatchObject({
      dirty: true,
      overtaken: true,
      definition: { title: "Renamed" },
    });
    const undone = changeWorkflowEdit(resolveWorkflowEdit(saved, start, edit), saved, edit, {
      definition: saved.definition,
    });
    expect(resolveWorkflowEdit(newer, start, undone)).toMatchObject({
      dirty: false,
      overtaken: false,
      definition: saved.definition,
    });
  });

  it("starts a new workflow from its starting point", () => {
    const shown = resolveWorkflowEdit(null, start, null);
    expect(shown).toMatchObject({ definition: start, dirty: false });
    const edit = changeWorkflowEdit(shown, null, null, { notes: "Skip herbs." });
    expect(resolveWorkflowEdit(null, start, edit)).toMatchObject({
      notes: "Skip herbs.",
      dirty: true,
    });
  });
});

describe("schedules", () => {
  const monday = { days: ["mon"], time: "09:00", timeZone: "Europe/London" } as const;

  it("lists the next runs in the schedule's own time zone", () => {
    const wednesday = Date.parse("2026-11-18T12:00:00Z");
    expect(upcomingRuns(monday, wednesday, 3)).toEqual([
      Date.parse("2026-11-23T09:00:00Z"),
      Date.parse("2026-11-30T09:00:00Z"),
      Date.parse("2026-12-07T09:00:00Z"),
    ]);
    expect(upcomingRunsLine(monday, wednesday, false)).toBe(
      "Next: Mon 23 Nov, Mon 30 Nov, Mon 7 Dec, all at 9:00.",
    );
    const newYork = { days: ["mon"], time: "09:00", timeZone: "America/New_York" } as const;
    expect(upcomingRuns(newYork, Date.parse("2026-10-30T12:00:00Z"), 1)).toEqual([
      Date.parse("2026-11-02T14:00:00Z"),
    ]);
  });

  it("follows clock changes as the scheduler does", () => {
    const sunday = { days: ["sun"], time: "09:00", timeZone: "Europe/London" } as const;
    expect(upcomingRuns(sunday, Date.parse("2027-03-25T00:00:00Z"), 2)).toEqual([
      Date.parse("2027-03-28T08:00:00Z"),
      Date.parse("2027-04-04T08:00:00Z"),
    ]);
    // 1:30 does not happen when the clocks go forward: the run is at the first minute after.
    expect(
      upcomingRuns({ ...sunday, time: "01:30" }, Date.parse("2027-03-27T12:00:00Z"), 1),
    ).toEqual([Date.parse("2027-03-28T01:00:00Z")]);
    // 1:30 happens twice when they go back: the run is at the first.
    expect(
      upcomingRuns({ ...sunday, time: "01:30" }, Date.parse("2026-10-24T12:00:00Z"), 1),
    ).toEqual([Date.parse("2026-10-25T00:30:00Z")]);
  });
});

describe("runs", () => {
  it("leads a card with its latest run while it needs watching, else its schedule", () => {
    const scheduled = {
      enabled: true,
      trigger: {
        ...blankWorkflow().trigger,
        schedule: { days: ["mon"], time: "09:00", timeZone: "UTC" },
      },
    } as const;
    expect(workflowCardStatus(scheduled, "waiting")).toBe("waiting");
    expect(workflowCardStatus(scheduled, "failed")).toBe("failed");
    expect(workflowCardStatus(scheduled, "stopped")).toBe("on");
    expect(workflowCardStatus({ ...scheduled, enabled: false }, null)).toBe("off");
    expect(workflowCardStatus({ ...scheduled, trigger: blankWorkflow().trigger }, "done")).toBe(
      "manual",
    );
  });

  it.each([
    ["running", undefined, false, "running"],
    ["running", { reason: "spend", at: "2026-11-18T09:00:00Z" }, false, "waiting"],
    ["running", undefined, true, "waiting"],
    ["completed", undefined, true, "done"],
    ["cancelled", undefined, false, "stopped"],
  ] as const)(
    "a %s plan with hold %o, a step asking %s, is %s",
    (status, hold, asking, expected) => {
      expect(workflowRunStatus({ status, hold }, asking)).toBe(expected);
    },
  );

  const task = (overrides: Partial<TeamTask>): TeamTask => ({
    id: TeamTaskId.make("write"),
    title: "Write",
    brief: "Write it.",
    agentId: TeamAgentId.make("writer"),
    dependsOn: [],
    status: "running",
    attempt: 1,
    threadId: null,
    result: null,
    startedAt: "2026-11-18T09:00:00Z",
    completedAt: null,
    ...overrides,
  });

  it.each([
    [{ status: "pending" }, "running", false, "waiting", "Waiting"],
    [{ status: "pending" }, "cancelled", false, "not-started", "Not started"],
    [{}, "running", false, "working", "Working"],
    [{}, "running", true, "needs-you", "Waiting for you"],
    [
      { review: { round: 2, awaiting: true, awaitingSince: null } },
      "running",
      false,
      "checking",
      "The lead is checking · sent back once",
    ],
    [
      {
        status: "completed",
        completedAt: "2026-11-18T09:04:30Z",
        review: { round: 3, awaiting: false, awaitingSince: null },
      },
      "running",
      false,
      "done",
      "Done · 4 min · sent back 2 times",
    ],
    [{ status: "failed" }, "failed", true, "failed", "Failed"],
    [{ status: "cancelled" }, "cancelled", false, "stopped", "Stopped"],
  ] as const)(
    "step %o in a %s run, asking %s, is %s",
    (overrides, planStatus, asking, kind, label) => {
      expect(stepRunState(planStatus, task(overrides), asking)).toMatchObject({ kind, label });
    },
  );

  it("goes on after a limit with what the run used plus what the workflow sets", () => {
    const run = { spendUsd: 4, minutes: 60 };
    const within = { costUsd: 3.5, minutes: 40 };
    expect(raisedLimits(run, { spendUsd: 2, minutes: 30 }, "spend", within)).toEqual({
      spendUsd: 6,
      minutes: 60,
    });
    expect(raisedLimits(run, null, "time", within)).toEqual({ spendUsd: 4, minutes: 120 });
    // A step that was already working finished past the limit.
    expect(
      raisedLimits(run, { spendUsd: 2, minutes: 30 }, "spend", { costUsd: 4.61, minutes: 62.5 }),
    ).toEqual({
      spendUsd: 6.61,
      minutes: 60,
    });
    expect(
      raisedLimits(run, { spendUsd: 2, minutes: 30 }, "time", { costUsd: 4.61, minutes: 62.5 }),
    ).toEqual({
      spendUsd: 4,
      minutes: 93,
    });
    expect(raisedLimits({ spendUsd: null, minutes: 10 }, null, "spend", within)).toEqual({
      spendUsd: null,
      minutes: 10,
    });
    // A run that cannot be priced drops the limit, so it is not stopped for it again.
    expect(raisedLimits(run, { spendUsd: 2, minutes: 30 }, "unpriced", within)).toEqual({
      spendUsd: null,
      minutes: 60,
    });
  });

  it("reads a machine's runs from shells, waiting while a step asks, newest first", () => {
    const environmentId = EnvironmentId.make("machine");
    const lead = (run: number, status: TeamPlanSummary["status"], startedAt: string) => ({
      environmentId,
      id: ThreadId.make(`thread:workflow:wf-1:${run}`),
      deletedAt: null,
      updatedAt: "2026-11-18T12:00:00Z",
      latestRun: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      source: {
        teamSummary: {
          planId: TeamPlanId.make(`plan-${run}`),
          status,
          revision: 1,
          total: 2,
          completed: 0,
          failed: 0,
          running: 1,
          cancelled: 0,
          run: {
            workflowId: WorkflowId.make("wf-1"),
            workflowName: "weekly-blog-post",
            title: "Weekly blog post",
            run,
            trigger: "schedule" as const,
            scheduledFor: startedAt,
            approvals: "ask" as const,
            startedAt,
            costUsd: 0.34,
            headline: null,
          },
        },
      },
    });
    const asking = {
      environmentId,
      id: ThreadId.make("thread:step"),
      deletedAt: null,
      updatedAt: "2026-11-18T12:00:00Z",
      latestRun: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      source: {
        pendingConnectorApproval: true,
        teamTask: {
          rootThreadId: ThreadId.make("thread:workflow:wf-1:2"),
          planId: TeamPlanId.make("plan-2"),
          taskId: TeamTaskId.make("publish"),
          attempt: 1,
        },
      },
    };
    const runs = workflowRunsOf(
      [
        lead(1, "completed", "2026-11-09T09:00:00Z"),
        lead(2, "running", "2026-11-16T09:00:00Z"),
        asking,
        { ...lead(3, "running", "2026-11-17T09:00:00Z"), deletedAt: "2026-11-17T10:00:00Z" },
        { ...lead(4, "running", "2026-11-17T09:00:00Z"), environmentId: EnvironmentId.make("x") },
      ],
      environmentId,
    );
    expect(runs.map((run) => [run.run, run.status, run.endedAt])).toEqual([
      [2, "waiting", null],
      [1, "done", "2026-11-18T12:00:00Z"],
    ]);
    expect(
      workflowHistoryRows(runs, [{ scheduledFor: "2026-11-02T09:00:00Z" }]).map((row) =>
        row.kind === "run" ? row.run.run : row.scheduledFor,
      ),
    ).toEqual([2, 1, "2026-11-02T09:00:00Z"]);
  });

  it("says how a run started", () => {
    const options = { nowMs: Date.parse("2026-11-18T12:00:00Z"), hour12: false, timeZone: "UTC" };
    expect(runStartLine({ trigger: "manual", scheduledFor: null }, options)).toBe("You started it");
    expect(runStartLine({ trigger: "missed", scheduledFor: "2026-11-16T09:00:00Z" }, options)).toBe(
      "Missed Mon 16 Nov at 9:00, ran when Codenine was back",
    );
  });
});
