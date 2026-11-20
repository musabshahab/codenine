import { scopeProjectRef } from "@codenine/client-runtime/environment";
import type { EnvironmentProject } from "@codenine/client-runtime/state/shell";
import type { AgentSummary, EnvironmentId, ProjectId } from "@codenine/contracts";

import { useComposerDraftStore } from "../../composerDraftStore";
import { setDraftChatChoices } from "../../draftChatChoicesStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useScratchProject } from "../../hooks/useScratchProject";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { useProjects } from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { toastManager } from "../ui/toast";
import { agentChatModelSelection } from "./useAgents";

/**
 * Opens a new chat with an agent: in `workspace` when it is on the agent's computer, else in
 * Personal there. The agent and its model wait with the draft until the first message.
 */
export function useStartAgentChat() {
  const handleNewThread = useNewThreadHandler();
  const { openScratchProject } = useScratchProject();
  const providersByEnvironment = useEnvironmentProviders();
  return async (input: {
    readonly environmentId: EnvironmentId;
    readonly agent: Pick<AgentSummary, "name" | "model">;
    readonly workspace: EnvironmentProject | null;
  }): Promise<boolean> => {
    const { environmentId, agent, workspace } = input;
    const project =
      workspace !== null && workspace.environmentId === environmentId && !workspace.isScratch
        ? workspace
        : await openScratchProject(environmentId);
    if (project === null) return false;
    const opened = await handleNewThread(scopeProjectRef(project.environmentId, project.id)).catch(
      (error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not start a chat",
          description: error instanceof Error ? error.message : "Try again.",
        });
        return null;
      },
    );
    if (opened === null) return false;
    setDraftChatChoices(opened.threadId, (current) => ({ ...current, agent: agent.name }));
    if (agent.model !== null) {
      const entries = deriveProviderInstanceEntries(
        providersByEnvironment.get(environmentId) ?? EMPTY_SERVER_PROVIDERS,
      );
      useComposerDraftStore
        .getState()
        .setModelSelection(opened.draftId, agentChatModelSelection(entries, agent.model), {
          explicit: true,
          replaceOptions: true,
        });
    }
    return true;
  };
}

/** Where Start chat opens: the workspace the page was opened from, while it is still there. */
export function useAgentChatWorkspace(
  environmentId: EnvironmentId | null,
  workspace: ProjectId | null,
): EnvironmentProject | null {
  return (
    useProjects().find(
      (project) =>
        project.environmentId === environmentId &&
        project.id === workspace &&
        project.archivedAt == null,
    ) ?? null
  );
}
