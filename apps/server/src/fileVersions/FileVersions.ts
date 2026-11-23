// @effect-diagnostics nodeBuiltinImport:off - the workspace walk needs lstat and O_NOFOLLOW.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import type {
  ProjectFileVersion,
  ProjectListFileVersionsInput,
  ProjectListFileVersionsResult,
  ProjectReadFileVersionInput,
  ProjectReadFileVersionResult,
  ProjectRestoreFileVersionInput,
  ProjectRestoreFileVersionResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "@codenine/contracts";
import { IsoDateTime, PositiveInt, ThreadId } from "@codenine/contracts";
import * as KeyedLock from "@codenine/shared/KeyedLock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import type * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as FileVersionStorage from "./FileVersionStorage.ts";

const PREVIEW_MAX_BYTES = 1024 * 1024;
// Folders that are rebuilt or belong to another tool, and would use the workspace's whole limit.
const SKIPPED_DIRECTORY_NAMES = new Set([".git", "node_modules"]);

export class FileVersionUnavailableError extends Schema.TaggedError<FileVersionUnavailableError>()(
  "FileVersionUnavailableError",
  {
    relativePath: Schema.String,
    reason: Schema.Literals(["not-found", "not-stored", "contents-missing"]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-found":
        return `That version of '${this.relativePath}' no longer exists.`;
      case "not-stored":
        return `That version of '${this.relativePath}' has no saved contents to restore.`;
      case "contents-missing":
        return `The saved contents of that version of '${this.relativePath}' are missing.`;
    }
  }
}

export type FileVersionSyncOrigin =
  | { readonly kind: "external" }
  | { readonly kind: "agent"; readonly threadId: string; readonly turnCount: number };

export interface FileVersionTurn {
  readonly cwd: string;
  readonly threadId: string;
  readonly turnCount: number;
}

type WriteError =
  | WorkspaceFileSystem.WorkspaceFileSystemError
  | WorkspaceFileSystem.WorkspaceFileConflictError
  | WorkspacePaths.WorkspacePathOutsideRootError
  | KnownWorkspaces.UnknownWorkspaceError;

/**
 * Earlier contents of files in workspaces without Git, where no checkpoint holds them. A Git
 * checkout records nothing here: its checkpoints and commits are the history, and a second one
 * would give two places to restore from.
 */
export class FileVersions extends Context.Service<
  FileVersions,
  {
    /** A save that first records what it replaces. In a Git checkout it only saves. */
    readonly writeFile: (
      input: ProjectWriteFileInput,
      origin: "user" | "restore",
    ) => Effect.Effect<ProjectWriteFileResult, WriteError>;
    /** A delete that first records what it removes. In a Git checkout it only deletes. */
    readonly removeFile: (
      input: WorkspaceFileSystem.RemoveWorkspaceFileInput,
    ) => Effect.Effect<void, WriteError>;
    readonly list: (
      input: ProjectListFileVersionsInput,
    ) => Effect.Effect<
      ProjectListFileVersionsResult,
      WorkspacePaths.WorkspacePathOutsideRootError | FileVersionStorage.FileVersionStorageError
    >;
    readonly read: (
      input: ProjectReadFileVersionInput,
    ) => Effect.Effect<
      ProjectReadFileVersionResult,
      | FileVersionUnavailableError
      | WorkspacePaths.WorkspacePathOutsideRootError
      | FileVersionStorage.FileVersionStorageError
    >;
    /**
     * Puts a version's contents back as a save does, after recording what is on disk, so the
     * restore can itself be undone.
     */
    readonly restore: (
      input: ProjectRestoreFileVersionInput,
    ) => Effect.Effect<
      ProjectRestoreFileVersionResult,
      FileVersionUnavailableError | FileVersionStorage.FileVersionStorageError | WriteError
    >;
    /**
     * Records every file that differs from its latest version. Run before a turn it attributes
     * the differences to outside changes, and after it to the turn. Never fails: a workspace
     * that cannot be read is logged and left alone. Does nothing in a Git checkout.
     */
    readonly syncWorkspace: (input: {
      readonly cwd: string;
      readonly origin: FileVersionSyncOrigin;
    }) => Effect.Effect<void>;
    /** Workspace-relative paths a turn changed, as recorded by its sync. */
    readonly turnChanges: (input: FileVersionTurn) => Effect.Effect<ReadonlyArray<string>>;
    /**
     * A file's contents before a turn changed it; `bytes` is null when the turn created the
     * file. Null when the turn did not change the file or the earlier contents were not kept.
     */
    readonly turnBaseline: (
      input: FileVersionTurn & { readonly relativePath: string },
    ) => Effect.Effect<
      { readonly bytes: Uint8Array | null } | null,
      WorkspacePaths.WorkspacePathOutsideRootError | FileVersionStorage.FileVersionStorageError
    >;
  }
>()("codenine/fileVersions/FileVersions") {}

/** What a turn's checkpoint capture asks of the version store. Records nothing by default. */
export class TurnFileVersions extends Context.Reference<
  Pick<FileVersions["Service"], "syncWorkspace" | "turnChanges">
>("codenine/fileVersions/TurnFileVersions", {
  defaultValue: () => ({
    syncWorkspace: () => Effect.void,
    turnChanges: () => Effect.succeed([]),
  }),
}) {}

interface WalkedFile {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly byteLength: number;
  readonly mtimeMs: number;
}

const toWire = (row: FileVersionStorage.FileVersionRow): ProjectFileVersion => ({
  id: String(row.versionId),
  createdAt: IsoDateTime.make(row.createdAt),
  byteLength: row.byteLength,
  state: row.state,
  origin: row.origin,
  ...(row.contentHash === null ? {} : { version: row.contentHash }),
  ...(row.threadId === null ? {} : { threadId: ThreadId.make(row.threadId) }),
  ...(row.turnCount === null ? {} : { turnCount: PositiveInt.make(row.turnCount) }),
});

const make = Effect.gen(function* () {
  const storage = yield* FileVersionStorage.make;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const locks = yield* KeyedLock.make<string>();
  const { limits } = storage;
  // Workspaces whose every file had a version after a walk in this process.
  const fullyWalked = new Set<string>();

  const rootOf = (cwd: string) => path.resolve(cwd);
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  // A failed lookup counts as Git, so nothing is recorded where the answer is unknown.
  const isTracked = (cwd: string) =>
    checkpointStore.isGitRepository(cwd).pipe(
      Effect.map((git) => !git),
      Effect.orElseSucceed(() => false),
    );

  const relativePathOf = (input: { readonly cwd: string; readonly relativePath: string }) =>
    workspacePaths
      .resolveRelativePathWithinRoot({ workspaceRoot: input.cwd, relativePath: input.relativePath })
      .pipe(Effect.map((target) => target.relativePath));

  const sameAsHead = (
    head: FileVersionStorage.FileVersionRow | null,
    content: FileVersionStorage.FileVersionContent,
  ) => {
    if (content.kind === "absent") return head === null || head.state === "deleted";
    if (head === null) return false;
    if (content.kind === "too-large") {
      return head.state === "skipped" && head.byteLength === content.byteLength;
    }
    return (
      head.state === "stored" && head.contentHash === FileVersionStorage.contentHash(content.bytes)
    );
  };

  /** Records the content as the file's latest version unless it already is. */
  const record = Effect.fn("FileVersions.record")(function* (
    root: string,
    relativePath: string,
    content: FileVersionStorage.FileVersionContent,
    mtimeMs: number | null,
    origin: FileVersionSyncOrigin | { readonly kind: "user" | "restore" },
    known?: { readonly head: FileVersionStorage.FileVersionRow | null },
  ) {
    const head = known === undefined ? yield* storage.head(root, relativePath) : known.head;
    if (sameAsHead(head, content)) {
      if (head !== null && mtimeMs !== null && head.mtimeMs !== mtimeMs) {
        yield* storage.touch(head, mtimeMs);
      }
      return false;
    }
    const createdAt = yield* now;
    if (
      origin.kind === "user" &&
      content.kind === "bytes" &&
      head?.origin === "user" &&
      head.state === "stored" &&
      Date.parse(createdAt) - Date.parse(head.createdAt) < limits.userSaveCoalesceMs
    ) {
      yield* storage.replaceContent(root, head, content.bytes);
      return true;
    }
    yield* storage.append(
      root,
      {
        relativePath,
        content,
        mtimeMs,
        origin: origin.kind,
        ...(origin.kind === "agent"
          ? { threadId: origin.threadId, turnCount: origin.turnCount }
          : {}),
        createdAt,
      },
      head,
    );
    return true;
  });

  /** Records what is on disk when the store has not seen it, so a write never loses it. */
  const recordDisk = Effect.fn("FileVersions.recordDisk")(function* (
    cwd: string,
    relativePath: string,
  ) {
    const disk = yield* workspaceFileSystem.readFileBytes({
      cwd,
      relativePath,
      maxBytes: limits.maxFileBytes,
    });
    yield* record(
      rootOf(cwd),
      relativePath,
      disk.kind === "file" ? { kind: "bytes", bytes: disk.bytes } : disk,
      disk.kind === "absent" ? null : disk.mtimeMs,
      { kind: "external" },
    );
  });

  // Versions are a safety net: failing to record one must not fail the save or the turn.
  const bestEffort = <E, R>(operation: string, effect: Effect.Effect<unknown, E, R>) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("file version store could not record a change", { operation, cause }),
      ),
      Effect.asVoid,
    );

  /** Runs a write between a record of what it replaces and a record of what it wrote. */
  const recorded = Effect.fn("FileVersions.recorded")(function* <A, E>(
    input: { readonly cwd: string; readonly relativePath: string },
    write: Effect.Effect<A, E>,
    written: FileVersionStorage.FileVersionContent,
    origin: "user" | "restore",
  ) {
    const relativePath = yield* relativePathOf(input).pipe(Effect.option);
    // The write reports a path outside the workspace itself.
    if (relativePath._tag === "None") return yield* write;
    return yield* locks.withLock(
      rootOf(input.cwd),
      Effect.gen(function* () {
        yield* bestEffort("record-replaced", recordDisk(input.cwd, relativePath.value));
        const result = yield* write;
        yield* bestEffort(
          "record-written",
          record(rootOf(input.cwd), relativePath.value, written, null, { kind: origin }),
        );
        return result;
      }),
    );
  });

  const writeFile: FileVersions["Service"]["writeFile"] = Effect.fn("FileVersions.writeFile")(
    function* (input, origin) {
      const write = workspaceFileSystem.writeFile(input);
      if (!(yield* isTracked(input.cwd))) return yield* write;
      const bytes = Buffer.from(input.contents);
      return yield* recorded(input, write, { kind: "bytes", bytes }, origin);
    },
  );

  const removeFile: FileVersions["Service"]["removeFile"] = Effect.fn("FileVersions.removeFile")(
    function* (input) {
      const remove = workspaceFileSystem.removeFile(input);
      if (!(yield* isTracked(input.cwd))) return yield* remove;
      return yield* recorded(input, remove, { kind: "absent" }, "restore");
    },
  );

  const list: FileVersions["Service"]["list"] = Effect.fn("FileVersions.list")(function* (input) {
    const relativePath = yield* relativePathOf(input);
    const rows = yield* storage.list(rootOf(input.cwd), relativePath);
    return { tracked: yield* isTracked(input.cwd), versions: rows.map(toWire) };
  });

  const storedVersion = Effect.fn("FileVersions.storedVersion")(function* (
    input: ProjectReadFileVersionInput,
  ) {
    const relativePath = yield* relativePathOf(input);
    const versionId = Number(input.versionId);
    const row = Number.isSafeInteger(versionId)
      ? yield* storage.get(rootOf(input.cwd), versionId)
      : null;
    if (row === null || row.relativePath !== relativePath) {
      return yield* new FileVersionUnavailableError({ relativePath, reason: "not-found" });
    }
    if (row.contentHash === null) {
      return yield* new FileVersionUnavailableError({ relativePath, reason: "not-stored" });
    }
    const bytes = yield* storage.readContents(rootOf(input.cwd), row.contentHash);
    if (bytes === null) {
      return yield* new FileVersionUnavailableError({ relativePath, reason: "contents-missing" });
    }
    return { relativePath, bytes };
  });

  const read: FileVersions["Service"]["read"] = Effect.fn("FileVersions.read")(function* (input) {
    const { bytes } = yield* storedVersion(input);
    const text = bytes.byteLength <= PREVIEW_MAX_BYTES && !bytes.includes(0);
    return {
      contents: text ? new TextDecoder("utf-8").decode(bytes) : null,
      byteLength: bytes.byteLength,
    };
  });

  const restore: FileVersions["Service"]["restore"] = Effect.fn("FileVersions.restore")(
    function* (input) {
      const { relativePath, bytes } = yield* storedVersion(input);
      const written = yield* recorded(
        input,
        workspaceFileSystem.writeFileBytes({
          cwd: input.cwd,
          relativePath,
          bytes,
          expectedVersion: input.expectedVersion,
        }),
        { kind: "bytes", bytes },
        "restore",
      );
      return { relativePath: written.relativePath, version: written.version ?? "" };
    },
  );

  /** Regular files below the root. Links are never followed, so nothing outside is reached. */
  const walk = async (realRoot: string, ownDirectories: ReadonlySet<string>) => {
    const files: Array<WalkedFile> = [];
    const pending = [realRoot];
    for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
      const entries = await NodeFSP.readdir(directory, { withFileTypes: true }).catch(() => []);
      entries.sort((left, right) => (left.name < right.name ? -1 : 1));
      for (const entry of entries) {
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!SKIPPED_DIRECTORY_NAMES.has(entry.name) && !ownDirectories.has(absolutePath)) {
            pending.push(absolutePath);
          }
          continue;
        }
        if (!entry.isFile()) continue;
        if (files.length >= limits.maxTrackedFiles) return { files, complete: false };
        const stat = await NodeFSP.lstat(absolutePath).catch(() => null);
        if (stat?.isFile() !== true) continue;
        files.push({
          relativePath: path.relative(realRoot, absolutePath).replaceAll(path.sep, "/"),
          absolutePath,
          byteLength: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      }
    }
    return { files, complete: true };
  };

  const readWalkedFile = async (
    file: WalkedFile,
  ): Promise<FileVersionStorage.FileVersionContent | null> => {
    if (file.byteLength > limits.maxFileBytes) {
      return { kind: "too-large", byteLength: file.byteLength };
    }
    // A link swapped in after the walk is not followed. Windows lacks O_NOFOLLOW.
    const handle = await NodeFSP.open(
      file.absolutePath,
      NodeFS.constants.O_RDONLY |
        (NodeFS.constants.O_NOFOLLOW ?? 0) |
        (NodeFS.constants.O_NONBLOCK ?? 0),
    ).catch(() => null);
    if (handle === null) return null;
    try {
      if (!(await handle.stat()).isFile()) return null;
      return { kind: "bytes", bytes: await handle.readFile() };
    } catch {
      return null;
    } finally {
      await handle.close().catch(() => undefined);
    }
  };

  const realPath = (value: string) =>
    Effect.promise(() => NodeFSP.realpath(value).catch(() => path.resolve(value)));

  const sync = Effect.fn("FileVersions.sync")(function* (
    cwd: string,
    origin: FileVersionSyncOrigin,
  ) {
    const root = rootOf(cwd);
    const realRoot = yield* realPath(root);
    // A workspace that holds Codenine's own data must not copy the store into itself.
    const ownDirectories = new Set(
      yield* Effect.forEach([config.baseDir, config.stateDir], realPath),
    );
    const heads = yield* storage.heads(root);
    if (heads.size === 0) {
      // Contents without rows are left from a restored backup or an interrupted delete.
      yield* storage.deleteWorkspace(root);
    }
    const { files, complete } = yield* Effect.promise(() => walk(realRoot, ownDirectories));
    if (!complete) {
      yield* Effect.logWarning("file version store reached its file limit for a workspace", {
        cwd,
        maxTrackedFiles: limits.maxTrackedFiles,
      });
    }
    // A file first seen now existed before the turn unless an earlier walk saw the whole folder.
    // Calling it the turn's would let a review's Discard delete it.
    const newFileOrigin = fullyWalked.has(root) ? origin : ({ kind: "external" } as const);
    const seen = new Set<string>();
    for (const file of files) {
      seen.add(file.relativePath);
      const head = heads.get(file.relativePath) ?? null;
      if (
        head !== null &&
        head.state !== "deleted" &&
        head.byteLength === file.byteLength &&
        head.mtimeMs === file.mtimeMs
      ) {
        continue;
      }
      const content = yield* Effect.promise(() => readWalkedFile(file));
      if (content === null) continue;
      yield* record(
        root,
        file.relativePath,
        content,
        file.mtimeMs,
        head === null ? newFileOrigin : origin,
        { head },
      );
    }
    if (complete) fullyWalked.add(root);
    else fullyWalked.delete(root);
    // A cut-short walk cannot tell a deleted file from one it did not reach.
    if (!complete) return;
    for (const head of heads.values()) {
      if (head.state === "deleted" || seen.has(head.relativePath)) continue;
      yield* record(root, head.relativePath, { kind: "absent" }, null, origin, { head });
    }
  });

  const syncWorkspace: FileVersions["Service"]["syncWorkspace"] = Effect.fn(
    "FileVersions.syncWorkspace",
  )(function* (input) {
    if (!(yield* isTracked(input.cwd))) return;
    yield* bestEffort("sync", locks.withLock(rootOf(input.cwd), sync(input.cwd, input.origin)));
  });

  const turnChanges: FileVersions["Service"]["turnChanges"] = Effect.fn("FileVersions.turnChanges")(
    function* (input) {
      const rows = yield* storage
        .turnRows(rootOf(input.cwd), input)
        .pipe(Effect.orElseSucceed(() => []));
      return [...new Set(rows.map((row) => row.relativePath))];
    },
  );

  const turnBaseline: FileVersions["Service"]["turnBaseline"] = Effect.fn(
    "FileVersions.turnBaseline",
  )(function* (input) {
    const root = rootOf(input.cwd);
    const relativePath = yield* relativePathOf(input);
    const first = (yield* storage.turnRows(root, input)).find(
      (row) => row.relativePath === relativePath,
    );
    if (first === undefined) return null;
    if (first.change === "created") return { bytes: null };
    const earlier = yield* storage.previous(root, first);
    if (earlier?.contentHash == null) return null;
    const bytes = yield* storage.readContents(root, earlier.contentHash);
    return bytes === null ? null : { bytes };
  });

  return FileVersions.of({
    writeFile,
    removeFile,
    list,
    read,
    restore,
    syncWorkspace,
    turnChanges,
    turnBaseline,
  });
});

export const layer = Layer.effect(FileVersions, make);

export const layerTurnFileVersions = Layer.effect(
  TurnFileVersions,
  Effect.gen(function* () {
    const { syncWorkspace, turnChanges } = yield* FileVersions;
    return { syncWorkspace, turnChanges };
  }),
);
