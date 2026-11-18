// @effect-diagnostics nodeBuiltinImport:off - node:sqlite copies the live database off the main
// thread, and archives stream files through Node streams with backpressure.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { BackupContents, BackupError, type BackupFileInfo, BackupKind } from "@codenine/contracts";
import * as HostProcess from "@codenine/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";
import { isWithinRoot } from "../workspace/KnownWorkspaces.ts";
import {
  BACKUP_FILE_EXTENSION,
  backupWriteError,
  DEFAULT_SCRYPT,
  type OpenedBackupFile,
  readBackupHeader,
  readBackupPayload,
  type ScryptParams,
  unlockBackup,
  writeBackupFile,
} from "./BackupFile.ts";
import {
  encodeTarHeader,
  TAR_END_BLOCKS,
  type TarEntry,
  TarFormatError,
  TarParser,
  tarPadding,
} from "./tar.ts";

/** The scrypt cost new backups use; tests lower it. */
export const BackupScrypt = Context.Reference<ScryptParams>("codenine/backup/BackupScrypt", {
  defaultValue: () => DEFAULT_SCRYPT,
});

export const BACKUP_STATE_FILE = "backup-state.json";
export const RESTORE_REPORT_FILE = "restore-report.json";
const MANIFEST_NAME = "manifest.json";
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;
const MANIFEST_FORMAT = 1;

export const BackupManifest = Schema.Struct({
  format: Schema.Literal(MANIFEST_FORMAT),
  createdAt: Schema.String,
  kind: BackupKind,
  codenineVersion: Schema.String,
  schemaVersion: Schema.Int,
  computerName: Schema.String,
  environmentId: Schema.String,
  platform: Schema.String,
  codenineHome: Schema.String,
  stateDirectory: Schema.String,
  homeDirectory: Schema.String,
  includeWorktrees: Schema.Boolean,
  contents: BackupContents,
  /** Bytes of files in the archive, before compression; what unpacking needs on disk. */
  contentBytes: Schema.Number,
  /** Git remotes of workspaces, so a restore can say where to clone one from again. */
  workspaceRemotes: Schema.Array(
    Schema.Struct({ projectId: Schema.String, remoteUrl: Schema.String }),
  ),
});
export type BackupManifest = typeof BackupManifest.Type;

const BackupManifestJson = Schema.fromJsonString(BackupManifest);
const decodeManifest = Schema.decodeOption(BackupManifestJson);
const encodeManifest = Schema.encodeEffect(BackupManifestJson);
const isBackupError = Schema.is(BackupError);
const isTarFormatError = Schema.is(TarFormatError);
const decodeManifestFormat = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ format: Schema.Number })),
);

export interface BackupPaths {
  readonly baseDir: string;
  readonly stateDir: string;
  readonly dbPath: string;
  readonly worktreesDir: string;
}

const unreadable = (detail: string) => new BackupError({ reason: "unreadable", detail });
const DAMAGED = "This backup is damaged or incomplete.";

// Runtime state, caches and logs stay on their computer; the database comes from a snapshot.
const STATE_EXCLUDED_NAMES = new Set([
  "logs",
  // Only managed Codex shadow homes, which Codenine rebuilds.
  "providers",
  "server-runtime.json",
  "model-manifest.json",
  "compacted-at",
  "reclaim-requested",
  "reclaim-failed",
  BACKUP_STATE_FILE,
  RESTORE_REPORT_FILE,
]);
const STATE_EXCLUDED_PATTERN =
  /^(?:server-owner\.sqlite|statev2\.sqlite|state\.sqlite|\.v2-import-|\.environment-id-)|^usage-.*\.json$/;

/** Whether a top-level entry of the state directory is backed up, and so replaced by a restore. */
export const isBackedUpStateEntry = (name: string) =>
  !STATE_EXCLUDED_NAMES.has(name) && !STATE_EXCLUDED_PATTERN.test(name);

const isBackedUpStatePath = (relative: string) => {
  const segments = relative.split("/");
  if (!isBackedUpStateEntry(segments[0] ?? "")) return false;
  // The secret store's in-flight writes and credential locks.
  return !(segments[0] === "secrets" && /\.(?:tmp|lock)$/.test(segments.at(-1) ?? ""));
};

export type ArchiveRootName =
  | "userdata"
  | "accounts"
  | "skills"
  | "agents"
  | "workflows"
  | "workspaces"
  | "scratch"
  | "projects"
  | "worktrees";

const ARCHIVE_ROOT_NAMES: ReadonlySet<string> = new Set<ArchiveRootName>([
  "userdata",
  "accounts",
  "skills",
  "agents",
  "workflows",
  "workspaces",
  "scratch",
  "projects",
  "worktrees",
]);

interface ArchiveRoot {
  readonly name: ArchiveRootName;
  readonly diskPath: string;
  readonly gitAware: boolean;
  readonly include?: (relative: string) => boolean;
}

/** Where each archive root lives in a Codenine home. `scratch` and `projects` are older layouts. */
export const archiveRoots = (
  paths: BackupPaths,
  includeWorktrees: boolean,
): ReadonlyArray<ArchiveRoot> => [
  { name: "userdata", diskPath: paths.stateDir, gitAware: false, include: isBackedUpStatePath },
  { name: "accounts", diskPath: NodePath.join(paths.baseDir, "accounts"), gitAware: true },
  { name: "skills", diskPath: NodePath.join(paths.baseDir, "skills"), gitAware: true },
  { name: "agents", diskPath: NodePath.join(paths.baseDir, "agents"), gitAware: true },
  { name: "workflows", diskPath: NodePath.join(paths.baseDir, "workflows"), gitAware: true },
  { name: "workspaces", diskPath: NodePath.join(paths.baseDir, "workspaces"), gitAware: true },
  { name: "scratch", diskPath: NodePath.join(paths.baseDir, "scratch"), gitAware: true },
  { name: "projects", diskPath: NodePath.join(paths.baseDir, "projects"), gitAware: true },
  ...(includeWorktrees
    ? [{ name: "worktrees" as const, diskPath: paths.worktreesDir, gitAware: true }]
    : []),
];

export interface ArchiveEntry extends TarEntry {
  readonly diskPath: string;
}

const joinRelative = (parent: string, name: string) => (parent === "" ? name : `${parent}/${name}`);

/**
 * Lists what a backup holds. In a Git repository that is the files Git tracks or would track,
 * which leaves out ignored build output and dependencies, plus the whole `.git` directory.
 * Symlinks into the archive become relative; symlinks out of it are left out.
 */
export const collectArchiveEntries = Effect.fn("BackupArchive.collectEntries")(function* (
  roots: ReadonlyArray<ArchiveRoot>,
  /** Real paths to leave out, such as a backup folder inside the Codenine home. */
  skip: ReadonlyArray<string> = [],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const entries: Array<ArchiveEntry> = [];
  let unreadableCount = 0;

  const present: Array<{ readonly root: ArchiveRoot; readonly real: string }> = [];
  for (const root of roots) {
    const real = yield* fs.realPath(root.diskPath).pipe(Effect.option);
    if (Option.isSome(real)) present.push({ root, real: real.value });
  }
  const archivePathOf = (absolute: string): string | null => {
    for (const { root, real } of present) {
      for (const base of [real, root.diskPath]) {
        if (!isWithinRoot(path, absolute, base)) continue;
        const relative = path.relative(base, absolute).split(path.sep).join("/");
        return relative === "" ? root.name : `${root.name}/${relative}`;
      }
    }
    return null;
  };

  // Untraced: one call per file in the home, under the collect span.
  const addPath: (
    disk: string,
    relative: string,
    root: ArchiveRoot,
  ) => Effect.Effect<void, never, never> = Effect.fnUntraced(function* (disk, relative, root) {
    if (relative !== "" && root.include !== undefined && !root.include(relative)) return;
    if (skip.includes(disk)) return;
    const archivePath = joinRelative(root.name, relative);
    const info = yield* fs.lstat(disk).pipe(
      Effect.asSome,
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
      Effect.catch(() => {
        unreadableCount += 1;
        return Effect.succeedNone;
      }),
    );
    if (Option.isNone(info)) return;
    const mtimeMs = Option.getOrUndefined(info.value.mtime)?.getTime() ?? 0;
    const mode = info.value.mode & 0o7777;
    if (info.value.type === "Directory") {
      entries.push({
        path: archivePath,
        diskPath: disk,
        type: "directory",
        size: 0,
        mode,
        mtimeMs,
      });
      return yield* walkDirectory(disk, relative, root);
    }
    if (info.value.type === "File") {
      entries.push({
        path: archivePath,
        diskPath: disk,
        type: "file",
        size: Number(info.value.size),
        mode,
        mtimeMs,
      });
      return;
    }
    if (info.value.type !== "SymbolicLink") return;
    const target = yield* fs.readLink(disk).pipe(Effect.option);
    if (Option.isNone(target)) return;
    const mapped = archivePathOf(path.resolve(path.dirname(disk), target.value));
    if (mapped === null) return;
    entries.push({
      path: archivePath,
      diskPath: disk,
      type: "symlink",
      size: 0,
      mode: 0o777,
      mtimeMs,
      linkTarget: NodePath.posix.relative(NodePath.posix.dirname(archivePath), mapped) || ".",
    });
  });

  const walkDirectory: (
    disk: string,
    relative: string,
    root: ArchiveRoot,
  ) => Effect.Effect<void, never, never> = Effect.fnUntraced(function* (disk, relative, root) {
    if (
      root.gitAware &&
      (yield* fs.exists(path.join(disk, ".git")).pipe(Effect.orElseSucceed(() => false)))
    ) {
      return yield* addRepository(disk, relative, root);
    }
    const names = yield* fs.readDirectory(disk).pipe(
      Effect.catch(() => {
        unreadableCount += 1;
        return Effect.succeed([] as ReadonlyArray<string>);
      }),
    );
    for (const name of [...names].sort()) {
      yield* addPath(path.join(disk, name), joinRelative(relative, name), root);
    }
  });

  const addRepository: (
    repository: string,
    relative: string,
    root: ArchiveRoot,
  ) => Effect.Effect<void, never, never> = Effect.fnUntraced(
    function* (repository, relative, root) {
      const listed = yield* runner
        .run({
          command: "git",
          args: [
            "--no-optional-locks",
            "-c",
            "core.quotePath=false",
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
          ],
          cwd: repository,
          timeout: "10 minutes",
          maxOutputBytes: 512 * 1024 * 1024,
        })
        .pipe(Effect.option);
      const everything = { ...root, gitAware: false };
      if (Option.isNone(listed) || listed.value.code !== 0) {
        yield* Effect.logWarning("Could not list a Git repository's files; backing up all of it.", {
          repository,
        });
        const names = yield* fs.readDirectory(repository).pipe(Effect.orElseSucceed(() => []));
        for (const name of [...names].sort()) {
          yield* addPath(path.join(repository, name), joinRelative(relative, name), everything);
        }
        return;
      }
      yield* addPath(path.join(repository, ".git"), joinRelative(relative, ".git"), everything);
      const listedPaths = new Set(
        listed.value.stdout
          .split("\0")
          .map((entry) => entry.replace(/\/+$/, ""))
          .filter((entry) => entry.length > 0 && entry !== ".git" && !entry.startsWith(".git/")),
      );
      // A listed directory is a submodule or a nested repository; the walk handles it.
      for (const listedPath of [...listedPaths].sort()) {
        yield* addPath(
          path.join(repository, ...listedPath.split("/")),
          joinRelative(relative, listedPath),
          root,
        );
      }
    },
  );

  for (const { root, real } of present) yield* addPath(real, "", root);
  if (unreadableCount > 0) {
    yield* Effect.logWarning("Some files could not be read and were left out of the backup.", {
      count: unreadableCount,
    });
  }
  return entries;
});

interface DatabaseSummary {
  readonly schemaVersion: number;
  readonly workspaces: number;
  readonly chats: number;
  readonly projects: ReadonlyArray<{ readonly projectId: string; readonly workspaceRoot: string }>;
}

const countRows = (database: NodeSqlite.DatabaseSync, sql: string) => {
  try {
    return Number(
      (database.prepare(sql).get() as { readonly count?: unknown } | undefined)?.count ?? 0,
    );
  } catch {
    return 0;
  }
};

const summarizeDatabase = (database: NodeSqlite.DatabaseSync): DatabaseSummary => {
  let projects: DatabaseSummary["projects"] = [];
  try {
    projects = database
      .prepare(
        "SELECT project_id, workspace_root FROM projection_projects WHERE deleted_at IS NULL",
      )
      .all()
      .map((row) => ({
        projectId: String(row.project_id),
        workspaceRoot: String(row.workspace_root),
      }));
  } catch {
    // A database too old to have projects has nothing to report.
  }
  return {
    schemaVersion: countRows(
      database,
      "SELECT MAX(migration_id) AS count FROM effect_sql_migrations",
    ),
    workspaces: projects.length,
    chats: countRows(
      database,
      "SELECT COUNT(*) AS count FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL",
    ),
    projects,
  };
};

// One backup step copies a consistent snapshot on a worker thread; WAL readers never block the
// server's writes, and a stepped copy would restart whenever the server wrote between steps.
const snapshotDatabase = (databasePath: string, snapshotPath: string) =>
  Effect.tryPromise({
    try: async () => {
      const source = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
      try {
        await NodeSqlite.backup(source, snapshotPath, { rate: -1 });
      } finally {
        source.close();
      }
      const snapshot = new NodeSqlite.DatabaseSync(snapshotPath);
      try {
        // A self-contained file with no WAL beside it; the server turns WAL back on when it opens it.
        snapshot.exec("PRAGMA journal_mode = DELETE");
        return summarizeDatabase(snapshot);
      } finally {
        snapshot.close();
      }
    },
    catch: (cause) =>
      backupWriteError(cause).reason === "not-enough-space"
        ? backupWriteError(cause)
        : new BackupError({ reason: "failed", detail: "The database could not be copied." }),
  });

/** The first remote in a repository's config, preferring origin, without credentials. */
export const remoteUrlFromGitConfig = (config: string): string | null => {
  const remotes = new Map<string, string>();
  let remote: string | null = null;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    const section = /^\[\s*remote\s+"([^"]+)"\s*\]$/.exec(line);
    if (section !== null) {
      remote = section[1] ?? null;
      continue;
    }
    if (line.startsWith("[")) {
      remote = null;
      continue;
    }
    const url = /^url\s*=\s*(.+)$/.exec(line);
    if (remote !== null && url?.[1] !== undefined && !remotes.has(remote)) {
      remotes.set(remote, url[1].trim());
    }
  }
  const value = remotes.get("origin") ?? remotes.values().next().value;
  if (value === undefined) return null;
  return value.replace(/^(https?:\/\/)[^@/]+@/i, "$1");
};

const countContents = (
  entries: ReadonlyArray<ArchiveEntry>,
  summary: DatabaseSummary,
): BackupContents => {
  const accounts = new Set<string>();
  let skills = 0;
  let savedKeys = 0;
  for (const entry of entries) {
    const [top, second, third, fourth] = entry.path.split("/");
    const depth = entry.path.split("/").length;
    if (
      top === "accounts" &&
      depth === 3 &&
      entry.type === "directory" &&
      !third?.startsWith(".") &&
      !(second === "codex" && third === "shared")
    ) {
      accounts.add(entry.path);
    }
    if (top === "skills" && depth === 3 && third === "SKILL.md") skills += 1;
    if (top === "userdata" && second === "secrets" && entry.type === "file") {
      // Keys saved in settings, and keys pasted into a chat.
      if (depth === 3 && SAVED_KEY_PATTERN.test(third ?? "")) savedKeys += 1;
      if (depth === 4 && third === "files" && fourth !== undefined) savedKeys += 1;
    }
  }
  return {
    workspaces: summary.workspaces,
    chats: summary.chats,
    accounts: accounts.size,
    savedKeys,
    skills,
  };
};

const SAVED_KEY_PATTERN =
  /^(?:provider-config|provider-env|source-control|usage-limit-source|text-generator)-.+\.bin$/;

/** Who made a backup, without revealing the environment id that names its cookies and links. */
export const computerIdOf = (environmentId: string) =>
  NodeCrypto.createHash("sha256")
    .update(`codenine-backup-computer\0${environmentId}`)
    .digest("hex")
    .slice(0, 16);

const backupFileName = (createdAtMs: number, computerName: string, kind: BackupKind) => {
  const parts = DateTime.toParts(
    DateTime.makeZonedUnsafe(createdAtMs, { timeZone: DateTime.zoneMakeLocal() }),
  );
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}${pad(parts.minute)}${pad(parts.second)}`;
  const computer =
    computerName
      .replace(/[^A-Za-z0-9 _-]/g, "")
      .trim()
      .slice(0, 40) || "computer";
  const suffix = kind === "manual" ? " manual" : kind === "before-restore" ? " before restore" : "";
  return `Codenine ${computer} ${stamp}${suffix}`;
};

export const backupFileInfo = (file: OpenedBackupFile): BackupFileInfo => ({
  path: file.path,
  fileName: NodePath.basename(file.path),
  createdAt: file.header.createdAt,
  computerName: file.header.computerName,
  codenineVersion: file.header.codenineVersion,
  kind: file.header.kind,
  sizeBytes: file.sizeBytes,
});

async function* archiveStream(input: {
  readonly entries: ReadonlyArray<ArchiveEntry>;
  readonly manifest: Uint8Array;
  readonly createdAtMs: number;
  readonly onBytes: (bytes: number) => void;
}): AsyncGenerator<Uint8Array> {
  yield encodeTarHeader({
    path: MANIFEST_NAME,
    type: "file",
    size: input.manifest.length,
    mode: 0o600,
    mtimeMs: input.createdAtMs,
  });
  yield input.manifest;
  yield tarPadding(input.manifest.length);
  for (const entry of input.entries) {
    if (entry.type !== "file") {
      yield encodeTarHeader(entry);
      continue;
    }
    let size: number;
    try {
      const info = await NodeFSP.lstat(entry.diskPath);
      if (!info.isFile()) continue;
      size = info.size;
    } catch {
      continue;
    }
    yield encodeTarHeader({ ...entry, size });
    let written = 0;
    if (size > 0) {
      try {
        const reader = NodeFS.createReadStream(entry.diskPath, {
          end: size - 1,
          highWaterMark: READ_CHUNK_BYTES,
        });
        for await (const chunk of reader) {
          const bytes = chunk as Buffer;
          written += bytes.length;
          input.onBytes(bytes.length);
          yield bytes;
        }
      } catch {
        // A file that shrinks or vanishes mid-read is padded below: its header is already out.
      }
      while (written < size) {
        const fill = Math.min(size - written, READ_CHUNK_BYTES);
        written += fill;
        input.onBytes(fill);
        yield new Uint8Array(fill);
      }
    }
    yield tarPadding(size);
  }
  yield TAR_END_BLOCKS;
}

const freeBytes = (directory: string) =>
  Effect.tryPromise({
    try: () => NodeFSP.statfs(directory),
    catch: () =>
      new BackupError({
        reason: "folder-unavailable",
        detail: "Codenine cannot reach the backup folder.",
      }),
  }).pipe(Effect.map((stats) => stats.bavail * stats.bsize));

const formatGigabytes = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

/** Refuses up front when `directory` cannot hold `neededBytes`. */
export const ensureFreeSpace = Effect.fn("BackupArchive.ensureFreeSpace")(function* (
  directory: string,
  neededBytes: number,
  purpose: string,
) {
  const free = yield* freeBytes(directory);
  if (free < neededBytes) {
    return yield* new BackupError({
      reason: "not-enough-space",
      detail: `${purpose} needs about ${formatGigabytes(neededBytes)} of free space; ${formatGigabytes(free)} is free.`,
    });
  }
});

export interface CreateBackupInput {
  readonly paths: BackupPaths;
  readonly folder: string;
  readonly password: string;
  readonly kind: BackupKind;
  readonly includeWorktrees: boolean;
  readonly computerName: string;
  readonly environmentId: string;
  readonly codenineVersion: string;
  /** Called with the fraction of file bytes written so far. */
  readonly onProgress?: ((fraction: number) => void) | undefined;
}

/** Writes one encrypted backup of the Codenine home into `folder`. */
export const createBackup = Effect.fn("BackupArchive.create")(function* (input: CreateBackupInput) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const platform = yield* HostProcess.Platform;
  const scrypt = yield* BackupScrypt;
  const createdAtMs = yield* Clock.currentTimeMillis;
  const folderUnavailable = new BackupError({
    reason: "folder-unavailable",
    detail: "Codenine cannot write to the backup folder.",
  });
  const exists = (target: string) => fs.exists(target).pipe(Effect.orElseSucceed(() => false));
  if (!path.isAbsolute(input.folder)) return yield* folderUnavailable;
  // Only the folder itself is created: a missing parent is usually a drive that is not
  // connected, and backups must not land on the disk underneath its mount point.
  if (!(yield* exists(input.folder))) {
    if (!(yield* exists(path.dirname(input.folder)))) {
      return yield* new BackupError({
        reason: "folder-unavailable",
        detail: "The backup folder is not available. Check that its drive is connected.",
      });
    }
    yield* fs.makeDirectory(input.folder).pipe(Effect.mapError(() => folderUnavailable));
  }
  if (!(yield* fs.exists(input.paths.dbPath).pipe(Effect.orElseSucceed(() => false)))) {
    return yield* new BackupError({
      reason: "failed",
      detail: "There is no Codenine data to back up yet.",
    });
  }

  const cachesDir = path.join(input.paths.baseDir, "caches");
  const workDir = yield* fs.makeDirectory(cachesDir, { recursive: true }).pipe(
    Effect.andThen(fs.makeTempDirectoryScoped({ directory: cachesDir, prefix: "backup-" })),
    Effect.mapError(
      () =>
        new BackupError({ reason: "failed", detail: "Codenine cannot write to its own folder." }),
    ),
  );
  const snapshotPath = path.join(workDir, path.basename(input.paths.dbPath));
  const summary = yield* snapshotDatabase(input.paths.dbPath, snapshotPath);
  const snapshotSize = Number((yield* fs.stat(snapshotPath).pipe(Effect.orDie)).size);
  const entries: ReadonlyArray<ArchiveEntry> = [
    {
      path: `userdata/${path.basename(input.paths.dbPath)}`,
      diskPath: snapshotPath,
      type: "file",
      size: snapshotSize,
      mode: 0o600,
      mtimeMs: createdAtMs,
    },
    // A backup folder inside the home must not back up earlier backups.
    ...(yield* collectArchiveEntries(archiveRoots(input.paths, input.includeWorktrees), [
      yield* fs.realPath(input.folder).pipe(Effect.orElseSucceed(() => input.folder)),
    ])),
  ];
  const contentBytes = entries.reduce((total, entry) => total + entry.size, 0);
  yield* ensureFreeSpace(input.folder, contentBytes, "This backup");

  const workspaceRemotes: Array<{ projectId: string; remoteUrl: string }> = [];
  for (const project of summary.projects) {
    const config = yield* fs
      .readFileString(path.join(project.workspaceRoot, ".git", "config"))
      .pipe(Effect.option);
    const remoteUrl = Option.isSome(config) ? remoteUrlFromGitConfig(config.value) : null;
    if (remoteUrl !== null) workspaceRemotes.push({ projectId: project.projectId, remoteUrl });
  }
  const createdAt = DateTime.formatIso(DateTime.makeUnsafe(createdAtMs));
  const manifest: BackupManifest = {
    format: MANIFEST_FORMAT,
    createdAt,
    kind: input.kind,
    codenineVersion: input.codenineVersion,
    schemaVersion: summary.schemaVersion,
    computerName: input.computerName,
    environmentId: input.environmentId,
    platform,
    codenineHome: input.paths.baseDir,
    stateDirectory: input.paths.stateDir,
    homeDirectory,
    includeWorktrees: input.includeWorktrees,
    contents: countContents(entries, summary),
    contentBytes,
    workspaceRemotes,
  };

  const baseName = backupFileName(createdAtMs, input.computerName, input.kind);
  let filePath = path.join(input.folder, `${baseName}${BACKUP_FILE_EXTENSION}`);
  for (
    let attempt = 2;
    yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false));
    attempt++
  ) {
    filePath = path.join(input.folder, `${baseName} ${attempt}${BACKUP_FILE_EXTENSION}`);
  }
  const manifestBytes = new TextEncoder().encode(
    yield* encodeManifest(manifest).pipe(Effect.orDie),
  );
  let streamedBytes = 0;
  const written = yield* Effect.tryPromise({
    try: (signal) =>
      writeBackupFile({
        filePath,
        identity: {
          createdAt,
          kind: input.kind,
          computerName: input.computerName,
          computerId: computerIdOf(input.environmentId),
          codenineVersion: input.codenineVersion,
          schemaVersion: summary.schemaVersion,
        },
        password: input.password,
        source: archiveStream({
          entries,
          manifest: manifestBytes,
          createdAtMs,
          onBytes: (bytes) => {
            streamedBytes += bytes;
            input.onProgress?.(contentBytes === 0 ? 1 : Math.min(1, streamedBytes / contentBytes));
          },
        }),
        scrypt,
        signal,
      }),
    catch: backupWriteError,
  });
  return { file: backupFileInfo(written), manifest };
}, Effect.scoped);

const toReadError = (cause: unknown): BackupError => {
  if (isBackupError(cause)) return cause;
  if (isTarFormatError(cause)) return unreadable(DAMAGED);
  const code =
    typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : "";
  if (code === "ENOSPC" || code === "EDQUOT") {
    return new BackupError({
      reason: "not-enough-space",
      detail: "There is not enough free space to unpack this backup.",
    });
  }
  // zlib reports a corrupt stream with Z_* codes.
  if (code.startsWith("Z_")) return unreadable(DAMAGED);
  return new BackupError({ reason: "failed", detail: "The backup could not be read." });
};

const parseManifest = (bytes: Uint8Array): BackupManifest => {
  const text = new TextDecoder().decode(bytes);
  const manifest = decodeManifest(text);
  if (Option.isSome(manifest)) return manifest.value;
  const format = decodeManifestFormat(text);
  if (Option.isSome(format) && format.value.format > MANIFEST_FORMAT) {
    throw new BackupError({
      reason: "newer-version",
      detail:
        "This backup was made by a newer version of Codenine. Update Codenine, then restore it.",
    });
  }
  throw unreadable(DAMAGED);
};

const concatBytes = (parts: ReadonlyArray<Uint8Array>) => Buffer.concat(parts);

/** Opens a backup with its password and reads only its manifest. */
export const readBackupManifest = Effect.fn("BackupArchive.readManifest")(function* (
  filePath: string,
  password: string,
) {
  return yield* Effect.tryPromise({
    try: async () => {
      const opened = await readBackupHeader(filePath);
      const key = await unlockBackup(opened, password);
      const payload = readBackupPayload(opened, key);
      try {
        const parser = new TarParser();
        const parts: Array<Uint8Array> = [];
        for await (const chunk of payload) {
          for (const event of parser.push(chunk as Uint8Array)) {
            if (event._tag === "entry") {
              const { entry } = event;
              if (
                entry.path !== MANIFEST_NAME ||
                entry.type !== "file" ||
                entry.size > MAX_MANIFEST_BYTES
              ) {
                throw unreadable(DAMAGED);
              }
            } else if (event._tag === "data") {
              parts.push(Buffer.from(event.bytes));
            } else if (event._tag === "entryEnd") {
              return { opened, manifest: parseManifest(concatBytes(parts)) };
            } else {
              throw unreadable(DAMAGED);
            }
          }
        }
        throw unreadable(DAMAGED);
      } finally {
        payload.destroy();
      }
    },
    catch: toReadError,
  });
});

const isUnsafeSegment = (segment: string, platform: NodeJS.Platform) =>
  segment === "" ||
  segment === "." ||
  segment === ".." ||
  segment.includes("\0") ||
  (platform === "win32" && /[\\:]/.test(segment));

/**
 * Unpacks a backup into an empty `destination`, verifying every chunk on the way. Symlinks are
 * made last, so no file is ever written through one, and only those that stay inside the
 * archive are made.
 */
export const extractBackup = Effect.fn("BackupArchive.extract")(function* (input: {
  readonly filePath: string;
  readonly password: string;
  readonly destination: string;
  readonly onProgress?: ((fraction: number) => void) | undefined;
}) {
  const platform = yield* HostProcess.Platform;
  return yield* Effect.tryPromise({
    try: async () => {
      const opened = await readBackupHeader(input.filePath);
      const key = await unlockBackup(opened, input.password);
      const payloadBytes = Math.max(1, opened.sizeBytes - opened.payloadOffset);
      let readBytes = 0;
      const payload = readBackupPayload(opened, key, {
        onBytesRead: (bytes) => {
          readBytes += bytes;
          input.onProgress?.(Math.min(1, readBytes / payloadBytes));
        },
      });
      const parser = new TarParser();
      const symlinks: Array<{
        readonly diskPath: string;
        readonly archivePath: string;
        readonly target: string;
      }> = [];
      let manifest: BackupManifest | null = null;
      let manifestParts: Array<Uint8Array> | null = null;
      let first = true;
      let open: {
        readonly handle: NodeFSP.FileHandle;
        readonly diskPath: string;
        readonly mtimeMs: number;
      } | null = null;
      const resolve = (archivePath: string) => {
        const segments = archivePath.split("/");
        if (
          !ARCHIVE_ROOT_NAMES.has(segments[0] ?? "") ||
          segments.some((segment) => isUnsafeSegment(segment, platform))
        ) {
          throw unreadable(DAMAGED);
        }
        return NodePath.join(input.destination, ...segments);
      };
      try {
        for await (const chunk of payload) {
          for (const event of parser.push(chunk as Uint8Array)) {
            if (event._tag === "entry") {
              const { entry } = event;
              if (first) {
                first = false;
                if (
                  entry.path !== MANIFEST_NAME ||
                  entry.type !== "file" ||
                  entry.size > MAX_MANIFEST_BYTES
                ) {
                  throw unreadable(DAMAGED);
                }
                manifestParts = [];
                continue;
              }
              const diskPath = resolve(entry.path);
              if (entry.type === "directory") {
                await NodeFSP.mkdir(diskPath, {
                  recursive: true,
                  mode: (entry.mode & 0o777) | 0o700,
                });
              } else if (entry.type === "symlink") {
                symlinks.push({
                  diskPath,
                  archivePath: entry.path,
                  target: entry.linkTarget ?? "",
                });
              } else {
                await NodeFSP.mkdir(NodePath.dirname(diskPath), { recursive: true, mode: 0o755 });
                open = {
                  handle: await NodeFSP.open(diskPath, "w", entry.mode & 0o777 || 0o600),
                  diskPath,
                  mtimeMs: entry.mtimeMs,
                };
              }
            } else if (event._tag === "data") {
              if (manifestParts !== null) manifestParts.push(Buffer.from(event.bytes));
              else if (open !== null) await open.handle.write(event.bytes);
            } else if (event._tag === "entryEnd") {
              if (manifestParts !== null) {
                manifest = parseManifest(concatBytes(manifestParts));
                manifestParts = null;
              } else if (open !== null) {
                const done = open;
                open = null;
                await done.handle.close();
                const seconds = done.mtimeMs / 1000;
                await NodeFSP.utimes(done.diskPath, seconds, seconds).catch(() => undefined);
              }
            }
          }
        }
        parser.finish();
      } finally {
        await open?.handle.close().catch(() => undefined);
        payload.destroy();
      }
      if (manifest === null) throw unreadable(DAMAGED);
      for (const link of symlinks) {
        const resolved = NodePath.posix.normalize(
          NodePath.posix.join(NodePath.posix.dirname(link.archivePath), link.target),
        );
        if (
          link.target === "" ||
          NodePath.posix.isAbsolute(link.target) ||
          resolved === ".." ||
          resolved.startsWith("../")
        ) {
          continue;
        }
        await NodeFSP.mkdir(NodePath.dirname(link.diskPath), { recursive: true, mode: 0o755 });
        // Windows needs a privilege for symlinks; a missing link beats a failed restore.
        await NodeFSP.symlink(link.target, link.diskPath).catch(() => undefined);
      }
      return { opened, manifest };
    },
    catch: toReadError,
  });
});
