import {
  CommandId,
  ProviderInstanceId,
  RunId,
  type TeamAgent,
  TeamAgentId,
  type TeamPlan,
  TeamPlanId,
  type TeamPlanRun,
  type TeamTaskDraft,
  TeamTaskId,
  ThreadId,
  WorkflowId,
} from "@codenine/contracts";
import { describe, expect, it } from "vite-plus/test";

import { decideTeamCommand, type TeamCommand, type TeamDecision } from "./TeamPlan.ts";

const planId = TeamPlanId.make("plan");
const target = { commandId: CommandId.make("command"), threadId: ThreadId.make("thread:lead") };
const started = "2026-11-18T10:00:00.000Z";
const later = "2026-11-18T10:05:00.000Z";

const member = (id: string): TeamAgent => ({
  id: TeamAgentId.make(id),
  label: id,
  role: "custom",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt" },
  workspace: "shared",
  agent: id,
});
const writer = member("writer");

const step = (id: string, dependsOn: ReadonlyArray<string> = []): TeamTaskDraft => ({
  id: TeamTaskId.make(id),
  title: `Step ${id}`,
  brief: `Do ${id}.`,
  agentId: writer.id,
  dependsOn: dependsOn.map((dependency) => TeamTaskId.make(dependency)),
  doneWhen: `${id} is done.`,
});

const run: TeamPlanRun = {
  workflowId: WorkflowId.make("workflow"),
  workflowName: "weekly-digest",
  title: "Weekly digest",
  run: 1,
  trigger: "manual",
  scheduledFor: null,
  inputs: [],
  approvals: "ask",
  limits: { spendUsd: 5, minutes: null },
  startedAt: started,
  costUsd: null,
  headline: null,
  note: null,
};

const decide = (plan: TeamPlan | null, command: TeamCommand, now = later) =>
  decideTeamCommand({ thread: { team: plan }, command, now, newPlanId: planId });

function applied(decision: TeamDecision) {
  if (decision.type !== "updated")
    throw new Error(`Expected an update: ${JSON.stringify(decision)}`);
  return decision;
}

const rejection = (decision: TeamDecision) =>
  decision.type === "rejected" ? decision.reason.split(":")[0] : decision.type;

const start = (
  tasks: ReadonlyArray<TeamTaskDraft>,
  agents: ReadonlyArray<TeamAgent> = [writer],
  maxParallelPerProvider?: number,
): TeamCommand => ({
  type: "team.start",
  ...target,
  goal: "Publish a weekly digest",
  agents,
  tasks,
  run,
  ...(maxParallelPerProvider === undefined ? {} : { maxParallelPerProvider }),
});

const startRun = (...tasks: ReadonlyArray<TeamTaskDraft>) =>
  applied(decide(null, start(tasks), started)).plan;

const settle = (
  taskId: string,
  runId: string,
  status: "completed" | "failed" = "completed",
): TeamCommand => ({
  type: "team.task.settle",
  ...target,
  planId,
  taskId: TeamTaskId.make(taskId),
  attempt: 1,
  status,
  result: `Result of ${runId}`,
  runId: RunId.make(runId),
});

const review = (
  taskId: string,
  round: number,
  verdict: "accept" | "revise",
  notes?: string,
): TeamCommand => ({
  type: "team.task.review",
  ...target,
  planId,
  taskId: TeamTaskId.make(taskId),
  attempt: 1,
  round,
  verdict,
  ...(notes === undefined ? {} : { notes }),
});

const hold = (reason: "spend" | "time" | "review"): TeamCommand => ({
  type: "team.hold",
  ...target,
  planId,
  reason,
});

const states = (plan: TeamPlan) =>
  Object.fromEntries(
    plan.tasks.map((task) => [
      task.id,
      `${task.status}#${task.review?.round}${task.review?.awaiting ? ":awaiting" : ""}`,
    ]),
  );

const ids = (tasks: ReadonlyArray<{ readonly id: string }>) => tasks.map((task) => task.id);

describe("decideTeamCommand for workflow runs", () => {
  it("starts a run approved, with every step at round one and the first launched", () => {
    const decision = applied(decide(null, start([step("draft"), step("publish", ["draft"])])));
    expect(decision.plan).toMatchObject({ id: planId, status: "running", revision: 1, run });
    expect(states(decision.plan)).toEqual({ draft: "running#1", publish: "pending#1" });
    expect(ids(decision.launch)).toEqual(["draft"]);
  });

  it.each([
    ["a plan is running", startRun(step("draft")), [step("draft")], [writer], "team_plan_running"],
    ["its draft is invalid", null, [step("draft", ["missing"])], [writer], "team_invalid"],
    [
      "a member has no agent",
      null,
      [step("draft")],
      [{ ...writer, agent: undefined }],
      "team_agent_needed",
    ],
  ] as const)("refuses to start when %s", (_name, plan, tasks, agents, code) => {
    expect(rejection(decide(plan, start(tasks, agents)))).toBe(code);
  });

  it("holds a step's result for review, and each of its runs reports once", () => {
    const settled = applied(
      decide(startRun(step("draft"), step("publish", ["draft"])), settle("draft", "run:1")),
    );
    expect(states(settled.plan)).toEqual({ draft: "running#1:awaiting", publish: "pending#1" });
    expect(settled.plan.tasks[0]).toMatchObject({
      result: "Result of run:1",
      resultRunId: "run:1",
      review: { round: 1, awaiting: true, awaitingSince: later },
    });
    expect(ids(settled.reviewSteps)).toEqual(["draft"]);
    expect(settled.launch).toEqual([]);
    expect(settled.wakeLead).toBe(false);
    expect(decide(settled.plan, settle("draft", "run:1")).type).toBe("unchanged");
  });

  it("sends a step back into its next round with the notes, then starts its dependents once accepted", () => {
    const awaiting = applied(
      decide(startRun(step("draft"), step("publish", ["draft"])), settle("draft", "run:1")),
    ).plan;
    expect(rejection(decide(awaiting, review("draft", 1, "revise")))).toBe(
      "team_review_notes_required",
    );

    const sentBack = applied(decide(awaiting, review("draft", 1, "revise", "Cite sources.")));
    expect(states(sentBack.plan)).toEqual({ draft: "running#2", publish: "pending#1" });
    expect(sentBack.sendBack).toEqual({ task: sentBack.plan.tasks[0], notes: "Cite sources." });
    expect(sentBack.launch).toEqual([]);
    // Notes stay out of the plan, which every event on the lead carries.
    expect(JSON.stringify(sentBack.plan)).not.toContain("Cite sources.");
    expect(rejection(decide(sentBack.plan, review("draft", 1, "accept")))).toBe(
      "team_task_not_awaiting_review",
    );

    const fixed = applied(decide(sentBack.plan, settle("draft", "run:2")));
    expect(states(fixed.plan)).toEqual({ draft: "running#2:awaiting", publish: "pending#1" });
    expect(fixed.plan.tasks[0]?.result).toBe("Result of run:2");
    const accepted = applied(decide(fixed.plan, review("draft", 2, "accept")));
    expect(states(accepted.plan)).toEqual({ draft: "completed#2", publish: "running#1" });
    expect(ids(accepted.launch)).toEqual(["publish"]);

    const finished = applied(
      decide(
        applied(decide(accepted.plan, settle("publish", "run:3"))).plan,
        review("publish", 1, "accept"),
      ),
    );
    expect(finished.plan.status).toBe("completed");
    expect(finished).toMatchObject({ wakeLead: true, settleTaskThreads: true, reviewSteps: [] });
  });

  it("fails a step as a team task fails, and a retry starts its review over", () => {
    const awaiting = applied(
      decide(startRun(step("draft"), step("publish", ["draft"])), settle("draft", "run:1")),
    ).plan;
    // A later run of the step's thread fails, such as one the user started there.
    const failed = applied(decide(awaiting, settle("draft", "run:2", "failed")));
    expect(states(failed.plan)).toEqual({ draft: "failed#1", publish: "pending#1" });
    expect(failed.plan.status).toBe("failed");
    expect(failed.wakeLead).toBe(true);

    const retried = applied(
      decide(failed.plan, { type: "team.task.retry", ...target, taskId: TeamTaskId.make("draft") }),
    );
    expect(retried.plan.tasks[0]).toMatchObject({
      status: "running",
      attempt: 2,
      review: { round: 1, awaiting: false, awaitingSince: null },
    });
    expect(retried.plan.tasks[0]).not.toHaveProperty("resultRunId");
  });

  it("starts nothing and wakes nobody while a limit holds the run, until the user resumes it", () => {
    // Two steps fill the provider's two slots; the third waits for one.
    const running = startRun(step("draft"), step("notes"), step("publish"));
    const held = applied(decide(running, hold("spend")));
    expect(held.plan.hold).toEqual({ reason: "spend", at: later });
    expect(decide(held.plan, hold("spend")).type).toBe("unchanged");
    // A review hold lifts itself, so it never replaces a limit's hold.
    expect(decide(held.plan, hold("review")).type).toBe("unchanged");

    // Running steps finish: a result waits without a wake, and a freed slot stays empty.
    const settled = applied(decide(held.plan, settle("draft", "run:1")));
    expect(settled.reviewSteps).toEqual([]);
    const failed = applied(decide(settled.plan, settle("notes", "run:2", "failed")));
    expect(failed.launch).toEqual([]);
    expect(failed.plan.status).toBe("running");
    expect(rejection(decide(failed.plan, review("draft", 1, "accept")))).toBe("team_run_waiting");

    const raised = { spendUsd: 10, minutes: 30 };
    const resumed = applied(
      decide(failed.plan, { type: "team.resume", ...target, planId, limits: raised }),
    );
    expect(resumed.plan).not.toHaveProperty("hold");
    expect(resumed.plan.run?.limits).toEqual(raised);
    expect(ids(resumed.reviewSteps)).toEqual(["draft"]);
    expect(ids(resumed.launch)).toEqual(["publish"]);
    expect(rejection(decide(resumed.plan, { type: "team.resume", ...target, planId }))).toBe(
      "team_run_not_waiting",
    );

    const cancelled = applied(decide(held.plan, { type: "team.cancel", ...target }));
    expect(cancelled.plan).not.toHaveProperty("hold");
  });

  it("lets the user decide while the lead left steps undecided, and lifts that hold with the last one", () => {
    const running = startRun(step("a"), step("b"), step("c", ["a", "b"]));
    expect(decide(running, hold("review")).type).toBe("unchanged");
    const awaiting = applied(
      decide(applied(decide(running, settle("a", "run:a"))).plan, settle("b", "run:b")),
    ).plan;
    const held = applied(decide(awaiting, hold("review"))).plan;

    // A send-back is the user's decision, so its notes go out while other steps still wait.
    const sentBack = applied(decide(held, review("a", 1, "revise", "Shorter.")));
    expect(sentBack.sendBack?.notes).toBe("Shorter.");
    expect(sentBack.plan.hold?.reason).toBe("review");

    const settled = applied(decide(sentBack.plan, settle("a", "run:a2")));
    expect(settled.reviewSteps).toEqual([]);
    const acceptedA = applied(decide(settled.plan, review("a", 2, "accept")));
    expect(acceptedA.plan.hold?.reason).toBe("review");
    expect(acceptedA.launch).toEqual([]);
    const acceptedB = applied(decide(acceptedA.plan, review("b", 1, "accept")));
    expect(acceptedB.plan).not.toHaveProperty("hold");
    expect(ids(acceptedB.launch)).toEqual(["c"]);
  });

  it("records the run's cost and the lead's headline and note, also once the run is done", () => {
    const update = (fields: { costUsd?: number | null; headline?: string; note?: string }) =>
      ({ type: "team.run.update", ...target, planId, ...fields }) satisfies TeamCommand;
    const costed = applied(decide(startRun(step("draft")), update({ costUsd: 1.5 }))).plan;
    expect(costed.run).toMatchObject({ costUsd: 1.5, headline: null, note: null });
    expect(decide(costed, update({ costUsd: 1.5 })).type).toBe("unchanged");

    const done = { ...costed, status: "completed" as const };
    const noted = applied(
      decide(done, update({ headline: "Published the digest", note: "Cover agents next." })),
    ).plan;
    expect(noted.run).toMatchObject({
      costUsd: 1.5,
      headline: "Published the digest",
      note: "Cover agents next.",
    });
  });

  it("reviews only a workflow run's steps", () => {
    const team = applied(
      decide(null, {
        type: "team.propose",
        ...target,
        goal: "Ship it",
        agents: [writer],
        tasks: [step("draft")],
      }),
    ).plan;
    expect(rejection(decide(team, review("draft", 1, "accept")))).toBe("team_not_workflow_run");
    expect(decide(team, hold("spend")).type).toBe("unchanged");
  });
});

describe("decideTeamCommand for teams", () => {
  const sol = { instanceId: ProviderInstanceId.make("claude"), model: "sol" };
  const propose = (
    tasks: ReadonlyArray<TeamTaskDraft>,
    goal = "Ship it",
    agents: ReadonlyArray<TeamAgent> = [writer],
  ): TeamCommand => ({ type: "team.propose", ...target, goal, agents, tasks });
  const approve: TeamCommand = { type: "team.approve", ...target, expectedRevision: 1 };
  const approved = (tasks: ReadonlyArray<TeamTaskDraft>, agents?: ReadonlyArray<TeamAgent>) =>
    applied(decide(applied(decide(null, propose(tasks, "Ship it", agents))).plan, approve)).plan;
  const settleTask = (
    taskId: string,
    attempt: number,
    status: "completed" | "failed",
    result = "Done.",
  ): TeamCommand => ({
    type: "team.task.settle",
    ...target,
    planId,
    taskId: TeamTaskId.make(taskId),
    attempt,
    status,
    result,
  });
  const retry = (
    taskId: string,
    fields: { agentId?: TeamAgent["id"]; modelSelection?: typeof sol } = {},
  ): TeamCommand => ({
    type: "team.task.retry",
    ...target,
    taskId: TeamTaskId.make(taskId),
    ...fields,
  });
  const edit = (
    tasks: ReadonlyArray<TeamTaskDraft>,
    maxParallelPerProvider?: number,
  ): TeamCommand => ({
    type: "team.edit",
    ...target,
    expectedRevision: 1,
    agents: [writer],
    tasks,
    ...(maxParallelPerProvider === undefined ? {} : { maxParallelPerProvider }),
  });
  // Ten full briefs: 60,000 characters of the 64,000 a plan's text may have.
  const fullBriefs = Array.from({ length: 10 }, (_, index): TeamTaskDraft => ({
    id: TeamTaskId.make(`t${index}`),
    title: `Step ${index}`,
    brief: "x".repeat(6_000),
    agentId: writer.id,
    dependsOn: [],
  }));

  it("cuts each result to its share of the plan's result budget", () => {
    const tasks = Array.from({ length: 20 }, (_, index) => step(`t${index}`));
    const settled = applied(
      decide(approved(tasks), settleTask("t0", 1, "completed", "x".repeat(5_000))),
    );
    expect(settled.plan.tasks[0]?.result?.indexOf("\n\n[")).toBe(3_200);
  });

  it("counts the goal against the plan's text budget, also the proposed goal on an edit", () => {
    expect(decide(null, propose(fullBriefs, "x".repeat(4_000))).type).toBe("updated");
    expect(rejection(decide(null, propose(fullBriefs, "x".repeat(4_001))))).toBe("team_invalid");
    const longGoal = applied(decide(null, propose([step("one")], "x".repeat(4_001)))).plan;
    expect(rejection(decide(longGoal, edit(fullBriefs)))).toBe("team_invalid");
  });

  it.each([0, 7])("refuses %i tasks at a time per provider", (maxParallelPerProvider) => {
    const proposed = applied(decide(null, propose([step("one")]))).plan;
    expect(rejection(decide(proposed, edit([step("one")], maxParallelPerProvider)))).toBe(
      "team_invalid",
    );
    expect(rejection(decide(null, start([step("one")], [writer], maxParallelPerProvider)))).toBe(
      "team_invalid",
    );
  });

  it("moves a retried task to the model it names and keeps it there, never changing the member", () => {
    const failed = applied(decide(approved([step("one")]), settleTask("one", 1, "failed"))).plan;
    const moved = applied(decide(failed, retry("one", { modelSelection: sol })));
    expect(moved.plan.tasks[0]).toMatchObject({
      attempt: 2,
      status: "running",
      modelSelection: sol,
    });
    expect(moved.launch[0]?.modelSelection).toEqual(sol);
    expect(moved.plan.agents).toEqual([writer]);

    const failedAgain = applied(decide(moved.plan, settleTask("one", 2, "failed"))).plan;
    const again = applied(decide(failedAgain, retry("one")));
    expect(again.plan.tasks[0]).toMatchObject({ attempt: 3, modelSelection: sol });
  });

  it("runs a task retried on another member on that member's model", () => {
    const reviewer = member("reviewer");
    const failed = applied(
      decide(approved([step("one")], [writer, reviewer]), settleTask("one", 1, "failed")),
    ).plan;
    const moved = applied(decide(failed, retry("one", { modelSelection: sol }))).plan;
    const failedAgain = applied(decide(moved, settleTask("one", 2, "failed"))).plan;
    const onReviewer = applied(decide(failedAgain, retry("one", { agentId: reviewer.id }))).plan;
    expect(onReviewer.tasks[0]).toMatchObject({ agentId: "reviewer", attempt: 3 });
    expect(onReviewer.tasks[0]).not.toHaveProperty("modelSelection");
  });
});
