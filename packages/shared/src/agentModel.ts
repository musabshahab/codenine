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
  const levels = effortLevels(descriptor);
  const level = effort === "max" ? levels.at(-1) : levels.find((option) => option.id === effort);
  return level === undefined ? null : { id: descriptor.id, value: level.id };
}

function effortLevels(descriptor: SelectDescriptor) {
  return descriptor.options.filter(
    (option) => !NOT_LEVELS.has(option.id) && !descriptor.promptInjectedValues?.includes(option.id),
  );
}

/**
 * The agent effort for a model selection's level, the reverse of `agentEffortOption`: the level of
 * that name, Max for the highest, else the nearest of those, the lower on a tie. Null when the
 * selection names no level.
 */
export function agentEffortOfSelection(
  selection: Pick<ModelSelection, "options">,
  capabilities: ModelCapabilities | null | undefined,
): AgentEffort | null {
  const descriptor = effortDescriptor(capabilities);
  if (descriptor === undefined) return null;
  const value = selection.options?.find((option) => option.id === descriptor.id)?.value;
  const levels = effortLevels(descriptor).map((option) => option.id);
  const at = typeof value === "string" ? levels.indexOf(value) : -1;
  if (at === -1) return null;
  let nearest: AgentEffort | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const effort of ["low", "medium", "high", "max"] as const) {
    const index = effort === "max" ? levels.length - 1 : levels.indexOf(effort);
    if (index === -1 || Math.abs(index - at) >= distance) continue;
    nearest = effort;
    distance = Math.abs(index - at);
  }
  return nearest;
}

/** What a chat runs on for an agent's model: that model, at the agent's effort. */
export function agentModelSelection(
  model: AgentModel,
  capabilities: ModelCapabilities | null | undefined,
): ModelSelection {
  const effort = agentEffortOption(model.effort, capabilities);
  return createModelSelection(model.instanceId, model.model, effort === null ? null : [effort]);
}
