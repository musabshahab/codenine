import { create } from "zustand";

interface FileReviewState {
  /** Per thread, the files whose latest-turn changes the user kept. Held for the session only. */
  readonly keptByThreadKey: Readonly<
    Record<string, { readonly turnCount: number; readonly paths: ReadonlyArray<string> }>
  >;
  readonly keep: (threadKey: string, turnCount: number, relativePath: string) => void;
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
