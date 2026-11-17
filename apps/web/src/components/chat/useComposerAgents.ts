import type { AgentName, AgentSummary, ProviderInstanceId } from "@codenine/contracts";

import { useStableCallback } from "../../hooks/useStableCallback";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { agentModelProblem } from "../agents/agents.logic";
import { agentChatModelSelection, agentTitle, useAgents } from "../agents/useAgents";
import type { ChatComposerProps } from "./ChatComposer";
import type { ModelPickerAgent, ModelPickerAgents } from "./ModelPickerAgentRow";
import { resolveModelPickerSelectedModel } from "./ModelPickerContent";
import { getTriggerDisplayModelName, type ModelEsque } from "./providerIconUtils";
import { type ChatChoicesTarget, useChatChoices } from "./useChatChoices";

function pickerAgent(
  agent: AgentSummary,
  entries: ReadonlyArray<ProviderInstanceEntry>,
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>,
  modelDisabledReason: (instanceId: ProviderInstanceId, model: string) => string | null,
): ModelPickerAgent {
  const model = agent.model;
  const option =
    model === null
      ? undefined
      : resolveModelPickerSelectedModel({
          model: model.model,
          options: modelOptionsByInstance.get(model.instanceId) ?? [],
        });
  const driverKind = entries.find((entry) => entry.instanceId === model?.instanceId)?.driverKind;
  const modelName = option ? getTriggerDisplayModelName(option, driverKind) : model?.model;
  return {
    name: agent.name,
    title: agent.title,
    detail: modelName === undefined ? agent.description : `${agent.description} · ${modelName}`,
    disabledReason:
      agentModelProblem(agent.modelStatus)?.short ??
      (model === null ? null : modelDisabledReason(model.instanceId, model.model)),
  };
}

/**
 * The composer picker's Agents tab. Picking an agent sets the chat's agent and moves the chat to
 * the agent's model and effort; No agent keeps the model. Absent when there is no agent to pick.
 */
export function useComposerAgents(input: {
  readonly target: ChatChoicesTarget;
  readonly providerInstanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  readonly getModelDisabledReason: ChatComposerProps["getModelDisabledReason"];
  readonly onProviderModelSelect: ChatComposerProps["onProviderModelSelect"];
  readonly onMultipleModelSelectionsChange: ChatComposerProps["onMultipleModelSelectionsChange"];
}): ModelPickerAgents | undefined {
  const { agents } = useAgents(input.target.environmentId);
  const choices = useChatChoices(input.target);
  const onPick = useStableCallback((name: AgentName | null) => {
    if (!choices.canChange) return;
    if (name === null) {
      void choices.setAgent(null);
      return;
    }
    const model = agents.find((agent) => agent.name === name)?.model;
    if (model == null) return;
    const selection = agentChatModelSelection(input.providerInstanceEntries, model);
    input.onMultipleModelSelectionsChange(null);
    const applied = input.onProviderModelSelect(selection.instanceId, selection.model, {
      agentOptions: selection.options ?? [],
    });
    if (applied) void choices.setAgent(name);
  });
  if (agents.length === 0 && choices.agent === null) return undefined;
  return {
    items: agents.map((agent) =>
      pickerAgent(
        agent,
        input.providerInstanceEntries,
        input.modelOptionsByInstance,
        (instanceId, model) =>
          choices.canChange
            ? input.getModelDisabledReason(instanceId, model)
            : "You can't change this chat's agent",
      ),
    ),
    selected: choices.agent,
    selectedTitle:
      choices.agent === null
        ? null
        : agentTitle(
            choices.agent,
            agents.find((agent) => agent.name === choices.agent),
          ),
    onPick,
  };
}
