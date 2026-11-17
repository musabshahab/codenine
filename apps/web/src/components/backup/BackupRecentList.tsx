import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted } from "@codenine/client-runtime/state/runtime";
import {
  AuthEnvironmentMaintainScope,
  type BackupFileInfo,
  type EnvironmentId,
} from "@codenine/contracts";
import { AsyncResult } from "effect/reactivity";
import { MoreVerticalIcon } from "lucide-react";
import { useState } from "react";

import { openRestoreDialog } from "../../backupDialogStore";
import { formatBytes } from "../../lib/formatBytes";
import { backupEnvironment } from "../../state/backup";
import { formatEnvironmentQueryError } from "../../state/query";
import { readEnvironmentScope, readPreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { searchableSetting } from "../settings/settingsSearch";
import { BACKUP_KIND_LABELS, capitalize, dayAndTime } from "./backup.logic";
import { commandErrorMessage } from "./commandError";
import { useBackupClock } from "./useBackupDateFormat";

const RECENT_COUNT = 5;

export function BackupRecentList({
  environmentId,
  canMaintain,
}: {
  readonly environmentId: EnvironmentId;
  readonly canMaintain: boolean;
}) {
  const backupsAtom = backupEnvironment.backups(environmentId);
  const result = useAtomValue(backupsAtom);
  const refresh = useAtomRefresh(backupsAtom);
  const { nowMs, format } = useBackupClock();
  const downloadUrl = useAtomCommand(backupEnvironment.downloadUrl, { reportFailure: false });
  const [showAll, setShowAll] = useState(false);
  const [deleting, setDeleting] = useState<BackupFileInfo | null>(null);
  const backups = AsyncResult.getOrElse(result, () => null)?.toSorted(
    (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
  );
  const shown = showAll ? backups : backups?.slice(0, RECENT_COUNT);
  const madeAt = (file: BackupFileInfo) => capitalize(dayAndTime(file.createdAt, nowMs, format));

  const download = async (file: BackupFileInfo) => {
    if (!readEnvironmentScope(environmentId, AuthEnvironmentMaintainScope)) return;
    const link = await downloadUrl({ environmentId, input: { path: file.path } });
    if (link._tag === "Failure") {
      if (!isAtomCommandInterrupted(link)) {
        toastManager.add({
          type: "error",
          title: "Could not download the backup",
          description: commandErrorMessage(link, "Try again."),
        });
      }
      return;
    }
    // The server may answer with a path on its own origin, which differs on a remote machine.
    const base = readPreparedConnection(environmentId)?.httpBaseUrl ?? window.location.href;
    const anchor = document.createElement("a");
    anchor.href = new URL(link.value.url, base).toString();
    anchor.download = file.fileName;
    anchor.rel = "noopener";
    anchor.click();
  };

  return (
    <SettingsSection {...searchableSetting("backup-recent")}>
      {shown === undefined ? (
        <SettingsRow
          title={result._tag === "Failure" ? "Could not list backups" : "Looking for backups…"}
          description={
            result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : undefined
          }
          control={
            result._tag === "Failure" ? (
              <Button size="sm" variant="outline" onClick={refresh}>
                Try again
              </Button>
            ) : undefined
          }
        />
      ) : shown.length === 0 ? (
        <SettingsRow
          title="No backups yet"
          description="Backups appear here once Codenine has made one."
        />
      ) : (
        shown.map((file) => (
          <SettingsRow
            key={file.path}
            title={madeAt(file)}
            description={`${formatBytes(file.sizeBytes)} · ${BACKUP_KIND_LABELS[file.kind]}`}
            control={
              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canMaintain}
                  onClick={() => openRestoreDialog({ environmentId, path: file.path })}
                >
                  Restore
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canMaintain}
                  onClick={() => void download(file)}
                >
                  Download
                </Button>
                <Menu>
                  <MenuTrigger
                    disabled={!canMaintain}
                    render={
                      <Button
                        size="icon-sm"
                        variant="ghost-muted"
                        aria-label={`More actions for the backup from ${madeAt(file)}`}
                      />
                    }
                  >
                    <MoreVerticalIcon />
                  </MenuTrigger>
                  <MenuPopup align="end">
                    <MenuItem variant="destructive" onClick={() => setDeleting(file)}>
                      Delete
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              </div>
            }
          />
        ))
      )}
      {backups !== undefined && backups.length > RECENT_COUNT ? (
        <div className="px-3 py-2 sm:px-4">
          <Button size="sm" variant="ghost" onClick={() => setShowAll(!showAll)}>
            {showAll ? "Show fewer" : "Show all backups"}
          </Button>
        </div>
      ) : null}
      {deleting === null ? null : (
        <DeleteBackupDialog
          environmentId={environmentId}
          file={deleting}
          madeAt={dayAndTime(deleting.createdAt, nowMs, format)}
          onClose={() => setDeleting(null)}
        />
      )}
    </SettingsSection>
  );
}

function DeleteBackupDialog({
  environmentId,
  file,
  madeAt,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly file: BackupFileInfo;
  readonly madeAt: string;
  readonly onClose: () => void;
}) {
  const deleteBackup = useAtomCommand(backupEnvironment.delete, { reportFailure: false });
  const [deleting, setDeleting] = useState(false);
  const confirm = async () => {
    if (!readEnvironmentScope(environmentId, AuthEnvironmentMaintainScope)) return;
    setDeleting(true);
    const result = await deleteBackup({ environmentId, input: { path: file.path } });
    setDeleting(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: "Could not delete the backup",
        description: commandErrorMessage(result, "Try again."),
      });
      return;
    }
    onClose();
  };
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !deleting) onClose();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this backup?</AlertDialogTitle>
          <AlertDialogDescription>
            {`The backup from ${madeAt} (${formatBytes(file.sizeBytes)}) is deleted from the backup folder. This can't be undone.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" disabled={deleting} />}>
            Cancel
          </AlertDialogClose>
          <Button variant="destructive" disabled={deleting} onClick={() => void confirm()}>
            {deleting ? "Deleting…" : "Delete"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
