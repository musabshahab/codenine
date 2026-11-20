import { isAtomCommandInterrupted } from "@codenine/client-runtime/state/runtime";
import {
  AuthEnvironmentMaintainScope,
  type BackupStatus,
  type EnvironmentId,
} from "@codenine/contracts";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  DatabaseBackupIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { openRestoreDialog } from "../../backupDialogStore";
import { formatBytes } from "../../lib/formatBytes";
import { cn } from "../../lib/utils";
import { backupEnvironment } from "../../state/backup";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Progress } from "../ui/progress";
import { toastManager } from "../ui/toast";
import { type BackupTone, summarizeBackupStatus } from "./backup.logic";
import { commandErrorMessage } from "../../lib/commandError";
import { useBackupClock } from "./useBackupDateFormat";

// Static icons: the title says when a backup runs, and spinners repaint every frame.
const TONE_ICONS = {
  healthy: CircleCheckIcon,
  running: DatabaseBackupIcon,
  failed: CircleAlertIcon,
  attention: TriangleAlertIcon,
  empty: DatabaseBackupIcon,
} as const satisfies Record<BackupTone, unknown>;

/** The card at the top of Settings › Backup: an icon, what is going on, and what to do. */
export function BackupCard({
  label,
  tone,
  title,
  detail,
  actions,
  children,
}: {
  readonly label: string;
  readonly tone: BackupTone;
  readonly title: string;
  readonly detail: string | null;
  readonly actions: ReactNode;
  readonly children?: ReactNode;
}) {
  const Icon = TONE_ICONS[tone];
  const troubled = tone === "failed" || tone === "attention";
  return (
    <section
      aria-label={label}
      className={cn(
        "flex flex-col gap-3 rounded-xl border px-3 py-3.5 sm:flex-row sm:items-start sm:px-4",
        tone === "failed"
          ? "border-error/32 bg-error-surface"
          : tone === "attention"
            ? "border-warning/32 bg-warning-surface"
            : "border-border/60 bg-card/40",
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <Icon
          aria-hidden
          className={cn(
            "mt-0.5 size-5 shrink-0",
            tone === "healthy"
              ? "text-success"
              : tone === "failed"
                ? "text-error"
                : tone === "attention"
                  ? "text-warning"
                  : "text-muted-foreground",
          )}
        />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium text-foreground">{title}</p>
          {detail === null ? null : (
            <p
              className={cn(
                "text-xs break-words",
                troubled ? "text-foreground/80" : "text-muted-foreground",
              )}
            >
              {detail}
            </p>
          )}
          {children}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>
    </section>
  );
}

/** The last backup, the next one, and the two things the user comes here to do. */
export function BackupStatusCard({
  environmentId,
  status,
  canMaintain,
}: {
  readonly environmentId: EnvironmentId;
  readonly status: BackupStatus;
  readonly canMaintain: boolean;
}) {
  const { nowMs, format } = useBackupClock();
  const summary = summarizeBackupStatus(status, nowMs, format, formatBytes);
  const createBackup = useAtomCommand(backupEnvironment.create, { reportFailure: false });
  const [starting, setStarting] = useState(false);

  const backUpNow = async () => {
    if (!readEnvironmentScope(environmentId, AuthEnvironmentMaintainScope)) return;
    setStarting(true);
    const result = await createBackup({ environmentId, input: {} });
    setStarting(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: "Could not start a backup",
        description: commandErrorMessage(result, "Try again."),
      });
    }
  };

  return (
    <BackupCard
      label="Backup status"
      tone={summary.tone}
      title={summary.title}
      detail={summary.detail}
      actions={
        <>
          <Button
            size="sm"
            disabled={!canMaintain || starting || summary.tone === "running"}
            onClick={() => void backUpNow()}
          >
            {summary.tone === "failed" || summary.tone === "attention"
              ? "Try again"
              : "Back up now"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!canMaintain}
            onClick={() => openRestoreDialog({ environmentId })}
          >
            Restore…
          </Button>
        </>
      }
    >
      {summary.percent === null ? null : (
        <Progress aria-label="Backup progress" max={100} value={summary.percent} />
      )}
    </BackupCard>
  );
}
