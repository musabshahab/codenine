import { resolveDiffPathForWorkspace } from "../../diffFileActions";

/**
 * The workspace paths "Undo this change" puts back for a turn. Empty unless every changed file
 * is listed and inside the workspace: undoing part of a change would leave it half done.
 */
export function turnUndoFiles(input: {
  readonly files: ReadonlyArray<{ readonly path: string }>;
  /** How many files the turn changed, which can be more than are listed. */
  readonly totalCount: number;
  readonly workspaceRoot: string;
  readonly repositoryRoot: string | undefined;
}): ReadonlyArray<string> {
  if (input.files.length === 0 || input.files.length !== input.totalCount) return [];
  const paths: Array<string> = [];
  for (const file of input.files) {
    const relativePath = resolveDiffPathForWorkspace({
      filePath: file.path,
      workspaceRoot: input.workspaceRoot,
      repositoryRoot: input.repositoryRoot,
    });
    if (relativePath === null) return [];
    paths.push(relativePath);
  }
  return paths;
}
