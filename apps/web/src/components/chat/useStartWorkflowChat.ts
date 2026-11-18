import { scopeProjectRef } from "@codenine/client-runtime/environment";
import type { EnvironmentId } from "@codenine/contracts";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useScratchProject } from "../../hooks/useScratchProject";
import { readProject } from "../../state/entities";
import { toastManager } from "../ui/toast";

/**
 * Starts a new chat with Workflow on, as New task with a team does with Team: in the workspace of
 * the chat on screen, else in Personal. A workflow is saved on the computer its chat ran on, so
 * `machine`, when given, keeps the chat there. Resolves false when no chat could start.
 */
export function useStartWorkflowChat() {
  const { activeThread, activeDraftThread, handleNewThread } = useHandleNewThread();
  const { scratchEnvironmentId, openScratchProject } = useScratchProject();
  return async (machine: EnvironmentId | null = null): Promise<boolean> => {
    const current = activeThread ?? activeDraftThread;
    const workspace =
      current && (machine === null || current.environmentId === machine)
        ? readProject(scopeProjectRef(current.environmentId, current.projectId))
        : null;
    let project = workspace?.isScratch === true ? null : workspace;
    if (project === null) {
      const environmentId = machine ?? scratchEnvironmentId(null);
      if (environmentId === null) return false;
      project = await openScratchProject(environmentId);
    }
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
    useComposerDraftStore.getState().setWorkflowRequested(opened.draftId, true);
    return true;
  };
}
