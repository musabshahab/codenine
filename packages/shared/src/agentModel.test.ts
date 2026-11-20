import { type ModelCapabilities, ProviderInstanceId } from "@codenine/contracts";
import { describe, expect, it } from "vite-plus/test";

import { agentEffortOfSelection, agentEffortOption, agentModelSelection } from "./agentModel.ts";

const claude: ModelCapabilities = {
  optionDescriptors: [
    {
      id: "effort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium", isDefault: true },
        { id: "high", label: "High" },
        { id: "xhigh", label: "Extra High" },
        { id: "max", label: "Max" },
        { id: "ultrathink", label: "Ultrathink" },
      ],
      promptInjectedValues: ["ultrathink"],
    },
    { id: "ultracode", label: "Ultracode", type: "boolean" },
  ],
};

const codex: ModelCapabilities = {
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "medium", label: "Medium", isDefault: true },
        { id: "high", label: "High" },
        { id: "xhigh", label: "Extra High" },
      ],
      currentValue: "medium",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        { id: "fast", label: "Fast" },
      ],
    },
  ],
};

// A model Claude Code reports itself lists its own default first, and an older server Ultracode.
const reported: ModelCapabilities = {
  optionDescriptors: [
    {
      id: "effort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "default", label: "Default", isDefault: true },
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
        { id: "ultracode", label: "Ultracode" },
      ],
    },
  ],
};

describe("agentEffortOption", () => {
  it("picks the level of the same name on Claude and Codex", () => {
    expect(agentEffortOption("low", claude)).toEqual({ id: "effort", value: "low" });
    expect(agentEffortOption("high", claude)).toEqual({ id: "effort", value: "high" });
    expect(agentEffortOption("medium", codex)).toEqual({
      id: "reasoningEffort",
      value: "medium",
    });
  });

  it("picks the highest level for Max, past prompt words and workflows", () => {
    expect(agentEffortOption("max", claude)).toEqual({ id: "effort", value: "max" });
    expect(agentEffortOption("max", codex)).toEqual({ id: "reasoningEffort", value: "xhigh" });
    expect(agentEffortOption("max", reported)).toEqual({ id: "effort", value: "high" });
  });

  it("leaves the model at its default when it has no such level or no effort at all", () => {
    expect(agentEffortOption("low", codex)).toBeNull();
    expect(agentEffortOption("medium", reported)).toBeNull();
    expect(agentEffortOption("high", { optionDescriptors: [] })).toBeNull();
    expect(agentEffortOption("max", null)).toBeNull();
  });
});

it.each([
  ["a level of the same name", claude, "effort", "high", "high"],
  ["the highest level", codex, "reasoningEffort", "xhigh", "max"],
  ["a level between two, the lower", claude, "effort", "xhigh", "high"],
  ["a model's own default", reported, "effort", "default", null],
] as const)(
  "an agent made from a model's selection keeps its effort: %s",
  (_name, capabilities, id, value, effort) => {
    expect(agentEffortOfSelection({ options: [{ id, value }] }, capabilities)).toBe(effort);
  },
);

it("runs a chat on the agent's model at the agent's effort", () => {
  const instanceId = ProviderInstanceId.make("claudeAgent");
  expect(
    agentModelSelection({ instanceId, model: "claude-sonnet-5-5", effort: "high" }, claude),
  ).toEqual({ instanceId, model: "claude-sonnet-5-5", options: [{ id: "effort", value: "high" }] });
  expect(agentModelSelection({ instanceId, model: "custom", effort: "high" }, null)).toEqual({
    instanceId,
    model: "custom",
  });
});
