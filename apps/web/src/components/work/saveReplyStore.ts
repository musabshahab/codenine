import { scopedThreadKey } from "@codenine/client-runtime/environment";
import type { ScopedThreadRef } from "@codenine/contracts";
import { create } from "zustand";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentThreadDetails } from "~/state/threads";

interface SaveReplyState {
  /** The reply a chat was asked to save as a file. Held until its dialog closes. */
  readonly request: { readonly threadKey: string; readonly markdown: string } | null;
  readonly open: (threadRef: ScopedThreadRef, markdown: string) => void;
  readonly close: () => void;
}

export const useSaveReplyStore = create<SaveReplyState>((set) => ({
  request: null,
  open: (threadRef, markdown) =>
    set({ request: { threadKey: scopedThreadKey(threadRef), markdown } }),
  close: () => set({ request: null }),
}));

/** The text of the chat's latest finished reply, or null when it has none. */
export function latestReplyText(threadRef: ScopedThreadRef): string | null {
  const items = appAtomRegistry.get(environmentThreadDetails.visibleTurnItemsAtom(threadRef));
  for (const { item } of items.toReversed()) {
    if (item.type === "assistant_message" && !item.streaming && item.text.trim() !== "") {
      return item.text;
    }
  }
  return null;
}
