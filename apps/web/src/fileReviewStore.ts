import { scopedThreadKey } from "@codenine/client-runtime/environment";
import type { ThreadCheckpointSummary } from "@codenine/client-runtime/state/thread-checkpoints";
import type { ScopedThreadRef } from "@codenine/contracts";
import { create } from "zustand";

import { useRightPanelStore } from "./rightPanelStore";

interface FileReviewState {
  /** Per thread, the files whose latest-turn changes the user kept. Held for the session only. */
  readonly keptByThreadKey: Readonly<
    Record<string, { readonly turnCount: number; readonly paths: ReadonlyArray<string> }>
  >;
  readonly keep: (threadKey: string, turnCount: number, relativePath: string) => void;
  /** Offers the file's change for review again. */
  readonly unkeep: (threadKey: string, relativePath: string) => void;
}

export const useFileReviewStore = create<FileReviewState>((set) => ({
  keptByThreadKey: {},
  keep: (threadKey, turnCount, relativePath) =>
    set((state) => {
      const current = state.keptByThreadKey[threadKey];
      // Only the latest turn is reviewed in the file, so an older turn's entries are dropped.
      const paths = current?.turnCount === turnCount ? current.paths : [];
      if (paths.includes(relativePath)) return state;
      return {
        keptByThreadKey: {
          ...state.keptByThreadKey,
          [threadKey]: { turnCount, paths: [...paths, relativePath] },
        },
      };
    }),
  unkeep: (threadKey, relativePath) =>
    set((state) => {
      const current = state.keptByThreadKey[threadKey];
      if (!current?.paths.includes(relativePath)) return state;
      return {
        keptByThreadKey: {
          ...state.keptByThreadKey,
          [threadKey]: {
            turnCount: current.turnCount,
            paths: current.paths.filter((path) => path !== relativePath),
          },
        },
      };
    }),
}));

export function isFileReviewKept(
  state: Pick<FileReviewState, "keptByThreadKey">,
  threadKey: string,
  turnCount: number,
  relativePath: string,
): boolean {
  const kept = state.keptByThreadKey[threadKey];
  return kept?.turnCount === turnCount && kept.paths.includes(relativePath);
}

/**
 * The turn whose change to a file can be reviewed in the file: the latest one, once its
 * checkpoint is ready, when it lists the file. A long list is cut short, so any file may be in it;
 * the server then answers whether the turn changed the file. Without Git the checkpoint is
 * missing and still lists the files, whose earlier contents the server's version store holds.
 */
export function reviewableTurnCount(
  latestTurn: ThreadCheckpointSummary | undefined,
  isFile: (changedPath: string) => boolean,
): number | null {
  if (latestTurn === undefined || latestTurn.checkpointTurnCount <= 0) return null;
  if (latestTurn.status !== "ready" && latestTurn.status !== "missing") return null;
  return latestTurn.filesTotal !== undefined || latestTurn.files.some((file) => isFile(file.path))
    ? latestTurn.checkpointTurnCount
    : null;
}

/**
 * Opens a file tab on its review of a turn. Asking for the review undoes an earlier Keep, which
 * would otherwise hide it. A null turn has nothing to review, so the file opens in the editor.
 */
export function openFileForReview(
  threadRef: ScopedThreadRef,
  relativePath: string,
  turnCount: number | null,
): void {
  if (turnCount === null) {
    useRightPanelStore.getState().openFile(threadRef, relativePath);
    return;
  }
  useFileReviewStore.getState().unkeep(scopedThreadKey(threadRef), relativePath);
  useRightPanelStore
    .getState()
    .openFile(threadRef, relativePath, undefined, { reviewTurnCount: turnCount });
}
