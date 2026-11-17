// @effect-diagnostics nodeBuiltinImport:off - a restore applies before the server opens its
// database, so it edits the database with node:sqlite and flushes its journal itself.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import {
  BackupError,
  BackupFileInfo,
  BackupRestoreReport,
  type BackupRestoreSummary,
  ProjectId,
  ProviderInstanceId,
} from "@codenine/contracts";
import { writeFileStringAtomically } from "@codenine/shared/atomicWrite";
import * as HostProcess from "@codenine/shared/HostProcess";
import { fromLenientJson } from "@codenine/shared/schemaJson";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  CLOUD_ENDPOINT_CONFIRMED_ORIGIN,
  CLOUD_ENDPOINT_RUNTIME_CONFIG,
  CLOUD_LINK_REVOKED,
  CLOUD_LINKED_USER_ID,
  CLOUD_MINT_PUBLIC_KEY,
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "../cloud/config.ts";
import { CLOUD_CLI_DESIRED_LINK_SECRET } from "../cloud/CliState.ts";
import { BUILD_MIGRATION_HEAD } from "../persistence/databaseMigrationHead.ts";
import { isProcessAlive } from "../serverRuntimeState.ts";
import { isWithinRoot } from "../workspace/KnownWorkspaces.ts";
import {
  BackupManifest,
  type BackupPaths,
  backupFileInfo,
  createBackup,
  ensureFreeSpace,
  extractBackup,
  isBackedUpStateEntry,
  readBackupManifest,
  RESTORE_REPORT_FILE,
} from "./BackupArchive.ts";
import { isAbandonedPartial, readBackupSummary } from "./BackupFile.ts";
import { readBackupState, writeBackupState } from "./BackupSchedule.ts";

/** The secret the backup password is saved under. */
export const BACKUP_PASSWORD_SECRET = "backup-password";
const UNDO_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RestorePaths extends BackupPaths {
  readonly environmentIdPath: string;
  readonly secretsDir: string;
  readonly settingsPath: string;
  readonly anonymousIdPath: string;
}

const restoreFolders = (baseDir: string) => ({
  marker: NodePath.join(baseDir, "restore-pending.json"),
  staging: NodePath.join(baseDir, "restore-staging"),
  previous: NodePath.join(baseDir, "restore-previous"),
  journal: NodePath.join(baseDir, "restore-previous", "journal.json"),
  undo: NodePath.join(baseDir, "restore-undo"),
});

/** Where the safety backups a restore saves live, inside the Codenine home. */
const restoreUndoFolder = (baseDir: string) => restoreFolders(baseDir).undo;

const RestorePlan = Schema.Struct({
  manifest: BackupManifest,
  keepIdentity: Schema.Boolean,
  restoredFrom: BackupFileInfo,
  safetyBackup: Schema.NullOr(BackupFileInfo),
  stagedAt: Schema.String,
});
type RestorePlan = typeof RestorePlan.Type;
const RestorePlanJson = Schema.fromJsonString(RestorePlan);

const RestoreMove = Schema.Struct({
  live: Schema.String,
  staged: Schema.NullOr(Schema.String),
  previous: Schema.String,
});
type RestoreMove = typeof RestoreMove.Type;
const RestoreJournalJson = Schema.fromJsonString(
  Schema.Struct({ moves: Schema.Array(RestoreMove) }),
);

const RestoreReportJson = Schema.fromJsonString(BackupRestoreReport);
const encodePlan = Schema.encodeEffect(RestorePlanJson);
const decodePlan = Schema.decodeEffect(RestorePlanJson);
const encodeJournal = Schema.encodeEffect(RestoreJournalJson);
const decodeJournal = Schema.decodeEffect(RestoreJournalJson);
const decodeReport = Schema.decodeEffect(BackupRestoreReport);
const encodeReportJson = Schema.encodeEffect(RestoreReportJson);
const decodeReportJson = Schema.decodeOption(RestoreReportJson);
const isBackupError = Schema.is(BackupError);
const isProjectId = Schema.is(ProjectId);
const isProviderInstanceId = Schema.is(ProviderInstanceId);

class RestoreDatabaseError extends Schema.TaggedError<RestoreDatabaseError>()(
  "RestoreDatabaseError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not update the restored database.";
  }
}

const newerVersion = () =>
  new BackupError({
    reason: "newer-version",
    detail:
      "This backup was made by a newer version of Codenine. Update Codenine, then restore it.",
  });

const readEnvironmentId = Effect.fn("BackupRestore.readEnvironmentId")(function* (
  environmentIdPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(environmentIdPath).pipe(
    Effect.map((value) => value.trim()),
    Effect.orElseSucceed(() => ""),
  );
});

/** What a backup would bring back. A file Codenine cannot read at all fails instead. */
export const inspectBackup = Effect.fn("BackupRestore.inspect")(function* (input: {
  readonly paths: RestorePaths;
  readonly filePath: string;
  readonly password: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const read = yield* readBackupManifest(input.filePath, input.password).pipe(
    Effect.asSome,
    Effect.catchIf(
      (error) => error.reason === "newer-version",
      () => Effect.succeedNone,
    ),
  );
  if (Option.isNone(read)) {
    const file = yield* Effect.tryPromise({
      try: () => readBackupSummary(input.filePath),
      catch: () => newerVersion(),
    });
    const summary: BackupRestoreSummary = {
      file: file.file,
      contents: { workspaces: 0, chats: 0, accounts: 0, savedKeys: 0, skills: 0 },
      fromThisComputer: false,
      blockedReason: newerVersion().detail,
    };
    return { summary, manifest: null };
  }
  const { opened, manifest } = read.value;
  const environmentId = yield* readEnvironmentId(input.paths.environmentIdPath);
  const realPath = (value: string) => fs.realPath(value).pipe(Effect.orElseSucceed(() => value));
  // A safety backup in this home restores this computer's own identity, even after a restore
  // from another computer gave it a new one.
  const ownSafetyBackup =
    opened.header.kind === "before-restore" &&
    isWithinRoot(
      path,
      yield* realPath(input.filePath),
      yield* realPath(restoreUndoFolder(input.paths.baseDir)),
    );
  const summary: BackupRestoreSummary = {
    file: backupFileInfo(opened),
    contents: manifest.contents,
    fromThisComputer:
      ownSafetyBackup || (environmentId !== "" && manifest.environmentId === environmentId),
    blockedReason: manifest.schemaVersion > BUILD_MIGRATION_HEAD ? newerVersion().detail : null,
  };
  return { summary, manifest };
});

/**
 * Unpacks a backup beside the live data and marks it to replace that data at the next start.
 * The password just entered becomes the backup password, so it also opens the safety backup.
 */
const stageRestore = Effect.fn("BackupRestore.stage")(function* (input: {
  readonly paths: RestorePaths;
  readonly filePath: string;
  readonly password: string;
  readonly keepIdentity: boolean;
  readonly safetyBackup: BackupFileInfo | null;
  readonly onProgress?: ((fraction: number) => void) | undefined;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const folders = restoreFolders(input.paths.baseDir);
  const cleanUp = fs.remove(folders.staging, { recursive: true, force: true }).pipe(Effect.ignore);
  yield* cleanUp;
  return yield* Effect.gen(function* () {
    yield* fs.makeDirectory(folders.staging, { recursive: true, mode: 0o700 });
    const { opened, manifest } = yield* extractBackup({
      filePath: input.filePath,
      password: input.password,
      destination: folders.staging,
      onProgress: input.onProgress,
    });
    if (manifest.schemaVersion > BUILD_MIGRATION_HEAD) return yield* newerVersion();
    const stagedSecrets = path.join(
      folders.staging,
      "userdata",
      path.relative(input.paths.stateDir, input.paths.secretsDir),
    );
    yield* fs.makeDirectory(stagedSecrets, { recursive: true, mode: 0o700 });
    yield* fs.writeFile(
      path.join(stagedSecrets, `${BACKUP_PASSWORD_SECRET}.bin`),
      new TextEncoder().encode(input.password),
      { mode: 0o600 },
    );
    const plan: RestorePlan = {
      manifest,
      keepIdentity: input.keepIdentity,
      restoredFrom: backupFileInfo(opened),
      safetyBackup: input.safetyBackup,
      stagedAt: DateTime.formatIso(yield* DateTime.now),
    };
    yield* writeFileStringAtomically({
      filePath: folders.marker,
      contents: yield* encodePlan(plan),
    });
    return plan;
  }).pipe(
    Effect.mapError((cause) =>
      isBackupError(cause)
        ? cause
        : new BackupError({ reason: "failed", detail: "The backup could not be unpacked." }),
    ),
    Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : cleanUp)),
  );
});

/**
 * Inspects a backup, saves a safety backup of the current data with the same password, and
 * stages the backup to apply at the next start.
 */
export const prepareRestore = Effect.fn("BackupRestore.prepare")(function* (input: {
  readonly paths: RestorePaths;
  readonly filePath: string;
  readonly password: string;
  readonly computerName: string;
  readonly codenineVersion: string;
  /** Undoing a restore brings back this computer's own identity. */
  readonly keepIdentity?: boolean;
  readonly onProgress?: ((fraction: number, detail: string) => void) | undefined;
}) {
  const fs = yield* FileSystem.FileSystem;
  const folders = restoreFolders(input.paths.baseDir);
  if (yield* fs.exists(folders.marker).pipe(Effect.orElseSucceed(() => false))) {
    return yield* new BackupError({
      reason: "busy",
      detail: "A restore is already waiting for Codenine to restart.",
    });
  }
  const { summary, manifest } = yield* inspectBackup(input);
  if (manifest === null || summary.blockedReason !== null) return yield* newerVersion();
  yield* ensureFreeSpace(input.paths.baseDir, manifest.contentBytes, "Restoring this backup");
  // A home that never ran a server has nothing to keep, as on a new computer.
  const safety = (yield* fs.exists(input.paths.dbPath).pipe(Effect.orElseSucceed(() => false)))
    ? yield* createBackup({
        paths: input.paths,
        folder: folders.undo,
        password: input.password,
        kind: "before-restore",
        includeWorktrees: manifest.includeWorktrees,
        computerName: input.computerName,
        environmentId: yield* readEnvironmentId(input.paths.environmentIdPath),
        codenineVersion: input.codenineVersion,
        onProgress: (fraction) =>
          input.onProgress?.(fraction / 2, "Saving a safety backup of your current data"),
      }).pipe(Effect.map(({ file }) => file))
    : null;
  yield* ensureFreeSpace(input.paths.baseDir, manifest.contentBytes, "Restoring this backup").pipe(
    Effect.andThen(
      stageRestore({
        paths: input.paths,
        filePath: input.filePath,
        password: input.password,
        keepIdentity: input.keepIdentity === true || summary.fromThisComputer,
        safetyBackup: safety,
        onProgress: (fraction) => input.onProgress?.(0.5 + fraction / 2, "Unpacking the backup"),
      }),
    ),
    // Nothing was restored, so there is nothing to undo.
    Effect.tapError(() =>
      safety === null ? Effect.void : fs.remove(safety.path, { force: true }).pipe(Effect.ignore),
    ),
  );
  return { summary, safetyBackup: safety };
});

interface PathRule {
  readonly from: string;
  readonly to: string;
}

const isAbsoluteOnAnyPlatform = (value: string) => /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value);

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Rewrites absolute paths that start with the source computer's Codenine home, state folder or
 * user home. Matches whole JSON strings only, so a path mentioned inside a message stays as
 * written.
 */
const makePathRewriter = (input: {
  readonly rules: ReadonlyArray<PathRule>;
  readonly fromPlatform: string;
  readonly toPlatform: string;
}) => {
  const rules = input.rules
    .filter(
      (rule) => rule.from !== rule.to && rule.from.length > 1 && isAbsoluteOnAnyPlatform(rule.from),
    )
    .toSorted((left, right) => right.from.length - left.from.length);
  const separators = (rest: string) =>
    input.fromPlatform === input.toPlatform
      ? rest
      : input.toPlatform === "win32"
        ? rest.replace(/\//g, "\\")
        : rest.replace(/\\/g, "/");
  const rewritePath = (value: string): string => {
    for (const rule of rules) {
      if (value === rule.from) return rule.to;
      const next = value.charAt(rule.from.length);
      if (value.startsWith(rule.from) && (next === "/" || next === "\\")) {
        return rule.to + separators(value.slice(rule.from.length));
      }
    }
    return value;
  };
  const needles = [
    ...new Set(rules.flatMap((rule) => [rule.from, JSON.stringify(rule.from).slice(1, -1)])),
  ];
  const jsonString =
    rules.length === 0
      ? null
      : new RegExp(
          `"(?:${rules.map((rule) => escapeRegExp(JSON.stringify(rule.from).slice(1, -1))).join("|")})(?=["/\\\\])(?:[^"\\\\]|\\\\.)*"`,
          "g",
        );
  const rewriteText = (text: string): string => {
    const whole = rewritePath(text);
    if (whole !== text || jsonString === null || !text.includes('"')) return whole;
    return text.replace(jsonString, (literal) => {
      let value: unknown;
      try {
        value = JSON.parse(literal);
      } catch {
        return literal;
      }
      if (typeof value !== "string") return literal;
      const next = rewritePath(value);
      return next === value ? literal : JSON.stringify(next);
    });
  };
  return { active: rules.length > 0, needles, rewritePath, rewriteText };
};
type PathRewriter = ReturnType<typeof makePathRewriter>;

const quoteIdentifier = (name: string) => `"${name.replace(/"/g, '""')}"`;

const tableNames = (database: NodeSqlite.DatabaseSync) =>
  new Set(
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String(row.name)),
  );

const REWRITE_PAGE_ROWS = 500;

/** Rewrites paths in every text column, a page of rows at a time. */
const rewriteDatabasePaths = (database: NodeSqlite.DatabaseSync, rewriter: PathRewriter) => {
  if (!rewriter.active) return;
  const tables = database
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all()
    .map((row) => ({ name: String(row.name), sql: String(row.sql ?? "") }));
  const virtualTables = tables.filter((table) => /^CREATE\s+VIRTUAL\s+TABLE/i.test(table.sql));
  for (const table of tables) {
    // Full-text indexes follow their source rows; WITHOUT ROWID tables hold no paths.
    if (
      virtualTables.some(
        (virtual) => table.name === virtual.name || table.name.startsWith(`${virtual.name}_`),
      ) ||
      /WITHOUT\s+ROWID/i.test(table.sql)
    ) {
      continue;
    }
    const columns = database
      .prepare("SELECT name, type FROM pragma_table_info(?)")
      .all(table.name)
      .filter((column) => /TEXT|CHAR|CLOB|^$/i.test(String(column.type)))
      .map((column) => String(column.name));
    if (columns.length === 0) continue;
    const matches = columns
      .flatMap((column) => rewriter.needles.map(() => `instr(${quoteIdentifier(column)}, ?) > 0`))
      .join(" OR ");
    const page = database.prepare(
      `SELECT rowid AS id, ${columns.map(quoteIdentifier).join(", ")} FROM ${quoteIdentifier(table.name)}
       WHERE rowid > ? AND (${matches}) ORDER BY rowid LIMIT ${REWRITE_PAGE_ROWS}`,
    );
    const needles = columns.flatMap(() => rewriter.needles);
    const updates = new Map(
      columns.map((column) => [
        column,
        database.prepare(
          `UPDATE ${quoteIdentifier(table.name)} SET ${quoteIdentifier(column)} = ? WHERE rowid = ?`,
        ),
      ]),
    );
    let after = Number.MIN_SAFE_INTEGER;
    for (;;) {
      const rows = page.all(after, ...needles);
      for (const row of rows) {
        for (const column of columns) {
          const value = row[column];
          if (typeof value !== "string") continue;
          const next = rewriter.rewriteText(value);
          if (next !== value) updates.get(column)!.run(next, row.id as number);
        }
      }
      if (rows.length < REWRITE_PAGE_ROWS) break;
      after = rows.at(-1)!.id as number;
    }
  }
};

// Sessions and pairing links stay as they are now: a restore of this computer's own backup must
// neither sign out devices paired since, nor revive ones revoked since.
const AUTH_TABLES = ["auth_sessions", "auth_pairing_links"] as const;
// Runs and launches in flight when the backup was taken must never resume.
const RUNTIME_TABLES = [
  "provider_session_runtime",
  "orchestration_v2_effect_outbox",
  "orchestration_v2_thread_launch_workflows",
] as const;

const copyTable = (from: NodeSqlite.DatabaseSync, to: NodeSqlite.DatabaseSync, table: string) => {
  const columnsOf = (database: NodeSqlite.DatabaseSync) =>
    database
      .prepare("SELECT name FROM pragma_table_info(?)")
      .all(table)
      .map((row) => String(row.name));
  const fromColumns = new Set(columnsOf(from));
  const shared = columnsOf(to).filter((column) => fromColumns.has(column));
  const list = shared.map(quoteIdentifier).join(", ");
  const insert = to.prepare(
    `INSERT INTO ${quoteIdentifier(table)} (${list}) VALUES (${shared.map(() => "?").join(", ")})`,
  );
  to.exec(`DELETE FROM ${quoteIdentifier(table)}`);
  for (const row of from.prepare(`SELECT ${list} FROM ${quoteIdentifier(table)}`).all()) {
    insert.run(...shared.map((column) => row[column] ?? null));
  }
};

interface DatabaseFixups {
  readonly rewriter: PathRewriter;
  readonly resetIdentity: boolean;
  /** This computer's database before the restore, to keep its sessions; null to keep the backup's. */
  readonly previousDatabase: string | null;
}

/** Returns the secrets that cleared peer links used. */
const fixDatabase = (databasePath: string, fixups: DatabaseFixups) => {
  const database = new NodeSqlite.DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    const tables = tableNames(database);
    const previous =
      fixups.previousDatabase === null
        ? null
        : new NodeSqlite.DatabaseSync(fixups.previousDatabase, { readOnly: true });
    let peerSecrets: Array<string> = [];
    database.exec("BEGIN IMMEDIATE");
    try {
      rewriteDatabasePaths(database, fixups.rewriter);
      for (const table of RUNTIME_TABLES) {
        if (tables.has(table)) database.exec(`DELETE FROM ${quoteIdentifier(table)}`);
      }
      if (fixups.resetIdentity) {
        if (tables.has("peer_environment_links")) {
          peerSecrets = database
            .prepare("SELECT secret_name FROM peer_environment_links")
            .all()
            .map((row) => String(row.secret_name));
          database.exec("DELETE FROM peer_environment_links");
        }
        for (const table of AUTH_TABLES) {
          if (tables.has(table)) database.exec(`DELETE FROM ${quoteIdentifier(table)}`);
        }
      } else if (previous !== null) {
        const previousTables = tableNames(previous);
        for (const table of AUTH_TABLES) {
          if (tables.has(table) && previousTables.has(table)) copyTable(previous, database, table);
        }
      }
      database.exec("COMMIT");
    } catch (cause) {
      database.exec("ROLLBACK");
      throw cause;
    } finally {
      previous?.close();
    }
    return peerSecrets;
  } finally {
    database.close();
  }
};

const hasActiveSessions = (databasePath: string) => {
  try {
    const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
    try {
      return (
        database.prepare("SELECT 1 FROM auth_sessions WHERE revoked_at IS NULL LIMIT 1").get() !==
        undefined
      );
    } finally {
      database.close();
    }
  } catch {
    return true;
  }
};

// The environment's identity: what names its cookies, relay endpoint and peer links.
const IDENTITY_SECRETS = [
  "server-signing-key",
  "asset-access-signing-key",
  "mcp-oauth-signing-key",
  "cloud-link-ed25519-key-pair",
  "cloud-link-ed25519-private-key",
  "cloud-link-ed25519-public-key",
  "cloud-cli-oauth-token",
  CLOUD_CLI_DESIRED_LINK_SECRET,
  CLOUD_LINKED_USER_ID,
  RELAY_URL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  CLOUD_MINT_PUBLIC_KEY,
  CLOUD_ENDPOINT_RUNTIME_CONFIG,
  CLOUD_ENDPOINT_CONFIRMED_ORIGIN,
  PUBLISH_AGENT_ACTIVITY_SECRET,
  CLOUD_LINK_REVOKED,
];

/** Where Codenine keeps an instance's ChatGPT session; see ProviderCredentialStore. */
const chatGptSessionSecret = (instanceId: string) => {
  const driver = "codex-chatgpt";
  return `provider-auth-${NodeCrypto.createHash("sha256")
    .update(`${driver.length}:${driver}${instanceId}`)
    .digest("hex")}`;
};

const SettingsDocument = fromLenientJson(Schema.Record(Schema.String, Schema.Unknown));
const decodeSettingsDocument = Schema.decodeOption(SettingsDocument);

interface ProviderAccount {
  readonly instanceId: string;
  readonly driver: string;
  readonly displayName: string;
  readonly config: Readonly<Record<string, unknown>>;
}

const readProviderAccounts = (settingsText: string): ReadonlyArray<ProviderAccount> => {
  const settings = Option.getOrUndefined(decodeSettingsDocument(settingsText));
  const instances = settings?.providerInstances;
  if (typeof instances !== "object" || instances === null) return [];
  return Object.entries(instances).flatMap(([instanceId, raw]) => {
    if (typeof raw !== "object" || raw === null) return [];
    const instance = raw as Readonly<Record<string, unknown>>;
    const driver = typeof instance.driver === "string" ? instance.driver : "";
    if (driver !== "claudeAgent" && driver !== "codex") return [];
    const label = driver === "claudeAgent" ? "Claude" : "Codex";
    return [
      {
        instanceId,
        driver,
        displayName:
          typeof instance.displayName === "string" && instance.displayName.trim() !== ""
            ? instance.displayName
            : instanceId === driver
              ? label
              : `${label} (${instanceId})`,
        config:
          typeof instance.config === "object" && instance.config !== null
            ? (instance.config as Readonly<Record<string, unknown>>)
            : {},
      },
    ];
  });
};

const configString = (config: Readonly<Record<string, unknown>>, key: string) =>
  typeof config[key] === "string" ? config[key].trim() : "";

/**
 * Applies a restore that a previous run staged. Runs once the server owns the Codenine home and
 * before anything opens the database. The data it replaces waits in `restore-previous` until the
 * restore is complete, and goes back if any step fails.
 */
export const applyPendingRestore = Effect.fn("BackupRestore.applyPending")(function* (
  paths: RestorePaths,
) {
  const fs = yield* FileSystem.FileSystem;
  const folders = restoreFolders(paths.baseDir);
  const exists = (target: string) => fs.exists(target).pipe(Effect.orElseSucceed(() => false));
  const removeQuietly = (target: string) =>
    fs.remove(target, { recursive: true, force: true }).pipe(Effect.ignore({ log: true }));

  // Removing the marker commits a restore. A journal beside a marker is an apply that stopped
  // part way, so its moves go back; a journal alone is cleanup that stopped part way.
  if (yield* exists(folders.journal)) {
    if (yield* exists(folders.marker)) {
      const journal = yield* fs
        .readFileString(folders.journal)
        .pipe(Effect.flatMap(decodeJournal), Effect.orDie);
      yield* rollBack(journal.moves);
      yield* removeQuietly(folders.previous);
      yield* abandonRestore(
        paths,
        "The last restore was interrupted, so your data was left as it was.",
      );
    } else {
      yield* removeQuietly(folders.previous);
    }
  }

  if (!(yield* exists(folders.marker))) {
    yield* removeQuietly(folders.staging);
    yield* removeQuietly(folders.previous);
    yield* removeExpiredSafetyBackups(folders.undo);
    return;
  }

  const plan = yield* fs
    .readFileString(folders.marker)
    .pipe(Effect.flatMap(decodePlan), Effect.option);
  if (Option.isNone(plan) || !(yield* exists(folders.staging))) {
    return yield* abandonRestore(
      paths,
      "The restore could not start because its files were missing.",
    );
  }
  if (plan.value.manifest.schemaVersion > BUILD_MIGRATION_HEAD) {
    return yield* abandonRestore(paths, newerVersion().detail);
  }

  const previousEnvironmentId = yield* readEnvironmentId(paths.environmentIdPath);
  const moves = yield* planMoves(paths, plan.value).pipe(Effect.option);
  const journal = Option.isNone(moves)
    ? Option.none()
    : yield* encodeJournal({ moves: moves.value }).pipe(
        Effect.flatMap((contents) =>
          Effect.tryPromise({
            try: () => writeDurably(folders.journal, contents),
            catch: () =>
              new BackupError({ reason: "failed", detail: "The restore could not start." }),
          }),
        ),
        Effect.option,
      );
  if (Option.isNone(moves) || Option.isNone(journal)) {
    return yield* abandonRestore(
      paths,
      "The restore could not start, so your data was left as it was.",
    );
  }
  const applied = yield* Effect.exit(
    applyMoves(moves.value).pipe(
      Effect.andThen(
        finishRestore(paths, plan.value, {
          carryOverAuth:
            plan.value.keepIdentity &&
            previousEnvironmentId !== "" &&
            previousEnvironmentId === plan.value.manifest.environmentId,
          previousDatabase: NodePath.join(
            folders.previous,
            "userdata",
            NodePath.basename(paths.dbPath),
          ),
        }),
      ),
    ),
  );
  if (Exit.isFailure(applied)) {
    yield* Effect.logError("Restore failed; putting the previous data back.", {
      cause: applied.cause,
    });
    // A failed rollback stops the server rather than open half of each.
    yield* rollBack(moves.value);
    yield* removeQuietly(folders.previous);
    return yield* abandonRestore(
      paths,
      "The restore could not be applied, so your data was left as it was.",
    );
  }
  yield* fs.remove(folders.marker).pipe(Effect.orDie);
  yield* removeQuietly(folders.previous);
  yield* removeQuietly(folders.staging);
  yield* Effect.logInfo("Restored a backup.", {
    fromThisComputer: plan.value.keepIdentity,
    createdAt: plan.value.manifest.createdAt,
  });
});

const writeDurably = async (filePath: string, contents: string) => {
  await NodeFSP.mkdir(NodePath.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp`;
  const handle = await NodeFSP.open(temporary, "w", 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await NodeFSP.rename(temporary, filePath);
  const directory = await NodeFSP.open(NodePath.dirname(filePath), "r").catch(() => undefined);
  await directory?.sync().catch(() => undefined);
  await directory?.close();
};

/** Drops a staged restore that cannot apply and tells the app why. */
const abandonRestore = Effect.fn("BackupRestore.abandon")(function* (
  paths: RestorePaths,
  detail: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const folders = restoreFolders(paths.baseDir);
  yield* Effect.logWarning(detail);
  for (const target of [folders.marker, folders.staging]) {
    yield* fs.remove(target, { recursive: true, force: true }).pipe(Effect.ignore({ log: true }));
  }
  const state = yield* readBackupState(paths.stateDir);
  yield* writeBackupState(paths.stateDir, { ...state, lastError: detail }).pipe(
    Effect.ignore({ log: true }),
  );
});

const removeExpiredSafetyBackups = Effect.fn("BackupRestore.removeExpiredSafetyBackups")(function* (
  folder: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const now = yield* Clock.currentTimeMillis;
  const names = yield* fs.readDirectory(folder).pipe(Effect.orElseSucceed(() => []));
  for (const name of names) {
    const filePath = path.join(folder, name);
    if (isAbandonedPartial(name, isProcessAlive)) {
      yield* fs.remove(filePath, { force: true }).pipe(Effect.ignore({ log: true }));
      continue;
    }
    const createdAt = yield* Effect.tryPromise({
      try: () => readBackupSummary(filePath),
      catch: () => new BackupError({ reason: "unreadable", detail: "Not a backup." }),
    }).pipe(
      Effect.map(({ file }) => Date.parse(file.createdAt)),
      Effect.catch(() =>
        fs.stat(filePath).pipe(
          Effect.map((info) => Option.getOrUndefined(info.mtime)?.getTime() ?? now),
          Effect.orElseSucceed(() => now),
        ),
      ),
    );
    if (now - createdAt > UNDO_DAYS * DAY_MS) {
      yield* fs
        .remove(filePath, { recursive: true, force: true })
        .pipe(Effect.ignore({ log: true }));
    }
  }
});

const ROOT_FOLDERS = ["accounts", "skills", "workspaces", "scratch", "projects"] as const;
const DATABASE_SIDE_FILES = ["-wal", "-shm", "-journal"] as const;

/** One rename per state-folder entry and per top-level folder, so excluded files stay put. */
const planMoves = Effect.fn("BackupRestore.planMoves")(function* (
  paths: RestorePaths,
  plan: RestorePlan,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const folders = restoreFolders(paths.baseDir);
  const exists = (target: string) => fs.exists(target).pipe(Effect.orElseSucceed(() => false));
  const stagedState = path.join(folders.staging, "userdata");
  const databaseName = path.basename(paths.dbPath);
  const restorable = (name: string) => isBackedUpStateEntry(name) || name === databaseName;
  const stagedNames = (yield* fs
    .readDirectory(stagedState)
    .pipe(Effect.orElseSucceed(() => []))).filter(restorable);
  const liveNames = (yield* fs
    .readDirectory(paths.stateDir)
    .pipe(Effect.orElseSucceed(() => []))).filter(restorable);
  const moves: Array<RestoreMove> = [];
  for (const name of new Set([...stagedNames, ...liveNames])) {
    moves.push({
      live: path.join(paths.stateDir, name),
      staged: stagedNames.includes(name) ? path.join(stagedState, name) : null,
      previous: path.join(folders.previous, "userdata", name),
    });
  }
  // A WAL left beside the restored database would be replayed into it.
  for (const suffix of DATABASE_SIDE_FILES) {
    moves.push({
      live: `${paths.dbPath}${suffix}`,
      staged: null,
      previous: path.join(folders.previous, "userdata", `${databaseName}${suffix}`),
    });
  }
  const roots: Array<readonly [string, string]> = ROOT_FOLDERS.map((name) => [
    name,
    path.join(paths.baseDir, name),
  ]);
  if (plan.manifest.includeWorktrees) roots.push(["worktrees", paths.worktreesDir]);
  for (const [name, live] of roots) {
    const staged = path.join(folders.staging, name);
    moves.push({
      live,
      staged: (yield* exists(staged)) ? staged : null,
      previous: path.join(folders.previous, name),
    });
  }
  const relevant: Array<RestoreMove> = [];
  for (const move of moves) {
    if (move.staged !== null || (yield* exists(move.live))) relevant.push(move);
  }
  return relevant;
});

const applyMoves = Effect.fn("BackupRestore.applyMoves")(function* (
  moves: ReadonlyArray<RestoreMove>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const move of moves) {
    if (yield* fs.exists(move.live)) {
      yield* fs.makeDirectory(path.dirname(move.previous), { recursive: true });
      yield* fs.rename(move.live, move.previous);
    }
    if (move.staged !== null) {
      yield* fs.makeDirectory(path.dirname(move.live), { recursive: true });
      yield* fs.rename(move.staged, move.live);
    }
  }
});

/** Puts every move back, whichever step it reached. */
const rollBack = Effect.fn("BackupRestore.rollBack")(function* (moves: ReadonlyArray<RestoreMove>) {
  const fs = yield* FileSystem.FileSystem;
  for (const move of moves.toReversed()) {
    if (move.staged !== null && !(yield* fs.exists(move.staged)) && (yield* fs.exists(move.live))) {
      yield* fs.rename(move.live, move.staged);
    }
    if (yield* fs.exists(move.previous)) yield* fs.rename(move.previous, move.live);
  }
}, Effect.orDie);

const rewriteGitLinks = Effect.fn("BackupRestore.rewriteGitLinks")(function* (
  paths: RestorePaths,
  rewriter: PathRewriter,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const rewriteLinkFile = (file: string, prefix: string) =>
    fs.readFileString(file).pipe(
      Effect.flatMap((text) => {
        if (!text.startsWith(prefix)) return Effect.void;
        const target = text.slice(prefix.length).trim();
        const next = rewriter.rewritePath(target);
        return next === target ? Effect.void : fs.writeFileString(file, `${prefix}${next}\n`);
      }),
      Effect.ignore,
    );
  // Worktrees and repositories sit a few levels down; their own contents are not searched.
  const visit: (directory: string, depth: number) => Effect.Effect<void> = Effect.fnUntraced(
    function* (directory, depth) {
      const dotGit = path.join(directory, ".git");
      const info = yield* fs.stat(dotGit).pipe(Effect.option);
      if (Option.isSome(info)) {
        if (info.value.type === "File") return yield* rewriteLinkFile(dotGit, "gitdir: ");
        const worktrees = path.join(dotGit, "worktrees");
        for (const name of yield* fs
          .readDirectory(worktrees)
          .pipe(Effect.orElseSucceed(() => []))) {
          yield* rewriteLinkFile(path.join(worktrees, name, "gitdir"), "");
        }
        return;
      }
      if (depth === 0) return;
      for (const name of yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []))) {
        const child = path.join(directory, name);
        const childInfo = yield* fs.lstat(child).pipe(Effect.option);
        if (Option.isSome(childInfo) && childInfo.value.type === "Directory")
          yield* visit(child, depth - 1);
      }
    },
  );
  for (const root of [...ROOT_FOLDERS, "worktrees"]) {
    yield* visit(root === "worktrees" ? paths.worktreesDir : path.join(paths.baseDir, root), 4);
  }
});

/** Edits the restored data for this computer and leaves the checklist the app shows. */
const finishRestore = Effect.fn("BackupRestore.finish")(function* (
  paths: RestorePaths,
  plan: RestorePlan,
  options: { readonly carryOverAuth: boolean; readonly previousDatabase: string },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const platform = yield* HostProcess.Platform;
  const { manifest } = plan;
  const resetIdentity = !plan.keepIdentity;
  const rewriter = makePathRewriter({
    rules: [
      { from: manifest.stateDirectory, to: paths.stateDir },
      { from: manifest.codenineHome, to: paths.baseDir },
      { from: manifest.homeDirectory, to: homeDirectory },
    ],
    fromPlatform: manifest.platform,
    toPlatform: platform,
  });
  const secretPath = (name: string) => path.join(paths.secretsDir, `${name}.bin`);

  const hadPreviousDatabase = yield* fs.exists(options.previousDatabase);
  const previousDatabase =
    options.carryOverAuth && hadPreviousDatabase ? options.previousDatabase : null;
  // Only devices paired with this computer before the restore lose access.
  const devicesSignedOut =
    resetIdentity && hadPreviousDatabase && hasActiveSessions(options.previousDatabase);
  const peerSecrets = yield* Effect.try({
    try: () => fixDatabase(paths.dbPath, { rewriter, resetIdentity, previousDatabase }),
    catch: (cause) => new RestoreDatabaseError({ cause }),
  });

  const savedSettings = yield* fs
    .readFileString(paths.settingsPath)
    .pipe(Effect.orElseSucceed(() => ""));
  const settings = rewriter.rewriteText(savedSettings);
  if (settings !== savedSettings) {
    yield* writeFileStringAtomically({ filePath: paths.settingsPath, contents: settings });
  }
  if (rewriter.active) yield* rewriteGitLinks(paths, rewriter);

  const accounts = readProviderAccounts(settings);
  const signedOutChatGpt = new Set<string>();
  if (resetIdentity) {
    yield* writeFileStringAtomically({
      filePath: paths.environmentIdPath,
      contents: `${NodeCrypto.randomUUID()}\n`,
    });
    yield* fs.remove(paths.anonymousIdPath, { force: true });
    for (const name of [...IDENTITY_SECRETS, ...peerSecrets]) {
      yield* fs.remove(secretPath(name), { force: true });
    }
    // ChatGPT rotates refresh tokens: two computers sharing one sign it out on both.
    for (const account of accounts) {
      const secret = secretPath(chatGptSessionSecret(account.instanceId));
      if (account.driver === "codex" && (yield* fs.exists(secret))) {
        yield* fs.remove(secret, { force: true });
        signedOutChatGpt.add(account.instanceId);
      }
    }
  }

  const accountsRoot = path.join(paths.baseDir, "accounts");
  const accountsToSignIn: Array<{ instanceId: string; displayName: string; reason: string }> = [];
  for (const account of accounts) {
    const configured =
      account.driver === "codex"
        ? configString(account.config, "shadowHomePath") || configString(account.config, "homePath")
        : configString(account.config, "homePath");
    const expanded = configured.replace(/^~(?=$|[\\/])/, homeDirectory);
    const home = path.resolve(
      expanded || path.join(homeDirectory, account.driver === "codex" ? ".codex" : ".claude"),
    );
    const managed = configString(account.config, "setupMode") === "managed";
    const reason = signedOutChatGpt.has(account.instanceId)
      ? "ChatGPT keeps a sign-in on one computer at a time, so sign in again here."
      : !managed && !(yield* fs.exists(home))
        ? "Its sign-in folder is not on this computer."
        : resetIdentity &&
            account.driver === "claudeAgent" &&
            platform === "darwin" &&
            isWithinRoot(path, home, accountsRoot)
          ? "Claude keeps its sign-in in the Mac's keychain, which backups do not include."
          : null;
    if (reason !== null && isProviderInstanceId(account.instanceId)) {
      accountsToSignIn.push({
        instanceId: account.instanceId,
        displayName: account.displayName,
        reason,
      });
    }
  }

  const remotes = new Map(
    manifest.workspaceRemotes.map((entry) => [entry.projectId, entry.remoteUrl]),
  );
  const projects = yield* Effect.try({
    try: () => {
      const database = new NodeSqlite.DatabaseSync(paths.dbPath, { readOnly: true });
      try {
        return tableNames(database).has("projection_projects")
          ? database
              .prepare(
                "SELECT project_id, title, workspace_root FROM projection_projects WHERE deleted_at IS NULL",
              )
              .all()
              .map((row) => ({
                projectId: String(row.project_id),
                title: String(row.title),
                path: String(row.workspace_root),
              }))
          : [];
      } finally {
        database.close();
      }
    },
    catch: (cause) => new RestoreDatabaseError({ cause }),
  });
  const missingWorkspaces: Array<{
    projectId: string;
    title: string;
    path: string;
    remoteUrl: string | null;
  }> = [];
  for (const project of projects) {
    if (!isProjectId(project.projectId)) continue;
    if (!(yield* fs.exists(project.path).pipe(Effect.orElseSucceed(() => false)))) {
      missingWorkspaces.push({ ...project, remoteUrl: remotes.get(project.projectId) ?? null });
    }
  }

  const restoredAt = yield* DateTime.now;
  const report = yield* decodeReport({
    restoredAt: DateTime.formatIso(restoredAt),
    fromComputer: manifest.computerName,
    fromThisComputer: plan.keepIdentity,
    safetyBackup: plan.safetyBackup,
    undoUntil:
      plan.safetyBackup === null
        ? null
        : DateTime.formatIso(DateTime.add(restoredAt, { days: UNDO_DAYS })),
    accountsToSignIn,
    missingWorkspaces,
    devicesSignedOut,
  });
  yield* writeFileStringAtomically({
    filePath: path.join(paths.stateDir, RESTORE_REPORT_FILE),
    contents: yield* encodeReportJson(report),
  });
});

/** The checklist the last restore left, until it is dismissed. */
export const readRestoreReport = Effect.fn("BackupRestore.readReport")(function* (
  stateDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const raw = yield* fs
    .readFileString(path.join(stateDir, RESTORE_REPORT_FILE))
    .pipe(Effect.option);
  return Option.isNone(raw) ? null : Option.getOrNull(decodeReportJson(raw.value));
});

export const removeRestoreReport = Effect.fn("BackupRestore.removeReport")(function* (
  stateDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.remove(path.join(stateDir, RESTORE_REPORT_FILE), { force: true });
});

export const isRestorePending = Effect.fn("BackupRestore.isPending")(function* (baseDir: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.exists(restoreFolders(baseDir).marker).pipe(Effect.orElseSucceed(() => false));
});
