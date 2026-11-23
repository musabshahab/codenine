import type {
  ProjectFileLineChange,
  ProjectReadFileBaselineInput,
  ProjectReadFileBaselineResult,
  ProjectRevertFileChangeInput,
  ProjectRevertFileChangeResult,
} from "@codenine/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as CheckpointDiffQuery from "./CheckpointDiffQuery.ts";
import * as CheckpointStore from "./CheckpointStore.ts";
import type { CheckpointServiceError } from "./Errors.ts";

export class FileBaselineUnavailableError extends Schema.TaggedError<FileBaselineUnavailableError>()(
  "FileBaselineUnavailableError",
  {
    relativePath: Schema.String,
    reason: Schema.Literals(["no-baseline", "file-not-text", "change-out-of-range"]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "no-baseline":
        return `No earlier version of '${this.relativePath}' is available for this turn.`;
      case "file-not-text":
        return `'${this.relativePath}' is too large or not text, so it cannot be restored here.`;
      case "change-out-of-range":
        return `The change in '${this.relativePath}' no longer matches the file.`;
    }
  }
}

// Lines keep their terminators, so a restored range brings its own line endings back.
const splitLines = (text: string) => (text === "" ? [] : text.split(/(?<=\n)/));

/** Puts the baseline's lines back in place of one change. Null when a range is outside its file. */
function revertLineChange(
  current: string,
  baseline: string,
  change: ProjectFileLineChange,
): string | null {
  const currentLines = splitLines(current);
  const baselineLines = splitLines(baseline);
  const currentEnd = change.currentStart + change.currentCount;
  const baselineEnd = change.baseStart + change.baseCount;
  if (currentEnd > currentLines.length || baselineEnd > baselineLines.length) return null;
  return [
    ...currentLines.slice(0, change.currentStart),
    ...baselineLines.slice(change.baseStart, baselineEnd),
    ...currentLines.slice(currentEnd),
  ].join("");
}

export class FileBaselines extends Context.Service<
  FileBaselines,
  {
    /** A workspace file's text at the last commit or at the start of a thread's turn. */
    readonly read: (
      input: ProjectReadFileBaselineInput,
    ) => Effect.Effect<
      ProjectReadFileBaselineResult,
      WorkspacePaths.WorkspacePathOutsideRootError | CheckpointServiceError
    >;
    /**
     * Restores a file, or one change in it, to the start of a turn. Refused when the file no
     * longer has the version the caller saw.
     */
    readonly revertTurnChange: (
      input: ProjectRevertFileChangeInput,
    ) => Effect.Effect<
      ProjectRevertFileChangeResult,
      | FileBaselineUnavailableError
      | WorkspaceFileSystem.WorkspaceFileConflictError
      | WorkspaceFileSystem.WorkspaceFileSystemError
      | WorkspacePaths.WorkspacePathOutsideRootError
      | KnownWorkspaces.UnknownWorkspaceError
      | CheckpointServiceError
    >;
  }
>()("codenine/checkpointing/FileBaselines") {}

const UNAVAILABLE: ProjectReadFileBaselineResult = { available: false, contents: null };

const make = Effect.gen(function* () {
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const checkpointDiffQuery = yield* CheckpointDiffQuery.CheckpointDiffQuery;
  const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;

  const read: FileBaselines["Service"]["read"] = Effect.fn("FileBaselines.read")(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
    const source = input.source;
    const revision =
      source.kind === "head"
        ? ("HEAD" as const)
        : yield* checkpointDiffQuery.getTurnStartRef(source).pipe(
            // A turn whose checkpoints are missing or not yet captured has no baseline.
            Effect.catchTags({
              CheckpointTurnRangeUnavailableError: () => Effect.succeed(null),
              CheckpointRefUnavailableError: () => Effect.succeed(null),
              CheckpointWorkspacePathMissingError: () => Effect.succeed(null),
            }),
          );
    if (revision === null) return UNAVAILABLE;
    const file = yield* checkpointStore.readFileAtRevision({
      cwd: input.cwd,
      revision,
      relativePath: target.relativePath,
      knownCommit: input.knownRevision,
    });
    if (file.kind === "unavailable") return UNAVAILABLE;
    const result: ProjectReadFileBaselineResult = {
      available: true,
      // Workspace reads drop a byte order mark, so the baseline drops it too.
      contents: file.kind === "text" ? file.contents.replace(/^\uFEFF/, "") : null,
      revision: file.commit,
      ...(file.kind === "unchanged" ? { unchanged: true } : {}),
    };
    return result;
  });

  const revertTurnChange: FileBaselines["Service"]["revertTurnChange"] = Effect.fn(
    "FileBaselines.revertTurnChange",
  )(function* (input) {
    const target = { cwd: input.cwd, relativePath: input.relativePath };
    const baseline = yield* read({
      ...target,
      source: { kind: "turn", threadId: input.threadId, turnCount: input.turnCount },
    });
    if (!baseline.available) {
      return yield* new FileBaselineUnavailableError({ ...target, reason: "no-baseline" });
    }
    const current = yield* workspaceFileSystem.readFile({ ...target, allowMissing: true });
    if (current.truncated) {
      return yield* new FileBaselineUnavailableError({ ...target, reason: "file-not-text" });
    }
    if (current.version !== input.expectedVersion) {
      return yield* new WorkspaceFileSystem.WorkspaceFileConflictError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        ...(current.version === undefined ? {} : { currentVersion: current.version }),
      });
    }
    if (input.change === undefined && baseline.contents === null) {
      yield* workspaceFileSystem.removeFile({ ...target, expectedVersion: input.expectedVersion });
      return { relativePath: current.relativePath, deleted: true };
    }
    const contents =
      input.change === undefined
        ? baseline.contents
        : revertLineChange(current.contents, baseline.contents ?? "", input.change);
    if (contents === null) {
      return yield* new FileBaselineUnavailableError({ ...target, reason: "change-out-of-range" });
    }
    // The write checks the version again, so a change after the read above is still refused.
    const written = yield* workspaceFileSystem.writeFile({
      ...target,
      contents,
      expectedVersion: input.expectedVersion,
    });
    return { ...written, deleted: false };
  });

  return FileBaselines.of({ read, revertTurnChange });
});

export const layer = Layer.effect(FileBaselines, make);
