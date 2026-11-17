import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted } from "@codenine/client-runtime/state/runtime";
import {
  AuthEnvironmentMaintainScope,
  type BackupRestoreReport,
  type EnvironmentId,
  type ProviderInstanceId,
} from "@codenine/contracts";
import { Link } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { CircleCheckIcon } from "lucide-react";
import { lazy, type ReactNode, Suspense, useState } from "react";

import {
  restoreReportKey,
  setRestoreReportHidden,
  useBackupDialogStore,
} from "../../backupDialogStore";
import { useProjectGroupUpdate } from "../../hooks/useProjectGroupUpdate";
import { openNewProjectDialog } from "../../newProjectDialogStore";
import {
  type AgentSetupDriver,
  isAgentSetupDriver,
} from "../../onboarding/providerReadiness.logic";
import { backupEnvironment, restoreReportsAtom } from "../../state/backup";
import { environmentIdsKey } from "../../state/environmentAtomList";
import { useConnectedEnvironmentIds, useEnvironment } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
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
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { undoAvailability } from "./backup.logic";
import { commandErrorMessage } from "../../lib/commandError";
import { useAwaitRestartThenReload } from "./useAwaitRestartThenReload";
import { useBackupClock } from "./useBackupDateFormat";

// Holds a terminal, so it loads only when an account needs signing in.
const AgentSetupDialog = lazy(() => import("../onboarding/AgentSetupDialog"));

/** Shows what is left to do after a restore, on the first start after it, until Done. */
export function RestoreReportCoordinator() {
  const environmentIds = useConnectedEnvironmentIds();
  const results = useAtomValue(restoreReportsAtom(environmentIdsKey(environmentIds)));
  const hiddenReports = useBackupDialogStore((state) => state.hiddenReports);
  const shown = environmentIds.flatMap((environmentId, index) => {
    const result = results[index];
    const report = result === undefined ? null : AsyncResult.getOrElse(result, () => null)?.report;
    if (report === undefined || report === null) return [];
    const key = restoreReportKey(environmentId, report.restoredAt);
    return hiddenReports.has(key) ? [] : [{ environmentId, report, key }];
  })[0];
  return shown === undefined ? null : (
    <RestoreReportDialog
      key={shown.key}
      reportKey={shown.key}
      environmentId={shown.environmentId}
      report={shown.report}
    />
  );
}

type Phase = "report" | "restarting" | "notBack" | "finishByHand";

function RestoreReportDialog({
  reportKey,
  environmentId,
  report,
}: {
  readonly reportKey: string;
  readonly environmentId: EnvironmentId;
  readonly report: BackupRestoreReport;
}) {
  const { nowMs } = useBackupClock();
  const canMaintain = useAtomValue(
    backupEnvironment.dismissRestoreReport.permissionAtom(environmentId),
  );
  const dismiss = useAtomCommand(backupEnvironment.dismissRestoreReport, { reportFailure: false });
  const undoRestore = useAtomCommand(backupEnvironment.undoRestore, { reportFailure: false });
  const awaitRestart = useAwaitRestartThenReload(environmentId);
  const [phase, setPhase] = useState<Phase>("report");
  const [busy, setBusy] = useState(false);
  const [confirmingUndo, setConfirmingUndo] = useState(false);
  const undoLabel = report.safetyBackup === null ? null : undoAvailability(report.undoUntil, nowMs);
  const closable = phase !== "restarting" && !busy;
  const hide = () => setRestoreReportHidden(reportKey, true);

  // Closes right away; the report only comes back if the server did not let it go.
  const done = async () => {
    hide();
    if (!readEnvironmentScope(environmentId, AuthEnvironmentMaintainScope)) return;
    const result = await dismiss({ environmentId, input: {} });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setRestoreReportHidden(reportKey, false);
      toastManager.add({
        type: "error",
        title: "Could not close the restore report",
        description: commandErrorMessage(result, "Try again."),
      });
    }
  };

  const undo = async () => {
    setConfirmingUndo(false);
    if (!readEnvironmentScope(environmentId, AuthEnvironmentMaintainScope)) return;
    setBusy(true);
    const result = await undoRestore({ environmentId, input: {} });
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: "Could not undo the restore",
          description: commandErrorMessage(result, "Try again."),
        });
      }
      return;
    }
    if (!result.value.restarting) {
      setPhase("finishByHand");
      return;
    }
    setPhase("restarting");
    if (!(await awaitRestart())) setPhase("notBack");
  };

  return (
    <Dialog
      open
      // The New workspace dialog and Settings open over this one; a press there is not a dismissal.
      disablePointerDismissal
      onOpenChange={(open) => {
        if (!open && closable) hide();
      }}
    >
      <DialogPopup className="max-w-xl" showCloseButton={closable}>
        {phase === "restarting" ? (
          <DialogHeader>
            <DialogTitle>Undoing the restore…</DialogTitle>
            <DialogDescription>
              Codenine is restarting. It takes a minute or two, and this window reloads when it is
              back.
            </DialogDescription>
          </DialogHeader>
        ) : phase === "notBack" ? (
          <>
            <DialogHeader>
              <DialogTitle>Codenine has not come back yet</DialogTitle>
              <DialogDescription>
                The undo may still be finishing. Reload to check again.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button size="sm" onClick={() => window.location.reload()}>
                Reload
              </Button>
            </DialogFooter>
          </>
        ) : phase === "finishByHand" ? (
          <>
            <DialogHeader>
              <DialogTitle>Almost done</DialogTitle>
              <DialogDescription>
                Quit Codenine and open it again to finish undoing the restore.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button size="sm" onClick={hide}>
                Close
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <CircleCheckIcon aria-hidden className="size-7 text-success" />
              <DialogTitle>{report.undone ? "Restore undone" : "Restore complete"}</DialogTitle>
              <DialogDescription>
                {report.undone
                  ? "What was on this computer before the restore is back."
                  : `Your chats, workspaces, accounts and settings from ${report.fromComputer} are back.`}
              </DialogDescription>
            </DialogHeader>
            <ReportTasks environmentId={environmentId} report={report} />
            <DialogFooter className="sm:items-center">
              {undoLabel === null ? null : (
                <div className="flex flex-col gap-1.5 sm:me-auto sm:flex-row sm:items-center sm:gap-3">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!canMaintain || busy}
                    onClick={() => setConfirmingUndo(true)}
                  >
                    Undo restore
                  </Button>
                  <p className="text-xs text-muted-foreground sm:max-w-52">
                    Brings back what was on this computer before. {undoLabel}
                  </p>
                </div>
              )}
              <Button size="sm" disabled={busy} onClick={() => void done()}>
                Done
              </Button>
            </DialogFooter>
          </>
        )}
        <AlertDialog open={confirmingUndo} onOpenChange={setConfirmingUndo}>
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>Undo the restore?</AlertDialogTitle>
              <AlertDialogDescription>
                Codenine brings back what was on this computer before the restore, then restarts.
                Anything you changed since the restore is lost.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
              <Button variant="destructive" onClick={() => void undo()}>
                Undo and restart
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      </DialogPopup>
    </Dialog>
  );
}

function ReportTask({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:gap-4">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-xs break-words text-muted-foreground">{description}</p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-1.5">{children}</div>
    </li>
  );
}

function ReportTasks({
  environmentId,
  report,
}: {
  readonly environmentId: EnvironmentId;
  readonly report: BackupRestoreReport;
}) {
  const environment = useEnvironment(environmentId);
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const { updateProjectGroup } = useProjectGroupUpdate();
  const [setupFor, setSetupFor] = useState<{
    readonly driver: AgentSetupDriver;
    readonly instanceId: ProviderInstanceId;
  } | null>(null);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const hasTasks =
    report.accountsToSignIn.length > 0 ||
    report.missingWorkspaces.length > 0 ||
    report.devicesSignedOut;
  if (!hasTasks) return null;

  const remove = async (workspace: BackupRestoreReport["missingWorkspaces"][number]) => {
    const result = await updateProjectGroup(
      [
        {
          environmentId,
          id: workspace.projectId,
          environmentLabel: environment?.label ?? null,
        },
      ],
      { archived: true },
      `Could not remove ${workspace.title}`,
    );
    if (result._tag !== "Success") return;
    setRemoved(new Set([...removed, workspace.projectId]));
    toastManager.add({
      type: "success",
      title: `Removed ${workspace.title}`,
      description: "Its chats are kept in the archive. Add its folder again to bring it back.",
    });
  };

  return (
    <DialogPanel>
      <section className="space-y-3">
        <h3 className="text-sm font-medium text-foreground">A few things need you</h3>
        <ul className="divide-y divide-border/60">
          {report.accountsToSignIn.map((account) => {
            const driver = providers?.find(
              (provider) => provider.instanceId === account.instanceId,
            )?.driver;
            return (
              <ReportTask
                key={account.instanceId}
                title={`Sign in to ${account.displayName}`}
                description={account.reason}
              >
                {driver !== undefined && isAgentSetupDriver(driver) ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setSetupFor({ driver, instanceId: account.instanceId })}
                  >
                    Sign in
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    render={
                      <Link
                        to="/settings/providers"
                        search={{ environmentId, instanceId: account.instanceId }}
                      />
                    }
                  >
                    Sign in
                  </Button>
                )}
              </ReportTask>
            );
          })}
          {report.missingWorkspaces.map((workspace) => {
            const { remoteUrl } = workspace;
            return (
              <ReportTask
                key={workspace.projectId}
                title={`Find the ${workspace.title} workspace's folder`}
                description={`It lived outside your Codenine folder, at ${workspace.path}, so it was not in the backup.`}
              >
                {removed.has(workspace.projectId) ? (
                  <span className="text-xs text-muted-foreground">Removed</span>
                ) : (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        openNewProjectDialog({
                          environmentId,
                          source: "folder",
                          name: workspace.title,
                          folderPath: workspace.path,
                        })
                      }
                    >
                      Find folder
                    </Button>
                    {remoteUrl === null ? null : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          openNewProjectDialog({
                            environmentId,
                            source: "clone",
                            name: workspace.title,
                            repository: remoteUrl,
                          })
                        }
                      >
                        Clone again
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => void remove(workspace)}>
                      Remove
                    </Button>
                  </>
                )}
              </ReportTask>
            );
          })}
          {report.devicesSignedOut ? (
            <ReportTask
              title="Connect your other devices again"
              description="Other browsers and computers were signed out. A pairing link connects each one again."
            >
              <Button
                size="sm"
                variant="outline"
                render={
                  <Link
                    to="/settings/access"
                    search={{ machine: environmentId }}
                    hash="authorized-clients"
                  />
                }
              >
                Show pairing link
              </Button>
            </ReportTask>
          ) : null}
        </ul>
      </section>
      {setupFor === null ? null : (
        <Suspense fallback={null}>
          <AgentSetupDialog
            environmentId={environmentId}
            agent={setupFor}
            startWith="signIn"
            onClose={() => setSetupFor(null)}
          />
        </Suspense>
      )}
    </DialogPanel>
  );
}
