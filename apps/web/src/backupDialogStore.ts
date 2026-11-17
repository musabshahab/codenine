import type { EnvironmentId } from "@codenine/contracts";
import { create } from "zustand";

/** What an entry point asks the restore dialog to start with. */
export interface RestoreDialogRequest {
  readonly environmentId: EnvironmentId;
  /** A backup already picked, such as a row in Recent backups; it skips the first step. */
  readonly path?: string;
}

interface BackupDialogState {
  /** Kept through the closing animation, so the dialog does not change as it fades. */
  readonly restore: RestoreDialogRequest | null;
  readonly restoreOpen: boolean;
  /** Bumped by every open, so the dialog starts over from the new request. */
  readonly restoreSession: number;
  /** Restore reports closed for now; they open again on the next start until dismissed. */
  readonly hiddenReports: ReadonlySet<string>;
  /** Backup notices dismissed this session; a new failure shows again. */
  readonly dismissedAttention: ReadonlySet<string>;
}

export const useBackupDialogStore = create<BackupDialogState>(() => ({
  restore: null,
  restoreOpen: false,
  restoreSession: 0,
  hiddenReports: new Set(),
  dismissedAttention: new Set(),
}));

export function openRestoreDialog(request: RestoreDialogRequest): void {
  useBackupDialogStore.setState((state) => ({
    restore: request,
    restoreOpen: true,
    restoreSession: state.restoreSession + 1,
  }));
}

export function closeRestoreDialog(): void {
  useBackupDialogStore.setState({ restoreOpen: false });
}

/** Drops the request once the dialog has finished closing. */
export function clearRestoreDialog(): void {
  useBackupDialogStore.setState((state) => (state.restoreOpen ? state : { restore: null }));
}

export function restoreReportKey(environmentId: EnvironmentId, restoredAt: string): string {
  return `${environmentId}:${restoredAt}`;
}

export function setRestoreReportHidden(key: string, hidden: boolean): void {
  useBackupDialogStore.setState((state) => {
    if (state.hiddenReports.has(key) === hidden) return state;
    const hiddenReports = new Set(state.hiddenReports);
    if (hidden) hiddenReports.add(key);
    else hiddenReports.delete(key);
    return { hiddenReports };
  });
}

export function dismissBackupAttention(key: string): void {
  useBackupDialogStore.setState((state) => ({
    dismissedAttention: new Set([...state.dismissedAttention, key]),
  }));
}
