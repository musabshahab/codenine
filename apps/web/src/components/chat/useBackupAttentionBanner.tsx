import { useAtomValue } from "@effect/atom-react";
import type { BackupStatus, EnvironmentId } from "@codenine/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult, Atom } from "effect/reactivity";
import { DatabaseBackupIcon } from "lucide-react";

import { dismissBackupAttention, useBackupDialogStore } from "../../backupDialogStore";
import { backupEnvironment } from "../../state/backup";
import { backupAttentionMessage } from "../backup/backup.logic";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

const EMPTY_STATUS_ATOM = Atom.make(AsyncResult.initial<BackupStatus, unknown>()).pipe(
  Atom.withLabel("web-backup-status:empty"),
);

// Strings, so the progress a running backup reports does not re-render the composer.
const selectMessage = (result: AsyncResult.AsyncResult<BackupStatus, unknown>) => {
  const status = AsyncResult.getOrElse(result, () => null);
  return status === null ? null : backupAttentionMessage(status);
};
const selectLastAttempt = (result: AsyncResult.AsyncResult<BackupStatus, unknown>) =>
  AsyncResult.getOrElse(result, () => null)?.lastAttemptAt ?? null;

/** A calm notice when the machine's backups need attention, until the user dismisses it. */
export function useBackupAttentionBanner(
  environmentId: EnvironmentId | null,
  machineLabel: string | null,
): ComposerBannerStackItem | null {
  const statusAtom =
    environmentId === null
      ? EMPTY_STATUS_ATOM
      : backupEnvironment.status({ environmentId, input: {} });
  const message = useAtomValue(statusAtom, selectMessage);
  const lastAttempt = useAtomValue(statusAtom, selectLastAttempt);
  const dismissed = useBackupDialogStore((state) => state.dismissedAttention);
  const navigate = useNavigate();
  if (environmentId === null || message === null) return null;
  const key = JSON.stringify([environmentId, lastAttempt, message]);
  if (dismissed.has(key)) return null;
  return {
    id: `backup-attention:${environmentId}`,
    variant: "default",
    group: "environment",
    icon: <DatabaseBackupIcon />,
    title:
      machineLabel === null
        ? "Backups need attention"
        : `Backups on ${machineLabel} need attention`,
    description: message,
    actions: (
      <Button
        size="xs"
        variant="ghost"
        onClick={() =>
          void navigate({ to: "/settings/backup", search: { machine: environmentId } })
        }
      >
        Open Backup settings
      </Button>
    ),
    dismissLabel: "Dismiss backup notice",
    onDismiss: () => dismissBackupAttention(key),
  };
}
