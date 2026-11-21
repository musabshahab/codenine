import {
  AgentName,
  type WorkflowDraft,
  WorkflowId,
  type WorkflowStepId,
  type WorkflowSummary,
} from "@codenine/contracts";
import { describe, expect, it } from "vite-plus/test";

import { draftStepsOver, workflowDraftStatus, workflowScheduleText } from "./workflowDraft.logic";

describe("workflowScheduleText", () => {
  const timeZone = "Europe/London";
  it.each([
    [null, "When you start it"],
    [{ days: ["mon"], time: "09:00", timeZone }, "Every Monday at 9:00 · Europe/London"],
    [
      { days: ["fri", "mon", "wed"], time: "09:00", timeZone },
      "Every Monday, Wednesday and Friday at 9:00 · Europe/London",
    ],
    [
      { days: ["mon", "tue", "wed", "thu", "fri"], time: "17:30", timeZone },
      "Every weekday at 17:30 · Europe/London",
    ],
    [
      { days: ["sat", "sun"], time: "10:05", timeZone },
      "Every Saturday and Sunday at 10:05 · Europe/London",
    ],
    [
      { days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], time: "00:15", timeZone },
      "Every day at 0:15 · Europe/London",
    ],
    [{ days: ["mon"], time: "08:00", timeZone: "Etc/GMT" }, "Every Monday at 8:00 · GMT"],
  ] as const)("says %j as %s", (schedule, text) => {
    expect(workflowScheduleText(schedule)).toBe(text);
  });
});

const stepId = (value: string) => value as WorkflowStepId;
const draftStep = (id: string, agent: string | null) => ({
  id: stepId(id),
  title: id,
  agent: agent === null ? null : AgentName.make(agent),
  ...(agent === null
    ? {
        suggestion: { title: "Poster", description: "Posts.", instructions: "", connectors: [] },
      }
    : {}),
  instructions: "",
  doneWhen: "",
  dependsOn: [],
});
const draftAt = (proposedAt: string): WorkflowDraft => ({
  title: "Daily digest",
  description: "",
  goal: "",
  schedule: null,
  inputs: [],
  steps: [draftStep("collect", "researcher"), draftStep("post", null)],
  proposedAt,
});
const summary = {
  id: WorkflowId.make("wf-1"),
  name: "daily-digest",
  title: "Daily digest",
} as WorkflowSummary;
const first = "2026-11-20T08:00:00.000Z";
const second = "2026-11-21T08:00:00.000Z";
const link = { id: summary.id, proposedAt: first };

describe("workflowDraftStatus", () => {
  it.each([
    ["no link", draftAt(first), null, [summary], false, { kind: "unsaved", deleted: false }],
    ["the list not loaded", draftAt(first), link, null, false, { kind: "checking" }],
    ["the saved draft", draftAt(first), link, [summary], false, { kind: "saved" }],
    ["a newer draft", draftAt(second), link, [summary], false, { kind: "changed" }],
    ["no draft", null, link, [summary], false, { kind: "saved" }],
    ["a list from before the link", draftAt(first), link, [], false, { kind: "checking" }],
    [
      "a list from after the link",
      draftAt(first),
      link,
      [],
      true,
      { kind: "unsaved", deleted: true },
    ],
  ] as const)("with %s", (_name, draft, current, workflows, listedAfterLink, expected) => {
    expect(workflowDraftStatus({ draft, link: current, workflows, listedAfterLink })).toMatchObject(
      expected,
    );
  });
});

describe("draftStepsOver", () => {
  it("keeps the agent the saved workflow gave a step the draft left without one", () => {
    const draft = { steps: [draftStep("collect", null), draftStep("post", null)] };
    const steps = draftStepsOver(draft, [
      { id: stepId("collect"), agent: AgentName.make("researcher") },
      { id: stepId("post"), agent: null },
    ]);
    expect(steps[0]).toMatchObject({ agent: "researcher" });
    expect(steps[0]).not.toHaveProperty("suggestion");
    expect(steps[1]).toBe(draft.steps[1]);
  });
});
