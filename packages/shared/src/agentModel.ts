import type {
  AgentEffort,
  AgentModel,
  ModelCapabilities,
  ModelSelection,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
} from "@codenine/contracts";

import { createModelSelection } from "./model.ts";

type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;

// Claude names its reasoning select `effort`, Codex `reasoningEffort`.
const EFFORT_OPTION_IDS: ReadonlySet<string> = new Set(["effort", "reasoningEffort"]);
// Claude Code's own default, and Ultracode, a workflow older servers list among the levels.
const NOT_LEVELS: ReadonlySet<string> = new Set(["default", "ultracode"]);

function effortDescriptor(
  capabilities: ModelCapabilities | null | undefined,
): SelectDescriptor | undefined {
  return capabilities?.optionDescriptors?.find(
    (descriptor): descriptor is SelectDescriptor =>
      descriptor.type === "select" && EFFORT_OPTION_IDS.has(descriptor.id),
  );
}

/**
 * The model's own option for an agent's effort: Low, Medium and High pick the level of that name,
 * Max the highest level. Null when the model has no such level, so it runs at its default.
 */
export function agentEffortOption(
  effort: AgentEffort,
  capabilities: ModelCapabilities | null | undefined,
): ProviderOptionSelection | null {
  const descriptor = effortDescriptor(capabilities);
  if (descriptor === undefined) return null;
  const levels = descriptor.options.filter(
    (option) => !NOT_LEVELS.has(option.id) && !descriptor.promptInjectedValues?.includes(option.id),
  );
  const level = effort === "max" ? levels.at(-1) : levels.find((option) => option.id === effort);
  return level === undefined ? null : { id: descriptor.id, value: level.id };
}

/** What a chat runs on for an agent's model: that model, at the agent's effort. */
export function agentModelSelection(
  model: AgentModel,
  capabilities: ModelCapabilities | null | undefined,
): ModelSelection {
  const effort = agentEffortOption(model.effort, capabilities);
  return createModelSelection(model.instanceId, model.model, effort === null ? null : [effort]);
}
