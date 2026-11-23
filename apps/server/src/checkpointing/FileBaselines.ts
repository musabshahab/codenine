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

import * as FileVersions from "../fileVersions/FileVersions.ts";
import type * as FileVersionStorage from "../fileVersions/FileVersionStorage.ts";
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

const BYTE_ORDER_MARK = "\uFEFF";

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
  const lines = [
    ...currentLines.slice(0, change.currentStart),
    ...baselineLines.slice(change.baseStart, baselineEnd),
    ...currentLines.slice(currentEnd),
  ];
  // Only a file's last line may lack a terminator; one moved off the end would join the next line.
  const terminator = current.includes("\r\n") ? "\r\n" : "\n";
  return lines
    .map((line, index) =>
      index < lines.length - 1 && !line.endsWith("\n") ? line + terminator : line,
    )
    .join("");
}

export class FileBaselines extends Context.Service<
  FileBaselines,
  {
    /**
     * A workspace file's text at the last commit or at the start of a thread's turn. A turn that
     * did not change the file has no baseline for it. Without Git a turn's baseline comes from
     * the version store, and there is no last commit.
     */
    readonly read: (
      input: ProjectReadFileBaselineInput,
    ) => Effect.Effect<
      ProjectReadFileBaselineResult,
      | WorkspacePaths.WorkspacePathOutsideRootError
      | CheckpointServiceError
      | FileVersionStorage.FileVersionStorageError
    >;
    /**
     * Restores a file, or one change in it, to the start of a turn. Refused when the file no
     * longer has the version the caller saw, which is none for a file the turn deleted.
     */
    readonly revertTurnChange: (
      input: ProjectRevertFileChangeInput,
    ) => Effect.Effect<
      ProjectRevertFileChangeResult,
      | FileBaselineUnavailableError
      | FileVersions.FileVersionNotKeptError
      | WorkspaceFileSystem.WorkspaceFileConflictError
      | WorkspaceFileSystem.WorkspaceFileSystemError
      | WorkspacePaths.WorkspacePathOutsideRootError
      | KnownWorkspaces.UnknownWorkspaceError
      | CheckpointServiceError
      | FileVersionStorage.FileVersionStorageError
    >;
  }
>()("codenine/checkpointing/FileBaselines") {}

const UNAVAILABLE: ProjectReadFileBaselineResult = { available: false, contents: null };
const WHOLE_FILE_ONLY: ProjectReadFileBaselineResult = { ...UNAVAILABLE, wholeFileOnly: true };
// The largest text a workspace read returns, so a baseline never exceeds what it is compared to.
const VERSION_BASELINE_MAX_BYTES = 1024 * 1024;
const BYTE_ORDER_MARK_BYTES = [0xef, 0xbb, 0xbf];

const decodeUtf8 = (bytes: Uint8Array) => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};

const make = Effect.gen(function* () {
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const checkpointDiffQuery = yield* CheckpointDiffQuery.CheckpointDiffQuery;
  const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const fileVersions = yield* FileVersions.FileVersions;

  const readFromVersions = Effect.fn("FileBaselines.readFromVersions")(function* (
    input: ProjectReadFileBaselineInput,
    turn: { readonly threadId: string; readonly turnCount: number },
  ) {
    const baseline = yield* fileVersions.turnBaseline({ ...turn, ...input });
    if (baseline === null) return { result: UNAVAILABLE, byteOrderMark: false };
    const bytes = baseline.bytes;
    if (bytes === null) {
      return { result: { available: true, contents: null }, byteOrderMark: false };
    }
    // Contents that are not UTF-8 text cannot be compared or put back as text: a Discard
    // would write them as UTF-8 with every other character replaced. They can go back whole.
    const contents =
      bytes.byteLength > VERSION_BASELINE_MAX_BYTES || bytes.includes(0) ? null : decodeUtf8(bytes);
    if (contents === null) return { result: WHOLE_FILE_ONLY, byteOrderMark: false };
    return {
      // Decoding drops a byte order mark, as a workspace read does.
      result: { available: true, contents },
      byteOrderMark: BYTE_ORDER_MARK_BYTES.every((byte, index) => bytes[index] === byte),
    };
  });

  const readWithByteOrderMark = Effect.fn("FileBaselines.read")(function* (
    input: ProjectReadFileBaselineInput,
  ): Effect.fn.Return<
    { readonly result: ProjectReadFileBaselineResult; readonly byteOrderMark: boolean },
    | WorkspacePaths.WorkspacePathOutsideRootError
    | CheckpointServiceError
    | FileVersionStorage.FileVersionStorageError
  > {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
    const source = input.source;
    if (source.kind === "turn" && !(yield* checkpointStore.isGitRepository(input.cwd))) {
      return yield* readFromVersions(input, source);
    }
    const turn =
      source.kind === "head"
        ? undefined
        : yield* checkpointDiffQuery.getTurnRefs(source).pipe(
            // A turn whose checkpoints are missing or not yet captured has no baseline.
            Effect.catchTags({
              CheckpointTurnRangeUnavailableError: () => Effect.succeed(null),
              CheckpointRefUnavailableError: () => Effect.succeed(null),
              CheckpointWorkspacePathMissingError: () => Effect.succeed(null),
            }),
          );
    if (turn === null) return { result: UNAVAILABLE, byteOrderMark: false };
    const file = yield* checkpointStore.readFileAtRevision({
      cwd: input.cwd,
      revision: turn?.start ?? "HEAD",
      relativePath: target.relativePath,
      knownCommit: input.knownRevision,
      // A file the turn left alone has nothing to review. That covers files a checkpoint never
      // holds, such as ignored ones, which would otherwise look created by the turn.
      unlessSameAt: turn?.end,
    });
    if (file.kind === "unavailable" || file.kind === "same") {
      return { result: UNAVAILABLE, byteOrderMark: false };
    }
    const byteOrderMark = file.kind === "text" && file.contents.startsWith(BYTE_ORDER_MARK);
    const result: ProjectReadFileBaselineResult = {
      available: true,
      // Workspace reads drop a byte order mark, so the baseline drops it too.
      contents:
        file.kind === "text"
          ? byteOrderMark
            ? file.contents.slice(BYTE_ORDER_MARK.length)
            : file.contents
          : null,
      revision: file.commit,
      ...(file.kind === "unchanged" ? { unchanged: true } : {}),
    };
    return { result, byteOrderMark };
  });

  const read: FileBaselines["Service"]["read"] = (input) =>
    readWithByteOrderMark(input).pipe(Effect.map(({ result }) => result));

  const revertTurnChange: FileBaselines["Service"]["revertTurnChange"] = Effect.fn(
    "FileBaselines.revertTurnChange",
  )(function* (input) {
    const target = { cwd: input.cwd, relativePath: input.relativePath };
    const { result: baseline, byteOrderMark } = yield* readWithByteOrderMark({
      ...target,
      source: { kind: "turn", threadId: input.threadId, turnCount: input.turnCount },
    });
    if (baseline.wholeFileOnly === true && input.change === undefined) {
      const earlier = yield* fileVersions.turnBaseline({ ...target, ...input });
      if (earlier?.bytes) {
        // The write refuses a file that no longer has the version the caller saw.
        const written = yield* fileVersions.overwriteFileBytes({
          ...target,
          bytes: earlier.bytes,
          expectedVersion: input.expectedVersion,
        });
        return { ...written, deleted: false };
      }
    }
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
      if (input.expectedVersion !== undefined) {
        yield* fileVersions.removeFile({ ...target, expectedVersion: input.expectedVersion });
      }
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
    const written = yield* fileVersions.overwriteFile({
      ...target,
      // Reads hide the mark, so it is put back for a file that began the turn with one.
      contents: byteOrderMark ? BYTE_ORDER_MARK + contents : contents,
      expectedVersion: input.expectedVersion,
    });
    return { ...written, deleted: false };
  });

  return FileBaselines.of({ read, revertTurnChange });
});

export const layer = Layer.effect(FileBaselines, make);
