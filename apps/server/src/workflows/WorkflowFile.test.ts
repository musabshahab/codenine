import {
  ProjectId,
  type WorkflowDefinition,
  WorkflowId,
  type WorkflowStep,
  WorkflowStepId,
} from "@codenine/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  appendNote,
  EMPTY_WORKFLOW_STATE,
  parseWorkflowFile,
  parseWorkflowState,
  renderWorkflowFile,
  trimNotes,
  workflowDefinitionIssue,
} from "./WorkflowFile.ts";

const step = (id: string, dependsOn: ReadonlyArray<string> = []): WorkflowStep => ({
  id: WorkflowStepId.make(id),
  title: id.charAt(0).toUpperCase() + id.slice(1),
  agent: "writer",
  model: null,
  instructions: "Do the work.",
  doneWhen: "",
  dependsOn: dependsOn.map((dependency) => WorkflowStepId.make(dependency)),
  position: { x: 0, y: 0 },
});

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
    model: null,
    goal: "A digest our readers trust.",
    projectId: ProjectId.make("project-site"),
    approvals: "ask",
    limits: { spendUsd: 5, minutes: null },
  },
  steps: [step("research"), step("draft", ["research"])],
};
const id = WorkflowId.make("4d1f6c1e-0d6a-4d0e-9c55-2f1f0f0a7b11");

describe("workflow.json", () => {
  it("reads back what it writes, named by its folder, and keeps keys it does not know", () => {
    const written = renderWorkflowFile(id, digest);
    expect(Object.keys(JSON.parse(written))).not.toContain("name");
    expect(parseWorkflowFile("weekly-digest", written)).toEqual({
      _tag: "found",
      id,
      workflow: digest,
    });
    // A folder renamed by hand renames the workflow; its id stays.
    expect(parseWorkflowFile("digest", written)).toMatchObject({
      id,
      workflow: { name: "digest" },
    });

    const fromNewerVersion = JSON.stringify({ ...JSON.parse(written), owner: "platform" });
    const edited = renderWorkflowFile(id, { ...digest, title: "Digest" }, fromNewerVersion);
    expect(JSON.parse(edited)).toMatchObject({ id, title: "Digest", owner: "platform" });
  });

  it("is broken when it cannot be read or would not save, keeping the id it names", () => {
    expect(parseWorkflowFile("weekly-digest", "{ not json")).toMatchObject({
      _tag: "broken",
      id: undefined,
    });
    expect(parseWorkflowFile("weekly-digest", JSON.stringify({ id, title: 7 }))).toMatchObject({
      _tag: "broken",
      id,
    });
    const looped = renderWorkflowFile(id, {
      ...digest,
      steps: [step("research", ["draft"]), step("draft", ["research"])],
    });
    expect(parseWorkflowFile("weekly-digest", looped)).toMatchObject({ _tag: "broken", id });
  });

  it("refuses steps that repeat an id, wait for a step that is not there, or wait in a loop", () => {
    expect(workflowDefinitionIssue(digest)).toBeNull();
    expect(workflowDefinitionIssue({ ...digest, steps: [step("draft"), step("draft")] })).toBe(
      'Two steps have the id "draft". Give each its own.',
    );
    expect(workflowDefinitionIssue({ ...digest, steps: [step("draft", ["research"])] })).toBe(
      '"Draft" waits for "research", which is not a step of this workflow.',
    );
    expect(
      workflowDefinitionIssue({
        ...digest,
        steps: [step("research", ["check"]), step("draft", ["research"]), step("check", ["draft"])],
      }),
    ).toBe("Steps wait for each other in a loop: Research → Check → Draft → Research.");
    expect(workflowDefinitionIssue({ ...digest, steps: [step("draft", ["draft"])] })).toBe(
      "Steps wait for each other in a loop: Draft → Draft.",
    );
    expect(
      workflowDefinitionIssue({
        ...digest,
        steps: Array.from({ length: 13 }, (_, index) => step(`step-${index}`)),
      }),
    ).toBe("A workflow has at most 12 steps; this one has 13.");
    expect(
      workflowDefinitionIssue({
        ...digest,
        trigger: {
          ...digest.trigger,
          schedule: { days: ["mon"], time: "09:00", timeZone: "Moon" },
        },
      }),
    ).toBe('Codenine does not know the time zone "Moon".');
  });
});

describe("notes.md", () => {
  it("keeps the newest lines that fit, dropping the oldest first", () => {
    const line = (index: number) => `- run ${index}: ${"x".repeat(90)}`;
    const notes = Array.from({ length: 79 }, (_, index) => line(index + 1)).join("\n");
    expect(notes.length).toBeLessThan(8_000);
    const added = appendNote(notes, line(80));
    expect(added.length).toBeLessThanOrEqual(8_000);
    expect(added.endsWith(line(80))).toBe(true);
    expect(added.startsWith(`${line(2)}\n`)).toBe(true);
    expect(appendNote("  \n", "- first")).toBe("- first");
    expect(trimNotes("y".repeat(9_000))).toHaveLength(8_000);
  });
});

it("starts over from a state file it cannot read", () => {
  expect(parseWorkflowState("{ runs: ")).toEqual(EMPTY_WORKFLOW_STATE);
  expect(parseWorkflowState(JSON.stringify({ ...EMPTY_WORKFLOW_STATE, runs: 4 })).runs).toBe(4);
});
