import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { FileView } from "./documentView.logic";
import { resolveStorage } from "./lib/storage";

interface DocumentViewStoreState {
  /** Keyed by environment and project: the arrangement the user last chose there. */
  readonly viewByWorkspace: Record<string, FileView>;
  readonly chatCollapsed: boolean;
  readonly railCollapsed: boolean;
  readonly setView: (workspaceKey: string, view: FileView) => void;
  readonly setChatCollapsed: (collapsed: boolean) => void;
  readonly setRailCollapsed: (collapsed: boolean) => void;
}

export const useDocumentViewStore = create<DocumentViewStoreState>()(
  persist(
    (set) => ({
      viewByWorkspace: {},
      chatCollapsed: false,
      railCollapsed: false,
      setView: (workspaceKey, view) =>
        set((state) =>
          state.viewByWorkspace[workspaceKey] === view
            ? state
            : { viewByWorkspace: { ...state.viewByWorkspace, [workspaceKey]: view } },
        ),
      setChatCollapsed: (chatCollapsed) => set({ chatCollapsed }),
      setRailCollapsed: (railCollapsed) => set({ railCollapsed }),
    }),
    {
      name: "codenine:document-view:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window === "undefined" ? undefined : window.localStorage),
      ),
    },
  ),
);
