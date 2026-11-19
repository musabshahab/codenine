import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted } from "@codenine/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  type BackupFrequency,
  type BackupSettings,
  type BackupStatus,
  EnvironmentId,
} from "@codenine/contracts";
import { useSearch } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { CheckIcon } from "lucide-react";
import { useState } from "react";

import {
  openRestoreDialog,
  restoreReportKey,
  setRestoreReportHidden,
  useBackupDialogStore,
} from "../../backupDialogStore";
import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { backupEnvironment } from "../../state/backup";
import type { EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { shellEnvironment } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { EnvironmentPagePicker } from "../settings/EnvironmentPagePicker";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSearchTarget,
  SettingsSection,
} from "../settings/settingsLayout";
import { searchableSetting } from "../settings/settingsSearch";
import { useAccessEnvironment } from "../settings/useAccessEnvironment";
import {
  folderLabel,
  keepLabel,
  keepOptions,
  scheduleTimeOptions,
  wallTimeLabel,
  WEEKDAY_NAMES,
} from "./backup.logic";
import { BackupFolderDialog } from "./BackupFolderChoice";
import { BackupPasswordDialog } from "./BackupPasswordFields";
import { BackupRecentList } from "./BackupRecentList";
import { BackupSetupDialog } from "./BackupSetupDialog";
import { BackupCard, BackupStatusCard } from "./BackupStatusCard";
import { commandErrorMessage } from "../../lib/commandError";
import { useBackupDateFormat } from "./useBackupDateFormat";

const FREQUENCIES = [
  { value: "off", label: "Off" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
] as const satisfies ReadonlyArray<{ value: BackupFrequency; label: string }>;

const BACKUP_CONTENTS = [
  "Chats, with their history and attachments",
  "Workspaces in your Codenine folder, leaving out files Git ignores, like node_modules",
  "Accounts you added in Codenine, and your saved keys",
  "Settings, skills, agents and workflows",
] as const;

/** Settings › Backup, for one machine at a time. */
export function BackupSettingsPanel() {
  // A link that names a machine, such as the backup notice's, opens the page on it.
  const linkedEnvironmentId = useSearch({
    strict: false,
    select: (search) =>
      typeof search.machine === "string" ? EnvironmentId.make(search.machine) : null,
  });
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState(linkedEnvironmentId);
  const { candidates, environment, label } = useAccessEnvironment(selectedEnvironmentId);
  return (
    <SettingsPageContainer>
      <div className="space-y-1.5 px-3 sm:px-4">
        <h1 className="text-xl font-semibold text-foreground">Backup</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Keep a copy of your chats, workspaces, accounts and settings. Use it to recover from a
          problem or to move to a new computer.
        </p>
      </div>
      {candidates.length > 1 && environment !== null ? (
        <EnvironmentPagePicker
          label="Showing backups for"
          candidates={candidates}
          value={environment.environmentId}
          onChange={setSelectedEnvironmentId}
        />
      ) : null}
      {environment === null ? (
        <p className="px-3 text-sm text-muted-foreground sm:px-4">
          Connect a computer to back it up.
        </p>
      ) : (
        // Keyed so dialogs and pending work never carry over to another machine.
        <BackupMachineSettings
          key={environment.environmentId}
          environment={environment}
          label={label ?? environment.label}
        />
      )}
    </SettingsPageContainer>
  );
}

function BackupMachineSettings({
  environment,
  label,
}: {
  readonly environment: EnvironmentPresentation;
  readonly label: string;
}) {
  const { environmentId } = environment;
  const connected = environment.connection.phase === "connected";
  const status = useEnvironmentQuery(
    connected ? backupEnvironment.status({ environmentId, input: {} }) : null,
  );
  const canMaintain = useAtomValue(backupEnvironment.create.permissionAtom(environmentId));
  const canWriteSettings = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [dialog, setDialog] = useState<"setup" | "folder" | "password" | null>(null);

  if (!connected) {
    return (
      <p className="px-3 text-sm text-muted-foreground sm:px-4">
        Reconnect {label} to manage its backups.
      </p>
    );
  }
  if (status.data === null) {
    return status.error === null ? (
      <p className="px-3 text-sm text-muted-foreground sm:px-4">Checking backups…</p>
    ) : (
      <SettingsSection id="backup-status" title="Backups unavailable" hideTitle>
        <SettingsRow
          title={`Backups are not available on ${label}`}
          description={status.error}
          control={
            <Button size="sm" variant="outline" onClick={status.refresh}>
              Try again
            </Button>
          }
        />
      </SettingsSection>
    );
  }
  const current = status.data;
  // From the settings stream, which answers a save before the backup service does.
  const settings = environment.serverConfig?.settings.backup ?? current.settings;
  const save = (backup: BackupSettings) => updateSettings({ backup });

  return (
    <>
      {canMaintain ? null : (
        <p className="px-3 text-sm text-muted-foreground sm:px-4">
          This connection cannot manage backups on {label}.
        </p>
      )}
      <RestoreReportNotice environmentId={environmentId} />
      <SettingsSearchTarget id="backup-status">
        {current.configured ? (
          <BackupStatusCard
            environmentId={environmentId}
            status={current}
            canMaintain={canMaintain}
          />
        ) : (
          <TurnOnBackups
            canTurnOn={canMaintain && canWriteSettings}
            canRestore={canMaintain}
            onTurnOn={() => setDialog("setup")}
            onRestore={() => openRestoreDialog({ environmentId })}
          />
        )}
      </SettingsSearchTarget>
      {current.configured ? (
        <>
          <ScheduleSection settings={settings} disabled={!canWriteSettings} onChange={save} />
          <FolderSection
            environment={environment}
            status={current}
            settings={settings}
            canChange={canWriteSettings}
            onChange={() => setDialog("folder")}
          />
          <SettingsSection id="backup-protection" title="Protection">
            <SettingsRow
              id={searchableSetting("backup-password").id}
              title="Every backup is encrypted with your backup password"
              description="You need it to restore. Codenine cannot recover it, so keep it in a password manager."
              control={
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canMaintain}
                  onClick={() => setDialog("password")}
                >
                  Change password
                </Button>
              }
            />
          </SettingsSection>
        </>
      ) : null}
      <ContentsSection settings={settings} disabled={!canWriteSettings} onChange={save} />
      {current.configured ? (
        <BackupRecentList environmentId={environmentId} canMaintain={canMaintain} />
      ) : null}
      {dialog === "setup" ? (
        <BackupSetupDialog
          environmentId={environmentId}
          environmentLabel={label}
          settings={settings}
          onClose={() => setDialog(null)}
        />
      ) : dialog === "folder" ? (
        <BackupFolderDialog
          environmentId={environmentId}
          settings={settings}
          onClose={() => setDialog(null)}
        />
      ) : dialog === "password" ? (
        <BackupPasswordDialog environmentId={environmentId} onClose={() => setDialog(null)} />
      ) : null}
    </>
  );
}

function TurnOnBackups({
  canTurnOn,
  canRestore,
  onTurnOn,
  onRestore,
}: {
  readonly canTurnOn: boolean;
  readonly canRestore: boolean;
  readonly onTurnOn: () => void;
  readonly onRestore: () => void;
}) {
  return (
    <BackupCard
      label="Turn on backups"
      tone="empty"
      title="Backups are off"
      detail="Turn them on to keep a copy somewhere that survives losing this computer."
      actions={
        <>
          <Button size="sm" disabled={!canTurnOn} onClick={onTurnOn}>
            Turn on backups
          </Button>
          <Button size="sm" variant="outline" disabled={!canRestore} onClick={onRestore}>
            Restore…
          </Button>
        </>
      }
    />
  );
}

function ScheduleSection({
  settings,
  disabled,
  onChange,
}: {
  readonly settings: BackupSettings;
  readonly disabled: boolean;
  readonly onChange: (settings: BackupSettings) => void;
}) {
  const format = useBackupDateFormat();
  const { schedule } = settings;
  const setSchedule = (patch: Partial<BackupSettings["schedule"]>) =>
    onChange({ ...settings, schedule: { ...schedule, ...patch } });
  return (
    <SettingsSection {...searchableSetting("backup-schedule")}>
      <SettingsRow
        title="How often"
        description="If this computer is asleep or off at that time, Codenine backs up as soon as it is back."
        control={
          <ToggleGroup
            aria-label="How often"
            variant="segmented"
            disabled={disabled}
            value={[schedule.frequency]}
            onValueChange={(next) => {
              const frequency = FREQUENCIES.find((option) => option.value === next[0])?.value;
              if (frequency !== undefined) setSchedule({ frequency });
            }}
          >
            {FREQUENCIES.map((option) => (
              <Toggle key={option.value} value={option.value}>
                {option.label}
              </Toggle>
            ))}
          </ToggleGroup>
        }
      >
        {schedule.frequency === "off" ? null : (
          <div className="flex flex-wrap items-center gap-2 pb-2 text-sm text-muted-foreground">
            {schedule.frequency === "weekly" ? (
              <>
                <span>Every</span>
                <Select
                  value={schedule.weekday}
                  disabled={disabled}
                  onValueChange={(weekday) => {
                    if (typeof weekday === "number") setSchedule({ weekday });
                  }}
                >
                  <SelectTrigger size="sm" className="w-auto" aria-label="Day">
                    <SelectValue>{(weekday: number) => WEEKDAY_NAMES[weekday]}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {WEEKDAY_NAMES.map((name, weekday) => (
                      <SelectItem hideIndicator key={name} value={weekday}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <span>at</span>
              </>
            ) : (
              <span>At</span>
            )}
            <Select
              value={schedule.time}
              disabled={disabled}
              onValueChange={(time) => {
                if (typeof time === "string") setSchedule({ time });
              }}
            >
              <SelectTrigger size="sm" className="w-auto" aria-label="Time">
                <SelectValue>{(time: string) => wallTimeLabel(time, format)}</SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {scheduleTimeOptions(schedule.time).map((time) => (
                  <SelectItem hideIndicator key={time} value={time}>
                    {wallTimeLabel(time, format)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        )}
      </SettingsRow>
      <SettingsRow
        title="Keep"
        description="Older automatic backups are deleted. Backups you make yourself stay until you delete them."
        control={
          <Select
            value={settings.keep}
            disabled={disabled}
            onValueChange={(keep) => {
              if (typeof keep === "number") onChange({ ...settings, keep });
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Keep">
              <SelectValue>{(keep: number) => keepLabel(keep)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {keepOptions(settings.keep).map((keep) => (
                <SelectItem hideIndicator key={keep} value={keep}>
                  {keepLabel(keep)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}

function FolderSection({
  environment,
  status,
  settings,
  canChange,
  onChange,
}: {
  readonly environment: EnvironmentPresentation;
  readonly status: BackupStatus;
  readonly settings: BackupSettings;
  readonly canChange: boolean;
  readonly onChange: () => void;
}) {
  const { environmentId } = environment;
  const suggestions = AsyncResult.getOrElse(
    useAtomValue(backupEnvironment.suggestedFolders(environmentId)),
    () => [],
  );
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  const folderPath = status.folderPath;
  const title = folderLabel(settings.folder, suggestions);
  const canOpen =
    folderPath !== null &&
    environment.serverConfig?.availableEditors.includes("file-manager") === true;

  const openFolder = async () => {
    if (
      folderPath === null ||
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
    ) {
      return;
    }
    const result = await openInEditor({
      environmentId,
      input: { cwd: folderPath, editor: "file-manager" },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: "Could not open the backup folder",
        description: commandErrorMessage(result, "Try again."),
      });
    }
  };

  return (
    <SettingsSection {...searchableSetting("backup-folder")}>
      <SettingsRow
        title={<span className="break-all">{title}</span>}
        description={
          <>
            {title === settings.folder ? null : (
              <span className="mb-1 block font-mono break-all text-foreground">
                {folderPath ?? settings.folder}
              </span>
            )}
            Somewhere that survives losing this computer, like a synced cloud folder or an external
            drive, keeps your backups safe.
          </>
        }
        control={
          <div className="flex shrink-0 items-center gap-2">
            <Button size="sm" variant="outline" disabled={!canChange} onClick={onChange}>
              Change
            </Button>
            {canOpen ? (
              <Button size="sm" variant="outline" onClick={() => void openFolder()}>
                Open
              </Button>
            ) : null}
          </div>
        }
      />
    </SettingsSection>
  );
}

function ContentsSection({
  settings,
  disabled,
  onChange,
}: {
  readonly settings: BackupSettings;
  readonly disabled: boolean;
  readonly onChange: (settings: BackupSettings) => void;
}) {
  return (
    <SettingsSection id="backup-contents" title="What a backup holds">
      <ul className="space-y-2 px-3 py-3 text-sm text-foreground sm:px-4">
        {BACKUP_CONTENTS.map((line) => (
          <li key={line} className="flex items-start gap-2">
            <CheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
            {line}
          </li>
        ))}
      </ul>
      <SettingsSearchTarget id={searchableSetting("backup-worktrees").id}>
        <label className="flex cursor-pointer items-start gap-3 px-3 py-3 has-disabled:cursor-not-allowed sm:px-4">
          <span className="flex h-5 items-center">
            <Checkbox
              checked={settings.includeWorktrees}
              disabled={disabled}
              onCheckedChange={(includeWorktrees) => onChange({ ...settings, includeWorktrees })}
            />
          </span>
          <span className="min-w-0 space-y-1">
            <span className="block text-sm font-medium text-foreground">
              Also keep unfinished task copies (worktrees)
            </span>
            <span className="block text-xs text-muted-foreground">
              Bigger backups. Without them, an unfinished task restarts from its branch and loses
              changes not yet committed.
            </span>
          </span>
        </label>
      </SettingsSearchTarget>
      <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">
        Not included: workspaces kept elsewhere on this computer, which stay where they are, and
        Codenine's caches and downloads.
      </p>
    </SettingsSection>
  );
}

/** A restore report the user closed before finishing, so it can be opened again from here. */
function RestoreReportNotice({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const report = useEnvironmentQuery(backupEnvironment.restoreReport({ environmentId, input: {} }))
    .data?.report;
  const hiddenReports = useBackupDialogStore((state) => state.hiddenReports);
  if (report === undefined || report === null) return null;
  const key = restoreReportKey(environmentId, report.restoredAt);
  if (!hiddenReports.has(key)) return null;
  return (
    <SettingsSection id="backup-restore-report" title="Last restore" hideTitle>
      <SettingsRow
        title={report.undone ? "Restore undone" : `Restored from ${report.fromComputer}`}
        description={
          report.undone
            ? "A few things may still need you."
            : "A few things may still need you, and you can undo the restore from there."
        }
        control={
          <Button size="sm" variant="outline" onClick={() => setRestoreReportHidden(key, false)}>
            Review
          </Button>
        }
      />
    </SettingsSection>
  );
}
