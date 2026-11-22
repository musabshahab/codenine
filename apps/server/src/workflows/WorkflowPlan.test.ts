import {
  type AgentModel,
  ProjectId,
  type TeamTask,
  TeamTaskId,
  WORKFLOW_RUN_RESULT_MAX_CHARS,
  ProviderInstanceId,
  type ServerProvider,
  type WorkflowDefinition,
  type WorkflowStep,
  WorkflowStepId,
} from "@codenine/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  capRunResult,
  runResult,
  turnUsage,
  type WorkflowAgent,
  workflowProblems,
  workflowRunBrief,
  workflowTeam,
} from "./WorkflowPlan.ts";

const claude = ProviderInstanceId.make("claude_work");
const model = (name: string): AgentModel => ({ instanceId: claude, model: name, effort: "high" });
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
const agents = new Map<string, WorkflowAgent>([
  ["researcher", { title: "Researcher", model: model("claude-x") }],
  ["writer", { title: "Writer", model: model("claude-x") }],
  ["editor", { title: "Editor", model: null }],
]);

const step = (
  id: string,
  agent: string | null,
  options: Partial<Pick<WorkflowStep, "model" | "dependsOn" | "doneWhen" | "instructions">> = {},
): WorkflowStep => ({
  id: WorkflowStepId.make(id),
  title: id.charAt(0).toUpperCase() + id.slice(1),
  agent,
  model: null,
  instructions: `Do the ${id}.`,
  doneWhen: "",
  dependsOn: [],
  position: { x: 0, y: 0 },
  ...options,
});

const digest: WorkflowDefinition = {
  name: "weekly-digest",
  title: "Weekly digest",
  description: "",
  enabled: true,
  trigger: { schedule: null, missedRuns: "once", position: { x: 0, y: 0 } },
  inputs: [],
  lead: {
    model: model("claude-x"),
    goal: "A digest our readers trust.",
    projectId: ProjectId.make("project-site"),
    approvals: "ask",
    limits: { spendUsd: null, minutes: null },
  },
  steps: [
    step("research", "researcher"),
    step("draft", "writer", { dependsOn: [WorkflowStepId.make("research")] }),
    step("check", "writer", {
      model: model("claude-y"),
      dependsOn: [WorkflowStepId.make("draft")],
      doneWhen: "Every claim has a source.",
    }),
  ],
};

describe("workflowProblems", () => {
  const problems = (workflow: WorkflowDefinition, projectExists = true) =>
    workflowProblems({ workflow, agents, providers, projectExists });

  it("has none for a workflow that can run", () => {
    expect(problems(digest)).toEqual([]);
  });

  it("says what keeps each step or the whole workflow from running", () => {
    const broken: WorkflowDefinition = {
      ...digest,
      lead: { ...digest.lead, model: { ...model("claude-z") }, goal: "  " },
      steps: [
        step("research", null),
        step("draft", null, {}),
        step("outline", "archivist"),
        step("edit", "editor"),
        step("check", "writer", {
          model: { ...model("claude-x"), instanceId: ProviderInstanceId.make("codex_off") },
        }),
      ].map((candidate, index) =>
        index === 1
          ? {
              ...candidate,
              suggestion: {
                title: "Fact checker",
                description: "Checks facts.",
                instructions: "",
                connectors: [],
              },
            }
          : candidate,
      ),
    };
    expect(problems(broken, false)).toEqual([
      {
        step: null,
        message: "Describe the outcome you want. The lead checks every result against it.",
      },
      {
        step: null,
        message: "The lead's model is no longer offered by its account. Choose another.",
      },
      {
        step: null,
        message: "The workspace this workflow works in no longer exists. Choose another.",
      },
      { step: "research", message: "Choose an agent for this step." },
      {
        step: "draft",
        message: 'Create the suggested agent "Fact checker", or choose one of yours.',
      },
      { step: "outline", message: 'The agent "archivist" no longer exists. Choose another.' },
      { step: "edit", message: "Choose a model for this step. Editor has no model of its own." },
      {
        step: "check",
        message: "This step's model is on an account that is turned off or removed.",
      },
    ]);
    expect(
      problems({ ...digest, steps: [], lead: { ...digest.lead, model: null, projectId: null } }),
    ).toEqual([
      { step: null, message: "Choose a model for the lead." },
      { step: null, message: "Choose the workspace the steps work in." },
      { step: null, message: "Add a step for one of your agents to do." },
    ]);
  });

  it("counts distinct agent and model pairs against a team's size", () => {
    const pairs = ["writer", "researcher"].flatMap((agent) =>
      ["claude-x", "claude-y"].flatMap((name) =>
        (["low", "medium", "high", "max"] as const).map((effort) => ({
          agent,
          model: { ...model(name), effort },
        })),
      ),
    );
    const wide: WorkflowDefinition = {
      ...digest,
      steps: [
        ...pairs
          .slice(0, 13)
          .map((pair, index) => step(`step-${index}`, pair.agent, { model: pair.model })),
        step("again", "writer", { model: pairs[0]!.model }),
      ],
    };
    expect(problems(wide)).toEqual([
      {
        step: null,
        message:
          "A run can use at most 12 pairs of agent and model; this workflow uses 13. Give some steps the same agent and model.",
      },
    ]);
  });
});

describe("workflowTeam", () => {
  it("makes one member per agent and model, and a task per step", () => {
    const team = workflowTeam({ workflow: digest, agents, providers });
    expect(
      team?.agents.map(({ id, label, agent, modelSelection }) => [
        id,
        label,
        agent,
        modelSelection.model,
      ]),
    ).toEqual([
      ["researcher", "Researcher", "researcher", "claude-x"],
      ["writer", "Writer", "writer", "claude-x"],
      ["writer:2", "Writer", "writer", "claude-y"],
    ]);
    expect(
      team?.agents.every((member) => member.role === "custom" && member.workspace === "shared"),
    ).toBe(true);
    expect(team?.tasks).toEqual([
      {
        id: "research",
        title: "Research",
        brief: "Do the research.",
        agentId: "researcher",
        dependsOn: [],
      },
      {
        id: "draft",
        title: "Draft",
        brief: "Do the draft.",
        agentId: "writer",
        dependsOn: ["research"],
      },
      {
        id: "check",
        title: "Check",
        brief: "Do the check.",
        agentId: "writer:2",
        dependsOn: ["draft"],
        doneWhen: "Every claim has a source.",
      },
    ]);
  });

  it("briefs a step with no instructions or inputs by its title, and has no team for a step without an agent", () => {
    const bare = { ...digest, steps: [step("research", "researcher", { instructions: " " })] };
    expect(workflowTeam({ workflow: bare, agents, providers })?.tasks[0]?.brief).toBe("Research");
    const unassigned = { ...digest, steps: [step("research", null)] };
    expect(workflowTeam({ workflow: unassigned, agents, providers })).toBeNull();
  });
});

describe("workflowRunBrief", () => {
  it("gives the lead the goal, the run's inputs, each step with its Done when, and past notes", () => {
    const brief = workflowRunBrief({
      workflow: digest,
      run: 3,
      inputs: [{ name: "Topic", value: "Agents" }],
      notes: "- 2026-11-09 run 2: Readers liked the charts.",
      agents,
    });
    expect(brief.startsWith("You lead run 3 of the workflow 'Weekly digest'.")).toBe(true);
    expect(brief).toContain("Goal:\nA digest our readers trust.");
    expect(brief).toContain("This run's inputs:\n- Topic: Agents");
    expect(brief).toContain(
      '- Check (step "check"), by Writer. Done when: Every claim has a source. Depends on: Draft.',
    );
    expect(brief).toContain("Notes from past runs:\n- 2026-11-09 run 2: Readers liked the charts.");
    const plain = workflowRunBrief({ workflow: digest, run: 1, inputs: [], notes: " ", agents });
    expect(plain).not.toContain("This run's inputs");
    expect(plain).not.toContain("Notes from past runs");
  });
});

describe("turnUsage", () => {
  it("separates cached input from the input total and adds work beyond the main agent", () => {
    expect(
      turnUsage(
        {
          model: "claude-opus-x",
          turnTokenUsage: {
            usageScope: "main_agent",
            usageStatus: "complete",
            hasSubagents: true,
            inputTokens: 1_000,
            cachedInputTokens: 600,
            cacheCreationTokens: 100,
            outputTokens: 50,
            reasoningTokens: 20,
            otherUsage: { inputTokens: 40, outputTokens: 5 },
          },
        },
        "claude-x",
      ),
    ).toEqual({
      model: "claude-opus-x",
      totals: {
        uncachedInputTokens: 340,
        cachedInputTokens: 600,
        cacheCreationTokens: 100,
        outputTokens: 55,
        reasoningTokens: 20,
      },
    });
    const partial = {
      usageScope: "main_agent",
      usageStatus: "partial",
      hasSubagents: false,
      outputTokens: 9,
    } as const;
    expect(turnUsage({ turnTokenUsage: partial }, "claude-x")?.model).toBe("claude-x");
    expect(
      turnUsage({ turnTokenUsage: { ...partial, localCommand: true } }, "claude-x"),
    ).toBeUndefined();
    expect(turnUsage({}, "claude-x")).toBeUndefined();
  });
});

describe("runResult", () => {
  const task = (
    id: string,
    dependsOn: ReadonlyArray<string>,
    status: TeamTask["status"],
    result: string | null,
  ) =>
    ({
      id: TeamTaskId.make(id),
      title: id.charAt(0).toUpperCase() + id.slice(1),
      dependsOn: dependsOn.map((dependency) => TeamTaskId.make(dependency)),
      status,
      result,
    }) as unknown as TeamTask;

  it.each([
    {
      label: "the one last step's result",
      tasks: [
        task("research", [], "completed", "Notes"),
        task("draft", ["research"], "completed", "Draft"),
      ],
      expected: "Draft",
    },
    {
      label: "each last step under its title, in plan order",
      tasks: [
        task("research", [], "completed", "Notes"),
        task("post", ["research"], "completed", "Posted"),
        task("email", ["research"], "completed", "Sent"),
      ],
      expected: "## Post\n\nPosted\n\n## Email\n\nSent",
    },
    {
      label: "nothing when no last step completed with a result",
      tasks: [
        task("research", [], "completed", "Notes"),
        task("draft", ["research"], "failed", null),
        task("check", ["research"], "completed", null),
      ],
      expected: null,
    },
  ])("is $label", ({ tasks, expected }) => {
    expect(runResult({ tasks })).toBe(expected);
  });

  it("cuts a result to the limit, marker included, without splitting a character", () => {
    const marker = "\n\n[Result cut short. Open the run for the rest.]";
    const fits = "a".repeat(WORKFLOW_RUN_RESULT_MAX_CHARS);
    expect(capRunResult(fits)).toBe(fits);
    const kept = "a".repeat(WORKFLOW_RUN_RESULT_MAX_CHARS - marker.length);
    expect(capRunResult(`${fits}b`)).toBe(`${kept}${marker}`);
    // The emoji would straddle the cut, so it goes whole.
    expect(capRunResult(`${kept.slice(1)}😀${fits}`)).toBe(`${kept.slice(1)}${marker}`);
  });
});
