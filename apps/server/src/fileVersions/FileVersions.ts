// @effect-diagnostics nodeBuiltinImport:off - the workspace walk needs lstat and O_NOFOLLOW.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import type {
  ProjectFileVersion,
  ProjectListFileActivityInput,
  ProjectListFileActivityResult,
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

/** A write that would destroy contents the store holds no copy of, so nothing was changed. */
export class FileVersionNotKeptError extends Schema.TaggedError<FileVersionNotKeptError>()(
  "FileVersionNotKeptError",
  { relativePath: Schema.String },
) {
  override get message(): string {
    return `The current contents of '${this.relativePath}' could not be kept as a version, so the file was left as it is. It may be too large, or the workspace's versions may be full.`;
  }
}

type FileVersionWalkOrigin =
  | { readonly kind: "external" }
  | { readonly kind: "agent"; readonly threadId: string; readonly turnCount: number };

export type FileVersionSyncOrigin =
  | FileVersionWalkOrigin
  /** The walk before a thread's turn. It is skipped while another thread's turn runs there. */
  | { readonly kind: "turn-start"; readonly threadId: string };

export interface FileVersionTurn {
  readonly cwd: string;
  readonly threadId: string;
  readonly turnCount: number;
}

type SaveError =
  | WorkspaceFileSystem.WorkspaceFileSystemError
  | WorkspaceFileSystem.WorkspaceFileConflictError
  | WorkspacePaths.WorkspacePathOutsideRootError
  | KnownWorkspaces.UnknownWorkspaceError;
type WriteError = SaveError | FileVersionNotKeptError;

/**
 * Earlier contents of files in workspaces without Git, where no checkpoint holds them. A Git
 * checkout records nothing here: its checkpoints and commits are the history, and a second one
 * would give two places to restore from.
 */
export class FileVersions extends Context.Service<
  FileVersions,
  {
    /** Whether saves in this folder record what they replace: true in a folder without Git. */
    readonly keepsVersions: (cwd: string) => Effect.Effect<boolean>;
    /**
     * An editor save, which first records what it replaces and goes ahead when that fails. In a
     * Git checkout it only saves.
     */
    readonly writeFile: (
      input: ProjectWriteFileInput,
    ) => Effect.Effect<ProjectWriteFileResult, SaveError>;
    /**
     * `writeFile` for contents of any type, such as a workbook. A save with an `action` is kept
     * as a version of its own, so the record of it is not merged into the saves around it.
     */
    readonly writeFileBytes: (
      input: WorkspaceFileSystem.WriteWorkspaceFileBytesInput & {
        readonly action?: FileVersionStorage.FileVersionAction | undefined;
        /**
         * True for a write an agent makes during its turn. The walk that ends the turn records
         * it as the turn's change, as it does a change the agent made with its own tools.
         */
        readonly duringTurn?: boolean | undefined;
      },
    ) => Effect.Effect<ProjectWriteFileResult, SaveError>;
    /** `writeFile` for a write that promises an undo: refused when what it replaces is not kept. */
    readonly overwriteFile: (
      input: ProjectWriteFileInput,
    ) => Effect.Effect<ProjectWriteFileResult, WriteError>;
    /** `overwriteFile` for contents of any type. */
    readonly overwriteFileBytes: (
      input: WorkspaceFileSystem.WriteWorkspaceFileBytesInput,
    ) => Effect.Effect<ProjectWriteFileResult, WriteError>;
    /**
     * A delete that first records what it removes, and is refused when it cannot. In a Git
     * checkout it only deletes.
     */
    readonly removeFile: (
      input: WorkspaceFileSystem.RemoveWorkspaceFileInput,
    ) => Effect.Effect<void, WriteError>;
    readonly list: (
      input: ProjectListFileVersionsInput,
    ) => Effect.Effect<
      ProjectListFileVersionsResult,
      WorkspacePaths.WorkspacePathOutsideRootError | FileVersionStorage.FileVersionStorageError
    >;
    /** The workspace's newest recorded changes across its files. Empty in a Git checkout. */
    readonly activity: (
      input: ProjectListFileActivityInput,
    ) => Effect.Effect<ProjectListFileActivityResult, FileVersionStorage.FileVersionStorageError>;
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
     * restore can itself be undone. Refused when what is on disk cannot be recorded.
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
     * that cannot be read is logged and left alone. Does nothing in a Git checkout. A turn
     * that ends with no walk, as a failed one does, counts as running until its thread's next.
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

/** What a walk could not read, and so cannot say existed or not. Directories end in "/". */
interface Unread {
  readonly files: Set<string>;
  readonly directories: ReadonlyArray<string>;
}

const isUnread = (unread: Unread, relativePath: string) =>
  unread.files.has(relativePath) ||
  unread.directories.some((directory) => relativePath.startsWith(directory));

const EXTERNAL = { kind: "external" } as const;

interface WalkedFile {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly byteLength: number;
  readonly mtimeMs: number;
}

// The most changes one activity read answers with, so the list stays small on the wire.
const ACTIVITY_MAX_ENTRIES = 300;

const toWire = (row: FileVersionStorage.FileVersionRow): ProjectFileVersion => ({
  id: String(row.versionId),
  createdAt: IsoDateTime.make(row.createdAt),
  byteLength: row.byteLength,
  state: row.state,
  origin: row.origin,
  ...(row.contentHash === null ? {} : { version: row.contentHash }),
  ...(row.threadId === null ? {} : { threadId: ThreadId.make(row.threadId) }),
  ...(row.turnCount === null ? {} : { turnCount: PositiveInt.make(row.turnCount) }),
  ...(row.action === null ? {} : { action: row.action }),
});

const make = Effect.gen(function* () {
  const storage = yield* FileVersionStorage.FileVersionStorage;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const { limits } = storage;
  // Workspaces a walk in this process saw whole, apart from what it could not read.
  const walked = new Map<string, Unread>();
  // Threads with a turn running in each workspace.
  const runningTurns = new Map<string, Set<string>>();

  const rootOf = (cwd: string) => path.resolve(cwd);
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  // A failed lookup counts as Git, so nothing is recorded where the answer is unknown.
  const isTracked = (cwd: string) =>
    checkpointStore.isGitRepository(cwd).pipe(
      Effect.map((git) => !git),
      Effect.orElseSucceed(() => false),
    );

  /**
   * The path a file's versions are kept under: where it really is, as the walk records it, so a
   * file reached through a link inside the workspace has one history. A link that leaves the
   * workspace keeps the path as named.
   */
  const relativePathOf = Effect.fn("FileVersions.relativePathOf")(function* (input: {
    readonly cwd: string;
    readonly relativePath: string;
  }) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
    const root = rootOf(input.cwd);
    const segments = path.relative(root, target.absolutePath).split(path.sep);
    return yield* Effect.promise(async () => {
      const realRoot = await NodeFSP.realpath(root).catch(() => root);
      for (let depth = segments.length; depth > 0; depth--) {
        const real = await NodeFSP.realpath(path.join(realRoot, ...segments.slice(0, depth))).catch(
          () => null,
        );
        if (real === null) continue;
        const relative = path.relative(realRoot, path.join(real, ...segments.slice(depth)));
        return relative === "" || relative.startsWith("..") || path.isAbsolute(relative)
          ? target.relativePath
          : relative.replaceAll(path.sep, "/");
      }
      return target.relativePath;
    });
  });

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
    origin:
      | FileVersionWalkOrigin
      | {
          readonly kind: "user" | "restore";
          readonly action?: FileVersionStorage.FileVersionAction | undefined;
        },
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
      origin.action === undefined &&
      content.kind === "bytes" &&
      head?.origin === "user" &&
      head.action === null &&
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
        ...("action" in origin && origin.action !== undefined ? { action: origin.action } : {}),
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
      EXTERNAL,
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
  const recorded = Effect.fn("FileVersions.recorded")(function* <A, E, E2>(
    input: { readonly cwd: string; readonly relativePath: string },
    write: Effect.Effect<A, E>,
    written: FileVersionStorage.FileVersionContent,
    origin: "user" | "restore",
    recordReplaced: (relativePath: string) => Effect.Effect<void, E2>,
    action?: FileVersionStorage.FileVersionAction,
  ) {
    const found = yield* relativePathOf(input).pipe(Effect.option);
    // The write reports a path outside the workspace itself.
    if (found._tag === "None") return yield* write;
    const relativePath = found.value;
    const root = rootOf(input.cwd);
    return yield* storage.withWriteLock(
      root,
      Effect.gen(function* () {
        yield* recordReplaced(relativePath);
        const result = yield* write;
        yield* bestEffort(
          "record-written",
          record(root, relativePath, written, null, { kind: origin, action }),
        );
        return result;
      }),
    );
  });

  const replacedIfPossible = (cwd: string) => (relativePath: string) =>
    bestEffort("record-replaced", recordDisk(cwd, relativePath));

  /** Fails unless the store holds what is on disk, which a latest version without contents lacks. */
  const replacedKept = (cwd: string) =>
    Effect.fn("FileVersions.replacedKept")(function* (relativePath: string) {
      const kept = yield* recordDisk(cwd, relativePath).pipe(
        Effect.andThen(storage.head(rootOf(cwd), relativePath)),
        Effect.map((head) => head?.state !== "skipped"),
        Effect.catchTags({
          FileVersionStorageError: (cause) =>
            Effect.logWarning("file version store could not record a change", {
              operation: "record-replaced",
              cause,
            }).pipe(Effect.as(false)),
        }),
      );
      if (!kept) return yield* new FileVersionNotKeptError({ relativePath });
    });

  const writeFile: FileVersions["Service"]["writeFile"] = Effect.fn("FileVersions.writeFile")(
    function* (input) {
      const write = workspaceFileSystem.writeFile(input);
      if (!(yield* isTracked(input.cwd))) return yield* write;
      const bytes = Buffer.from(input.contents);
      return yield* recorded(
        input,
        write,
        { kind: "bytes", bytes },
        "user",
        replacedIfPossible(input.cwd),
      );
    },
  );

  const writeFileBytes: FileVersions["Service"]["writeFileBytes"] = Effect.fn(
    "FileVersions.writeFileBytes",
  )(function* (input) {
    const write = workspaceFileSystem.writeFileBytes(input);
    if (!(yield* isTracked(input.cwd))) return yield* write;
    if (input.duringTurn === true) {
      const found = yield* relativePathOf(input).pipe(Effect.option);
      if (found._tag === "None") return yield* write;
      const root = rootOf(input.cwd);
      return yield* storage.withWriteLock(
        root,
        Effect.gen(function* () {
          const earlier = walked.get(root);
          // The walk before the turn holds what the file was, unless it could not read it.
          if (earlier === undefined || isUnread(earlier, found.value)) {
            yield* replacedIfPossible(input.cwd)(found.value);
          }
          return yield* write;
        }),
      );
    }
    return yield* recorded(
      input,
      write,
      { kind: "bytes", bytes: input.bytes },
      "user",
      replacedIfPossible(input.cwd),
      input.action,
    );
  });

  const overwriteFile: FileVersions["Service"]["overwriteFile"] = Effect.fn(
    "FileVersions.overwriteFile",
  )(function* (input) {
    const write = workspaceFileSystem.writeFile(input);
    if (!(yield* isTracked(input.cwd))) return yield* write;
    const bytes = Buffer.from(input.contents);
    return yield* recorded(
      input,
      write,
      { kind: "bytes", bytes },
      "restore",
      replacedKept(input.cwd),
    );
  });

  const overwriteFileBytes: FileVersions["Service"]["overwriteFileBytes"] = Effect.fn(
    "FileVersions.overwriteFileBytes",
  )(function* (input) {
    const write = workspaceFileSystem.writeFileBytes(input);
    if (!(yield* isTracked(input.cwd))) return yield* write;
    return yield* recorded(
      input,
      write,
      { kind: "bytes", bytes: input.bytes },
      "restore",
      replacedKept(input.cwd),
    );
  });

  const removeFile: FileVersions["Service"]["removeFile"] = Effect.fn("FileVersions.removeFile")(
    function* (input) {
      const remove = workspaceFileSystem.removeFile(input);
      if (!(yield* isTracked(input.cwd))) return yield* remove;
      return yield* recorded(input, remove, { kind: "absent" }, "restore", replacedKept(input.cwd));
    },
  );

  const list: FileVersions["Service"]["list"] = Effect.fn("FileVersions.list")(function* (input) {
    const relativePath = yield* relativePathOf(input);
    const rows = yield* storage.list(rootOf(input.cwd), relativePath);
    return { tracked: yield* isTracked(input.cwd), versions: rows.map(toWire) };
  });

  const activity: FileVersions["Service"]["activity"] = Effect.fn("FileVersions.activity")(
    function* (input) {
      const rows = yield* storage.recent(rootOf(input.cwd), {
        since: input.since ?? null,
        threadId: input.threadId ?? null,
        limit: ACTIVITY_MAX_ENTRIES,
      });
      return {
        tracked: yield* isTracked(input.cwd),
        entries: rows.map((row) => ({
          ...toWire(row),
          relativePath: row.relativePath,
          change: row.change,
        })),
      };
    },
  );

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
      const { bytes } = yield* storedVersion(input);
      const written = yield* recorded(
        input,
        workspaceFileSystem.writeFileBytes({
          cwd: input.cwd,
          relativePath: input.relativePath,
          bytes,
          expectedVersion: input.expectedVersion,
        }),
        { kind: "bytes", bytes },
        "restore",
        replacedKept(input.cwd),
      );
      return { relativePath: written.relativePath, version: written.version ?? "" };
    },
  );

  /** Regular files below the root. Links are never followed, so nothing outside is reached. */
  const walk = async (realRoot: string, ownDirectories: ReadonlySet<string>) => {
    const files: Array<WalkedFile> = [];
    const unreadFiles = new Set<string>();
    const unreadDirectories: Array<string> = [];
    const relative = (absolutePath: string) =>
      path.relative(realRoot, absolutePath).replaceAll(path.sep, "/");
    const pending = [realRoot];
    for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
      const entries = await NodeFSP.readdir(directory, { withFileTypes: true }).catch(() => null);
      if (entries === null) {
        unreadDirectories.push(directory === realRoot ? "" : `${relative(directory)}/`);
        continue;
      }
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
        if (files.length >= limits.maxTrackedFiles) {
          return { files, unreadFiles, unreadDirectories, complete: false };
        }
        const stat = await NodeFSP.lstat(absolutePath).catch(() => null);
        if (stat === null) {
          unreadFiles.add(relative(absolutePath));
          continue;
        }
        if (!stat.isFile()) continue;
        files.push({
          relativePath: relative(absolutePath),
          absolutePath,
          byteLength: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      }
    }
    return { files, unreadFiles, unreadDirectories, complete: true };
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
    origin: FileVersionWalkOrigin,
  ) {
    const root = rootOf(cwd);
    const realRoot = yield* realPath(root);
    // A workspace that holds Codenine's own data must not copy the store into itself.
    const ownDirectories = new Set(
      yield* Effect.forEach([config.baseDir, config.stateDir], realPath),
    );
    // Forgotten until this walk ends, so one that fails part-way does not count as whole.
    const earlier = walked.get(root);
    walked.delete(root);
    const heads = yield* storage.withWriteLock(
      root,
      Effect.gen(function* () {
        const heads = yield* storage.heads(root);
        // Contents without rows are left from a restored backup or an interrupted delete.
        if (heads.size === 0) yield* storage.deleteWorkspace(root);
        return heads;
      }),
    );
    const { files, unreadFiles, unreadDirectories, complete } = yield* Effect.promise(() =>
      walk(realRoot, ownDirectories),
    );
    if (!complete) {
      yield* Effect.logWarning("file version store reached its file limit for a workspace", {
        cwd,
        maxTrackedFiles: limits.maxTrackedFiles,
      });
    }
    const unread: Unread = { files: unreadFiles, directories: unreadDirectories };
    // A file first seen now existed before the turn unless the walk before this one would have
    // seen it. Calling it the turn's would let a review's Discard delete it.
    const seenBefore = (relativePath: string) =>
      earlier !== undefined && !isUnread(earlier, relativePath);
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
      // The lock is taken for each file, so an editor save waits for one file and not the walk.
      // A save may have come since `heads` was read, so the file's latest version is read again.
      yield* storage.withWriteLock(
        root,
        Effect.gen(function* () {
          const content = yield* Effect.promise(() => readWalkedFile(file));
          if (content === null) {
            unread.files.add(file.relativePath);
            return;
          }
          const latest = yield* storage.head(root, file.relativePath);
          yield* record(
            root,
            file.relativePath,
            content,
            file.mtimeMs,
            latest === null && !seenBefore(file.relativePath) ? EXTERNAL : origin,
            { head: latest },
          );
        }),
      );
    }
    // A cut-short walk cannot tell a deleted file from one it did not reach.
    if (!complete) return;
    walked.set(root, unread);
    for (const head of heads.values()) {
      if (head.state === "deleted" || seen.has(head.relativePath)) continue;
      if (isUnread(unread, head.relativePath)) continue;
      yield* storage.withWriteLock(
        root,
        Effect.gen(function* () {
          const latest = yield* storage.head(root, head.relativePath);
          // A newer version means a save wrote the file after the walk passed it.
          if (latest?.versionId !== head.versionId) return;
          yield* record(root, head.relativePath, { kind: "absent" }, null, origin, { head });
        }),
      );
    }
  });

  const syncWorkspace: FileVersions["Service"]["syncWorkspace"] = Effect.fn(
    "FileVersions.syncWorkspace",
  )(function* (input) {
    if (!(yield* isTracked(input.cwd))) return;
    const root = rootOf(input.cwd);
    const origin = input.origin;
    if (origin.kind === "turn-start") {
      const running = runningTurns.get(root) ?? new Set<string>();
      runningTurns.set(root, running);
      const othersRunning = running.size > (running.has(origin.threadId) ? 1 : 0);
      running.add(origin.threadId);
      // A walk now would call the running turn's changes outside ones and take them from it.
      // They stay unrecorded for the turn that ends first.
      if (othersRunning) return;
    }
    yield* bestEffort(
      "sync",
      storage.withWalkLock(root, sync(input.cwd, origin.kind === "agent" ? origin : EXTERNAL)),
    );
    if (origin.kind === "agent") runningTurns.get(root)?.delete(origin.threadId);
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
    keepsVersions: isTracked,
    writeFile,
    writeFileBytes,
    overwriteFile,
    overwriteFileBytes,
    removeFile,
    list,
    activity,
    read,
    restore,
    syncWorkspace,
    turnChanges,
    turnBaseline,
  });
});

export const layer = Layer.effect(FileVersions, make).pipe(Layer.provide(FileVersionStorage.layer));

export const layerTurnFileVersions = Layer.effect(
  TurnFileVersions,
  Effect.gen(function* () {
    const { syncWorkspace, turnChanges } = yield* FileVersions;
    return { syncWorkspace, turnChanges };
  }),
);
