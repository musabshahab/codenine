import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ProjectId, TrimmedString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/** How often automatic backups run, on the server machine's local clock. */
export const BackupFrequency = Schema.Literals(["off", "daily", "weekly"]);
export type BackupFrequency = typeof BackupFrequency.Type;

// Saving settings drops values equal to their defaults, so every field needs its own default.
export const BackupSchedule = Schema.Struct({
  frequency: BackupFrequency.pipe(Schema.withDecodingDefault(Effect.succeed("daily" as const))),
  /** Local time of day, 24-hour "HH:MM". */
  time: Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/)).pipe(
    Schema.withDecodingDefault(Effect.succeed("03:00")),
  ),
  /** 0 is Sunday; read only when weekly. */
  weekday: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(0)),
  ),
});
export type BackupSchedule = typeof BackupSchedule.Type;

const DEFAULT_BACKUP_SCHEDULE: BackupSchedule = {
  frequency: "daily",
  time: "03:00",
  weekday: 0,
};
const DEFAULT_BACKUP_KEEP = 7;

/** Saved in server settings. Backups are set up once a folder and a backup password exist. */
export const BackupSettings = Schema.Struct({
  /** Where backup files go; may start with `~`. Empty until backups are set up. */
  folder: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  schedule: BackupSchedule.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BACKUP_SCHEDULE)),
  ),
  /** How many automatic backups to keep; manual ones stay until deleted. */
  keep: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 365 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BACKUP_KEEP)),
  ),
  /** Unfinished task copies (worktrees) make backups much larger, so they are opt-in. */
  includeWorktrees: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type BackupSettings = typeof BackupSettings.Type;

const DEFAULT_BACKUP_SETTINGS: BackupSettings = {
  folder: "",
  schedule: DEFAULT_BACKUP_SCHEDULE,
  keep: DEFAULT_BACKUP_KEEP,
  includeWorktrees: false,
};

export const BackupSettingsWithDefaults = BackupSettings.pipe(
  Schema.withDecodingDefault(Effect.succeed(DEFAULT_BACKUP_SETTINGS)),
);

export const BackupKind = Schema.Literals(["automatic", "manual", "before-restore"]);
export type BackupKind = typeof BackupKind.Type;

/** What a backup file says about itself without its password. */
export const BackupFileInfo = Schema.Struct({
  /** Absolute path on the server machine. */
  path: Schema.String,
  fileName: Schema.String,
  createdAt: IsoDateTime,
  computerName: Schema.String,
  codenineVersion: Schema.String,
  kind: BackupKind,
  sizeBytes: NonNegativeInt,
});
export type BackupFileInfo = typeof BackupFileInfo.Type;

const BACKUP_DETAIL_MAX_LENGTH = 200;
const BACKUP_ERROR_MAX_LENGTH = 1000;

/** A backup being written. */
export const BackupJobSnapshot = Schema.Struct({
  phase: Schema.Literals(["running", "done", "failed"]),
  kind: BackupKind,
  percent: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
  detail: Schema.NullOr(Schema.String.check(Schema.isMaxLength(BACKUP_DETAIL_MAX_LENGTH))),
  error: Schema.NullOr(Schema.String.check(Schema.isMaxLength(BACKUP_ERROR_MAX_LENGTH))),
  startedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
  file: Schema.NullOr(BackupFileInfo),
});
export type BackupJobSnapshot = typeof BackupJobSnapshot.Type;

export const BackupStatus = Schema.Struct({
  /** A folder and a backup password are both set. */
  configured: Schema.Boolean,
  passwordSet: Schema.Boolean,
  settings: BackupSettings,
  /** The folder with `~` expanded; null until set up. */
  folderPath: Schema.NullOr(Schema.String),
  lastSuccessAt: Schema.NullOr(IsoDateTime),
  lastAttemptAt: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(Schema.String.check(Schema.isMaxLength(BACKUP_ERROR_MAX_LENGTH))),
  lastFile: Schema.NullOr(BackupFileInfo),
  nextRunAt: Schema.NullOr(IsoDateTime),
  running: Schema.NullOr(BackupJobSnapshot),
  /** The last attempt failed, or automatic backups are on and none succeeded for 3 days. */
  needsAttention: Schema.Boolean,
});
export type BackupStatus = typeof BackupStatus.Type;

export const BackupFolderSuggestion = Schema.Struct({
  kind: Schema.Literals(["icloud", "dropbox", "onedrive", "google-drive", "local"]),
  label: Schema.String,
  /** As saved in settings, with `~` where it applies. */
  folder: Schema.String,
  recommended: Schema.Boolean,
});
export type BackupFolderSuggestion = typeof BackupFolderSuggestion.Type;

export const BackupEmptyInput = Schema.Struct({});
export const BackupEmptyResult = Schema.Struct({});

export const BackupSetPasswordInput = Schema.Struct({
  password: Schema.String.check(Schema.isMinLength(8)),
});

export const BackupSuggestFoldersResult = Schema.Struct({
  folders: Schema.Array(BackupFolderSuggestion),
});

export const BackupListInput = Schema.Struct({
  /** Also look in every suggested folder, as restoring on a new computer does. */
  includeSuggestedFolders: Schema.optionalKey(Schema.Boolean),
});
export const BackupListResult = Schema.Struct({
  backups: Schema.Array(BackupFileInfo),
});

export const BackupFileInput = Schema.Struct({ path: Schema.String });
export const BackupDownloadUrlResult = Schema.Struct({
  url: Schema.String,
  expiresAt: IsoDateTime,
});

export const BackupUnlockInput = Schema.Struct({
  path: Schema.String,
  password: Schema.String,
});

export const BackupContents = Schema.Struct({
  workspaces: NonNegativeInt,
  chats: NonNegativeInt,
  accounts: NonNegativeInt,
  savedKeys: NonNegativeInt,
  skills: NonNegativeInt,
});
export type BackupContents = typeof BackupContents.Type;

/** What a restore would bring back, read with the backup's password. */
export const BackupRestoreSummary = Schema.Struct({
  file: BackupFileInfo,
  contents: BackupContents,
  /** The backup was made on this computer, so its identity and sign-ins stay. */
  fromThisComputer: Schema.Boolean,
  /** Null when this Codenine can restore it; otherwise why not, such as a newer Codenine. */
  blockedReason: Schema.NullOr(Schema.String),
});
export type BackupRestoreSummary = typeof BackupRestoreSummary.Type;

export const BackupRestoreResult = Schema.Struct({
  /** False when Codenine cannot restart itself here and the user has to start it again. */
  restarting: Schema.Boolean,
});

/** Left by a restore for the first start after it; cleared when dismissed. */
export const BackupRestoreReport = Schema.Struct({
  restoredAt: IsoDateTime,
  fromComputer: Schema.String,
  fromThisComputer: Schema.Boolean,
  /** Saved before restoring, so the restore can be undone until `undoUntil`. */
  safetyBackup: Schema.NullOr(BackupFileInfo),
  undoUntil: Schema.NullOr(IsoDateTime),
  accountsToSignIn: Schema.Array(
    Schema.Struct({
      instanceId: ProviderInstanceId,
      displayName: Schema.String,
      reason: Schema.String,
    }),
  ),
  missingWorkspaces: Schema.Array(
    Schema.Struct({
      projectId: ProjectId,
      title: Schema.String,
      path: Schema.String,
      remoteUrl: Schema.NullOr(Schema.String),
    }),
  ),
  /** Other browsers and computers were signed out and need to pair again. */
  devicesSignedOut: Schema.Boolean,
  /** This restore undid the one before it, which is final, so it offers no undo. */
  undone: Schema.Boolean,
});
export type BackupRestoreReport = typeof BackupRestoreReport.Type;

export const BackupRestoreReportResult = Schema.Struct({
  report: Schema.NullOr(BackupRestoreReport),
});

export class BackupError extends Schema.TaggedError<BackupError>()("BackupError", {
  reason: Schema.Literals([
    "not-configured",
    "folder-unavailable",
    "not-enough-space",
    "wrong-password",
    "unreadable",
    "newer-version",
    "busy",
    "failed",
  ]),
  /** Shown to the user as is. */
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
