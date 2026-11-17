import type {
  AgentModel,
  AgentName,
  AgentSummary,
  EnvironmentId,
  ServerProviderModelInfo,
} from "@codenine/contracts";
import { skillTitle } from "@codenine/contracts";
import type { UnifiedSettings } from "@codenine/contracts/settings";
import { agentEffortOption, agentModelSelection } from "@codenine/shared/agentModel";
import { formatModelSlugName } from "@codenine/shared/model";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getAppModelOptionsForInstance } from "../../modelSelection";
import {
  isProviderInstancePickerVisible,
  providerInstanceEntriesFor,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { agentsEnvironment } from "../../state/agents";
import { useEnvironmentProviders } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { getDisplayModelName } from "../chat/providerIconUtils";
import type { AgentModelAccount } from "./agents.logic";

const NO_AGENTS: ReadonlyArray<AgentSummary> = [];

/** The agents on a computer; `agents` is empty while they load or when they could not. */
export function useAgents(environmentId: EnvironmentId | null) {
  const list = useEnvironmentQuery(
    environmentId === null ? null : agentsEnvironment.list({ environmentId, input: {} }),
  );
  return { ...list, agents: list.data?.agents ?? NO_AGENTS };
}

/** An agent's title, or one made from its name when the agent is gone or not loaded. */
export function agentTitle(name: AgentName, agent: Pick<AgentSummary, "title"> | null | undefined) {
  return agent?.title ?? skillTitle(name);
}

/** The accounts on a computer, as the composer's model picker lists them. */
export interface AgentModelCatalog {
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly settings: UnifiedSettings;
}

export function useAgentModelCatalog(environmentId: EnvironmentId): AgentModelCatalog {
  const settings = useEnvironmentSettings(environmentId);
  const providers = useEnvironmentProviders().get(environmentId) ?? EMPTY_SERVER_PROVIDERS;
  return { entries: providerInstanceEntriesFor(providers, settings, null), settings };
}

export interface AgentModelDescription {
  readonly name: string;
  /** The account's name; null when the account is gone. */
  readonly account: string | null;
  readonly info: ServerProviderModelInfo | null;
  /** Whether the model has its own effort levels for the agent's effort. */
  readonly hasEffort: boolean;
}

/** How the app names an agent's model, and what its account says about it. */
export function describeAgentModel(
  catalog: AgentModelCatalog,
  model: AgentModel,
): AgentModelDescription {
  const entry = catalog.entries.find((candidate) => candidate.instanceId === model.instanceId);
  const option = entry
    ? getAppModelOptionsForInstance(catalog.settings, entry).find(
        (candidate) => candidate.slug === model.model,
      )
    : undefined;
  const serverModel = entry?.models.find((candidate) => candidate.slug === model.model);
  const name = option
    ? getDisplayModelName(option)
    : (serverModel?.name ?? formatModelSlugName(model.model));
  return {
    name,
    account: entry?.displayName ?? null,
    info: serverModel?.info ?? null,
    hasEffort: agentEffortOption(model.effort, serverModel?.capabilities) !== null,
  };
}

/** What a chat runs on for the agent's model, its effort matched to the model's own levels. */
export function agentChatModelSelection(
  entries: ReadonlyArray<ProviderInstanceEntry>,
  model: AgentModel,
) {
  const capabilities = entries
    .find((entry) => entry.instanceId === model.instanceId)
    ?.models.find((candidate) => candidate.slug === model.model)?.capabilities;
  return agentModelSelection(model, capabilities);
}

/** The accounts turned on, with their models in the composer's order. */
export function agentModelAccounts(catalog: AgentModelCatalog): AgentModelAccount[] {
  return catalog.entries.filter(isProviderInstancePickerVisible).map((entry) => ({
    instanceId: entry.instanceId,
    name: entry.displayName,
    models: getAppModelOptionsForInstance(catalog.settings, entry)
      .filter((option) => option.isUnavailable !== true)
      .map((option) => ({
        slug: option.slug,
        name: getDisplayModelName(option),
        info: entry.models.find((model) => model.slug === option.slug)?.info ?? null,
      })),
  }));
}
