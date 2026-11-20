import type { ThreadId } from "@codenine/contracts";
import { create } from "zustand";

import { type ChatChoices, threadChoicesFromDraft } from "./components/chat/chatChoices.logic";

/**
 * Connectors, kept-on skills and the agent a new chat picked before the server had its thread, by
 * the id the thread will get. The first send hands them to that thread. Not persisted: a reload
 * goes back to the defaults.
 */
export const useDraftChatChoicesStore = create<{
  readonly byThread: Readonly<Record<ThreadId, ChatChoices>>;
}>(() => ({ byThread: {} }));

function readDraftChatChoices(threadId: ThreadId): ChatChoices | undefined {
  return useDraftChatChoicesStore.getState().byThread[threadId];
}

export function setDraftChatChoices(
  threadId: ThreadId,
  change: (current: ChatChoices) => ChatChoices,
): void {
  useDraftChatChoicesStore.setState((state) => ({
    byThread: { ...state.byThread, [threadId]: change(state.byThread[threadId] ?? {}) },
  }));
}

/** What a new chat's launch carries so its thread starts with the chat's choices. */
export function draftThreadChoices(threadId: ThreadId) {
  const threadChoices = threadChoicesFromDraft(readDraftChatChoices(threadId));
  return threadChoices === undefined ? {} : { threadChoices };
}
