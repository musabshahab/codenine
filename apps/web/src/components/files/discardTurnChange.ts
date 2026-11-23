import {
  type EnvironmentId,
  type ProjectRevertFileChangeInput,
  ProjectWriteFileConflictError,
  type ThreadId,
} from "@codenine/contracts";
import {
  executeAtomQuery,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@codenine/client-runtime/state/runtime";
import * as Schema from "effect/Schema";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";

import { refreshProjectFileAfterOutsideWrite } from "./projectFilesQueryState";

const isWriteConflict = Schema.is(ProjectWriteFileConflictError);
const QUIET = { reportFailure: false, reportDefect: false } as const;

export interface TurnFileChange {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly threadId: ThreadId;
  readonly turnCount: number;
}

export type DiscardResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly conflict: boolean; readonly message: string | null };

/** How a discard reaches the server. Tests stand in for it. */
export interface DiscardTransport {
  /**
   * The read `version` of the file as it is now: undefined when it is gone, null when it could
   * not be read.
   */
  readonly currentVersion: (file: TurnFileChange) => Promise<string | undefined | null>;
  readonly revert: (
    file: TurnFileChange,
    input: ProjectRevertFileChangeInput,
  ) => Promise<DiscardResult & { readonly version?: string | undefined }>;
}

const serverTransport: DiscardTransport = {
  currentVersion: async (file) => {
    const { environmentId, cwd, relativePath, threadId, turnCount } = file;
    const baseline = await executeAtomQuery(
      appAtomRegistry,
      projectEnvironment.readFileBaseline({
        environmentId,
        input: { cwd, relativePath, source: { kind: "turn", threadId, turnCount } },
      }),
      { ...QUIET, refresh: true },
    );
    if (baseline._tag !== "Success") return null;
    // A file that is not text reports its version with its baseline.
    if (baseline.value.wholeFileOnly === true) return baseline.value.currentVersion;
    const current = await executeAtomQuery(
      appAtomRegistry,
      projectEnvironment.readFile({
        environmentId,
        input: { cwd, relativePath, allowMissing: true },
      }),
      { ...QUIET, refresh: true },
    );
    if (current._tag !== "Success") return null;
    return current.value.exists === false ? undefined : (current.value.version ?? null);
  },
  revert: async (file, input) => {
    const result = await runAtomCommand(
      appAtomRegistry,
      projectEnvironment.revertFileChange,
      { environmentId: file.environmentId, input },
      QUIET,
    );
    if (result._tag === "Success") return { ok: true, version: result.value.version };
    const failure = squashAtomCommandFailure(result);
    return {
      ok: false,
      conflict: isWriteConflict(failure),
      message: failure instanceof Error ? failure.message : null,
    };
  },
};

const revertListeners = new Set<(file: TurnFileChange) => void>();

/** Hears of every file a discard put back, so a view of it reads it again. */
export function onTurnFileChangeDiscarded(listener: (file: TurnFileChange) => void): () => void {
  revertListeners.add(listener);
  return () => revertListeners.delete(listener);
}

/**
 * Puts one file back as it was before a turn, whole. The file as it is now is named to the
 * server, so a write that lands meanwhile is refused instead of lost. The review bar's Discard
 * and a reply's "Undo this change" both end here.
 */
export async function discardTurnFileChange(
  file: TurnFileChange,
  transport: DiscardTransport = serverTransport,
): Promise<DiscardResult> {
  const expectedVersion = await transport.currentVersion(file);
  if (expectedVersion === null) return { ok: false, conflict: false, message: null };
  const result = await transport.revert(file, {
    cwd: file.cwd,
    relativePath: file.relativePath,
    threadId: file.threadId,
    turnCount: file.turnCount,
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
  });
  if (!result.ok) return result;
  refreshProjectFileAfterOutsideWrite(
    file.environmentId,
    file.cwd,
    file.relativePath,
    result.version,
  );
  for (const listener of revertListeners) listener(file);
  return { ok: true };
}

/** Discards a turn's change to each file in turn and reports the ones that could not be put back. */
export async function discardTurnFileChanges(
  files: ReadonlyArray<TurnFileChange>,
  transport: DiscardTransport = serverTransport,
): Promise<ReadonlyArray<{ readonly relativePath: string; readonly conflict: boolean }>> {
  const failed: Array<{ relativePath: string; conflict: boolean }> = [];
  for (const file of files) {
    const result = await discardTurnFileChange(file, transport);
    if (!result.ok) failed.push({ relativePath: file.relativePath, conflict: result.conflict });
  }
  return failed;
}
