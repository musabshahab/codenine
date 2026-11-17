import {
  BackupError,
  type BackupFileInfo,
  type BackupFolderSuggestion,
  type BackupJobSnapshot,
  type BackupKind,
  type BackupRestoreReport,
  type BackupRestoreSummary,
  type BackupSettings,
  type BackupStatus,
} from "@codenine/contracts";
import { expandHomePath } from "@codenine/provider-core/server/pathExpansion";
import * as HostProcess from "@codenine/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import packageJson from "../../package.json" with { type: "json" };
import { issueBackupDownloadUrl } from "../assets/AssetAccess.ts";
import * as AssetSigner from "../assets/AssetSigner.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { ServerRestart } from "../persistence/DatabaseStorage.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import { isProcessAlive } from "../serverRuntimeState.ts";
import * as ServerSettings from "../serverSettings.ts";
import { computerIdOf, createBackup } from "./BackupArchive.ts";
import { BACKUP_FILE_EXTENSION, isAbandonedPartial, readBackupSummary } from "./BackupFile.ts";
import {
  BACKUP_PASSWORD_SECRET,
  inspectBackup,
  isRestorePending,
  prepareRestore,
  readRestoreReport,
  removeRestoreReport,
} from "./BackupRestore.ts";
import {
  type BackupState,
  backupsToPrune,
  needsAttention,
  nextAutomaticRunAt,
  readBackupState,
  scheduleKey,
  writeBackupState,
} from "./BackupSchedule.ts";

const DETAIL_MAX_LENGTH = 200;
const ERROR_MAX_LENGTH = 1000;
const BACKUP_FOLDER_NAME = "Codenine Backups";

export class BackupService extends Context.Service<
  BackupService,
  {
    readonly status: Effect.Effect<BackupStatus, BackupError>;
    /** The current status, then each change; progress at most twice a second. */
    readonly statusChanges: Stream.Stream<BackupStatus>;
    /** Starts a manual backup and returns once it is running. */
    readonly create: Effect.Effect<BackupJobSnapshot, BackupError>;
    readonly setPassword: (password: string) => Effect.Effect<void, BackupError>;
    readonly suggestFolders: Effect.Effect<ReadonlyArray<BackupFolderSuggestion>, BackupError>;
    readonly list: (options: {
      readonly includeSuggestedFolders: boolean;
    }) => Effect.Effect<ReadonlyArray<BackupFileInfo>, BackupError>;
    readonly remove: (filePath: string) => Effect.Effect<void, BackupError>;
    readonly downloadUrl: (
      filePath: string,
    ) => Effect.Effect<{ readonly url: string; readonly expiresAt: string }, BackupError>;
    readonly inspect: (input: {
      readonly path: string;
      readonly password: string;
    }) => Effect.Effect<BackupRestoreSummary, BackupError>;
    /** Saves a safety backup, stages the restore, and restarts when something supervises us. */
    readonly restore: (input: {
      readonly path: string;
      readonly password: string;
    }) => Effect.Effect<{ readonly restarting: boolean }, BackupError>;
    readonly restoreReport: Effect.Effect<BackupRestoreReport | null, BackupError>;
    readonly dismissRestoreReport: Effect.Effect<void, BackupError>;
    /** Restores the safety backup the last restore saved, with the backup password. */
    readonly undoRestore: Effect.Effect<{ readonly restarting: boolean }, BackupError>;
  }
>()("codenine/backup/BackupService") {}

const failed = (detail: string) => new BackupError({ reason: "failed", detail });
const isBackupError = Schema.is(BackupError);

const asBackupError =
  (detail: string) =>
  (cause: unknown): BackupError =>
    isBackupError(cause) ? cause : failed(detail);

const clip = (value: string | null, max: number) =>
  value === null || value.length <= max ? value : `${value.slice(0, max - 1)}…`;

interface BackupTarget {
  readonly folder: string;
  readonly password: string;
  readonly settings: BackupSettings;
}

const isoOrNull = (value: number | null) =>
  value === null ? null : DateTime.formatIso(DateTime.makeUnsafe(value));

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const scheduler = yield* Scheduler.Scheduler;
  const restart = yield* ServerRestart;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Effect.scope;
  const services = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | ProcessRunner.ProcessRunner | AssetSigner.AssetSigner
  >();
  const withServices = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      FileSystem.FileSystem | Path.Path | ProcessRunner.ProcessRunner | AssetSigner.AssetSigner
    >,
  ) => Effect.provideContext(effect, services);

  const backupSettings = settings.getSettings.pipe(
    Effect.map((current) => current.backup),
    Effect.mapError(() => failed("Codenine could not read its settings.")),
  );
  const readPassword = secrets.get(BACKUP_PASSWORD_SECRET).pipe(
    Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
    Effect.mapError(() => failed("Codenine could not read the backup password.")),
  );
  const home = yield* HostProcess.HomeDirectory;
  const resolveUserPath = (value: string) => path.resolve(expandHomePath(value, home));
  const expandFolder = (folder: string) => (folder === "" ? null : resolveUserPath(folder));

  const stateRef = yield* Ref.make(yield* readBackupState(config.stateDir));
  const passwordSet = yield* Ref.make(
    Option.isSome(yield* readPassword.pipe(Effect.orElseSucceed(Option.none))),
  );
  const jobRef = yield* Ref.make<BackupJobSnapshot | null>(null);
  const busy = yield* Ref.make(false);
  // Written by the archive's progress callbacks; a ticker publishes it.
  const progress = { fraction: 0, detail: "" };

  const computeStatus = Effect.gen(function* () {
    const current = yield* backupSettings;
    const state = yield* Ref.get(stateRef);
    const hasPassword = yield* Ref.get(passwordSet);
    const now = yield* Clock.currentTimeMillis;
    const folderPath = expandFolder(current.folder);
    const configured = folderPath !== null && hasPassword;
    const timeZone = DateTime.zoneMakeLocal();
    const scheduleSince = state.scheduleSince ?? now;
    return {
      configured,
      passwordSet: hasPassword,
      settings: current,
      folderPath,
      lastSuccessAt: isoOrNull(state.lastSuccessAt),
      lastAttemptAt: isoOrNull(state.lastAttemptAt),
      lastError: clip(state.lastError, ERROR_MAX_LENGTH),
      lastFile: state.lastFile,
      nextRunAt: configured
        ? isoOrNull(
            nextAutomaticRunAt({
              schedule: current.schedule,
              timeZone,
              scheduleSince,
              lastAutomaticAt: state.lastAutomaticAt,
              lastAutomaticFailed: state.lastAutomaticFailed,
            }),
          )
        : null,
      running: yield* Ref.get(jobRef),
      needsAttention: needsAttention({
        configured,
        schedule: current.schedule,
        timeZone,
        scheduleSince,
        lastError: state.lastError,
        lastSuccessAt: state.lastSuccessAt,
        nowMs: now,
      }),
    } satisfies BackupStatus;
  });

  const statusRef = yield* SubscriptionRef.make<BackupStatus>(yield* computeStatus);
  const publish = computeStatus.pipe(
    Effect.flatMap((next) =>
      SubscriptionRef.get(statusRef).pipe(
        Effect.flatMap((current) =>
          Equal.equals(current, next) ? Effect.void : SubscriptionRef.set(statusRef, next),
        ),
      ),
    ),
    Effect.catch((cause) => Effect.logWarning("Could not refresh the backup status.", { cause })),
  );

  const updateState = (update: (state: BackupState) => BackupState) =>
    Ref.updateAndGet(stateRef, update).pipe(
      Effect.flatMap((state) => writeBackupState(config.stateDir, state)),
      Effect.catch((cause) => Effect.logWarning("Could not save the backup state.", { cause })),
      Effect.andThen(publish),
    );

  // A new schedule, or backups just set up, starts counting from now rather than owing a run.
  const syncSchedule = Effect.gen(function* () {
    const current = yield* backupSettings;
    const key =
      current.folder !== "" && (yield* Ref.get(passwordSet)) ? scheduleKey(current.schedule) : null;
    if ((yield* Ref.get(stateRef)).scheduleKey === key) return;
    const now = yield* Clock.currentTimeMillis;
    yield* updateState((state) => ({ ...state, scheduleKey: key, scheduleSince: now }));
  });

  const backupTarget = Effect.gen(function* () {
    const current = yield* backupSettings;
    const folder = expandFolder(current.folder);
    const password = yield* readPassword;
    if (folder === null || Option.isNone(password)) {
      return yield* new BackupError({
        reason: "not-configured",
        detail: "Choose a backup folder and a backup password first.",
      });
    }
    return { folder, password: password.value, settings: current };
  });

  const identity = Effect.gen(function* () {
    const descriptor = yield* environment.getDescriptor;
    return { computerName: descriptor.label, environmentId: descriptor.environmentId };
  });

  const busyError = new BackupError({
    reason: "busy",
    detail: "A backup or restore is already running.",
  });
  const acquire = Effect.gen(function* () {
    if (yield* isRestorePending(config.baseDir)) {
      return yield* new BackupError({
        reason: "busy",
        detail: "A restore is waiting for Codenine to restart.",
      });
    }
    if (!(yield* Ref.modify(busy, (taken) => [!taken, true] as const))) return yield* busyError;
  });
  const release = Ref.set(busy, false);

  const startJob = Effect.fn("BackupService.startJob")(function* (
    kind: BackupKind,
    detail: string,
  ) {
    progress.fraction = 0;
    progress.detail = detail;
    const snapshot: BackupJobSnapshot = {
      phase: "running",
      kind,
      percent: 0,
      detail,
      error: null,
      startedAt: DateTime.formatIso(yield* DateTime.now),
      endedAt: null,
      file: null,
    };
    yield* Ref.set(jobRef, snapshot);
    yield* publish;
    return snapshot;
  });

  const tick = Effect.gen(function* () {
    const job = yield* Ref.get(jobRef);
    const percent = Math.min(99, Math.floor(progress.fraction * 100));
    const detail = clip(progress.detail, DETAIL_MAX_LENGTH);
    if (job?.phase !== "running" || (job.percent === percent && job.detail === detail)) return;
    yield* Ref.set(jobRef, { ...job, percent, detail });
    yield* publish;
  });

  /** Runs `work` as the visible job; records manual and automatic outcomes. */
  const runJob = Effect.fn("BackupService.runJob")(function* <
    A extends { readonly file: BackupFileInfo | null },
  >(kind: BackupKind, work: Effect.Effect<A, BackupError>) {
    const ticker = yield* Effect.forkScoped(
      tick.pipe(Effect.repeat(Schedule.spaced("500 millis"))),
    );
    const exit = yield* Effect.exit(
      work.pipe(
        Effect.catchDefect((defect) =>
          Effect.logError("Backup failed unexpectedly.", { defect }).pipe(
            Effect.andThen(Effect.fail(failed("The backup failed unexpectedly."))),
          ),
        ),
      ),
    );
    yield* Fiber.interrupt(ticker);
    const now = yield* Clock.currentTimeMillis;
    const job = yield* Ref.get(jobRef);
    if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) {
      yield* Ref.set(jobRef, null);
      yield* publish;
      return yield* exit;
    }
    const error = Exit.isFailure(exit)
      ? Option.match(Cause.findErrorOption(exit.cause), {
          onNone: () => "The backup failed unexpectedly.",
          onSome: (cause) => cause.detail,
        })
      : null;
    if (job !== null) {
      yield* Ref.set(jobRef, {
        ...job,
        phase: error === null ? "done" : "failed",
        percent: error === null ? 100 : job.percent,
        detail: null,
        error: clip(error, ERROR_MAX_LENGTH),
        endedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
        file: Exit.isSuccess(exit) ? exit.value.file : null,
      });
    }
    if (kind === "before-restore") {
      yield* publish;
    } else {
      yield* updateState((state) => ({
        ...state,
        lastAttemptAt: now,
        lastSuccessAt: error === null ? now : state.lastSuccessAt,
        lastError: error,
        lastFile: (Exit.isSuccess(exit) ? exit.value.file : null) ?? state.lastFile,
        ...(kind === "automatic"
          ? { lastAutomaticAt: now, lastAutomaticFailed: error !== null }
          : {}),
      }));
    }
    return yield* exit;
  }, Effect.scoped);

  const writeBackup = Effect.fn("BackupService.writeBackup")(function* (
    kind: "manual" | "automatic",
    target: BackupTarget,
  ) {
    const { computerName, environmentId } = yield* identity;
    return yield* withServices(
      createBackup({
        paths: config,
        folder: target.folder,
        password: target.password,
        kind,
        includeWorktrees: target.settings.includeWorktrees,
        computerName,
        environmentId,
        codenineVersion: packageJson.version,
        onProgress: (fraction) => {
          progress.fraction = fraction;
        },
      }),
    );
  });

  const readFolder = Effect.fn("BackupService.readFolder")(function* (folder: string) {
    const names = yield* fs.readDirectory(folder).pipe(Effect.orElseSucceed(() => []));
    const found: Array<{ readonly file: BackupFileInfo; readonly computerId: string | null }> = [];
    for (const name of names) {
      const filePath = path.join(folder, name);
      if (isAbandonedPartial(name, isProcessAlive)) {
        yield* fs.remove(filePath, { force: true }).pipe(Effect.ignore({ log: true }));
        continue;
      }
      if (name.startsWith(".") || !name.endsWith(BACKUP_FILE_EXTENSION)) continue;
      const summary = yield* Effect.tryPromise({
        try: () => readBackupSummary(filePath),
        catch: asBackupError("Not a backup."),
      }).pipe(Effect.option);
      if (Option.isSome(summary)) found.push(summary.value);
    }
    return found;
  });

  const prune = Effect.fn("BackupService.prune")(function* (folder: string, keep: number) {
    const computerId = computerIdOf((yield* identity).environmentId);
    for (const file of backupsToPrune(yield* readFolder(folder), { keep, computerId })) {
      yield* fs.remove(file.path, { force: true }).pipe(Effect.ignore({ log: true }));
    }
  });

  const runDueBackup = Effect.gen(function* () {
    yield* syncSchedule;
    yield* publish;
    const status = yield* SubscriptionRef.get(statusRef);
    const now = yield* Clock.currentTimeMillis;
    if (!status.configured || status.nextRunAt === null || now < Date.parse(status.nextRunAt))
      return;
    const target = yield* backupTarget;
    const acquired = yield* acquire.pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (!acquired) return;
    yield* Effect.gen(function* () {
      yield* startJob("automatic", "Backing up");
      yield* runJob("automatic", writeBackup("automatic", target));
      yield* prune(target.folder, target.settings.keep);
    }).pipe(Effect.ensuring(release));
  });

  const create = Effect.uninterruptible(
    Effect.gen(function* () {
      const target = yield* backupTarget;
      yield* acquire;
      const snapshot = yield* startJob("manual", "Backing up").pipe(Effect.onError(() => release));
      // The job outlives this request, and shutdown may still interrupt it.
      yield* runJob("manual", writeBackup("manual", target)).pipe(
        Effect.ignore,
        Effect.ensuring(release),
        Effect.interruptible,
        Effect.forkIn(scope),
      );
      return snapshot;
    }),
  );

  const setPassword = Effect.fn("BackupService.setPassword")(function* (password: string) {
    yield* secrets
      .set(BACKUP_PASSWORD_SECRET, new TextEncoder().encode(password))
      .pipe(Effect.mapError(() => failed("Codenine could not save the backup password.")));
    yield* Ref.set(passwordSet, true);
    yield* syncSchedule;
    yield* publish;
  }, withServices);

  const suggestFolders = Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    const isDirectory = (candidate: string) =>
      fs.stat(candidate).pipe(
        Effect.map((info) => info.type === "Directory"),
        Effect.orElseSucceed(() => false),
      );
    const found: Array<BackupFolderSuggestion> = [];
    // ~/Dropbox is often a link to the file provider's folder; suggest each place once.
    const seen = new Set<string>();
    const add = Effect.fnUntraced(function* (
      kind: BackupFolderSuggestion["kind"],
      label: string,
      root: string,
    ) {
      if (!(yield* isDirectory(root))) return;
      const real = yield* fs.realPath(root).pipe(Effect.orElseSucceed(() => root));
      if (seen.has(real)) return;
      seen.add(real);
      const folder = path.join("~", path.relative(home, path.join(root, BACKUP_FOLDER_NAME)));
      found.push({ kind, label, folder, recommended: false });
    });
    if (platform === "darwin") {
      yield* add(
        "icloud",
        "iCloud Drive",
        path.join(home, "Library", "Mobile Documents", "com~apple~CloudDocs"),
      );
      // Providers that use the macOS file provider live here, one folder per account.
      const cloudStorage = path.join(home, "Library", "CloudStorage");
      for (const name of yield* fs
        .readDirectory(cloudStorage)
        .pipe(Effect.orElseSucceed(() => []))) {
        const account = name.includes("-") ? ` (${name.slice(name.indexOf("-") + 1)})` : "";
        if (name.startsWith("Dropbox"))
          yield* add("dropbox", `Dropbox${account}`, path.join(cloudStorage, name));
        if (name.startsWith("OneDrive"))
          yield* add("onedrive", `OneDrive${account}`, path.join(cloudStorage, name));
        if (name.startsWith("GoogleDrive")) {
          yield* add(
            "google-drive",
            `Google Drive${account}`,
            path.join(cloudStorage, name, "My Drive"),
          );
        }
      }
    }
    yield* add("dropbox", "Dropbox", path.join(home, "Dropbox"));
    for (const name of yield* fs.readDirectory(home).pipe(Effect.orElseSucceed(() => []))) {
      if (name === "OneDrive" || name.startsWith("OneDrive - ")) {
        yield* add(
          "onedrive",
          name === "OneDrive" ? "OneDrive" : `OneDrive (${name.slice(11)})`,
          path.join(home, name),
        );
      }
    }
    const [first, ...rest] = found;
    const local: BackupFolderSuggestion = {
      kind: "local",
      label: "This computer",
      folder: path.join("~", BACKUP_FOLDER_NAME),
      recommended: first === undefined,
    };
    return first === undefined ? [local] : [{ ...first, recommended: true }, ...rest, local];
  }).pipe(Effect.withSpan("BackupService.suggestFolders"));

  const knownFolders = Effect.fn("BackupService.knownFolders")(function* (
    includeSuggested: boolean,
  ) {
    const folders: Array<string> = [];
    const configured = expandFolder((yield* backupSettings).folder);
    if (configured !== null) folders.push(configured);
    if (includeSuggested) {
      for (const suggestion of yield* suggestFolders)
        folders.push(resolveUserPath(suggestion.folder));
    }
    return [...new Set(folders)];
  });

  const list = Effect.fn("BackupService.list")(function* (options: {
    readonly includeSuggestedFolders: boolean;
  }) {
    const backups: Array<BackupFileInfo> = [];
    for (const folder of yield* knownFolders(options.includeSuggestedFolders)) {
      for (const { file } of yield* readFolder(folder)) backups.push(file);
    }
    return backups.toSorted(
      (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
    );
  });

  /** A backup file directly inside a backup folder, by its real path. */
  const knownBackupFile = Effect.fn("BackupService.knownBackupFile")(function* (filePath: string) {
    const notInFolder = failed("That file is not a backup in a backup folder.");
    const requested = resolveUserPath(filePath);
    const real = yield* fs.realPath(requested).pipe(Effect.mapError(() => notInFolder));
    const info = yield* fs.lstat(real).pipe(Effect.mapError(() => notInFolder));
    if (info.type !== "File" || !real.endsWith(BACKUP_FILE_EXTENSION)) return yield* notInFolder;
    for (const folder of yield* knownFolders(true)) {
      const realFolder = yield* fs.realPath(folder).pipe(Effect.orElseSucceed(() => folder));
      if (path.dirname(real) === realFolder) return real;
    }
    return yield* notInFolder;
  });

  const remove = Effect.fn("BackupService.remove")(function* (filePath: string) {
    const target = yield* knownBackupFile(filePath);
    yield* fs
      .remove(target)
      .pipe(Effect.mapError(() => failed("The backup could not be deleted.")));
  });

  const downloadUrl = Effect.fn("BackupService.downloadUrl")(function* (filePath: string) {
    const target = yield* knownBackupFile(filePath);
    const issued = yield* withServices(issueBackupDownloadUrl(target)).pipe(
      Effect.mapError(() => failed("Codenine could not make a download link.")),
    );
    if (issued === null) return yield* failed("That file is not a backup in a backup folder.");
    return {
      url: issued.relativeUrl,
      expiresAt: DateTime.formatIso(DateTime.makeUnsafe(issued.expiresAt)),
    };
  });

  const inspect = Effect.fn("BackupService.inspect")(function* (input: {
    readonly path: string;
    readonly password: string;
  }) {
    const filePath = resolveUserPath(input.path);
    const { summary } = yield* withServices(
      inspectBackup({ paths: config, filePath, password: input.password }),
    ).pipe(Effect.mapError(asBackupError("The backup could not be read.")));
    return summary;
  });

  const runRestore = Effect.fn("BackupService.runRestore")(function* (input: {
    readonly filePath: string;
    readonly password: string;
    readonly keepIdentity: boolean;
  }) {
    yield* acquire;
    yield* Effect.gen(function* () {
      yield* startJob("before-restore", "Saving a safety backup of your current data");
      const { computerName } = yield* identity;
      yield* runJob(
        "before-restore",
        withServices(
          prepareRestore({
            paths: config,
            filePath: input.filePath,
            password: input.password,
            computerName,
            codenineVersion: packageJson.version,
            keepIdentity: input.keepIdentity,
            onProgress: (fraction, detail) => {
              progress.fraction = fraction;
              progress.detail = detail;
            },
          }),
        ).pipe(
          Effect.map((prepared) => ({ file: prepared.safetyBackup })),
          Effect.mapError(asBackupError("The backup could not be restored.")),
        ),
      );
    }).pipe(Effect.ensuring(release));
    if (restart === null) return { restarting: false };
    // Reply first: the restart closes this connection.
    yield* restart.pipe(Effect.delay("500 millis"), Effect.forkDetach);
    yield* Effect.logInfo("Restarting to apply a restore.");
    return { restarting: true };
  });

  const restore = Effect.fn("BackupService.restore")(function* (input: {
    readonly path: string;
    readonly password: string;
  }) {
    const filePath = resolveUserPath(input.path);
    return yield* runRestore({ filePath, password: input.password, keepIdentity: false });
  }, withServices);

  const restoreReport = readRestoreReport(config.stateDir).pipe(
    Effect.mapError(() => failed("Codenine could not read the restore report.")),
  );

  const undoRestore = Effect.gen(function* () {
    const report = yield* restoreReport;
    const safetyBackup = report?.safetyBackup ?? null;
    if (report === null || safetyBackup === null)
      return yield* failed("There is no restore to undo.");
    if (
      report.undoUntil !== null &&
      (yield* Clock.currentTimeMillis) > Date.parse(report.undoUntil)
    ) {
      return yield* failed("The last restore can no longer be undone.");
    }
    const password = yield* readPassword;
    if (Option.isNone(password)) {
      return yield* new BackupError({
        reason: "not-configured",
        detail: "Set the backup password first.",
      });
    }
    return yield* runRestore({
      filePath: safetyBackup.path,
      password: password.value,
      keepIdentity: true,
    });
  }).pipe(Effect.withSpan("BackupService.undoRestore"));

  yield* syncSchedule.pipe(Effect.ignore({ log: true }));
  yield* forkParked(
    Stream.runForEach(settings.streamChanges, () =>
      syncSchedule.pipe(Effect.andThen(publish), Effect.ignore),
    ),
  );
  yield* scheduler.register("backup", runDueBackup);

  return BackupService.of({
    status: computeStatus,
    statusChanges: SubscriptionRef.changes(statusRef),
    create: withServices(create),
    setPassword,
    suggestFolders,
    list,
    remove,
    downloadUrl,
    inspect,
    restore,
    restoreReport: withServices(restoreReport),
    dismissRestoreReport: withServices(
      removeRestoreReport(config.stateDir).pipe(
        Effect.mapError(() => failed("Codenine could not dismiss the restore report.")),
      ),
    ),
    undoRestore: withServices(undoRestore),
  });
});

export const layer = Layer.effect(BackupService, make);
