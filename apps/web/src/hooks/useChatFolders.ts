import { scopeThreadRef } from "@codenine/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@codenine/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@codenine/contracts";

import { requestFolderName } from "../components/sidebar/FolderNameDialog";
import { resolveChatFolderNames } from "../components/Sidebar.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { readProjects, readThreadShells } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { useUiStateStore } from "../uiStateStore";

/** The chats without a project this client holds. */
function readChats() {
  const chatProjectKeys = new Set(
    readProjects()
      .filter((project) => project.isScratch)
      .map((project) => `${project.environmentId}:${project.id}`),
  );
  return readThreadShells().filter((thread) =>
    chatProjectKeys.has(`${thread.environmentId}:${thread.projectId}`),
  );
}

/** The chat folders a menu offers, read when it opens. */
export function readChatFolderNames(): string[] {
  return resolveChatFolderNames(readChats(), useUiStateStore.getState().chatFolderNames);
}

/** Makes, renames, and deletes chat folders, and moves chats between them. */
export function useChatFolders() {
  const setFolder = useOrchestrationCommand(threadEnvironment.setFolder, {
    reportFailure: false,
  });
  const setChatFolderName = useUiStateStore((store) => store.setChatFolderName);

  const moveChats = async (
    threadRefs: readonly ScopedThreadRef[],
    folder: string | null,
    failureTitle: string,
  ) => {
    for (const threadRef of threadRefs) {
      const result = await setFolder({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, folder },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: failureTitle,
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
        return;
      }
    }
  };
  const chatsIn = (name: string) =>
    readChats()
      .filter((thread) => thread.folder === name)
      .map((thread) => scopeThreadRef(thread.environmentId, thread.id));
  const askForNewFolder = () => requestFolderName({ title: "New folder", action: "Create" });

  return {
    moveToFolder: (threadRef: ScopedThreadRef, folder: string | null) =>
      moveChats([threadRef], folder, "Could not move the chat"),
    moveToNewFolder: async (threadRef: ScopedThreadRef) => {
      const name = await askForNewFolder();
      if (name === null) return;
      setChatFolderName(null, name);
      await moveChats([threadRef], name, "Could not move the chat");
    },
    createFolder: async () => {
      const name = await askForNewFolder();
      if (name !== null) setChatFolderName(null, name);
    },
    renameFolder: async (from: string) => {
      const name = await requestFolderName({
        title: "Rename folder",
        action: "Rename",
        initial: from,
      });
      if (name === null || name === from) return;
      setChatFolderName(from, name);
      await moveChats(chatsIn(from), name, "Could not rename the folder");
    },
    // The chats stay; they move to Recent.
    deleteFolder: async (name: string) => {
      setChatFolderName(name, null);
      await moveChats(chatsIn(name), null, "Could not delete the folder");
    },
  };
}
