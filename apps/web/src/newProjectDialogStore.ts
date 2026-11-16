import { create } from "zustand";

import type { NewProjectRequest } from "./components/NewProjectDialog.logic";

interface NewProjectDialogState {
  /** Kept through the closing animation, so the dialog does not change as it fades. */
  readonly request: NewProjectRequest | null;
  readonly open: boolean;
  /** Bumped by every open, so the dialog starts over from the new request. */
  readonly session: number;
  /** Where the user was, so a dialog that navigated leaves focus to the new page. */
  readonly openedAt: string | null;
}

export const useNewProjectDialogStore = create<NewProjectDialogState>(() => ({
  request: null,
  open: false,
  session: 0,
  openedAt: null,
}));

/** Opens the New workspace dialog, starting from `request`'s machine and source. */
export function openNewProjectDialog(request: NewProjectRequest = {}): void {
  useNewProjectDialogStore.setState((state) => ({
    request,
    open: true,
    session: state.session + 1,
    openedAt: window.location.href,
  }));
}

export function closeNewProjectDialog(): void {
  useNewProjectDialogStore.setState({ open: false });
}

/** Drops the request once the dialog has finished closing. */
export function clearNewProjectDialog(): void {
  useNewProjectDialogStore.setState((state) => (state.open ? state : { request: null }));
}
