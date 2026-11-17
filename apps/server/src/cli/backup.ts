import { BackupSettingsWithDefaults, type BackupRestoreReport } from "@codenine/contracts";
import { fromLenientJson } from "@codenine/shared/schemaJson";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag, GlobalFlag, Prompt } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import packageJson from "../../package.json" with { type: "json" };
import { createBackup } from "../backup/BackupArchive.ts";
import {
  applyPendingRestore,
  BACKUP_PASSWORD_SECRET,
  inspectBackup,
  prepareRestore,
  readRestoreReport,
} from "../backup/BackupRestore.ts";
import { readBackupState } from "../backup/BackupSchedule.ts";
import * as BootService from "../cloud/bootService.ts";
import type * as ServerConfig from "../config.ts";
import { resolveServerEnvironmentLabel } from "../environment/ServerEnvironmentLabel.ts";
import { expandHomePath } from "../os-jank.ts";
import * as ProcessRunner from "../processRunner.ts";
import { acquireServerOwnership } from "../serverOwnership.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import * as CliService from "./service.ts";

const decodeBackupSettings = Schema.decodeEffect(
  fromLenientJson(Schema.Struct({ backup: BackupSettingsWithDefaults })),
);

const interactive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

const userError = (message: string) => new CliError.UserError({ cause: message });

const formatBytes = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
    : bytes >= 1024 ** 2
      ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
      : `${Math.ceil(bytes / 1024)} KB`;

const readSettings = Effect.fn("cli.backup.readSettings")(function* (
  config: ServerConfig.ServerConfig["Service"],
) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(config.settingsPath).pipe(Effect.orElseSucceed(() => "{}"));
  return yield* decodeBackupSettings(raw).pipe(
    Effect.map((document) => document.backup),
    Effect.mapError(() =>
      userError(`Could not read the backup settings in ${config.settingsPath}.`),
    ),
  );
});

const readSavedPassword = Effect.fn("cli.backup.readSavedPassword")(function* (
  config: ServerConfig.ServerConfig["Service"],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs.readFile(path.join(config.secretsDir, `${BACKUP_PASSWORD_SECRET}.bin`)).pipe(
    Effect.map((bytes) => Option.some(new TextDecoder().decode(bytes))),
    Effect.orElseSucceed(() => Option.none<string>()),
  );
});

const promptPassword = (message: string) =>
  Prompt.run(Prompt.Password({ message })).pipe(
    Effect.map(Redacted.value),
    Effect.mapError(() => userError("No password was entered.")),
  );

const promptNewPassword = Effect.gen(function* () {
  if (!interactive()) {
    return yield* userError(
      "No backup password is set. Set one in Settings > Backup, or run this in a terminal.",
    );
  }
  const password = yield* promptPassword("Backup password (at least 8 characters)");
  if (password.length < 8) return yield* userError("The password needs at least 8 characters.");
  if ((yield* promptPassword("Repeat the backup password")) !== password) {
    return yield* userError("The passwords did not match.");
  }
  yield* Console.log("Keep this password: the backup cannot be opened without it.");
  return password;
});

const readEnvironmentId = Effect.fn("cli.backup.readEnvironmentId")(function* (
  config: ServerConfig.ServerConfig["Service"],
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(config.environmentIdPath).pipe(
    Effect.map((value) => value.trim()),
    Effect.orElseSucceed(() => ""),
  );
});

export const backupCommand = Command.make("backup", {
  ...projectLocationFlags,
  folder: Flag.String("folder").pipe(
    Flag.withDescription("Folder to save the backup in. Defaults to the one in Settings > Backup."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Save an encrypted backup of this Codenine folder: chats, workspaces, accounts, saved keys, settings, skills and agents.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel, { quietLogs: true });
      const path = yield* Path.Path;
      const settings = yield* readSettings(config);
      const folderSetting = Option.getOrElse(flags.folder, () => settings.folder).trim();
      if (folderSetting === "") {
        return yield* userError(
          "No backup folder is set. Pass --folder, or choose one in Settings > Backup.",
        );
      }
      const folder = path.resolve(yield* expandHomePath(folderSetting));
      const password =
        Option.getOrUndefined(yield* readSavedPassword(config)) ?? (yield* promptNewPassword);
      yield* Console.log("Backing up. This can take a few minutes.");
      const { file } = yield* createBackup({
        paths: config,
        folder,
        password,
        kind: "manual",
        includeWorktrees: settings.includeWorktrees,
        computerName: yield* resolveServerEnvironmentLabel({ cwdBaseName: "" }),
        environmentId: yield* readEnvironmentId(config),
        codenineVersion: packageJson.version,
      }).pipe(Effect.mapError((error) => userError(error.detail)));
      yield* Console.log(`Saved ${file.path} (${formatBytes(file.sizeBytes)}).`);
    }).pipe(Effect.provide(ProcessRunner.layer)),
  ),
);

const describeReport = (report: BackupRestoreReport) => {
  const lines = [
    `Restored the backup from ${report.fromComputer}.`,
    ...report.accountsToSignIn.map(
      (account) => `- Sign in to ${account.displayName} again. ${account.reason}`,
    ),
    ...report.missingWorkspaces.map(
      (workspace) =>
        `- ${workspace.title} is not on this computer at ${workspace.path}.${
          workspace.remoteUrl === null ? "" : ` Clone it from ${workspace.remoteUrl}.`
        }`,
    ),
    ...(report.devicesSignedOut
      ? ["- Other browsers and computers were signed out. Pair them again."]
      : []),
  ];
  if (report.undoUntil !== null) {
    lines.push(`You can undo this restore in Settings > Backup until ${report.undoUntil}.`);
  }
  return lines.join("\n");
};

const runRestore = Effect.fn("cli.restore")(function* (
  config: ServerConfig.ServerConfig["Service"],
  flags: { readonly file: string; readonly passwordStdin: boolean; readonly yes: boolean },
) {
  const path = yield* Path.Path;
  const filePath = path.resolve(yield* expandHomePath(flags.file));
  const password = flags.passwordStdin
    ? (yield* Stdio.Stdio.pipe(
        Effect.flatMap((stdio) => stdio.stdin.pipe(Stream.decodeText(), Stream.mkString)),
        Effect.mapError(() => userError("Could not read the password from standard input.")),
      )).replace(/\r?\n$/, "")
    : interactive()
      ? yield* promptPassword("Backup password")
      : yield* userError("Pass --password-stdin to give the backup password without a terminal.");

  const { summary } = yield* inspectBackup({ paths: config, filePath, password }).pipe(
    Effect.mapError((error) => userError(error.detail)),
  );
  const { contents, file } = summary;
  yield* Console.log(
    `Backup from ${file.computerName}, made ${file.createdAt} by Codenine ${file.codenineVersion}: ${contents.workspaces} workspaces, ${contents.chats} chats, ${contents.accounts} accounts, ${contents.savedKeys} saved keys, ${contents.skills} skills.`,
  );
  if (summary.blockedReason !== null) return yield* userError(summary.blockedReason);
  if (!flags.yes) {
    if (!interactive()) {
      return yield* userError("Pass --yes to replace this folder's data without a prompt.");
    }
    const confirmed = yield* Prompt.run(
      Prompt.Confirm({
        message: `Replace the data in ${config.baseDir} with this backup? A safety backup is saved first.`,
        initial: false,
      }),
    ).pipe(Effect.orElseSucceed(() => false));
    if (!confirmed) return yield* Console.log("Nothing changed.");
  }

  yield* Console.log("Restoring. This can take a few minutes.");
  const startedAt = yield* Clock.currentTimeMillis;
  const service = yield* BootService.BootService;
  yield* service.withStopped(
    Effect.gen(function* () {
      // The server's own lock: holding it proves no server is using this folder.
      yield* acquireServerOwnership(config.serverRuntimeStatePath).pipe(
        Effect.catchTags({
          ServerAlreadyRunningError: () =>
            Effect.fail(
              userError(
                "Codenine is running for this folder. Quit it first, or restore from Settings > Backup in the app.",
              ),
            ),
        }),
      );
      yield* prepareRestore({
        paths: config,
        filePath,
        password,
        computerName: yield* resolveServerEnvironmentLabel({ cwdBaseName: "" }),
        codenineVersion: packageJson.version,
      }).pipe(Effect.mapError((error) => userError(error.detail)));
      yield* applyPendingRestore(config);
    }).pipe(Effect.scoped),
  );
  const report = yield* readRestoreReport(config.stateDir);
  // A report from an earlier restore does not describe this one.
  if (report === null || Date.parse(report.restoredAt) < startedAt) {
    const { lastError } = yield* readBackupState(config.stateDir);
    return yield* userError(
      lastError ?? "The restore did not finish. This folder's data was left as it was.",
    );
  }
  yield* Console.log(describeReport(report));
});

export const restoreCommand = Command.make("restore", {
  ...projectLocationFlags,
  file: Argument.String("file").pipe(Argument.withDescription("The .c9backup file to restore.")),
  passwordStdin: Flag.Boolean("password-stdin").pipe(
    Flag.withDescription("Read the backup password from standard input."),
    Flag.withDefault(false),
  ),
  yes: Flag.Boolean("yes").pipe(
    Flag.withDescription("Replace this Codenine folder's data without asking."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Replace this Codenine folder's data with a backup. Saves a safety backup first and pauses the background service while it runs.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel, { quietLogs: true });
      yield* runRestore(config, flags).pipe(Effect.provide(CliService.layer(config)));
    }).pipe(Effect.provide(ProcessRunner.layer)),
  ),
);
