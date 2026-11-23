import { scopeProjectRef, scopeThreadRef } from "@codenine/client-runtime/environment";
import type { EnvironmentId, ProjectId } from "@codenine/contracts";

import { useRightPanelStore } from "~/rightPanelStore";

import { useNewThreadHandler } from "./useHandleNewThread";

/**
 * Opens a workspace file where no chat is open yet: in a new, empty draft chat of that
 * workspace. The first message sent from it starts the chat.
 */
export function useOpenWorkspaceFile() {
  const handleNewThread = useNewThreadHandler();
  return async (
    project: { readonly environmentId: EnvironmentId; readonly id: ProjectId },
    relativePath: string,
  ) => {
    const opened = await handleNewThread(scopeProjectRef(project.environmentId, project.id));
    if (!opened) return;
    useRightPanelStore
      .getState()
      .openFile(scopeThreadRef(project.environmentId, opened.threadId), relativePath);
  };
}
