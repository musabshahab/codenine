import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted } from "@codenine/client-runtime/state/runtime";
import {
  AuthEnvironmentMaintainScope,
  type BackupFileInfo,
  type BackupRestoreSummary,
  type EnvironmentId,
} from "@codenine/contracts";
import { AsyncResult } from "effect/reactivity";
import { TriangleAlertIcon } from "lucide-react";
import { useId, useState } from "react";

import {
  clearRestoreDialog,
  closeRestoreDialog,
  type RestoreDialogRequest,
  useBackupDialogStore,
} from "../../backupDialogStore";
import { formatBytes } from "../../lib/formatBytes";
import { backupEnvironment } from "../../state/backup";
import { formatEnvironmentQueryError } from "../../state/query";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button, InlineButton } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { RadioCard, RadioGroup } from "../ui/radio-group";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup, WizardSteps } from "../ui/wizard";
import {
  capitalize,
  dayAndTime,
  nextRestoreFlow,
  OTHER_CHOICE,
  RESTORE_STEPS,
  restoreContentLines,
  type BackupDateFormat,
  type RestoreFlowEvent,
  restoreStepIndex,
  startRestoreFlow,
} from "./backup.logic";
import { FieldError } from "./BackupPasswordFields";
import { useAwaitRestartThenReload } from "./useAwaitRestartThenReload";
import { commandErrorMessage } from "./commandError";
import { useBackupClock } from "./useBackupDateFormat";

/** Hosted once at the root, so Settings, the Welcome page, and a backup row open the same flow. */
export function RestoreBackupDialogHost() {
  const request = useBackupDialogStore((state) => state.restore);
  const open = useBackupDialogStore((state) => state.restoreOpen);
  const session = useBackupDialogStore((state) => state.restoreSession);
  return request === null ? null : (
    <RestoreBackupDialog key={session} request={request} open={open} />
  );
}

function RestoreBackupDialog({
  request,
  open,
}: {
  readonly request: RestoreDialogRequest;
  readonly open: boolean;
}) {
  const { environmentId } = request;
  const restore = useAtomCommand(backupEnvironment.restore, { reportFailure: false });
  const awaitRestart = useAwaitRestartThenReload(environmentId);
  const [flow, setFlow] = useState(() => startRestoreFlow(request.path ?? null));
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const dispatch = (event: RestoreFlowEvent) => {
    setRestoreError(null);
    setFlow((current) => nextRestoreFlow(current, event));
  };
  const busy = restoring || flow.step === "restarting";

  const startRestore = async (path: string, password: string) => {
    if (restoring) return;
    if (!readEnvironmentScope(environmentId, AuthEnvironmentMaintainScope)) {
      setRestoreError("This connection cannot restore backups.");
      return;
    }
    setRestoring(true);
    setRestoreError(null);
    const result = await restore({ environmentId, input: { path, password } });
    setRestoring(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setRestoreError(commandErrorMessage(result, "The restore did not start."));
      }
      return;
    }
    if (!result.value.restarting) {
      dispatch({ type: "finishByHand" });
      return;
    }
    dispatch({ type: "restarting" });
    if (!(await awaitRestart())) dispatch({ type: "notBack" });
  };
  const steps =
    flow.step === "choose" || flow.step === "unlock" || flow.step === "review" ? (
      <WizardSteps
        steps={RESTORE_STEPS}
        currentStep={restoreStepIndex(flow)}
        isStepDisabled={(step) => step !== 0 || busy}
        onStepChange={(step) => {
          if (step === 0) dispatch({ type: "chooseAnother" });
        }}
      />
    ) : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Closing mid-restore would hide the wait that brings the app back.
        if (!next && !busy) closeRestoreDialog();
      }}
      onOpenChangeComplete={(next) => {
        if (!next) clearRestoreDialog();
      }}
    >
      <WizardPopup showCloseButton={!busy}>
        {flow.step === "restarting" ? (
          <WizardHeader
            title="Restoring…"
            description="Codenine is restarting. It takes a minute or two, and this window reloads when it is back."
          />
        ) : flow.step === "notBack" ? (
          <>
            <WizardHeader
              title="Codenine has not come back yet"
              description="The restore may still be finishing. Reload to check again."
            />
            <WizardFooter>
              <Button size="sm" onClick={() => window.location.reload()}>
                Reload
              </Button>
            </WizardFooter>
          </>
        ) : flow.step === "finishByHand" ? (
          <>
            <WizardHeader
              title="Almost done"
              description="Quit Codenine and open it again to finish the restore."
            />
            <WizardFooter>
              <Button size="sm" onClick={closeRestoreDialog}>
                Close
              </Button>
            </WizardFooter>
          </>
        ) : (
          <>
            <WizardHeader title="Restore from a backup">{steps}</WizardHeader>
            {flow.step === "choose" ? (
              <ChooseStep
                environmentId={environmentId}
                initialPath={flow.path}
                onChose={(path) => dispatch({ type: "chose", path })}
              />
            ) : flow.step === "unlock" ? (
              <UnlockStep
                environmentId={environmentId}
                path={flow.path}
                onBack={() => dispatch({ type: "chooseAnother" })}
                onUnlocked={(password, summary) =>
                  dispatch({ type: "unlocked", password, summary })
                }
              />
            ) : (
              <ReviewStep
                summary={flow.summary}
                restoring={restoring}
                error={restoreError}
                onChooseAnother={() => dispatch({ type: "chooseAnother" })}
                onRestore={() => void startRestore(flow.path, flow.password)}
              />
            )}
          </>
        )}
      </WizardPopup>
    </Dialog>
  );
}

function backupLine(file: BackupFileInfo, nowMs: number, format: BackupDateFormat) {
  return `${capitalize(dayAndTime(file.createdAt, nowMs, format))} · ${formatBytes(file.sizeBytes)}`;
}

function ChooseStep({
  environmentId,
  initialPath,
  onChose,
}: {
  readonly environmentId: EnvironmentId;
  readonly initialPath: string | null;
  readonly onChose: (path: string) => void;
}) {
  const id = useId();
  const { nowMs, format } = useBackupClock();
  const result = useAtomValue(
    backupEnvironment.backups(environmentId, { includeSuggestedFolders: true }),
  );
  const backups = AsyncResult.getOrElse(result, () => null)?.toSorted(
    (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
  );
  const [picked, setPicked] = useState<string | null>(null);
  const [typed, setTyped] = useState<string | null>(null);
  // Coming back from a later step starts on the file picked before, listed or typed.
  const typedBefore =
    initialPath !== null && backups?.every((file) => file.path !== initialPath) === true;
  const otherPath = typed ?? (typedBefore ? initialPath : "");
  const value =
    picked ??
    (backups === undefined
      ? null
      : typedBefore
        ? OTHER_CHOICE
        : (initialPath ?? backups[0]?.path ?? OTHER_CHOICE));
  const path = value === OTHER_CHOICE ? otherPath.trim() : value;

  return (
    <>
      <WizardPanel>
        <form
          id={`${id}-form`}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (path !== null && path !== "") onChose(path);
          }}
        >
          <h3 id={`${id}-label`} className="sr-only">
            Backup to restore
          </h3>
          <RadioGroup
            aria-labelledby={`${id}-label`}
            value={value}
            onValueChange={(next) => {
              if (typeof next === "string") setPicked(next);
            }}
          >
            {(backups ?? []).map((file) => (
              <RadioCard
                key={file.path}
                value={file.path}
                title={file.computerName}
                description={backupLine(file, nowMs, format)}
                selected={value === file.path}
              />
            ))}
            <RadioCard
              value={OTHER_CHOICE}
              title="Use another file…"
              selected={value === OTHER_CHOICE}
            >
              <Input
                aria-label="Backup file"
                value={otherPath}
                placeholder="/Volumes/Backup Drive/Codenine/backup.c9backup"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setTyped(event.target.value)}
              />
            </RadioCard>
          </RadioGroup>
          <p className="mt-2 text-xs text-muted-foreground">
            {backups === undefined
              ? result._tag === "Failure"
                ? `Could not look for backups: ${formatEnvironmentQueryError(result.cause)}`
                : "Looking for backups…"
              : backups.length === 0
                ? "No backups found in the backup folder or the synced folders on this computer."
                : "From the backup folder and the synced folders on this computer."}
          </p>
        </form>
      </WizardPanel>
      <WizardFooter>
        <Button variant="outline" size="sm" onClick={closeRestoreDialog}>
          Cancel
        </Button>
        <Button type="submit" form={`${id}-form`} size="sm" disabled={path === null || path === ""}>
          Continue
        </Button>
      </WizardFooter>
    </>
  );
}

function UnlockStep({
  environmentId,
  path,
  onBack,
  onUnlocked,
}: {
  readonly environmentId: EnvironmentId;
  readonly path: string;
  readonly onBack: () => void;
  readonly onUnlocked: (password: string, summary: BackupRestoreSummary) => void;
}) {
  const id = useId();
  const inspect = useAtomCommand(backupEnvironment.inspect, { reportFailure: false });
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [unlocking, setUnlocking] = useState(false);
  const fileName = path.split(/[\\/]/).findLast((segment) => segment !== "") ?? path;

  const unlock = async () => {
    if (password === "" || unlocking) return;
    if (!readEnvironmentScope(environmentId, AuthEnvironmentMaintainScope)) {
      setError("This connection cannot restore backups.");
      return;
    }
    setUnlocking(true);
    setError(undefined);
    const result = await inspect({ environmentId, input: { path, password } });
    setUnlocking(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setError(commandErrorMessage(result, "Could not open this backup."));
      }
      return;
    }
    onUnlocked(password, result.value);
  };

  return (
    <>
      <WizardPanel>
        <form
          id={`${id}-form`}
          noValidate
          className="flex flex-col gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            void unlock();
          }}
        >
          <Label htmlFor={`${id}-password`}>Backup password</Label>
          <Input
            id={`${id}-password`}
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            disabled={unlocking}
            aria-invalid={error !== undefined}
            aria-describedby={`${id}-file${error === undefined ? "" : ` ${id}-error`}`}
            onChange={(event) => {
              setPassword(event.target.value);
              setError(undefined);
            }}
          />
          <p id={`${id}-file`} className="text-xs break-all text-muted-foreground">
            Enter the password {fileName} was made with.
          </p>
          <FieldError id={`${id}-error`} message={error} />
        </form>
      </WizardPanel>
      <WizardFooter>
        <Button variant="outline" size="sm" disabled={unlocking} onClick={onBack}>
          Back
        </Button>
        <Button type="submit" form={`${id}-form`} size="sm" disabled={unlocking || password === ""}>
          {unlocking ? "Unlocking…" : "Unlock"}
        </Button>
      </WizardFooter>
    </>
  );
}

function ReviewStep({
  summary,
  restoring,
  error,
  onChooseAnother,
  onRestore,
}: {
  readonly summary: BackupRestoreSummary;
  readonly restoring: boolean;
  readonly error: string | null;
  readonly onChooseAnother: () => void;
  readonly onRestore: () => void;
}) {
  const { nowMs, format } = useBackupClock();
  const { file, contents } = summary;

  return (
    <>
      <WizardPanel>
        <div className="flex flex-col gap-4">
          <div className="flex items-start justify-between gap-3 rounded-lg border px-3 py-2.5 text-sm">
            <div className="min-w-0">
              <p className="font-medium text-foreground">Backup from {file.computerName}</p>
              <p className="text-xs text-muted-foreground">
                {backupLine(file, nowMs, format)} · Codenine {file.codenineVersion}
              </p>
            </div>
            <InlineButton tone="muted" disabled={restoring} onClick={onChooseAnother}>
              Choose another
            </InlineButton>
          </div>
          <section className="space-y-2">
            <h3 className="text-sm font-medium text-foreground">What comes back</h3>
            <ul className="grid grid-cols-2 gap-2">
              {restoreContentLines(contents).map((line) => (
                <li key={line} className="rounded-lg bg-muted/48 px-3 py-2 text-sm text-foreground">
                  {line}
                </li>
              ))}
            </ul>
          </section>
          {summary.fromThisComputer ? null : (
            <Alert variant="warning" controlAlignment="first-line" role="note">
              <TriangleAlertIcon />
              <AlertTitle>This backup comes from another computer</AlertTitle>
              <AlertDescription>
                <span>
                  Quit Codenine on {file.computerName} first. A ChatGPT sign-in only works on one
                  computer at a time.
                </span>
                <span>Devices that connect to this computer will need to pair again.</span>
              </AlertDescription>
            </Alert>
          )}
          <p className="text-sm text-muted-foreground">
            Codenine saves what is on this computer now before restoring, so you can undo it later.
          </p>
          {summary.blockedReason === null ? null : (
            <p role="alert" className="text-sm text-destructive-foreground">
              {summary.blockedReason}
            </p>
          )}
          {error === null ? null : (
            <p role="alert" className="text-sm text-destructive-foreground">
              {error}
            </p>
          )}
        </div>
      </WizardPanel>
      <WizardFooter
        leading={
          <p className="text-xs text-muted-foreground sm:max-w-56">
            Codenine restarts to finish. It takes a minute or two.
          </p>
        }
      >
        <Button variant="outline" size="sm" disabled={restoring} onClick={closeRestoreDialog}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={restoring || summary.blockedReason !== null}
          onClick={onRestore}
        >
          {restoring ? "Restoring…" : "Restore and restart"}
        </Button>
      </WizardFooter>
    </>
  );
}
