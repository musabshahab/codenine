// @effect-diagnostics nodeBuiltinImport:off - contents are bytes of any type, written and renamed in place.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import * as KeyedLock from "@codenine/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";

/** The store's folder in the state directory. Backups leave it out. */
export const FILE_VERSIONS_DIRECTORY = "file-versions";

const MEBIBYTE = 1024 * 1024;

/**
 * Every limit of the version store. The store holds a copy of each file it watches, so it is
 * bounded per workspace: a folder of documents fits, and a media library cannot fill the disk.
 */
export const FileVersionLimits = Context.Reference<{
  /** A larger file gets no copy; its changes are still listed. */
  readonly maxFileBytes: number;
  /** Stored contents per workspace. Older versions go first, then new files get no copy. */
  readonly maxWorkspaceBytes: number;
  readonly maxVersionsPerFile: number;
  /** Files watched per workspace; a turn's walk of the folder stops there. */
  readonly maxTrackedFiles: number;
  /** Editor saves this close together are one version, so autosave does not flood the list. */
  readonly userSaveCoalesceMs: number;
}>("codenine/fileVersions/FileVersionLimits", {
  defaultValue: () => ({
    maxFileBytes: 32 * MEBIBYTE,
    maxWorkspaceBytes: 1024 * MEBIBYTE,
    maxVersionsPerFile: 30,
    maxTrackedFiles: 10_000,
    userSaveCoalesceMs: 5 * 60_000,
  }),
});

export class FileVersionStorageError extends Schema.TaggedError<FileVersionStorageError>()(
  "FileVersionStorageError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `The file version store failed to ${this.operation}.`;
  }
}

export type FileVersionOrigin = "user" | "agent" | "restore" | "external";
/** What a save did beyond changing the contents. */
export type FileVersionAction = "signed";

export interface FileVersionRow {
  readonly versionId: number;
  readonly relativePath: string;
  readonly state: "stored" | "deleted" | "skipped";
  readonly contentHash: string | null;
  readonly byteLength: number;
  /** The file's modification time when recorded; null when the store wrote the row unseen. */
  readonly mtimeMs: number | null;
  readonly change: "created" | "modified" | "deleted";
  readonly origin: FileVersionOrigin;
  readonly threadId: string | null;
  readonly turnCount: number | null;
  readonly action: FileVersionAction | null;
  readonly createdAt: string;
}

export type FileVersionContent =
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  | { readonly kind: "absent" }
  /** Over the file size limit, so only the change is recorded. */
  | { readonly kind: "too-large"; readonly byteLength: number };

export interface AppendFileVersionInput {
  readonly relativePath: string;
  readonly content: FileVersionContent;
  readonly mtimeMs: number | null;
  readonly origin: FileVersionOrigin;
  readonly threadId?: string | undefined;
  readonly turnCount?: number | undefined;
  readonly action?: FileVersionAction | undefined;
  readonly createdAt: string;
}

export const contentHash = (bytes: Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

type Stored<A> = Effect.Effect<A, FileVersionStorageError>;

/**
 * Rows and contents of the version store. One instance serves the whole server: the total kept
 * in memory is only right when every write to a workspace goes through it under `withWriteLock`.
 */
export class FileVersionStorage extends Context.Service<
  FileVersionStorage,
  {
    readonly limits: (typeof FileVersionLimits)["Service"];
    readonly storeDirectory: string;
    /** Held for a whole walk of a workspace. Saves do not wait for it. */
    readonly withWalkLock: <A, E, R>(
      workspaceRoot: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    /** Held around each change to a workspace's rows, so a walk lets saves in between its files. */
    readonly withWriteLock: <A, E, R>(
      workspaceRoot: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    readonly list: (
      workspaceRoot: string,
      relativePath: string,
    ) => Stored<ReadonlyArray<FileVersionRow>>;
    readonly head: (workspaceRoot: string, relativePath: string) => Stored<FileVersionRow | null>;
    /** The latest version of every file in the workspace, by path. */
    readonly heads: (workspaceRoot: string) => Stored<Map<string, FileVersionRow>>;
    readonly get: (workspaceRoot: string, versionId: number) => Stored<FileVersionRow | null>;
    /** The version a row replaced. Null once pruned, and for a file's first version. */
    readonly previous: (
      workspaceRoot: string,
      row: FileVersionRow,
    ) => Stored<FileVersionRow | null>;
    readonly turnRows: (
      workspaceRoot: string,
      turn: { readonly threadId: string; readonly turnCount: number },
    ) => Stored<ReadonlyArray<FileVersionRow>>;
    /**
     * The workspace's newest versions across all its files, newest first. With a thread, only
     * what that chat's activity lists: its own turns' changes and the user's.
     */
    readonly recent: (
      workspaceRoot: string,
      input: {
        readonly since: string | null;
        readonly threadId: string | null;
        readonly limit: number;
      },
    ) => Stored<ReadonlyArray<FileVersionRow>>;
    /** Records a new latest version of a file, then applies the per-file limit. */
    readonly append: (
      workspaceRoot: string,
      input: AppendFileVersionInput,
      replaced: FileVersionRow | null,
    ) => Stored<void>;
    /** Puts new contents in an existing version, for editor saves that count as one. */
    readonly replaceContent: (
      workspaceRoot: string,
      row: FileVersionRow,
      bytes: Uint8Array,
    ) => Stored<void>;
    /** Notes the file's new modification time when only that changed. */
    readonly touch: (row: FileVersionRow, mtimeMs: number) => Stored<void>;
    /** Null when the contents are gone, as after restoring a backup onto another computer. */
    readonly readContents: (workspaceRoot: string, hash: string) => Stored<Uint8Array | null>;
    /** For a caller that holds the workspace's locks. */
    readonly deleteWorkspace: (workspaceRoot: string) => Stored<void>;
    /** `deleteWorkspace` for a caller that holds neither lock, such as a project's deletion. */
    readonly forgetWorkspace: (workspaceRoot: string) => Stored<void>;
    /**
     * Hands a workspace's versions to the folder it moved to. Versions the new folder already
     * has are of that folder's files, so they stay and the old folder's are dropped instead.
     */
    readonly moveWorkspace: (from: string, to: string) => Stored<void>;
  }
>()("codenine/fileVersions/FileVersionStorage") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const limits = yield* FileVersionLimits;
  const storeDirectory = path.join(config.stateDir, FILE_VERSIONS_DIRECTORY);
  const totals = new Map<string, number>();
  const walkLocks = yield* KeyedLock.make<string>();
  const writeLocks = yield* KeyedLock.make<string>();

  const withWalkLock = <A, E, R>(workspaceRoot: string, effect: Effect.Effect<A, E, R>) =>
    walkLocks.withLock(workspaceRoot, effect);
  const withWriteLock = <A, E, R>(workspaceRoot: string, effect: Effect.Effect<A, E, R>) =>
    writeLocks.withLock(workspaceRoot, effect);

  const failed = (operation: string) => (cause: unknown) =>
    new FileVersionStorageError({ operation, cause });

  const workspaceDirectory = (workspaceRoot: string) =>
    path.join(
      storeDirectory,
      NodeCrypto.createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 32),
    );
  const blobPath = (workspaceRoot: string, hash: string) =>
    path.join(workspaceDirectory(workspaceRoot), hash.slice(0, 2), hash);

  const columns = sql`
    version_id AS "versionId",
    relative_path AS "relativePath",
    state,
    content_hash AS "contentHash",
    byte_length AS "byteLength",
    mtime_ms AS "mtimeMs",
    change,
    origin,
    thread_id AS "threadId",
    turn_count AS "turnCount",
    action,
    created_at AS "createdAt"
  `;

  const list = (workspaceRoot: string, relativePath: string) =>
    sql<FileVersionRow>`
      SELECT ${columns} FROM file_versions
      WHERE workspace_root = ${workspaceRoot} AND relative_path = ${relativePath}
      ORDER BY version_id DESC
    `.pipe(Effect.mapError(failed("list versions")));

  const head = (workspaceRoot: string, relativePath: string) =>
    sql<FileVersionRow>`
      SELECT ${columns} FROM file_versions
      WHERE workspace_root = ${workspaceRoot} AND relative_path = ${relativePath}
      ORDER BY version_id DESC LIMIT 1
    `.pipe(
      Effect.map((rows) => rows[0] ?? null),
      Effect.mapError(failed("read the latest version")),
    );

  const heads = (workspaceRoot: string) =>
    sql<FileVersionRow>`
      SELECT ${columns} FROM file_versions
      WHERE version_id IN (
        SELECT MAX(version_id) FROM file_versions
        WHERE workspace_root = ${workspaceRoot}
        GROUP BY relative_path
      )
    `.pipe(
      Effect.map((rows) => new Map(rows.map((row) => [row.relativePath, row]))),
      Effect.mapError(failed("read the latest versions")),
    );

  const get = (workspaceRoot: string, versionId: number) =>
    sql<FileVersionRow>`
      SELECT ${columns} FROM file_versions
      WHERE workspace_root = ${workspaceRoot} AND version_id = ${versionId}
    `.pipe(
      Effect.map((rows) => rows[0] ?? null),
      Effect.mapError(failed("read a version")),
    );

  const previous = (workspaceRoot: string, row: FileVersionRow) =>
    sql<FileVersionRow>`
      SELECT ${columns} FROM file_versions
      WHERE workspace_root = ${workspaceRoot} AND relative_path = ${row.relativePath}
        AND version_id < ${row.versionId}
      ORDER BY version_id DESC LIMIT 1
    `.pipe(
      Effect.map((rows) => rows[0] ?? null),
      Effect.mapError(failed("read the earlier version")),
    );

  const turnRows = (
    workspaceRoot: string,
    turn: { readonly threadId: string; readonly turnCount: number },
  ) =>
    sql<FileVersionRow>`
      SELECT ${columns} FROM file_versions
      WHERE thread_id = ${turn.threadId} AND turn_count = ${turn.turnCount}
        AND workspace_root = ${workspaceRoot} AND origin = 'agent'
      ORDER BY version_id
    `.pipe(Effect.mapError(failed("read a turn's versions")));

  const recent = (
    workspaceRoot: string,
    input: {
      readonly since: string | null;
      readonly threadId: string | null;
      readonly limit: number;
    },
  ) =>
    sql<FileVersionRow>`
      SELECT ${columns} FROM file_versions
      WHERE workspace_root = ${workspaceRoot} AND created_at >= ${input.since ?? ""}
        AND (
          ${input.threadId} IS NULL
          OR origin IN ('user', 'restore')
          OR (origin = 'agent' AND thread_id = ${input.threadId} AND turn_count IS NOT NULL)
        )
      ORDER BY version_id DESC LIMIT ${input.limit}
    `.pipe(Effect.mapError(failed("read the workspace's recent versions")));

  const isReferenced = (workspaceRoot: string, hash: string) =>
    sql`
      SELECT 1 FROM file_versions
      WHERE workspace_root = ${workspaceRoot} AND content_hash = ${hash} LIMIT 1
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(failed("look up stored contents")),
    );

  const totalBytes = Effect.fn("FileVersionStorage.totalBytes")(function* (workspaceRoot: string) {
    const known = totals.get(workspaceRoot);
    if (known !== undefined) return known;
    const rows = yield* sql<{ readonly total: number }>`
      SELECT COALESCE(SUM(byte_length), 0) AS total FROM (
        SELECT MAX(byte_length) AS byte_length FROM file_versions
        WHERE workspace_root = ${workspaceRoot} AND content_hash IS NOT NULL
        GROUP BY content_hash
      )
    `.pipe(Effect.mapError(failed("measure the workspace")));
    const total = Number(rows[0]?.total ?? 0);
    totals.set(workspaceRoot, total);
    return total;
  });

  /** Drops contents no remaining row names. */
  const releaseContents = Effect.fn("FileVersionStorage.releaseContents")(function* (
    workspaceRoot: string,
    released: ReadonlyArray<Pick<FileVersionRow, "contentHash" | "byteLength">>,
  ) {
    const seen = new Set<string>();
    for (const row of released) {
      const hash = row.contentHash;
      if (hash === null || seen.has(hash)) continue;
      seen.add(hash);
      if (yield* isReferenced(workspaceRoot, hash)) continue;
      yield* Effect.promise(() => NodeFSP.rm(blobPath(workspaceRoot, hash), { force: true }));
      totals.set(workspaceRoot, Math.max(0, (yield* totalBytes(workspaceRoot)) - row.byteLength));
    }
  });

  const deleteRows = Effect.fn("FileVersionStorage.deleteRows")(function* (
    workspaceRoot: string,
    rows: ReadonlyArray<FileVersionRow>,
  ) {
    if (rows.length === 0) return;
    yield* sql`
      DELETE FROM file_versions
      WHERE ${sql.in(
        "version_id",
        rows.map((row) => row.versionId),
      )}
    `.pipe(Effect.mapError(failed("prune versions")));
    yield* releaseContents(workspaceRoot, rows);
  });

  /** Prunes the oldest versions that are not a file's latest until `needed` more bytes fit. */
  const makeRoom = Effect.fn("FileVersionStorage.makeRoom")(function* (
    workspaceRoot: string,
    needed: number,
  ) {
    for (;;) {
      if ((yield* totalBytes(workspaceRoot)) + needed <= limits.maxWorkspaceBytes) return true;
      const oldest = yield* sql<FileVersionRow>`
        SELECT ${columns} FROM file_versions AS version
        WHERE workspace_root = ${workspaceRoot} AND content_hash IS NOT NULL
          AND version_id < (
            SELECT MAX(version_id) FROM file_versions AS latest
            WHERE latest.workspace_root = version.workspace_root
              AND latest.relative_path = version.relative_path
          )
        ORDER BY version_id LIMIT 50
      `.pipe(Effect.mapError(failed("find versions to prune")));
      if (oldest.length === 0) return false;
      for (const row of oldest) {
        yield* deleteRows(workspaceRoot, [row]);
        if ((yield* totalBytes(workspaceRoot)) + needed <= limits.maxWorkspaceBytes) return true;
      }
    }
  });

  /** Keeps the bytes under their hash. False when the workspace has no room left for them. */
  const storeContents = Effect.fn("FileVersionStorage.storeContents")(function* (
    workspaceRoot: string,
    hash: string,
    bytes: Uint8Array,
  ) {
    if (yield* isReferenced(workspaceRoot, hash)) return true;
    if (!(yield* makeRoom(workspaceRoot, bytes.byteLength))) return false;
    const target = blobPath(workspaceRoot, hash);
    yield* Effect.tryPromise({
      try: async () => {
        await NodeFSP.mkdir(path.dirname(target), { recursive: true });
        // A reader never sees a half-written file under a hash.
        const temporary = `${target}.${NodeCrypto.randomUUID()}.tmp`;
        await NodeFSP.writeFile(temporary, bytes);
        await NodeFSP.rename(temporary, target);
      },
      catch: failed("store contents"),
    });
    totals.set(workspaceRoot, (yield* totalBytes(workspaceRoot)) + bytes.byteLength);
    return true;
  });

  const pruneFile = Effect.fn("FileVersionStorage.pruneFile")(function* (
    workspaceRoot: string,
    relativePath: string,
  ) {
    const surplus = yield* sql<FileVersionRow>`
      SELECT ${columns} FROM file_versions
      WHERE workspace_root = ${workspaceRoot} AND relative_path = ${relativePath}
      ORDER BY version_id DESC LIMIT -1 OFFSET ${limits.maxVersionsPerFile}
    `.pipe(Effect.mapError(failed("find versions to prune")));
    yield* deleteRows(workspaceRoot, surplus);
  });

  const resolveContent = Effect.fn("FileVersionStorage.resolveContent")(function* (
    workspaceRoot: string,
    content: FileVersionContent,
  ) {
    if (content.kind === "absent") {
      return { state: "deleted", contentHash: null, byteLength: 0 } as const;
    }
    if (content.kind === "too-large" || content.bytes.byteLength > limits.maxFileBytes) {
      const byteLength = content.kind === "too-large" ? content.byteLength : content.bytes.length;
      return { state: "skipped", contentHash: null, byteLength } as const;
    }
    const hash = contentHash(content.bytes);
    const byteLength = content.bytes.byteLength;
    return (yield* storeContents(workspaceRoot, hash, content.bytes))
      ? ({ state: "stored", contentHash: hash, byteLength } as const)
      : ({ state: "skipped", contentHash: null, byteLength } as const);
  });

  const append = Effect.fn("FileVersionStorage.append")(function* (
    workspaceRoot: string,
    input: AppendFileVersionInput,
    replaced: FileVersionRow | null,
  ) {
    const content = yield* resolveContent(workspaceRoot, input.content);
    const change =
      content.state === "deleted"
        ? "deleted"
        : replaced === null || replaced.state === "deleted"
          ? "created"
          : "modified";
    yield* sql`
      INSERT INTO file_versions (
        workspace_root, relative_path, state, content_hash, byte_length, mtime_ms, change,
        origin, thread_id, turn_count, action, created_at
      ) VALUES (
        ${workspaceRoot}, ${input.relativePath}, ${content.state}, ${content.contentHash},
        ${content.byteLength}, ${input.mtimeMs}, ${change}, ${input.origin},
        ${input.threadId ?? null}, ${input.turnCount ?? null}, ${input.action ?? null},
        ${input.createdAt}
      )
    `.pipe(Effect.mapError(failed("record a version")));
    if (replaced !== null) yield* pruneFile(workspaceRoot, input.relativePath);
  });

  const replaceContent = Effect.fn("FileVersionStorage.replaceContent")(function* (
    workspaceRoot: string,
    row: FileVersionRow,
    bytes: Uint8Array,
  ) {
    const content = yield* resolveContent(workspaceRoot, { kind: "bytes", bytes });
    yield* sql`
      UPDATE file_versions
      SET state = ${content.state}, content_hash = ${content.contentHash},
        byte_length = ${content.byteLength}, mtime_ms = NULL
      WHERE version_id = ${row.versionId}
    `.pipe(Effect.mapError(failed("update a version")));
    yield* releaseContents(workspaceRoot, [row]);
  });

  const touch = (row: FileVersionRow, mtimeMs: number) =>
    sql`UPDATE file_versions SET mtime_ms = ${mtimeMs} WHERE version_id = ${row.versionId}`.pipe(
      Effect.mapError(failed("update a version")),
      Effect.asVoid,
    );

  const readContents = (workspaceRoot: string, hash: string) =>
    Effect.tryPromise({
      try: () =>
        NodeFSP.readFile(blobPath(workspaceRoot, hash)).catch((cause: NodeJS.ErrnoException) => {
          if (cause.code === "ENOENT") return null;
          throw cause;
        }),
      catch: failed("read stored contents"),
    });

  const deleteWorkspace = Effect.fn("FileVersionStorage.deleteWorkspace")(function* (
    workspaceRoot: string,
  ) {
    yield* sql`DELETE FROM file_versions WHERE workspace_root = ${workspaceRoot}`.pipe(
      Effect.mapError(failed("delete a workspace's versions")),
    );
    totals.delete(workspaceRoot);
    yield* Effect.tryPromise({
      try: () => NodeFSP.rm(workspaceDirectory(workspaceRoot), { recursive: true, force: true }),
      catch: failed("delete a workspace's versions"),
    });
  });

  const whole = <A, E, R>(workspaceRoot: string, effect: Effect.Effect<A, E, R>) =>
    withWalkLock(workspaceRoot, withWriteLock(workspaceRoot, effect));

  const forgetWorkspace = (workspaceRoot: string) =>
    whole(workspaceRoot, deleteWorkspace(workspaceRoot));

  const moveWorkspace = Effect.fn("FileVersionStorage.moveWorkspace")(function* (
    from: string,
    to: string,
  ) {
    if (from === to) return;
    const [first, second] = from < to ? [from, to] : [to, from];
    yield* whole(
      first,
      whole(
        second,
        Effect.gen(function* () {
          if ((yield* heads(to)).size > 0) return yield* deleteWorkspace(from);
          yield* deleteWorkspace(to);
          yield* sql`UPDATE file_versions SET workspace_root = ${to} WHERE workspace_root = ${from}`.pipe(
            Effect.mapError(failed("move a workspace's versions")),
          );
          totals.delete(from);
          yield* Effect.tryPromise({
            try: async () => {
              await NodeFSP.mkdir(storeDirectory, { recursive: true });
              await NodeFSP.rename(workspaceDirectory(from), workspaceDirectory(to)).catch(
                (cause: NodeJS.ErrnoException) => {
                  if (cause.code !== "ENOENT") throw cause;
                },
              );
            },
            catch: failed("move a workspace's versions"),
          });
        }),
      ),
    );
  });

  return FileVersionStorage.of({
    limits,
    storeDirectory,
    withWalkLock,
    withWriteLock,
    forgetWorkspace,
    moveWorkspace,
    list,
    head,
    heads,
    get,
    previous,
    turnRows,
    recent,
    append,
    replaceContent,
    touch,
    readContents,
    deleteWorkspace,
  });
});

export const layer = Layer.effect(FileVersionStorage, make);
