import { isAtomCommandInterrupted } from "@codenine/client-runtime/state/runtime";
import {
  AuthEnvironmentMaintainScope,
  AuthSettingsWriteScope,
  type BackupSettings,
  type EnvironmentId,
} from "@codenine/contracts";
import { useId, useState } from "react";

import { backupEnvironment } from "../../state/backup";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Dialog } from "../ui/dialog";
import { RadioCard, RadioGroup } from "../ui/radio-group";
import { toastManager } from "../ui/toast";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup } from "../ui/wizard";
import {
  type BackupCadence,
  cadenceLabel,
  cadenceOf,
  settingsForSetup,
  setupErrors,
  type SetupErrors,
} from "./backup.logic";
import { BackupFolderChoice, useBackupFolderChoice } from "./BackupFolderChoice";
import { BackupPasswordFields, FieldError } from "./BackupPasswordFields";
import { commandErrorMessage } from "./commandError";
import { useBackupDateFormat } from "./useBackupDateFormat";

const CADENCES = ["daily", "weekly", "manual"] as const satisfies ReadonlyArray<BackupCadence>;

/** Turns backups on: where they go, the password, how often. Then makes the first one. */
export function BackupSetupDialog({
  environmentId,
  environmentLabel,
  settings,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly settings: BackupSettings;
  readonly onClose: () => void;
}) {
  const id = useId();
  const format = useBackupDateFormat();
  const folderChoice = useBackupFolderChoice(environmentId, settings.folder);
  const setPassword = useAtomCommand(backupEnvironment.setPassword, { reportFailure: false });
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const createBackup = useAtomCommand(backupEnvironment.create, { reportFailure: false });
  const [password, setPasswordValue] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [saved, setSaved] = useState(false);
  const [cadence, setCadence] = useState(() => cadenceOf(settings));
  const [errors, setErrors] = useState<SetupErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const submit = async () => {
    if (submitting) return;
    const problems = setupErrors({ folder: folderChoice.folder, password, confirmation, saved });
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    if (
      !readEnvironmentScope(environmentId, AuthEnvironmentMaintainScope) ||
      !readEnvironmentScope(environmentId, AuthSettingsWriteScope)
    ) {
      setSubmitError(`This connection cannot set up backups on ${environmentLabel}.`);
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    const passwordResult = await setPassword({ environmentId, input: { password } });
    if (passwordResult._tag === "Failure") {
      setSubmitting(false);
      if (!isAtomCommandInterrupted(passwordResult)) {
        setSubmitError(commandErrorMessage(passwordResult, "The backup password was not saved."));
      }
      return;
    }
    const settingsResult = await updateSettings({
      environmentId,
      input: {
        patch: {
          backup: settingsForSetup(settings, { folder: folderChoice.folder, cadence }),
        },
      },
    });
    if (settingsResult._tag === "Failure") {
      setSubmitting(false);
      if (!isAtomCommandInterrupted(settingsResult)) {
        setSubmitError(commandErrorMessage(settingsResult, "The backup settings were not saved."));
      }
      return;
    }
    // Backups are on now, so a first backup that does not start is reported, not retried here.
    const created = await createBackup({ environmentId, input: {} });
    if (created._tag === "Failure" && !isAtomCommandInterrupted(created)) {
      toastManager.add({
        type: "error",
        title: "Backups are on, but the first one did not start",
        description: commandErrorMessage(created, "Try Back up now in Settings."),
      });
    }
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting) onClose();
      }}
    >
      <WizardPopup>
        <WizardHeader
          title="Turn on backups"
          description="Codenine keeps a copy of your chats, workspaces, accounts and settings, so you can get them back or move to a new computer."
        />
        <WizardPanel>
          <form
            id={`${id}-form`}
            noValidate
            className="grid gap-6"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <section className="grid gap-2">
              <h3 id={`${id}-folder`} className="text-sm font-medium text-foreground">
                1. Where to keep backups
              </h3>
              <BackupFolderChoice
                choice={folderChoice}
                labelledBy={`${id}-folder`}
                error={errors.folder}
                disabled={submitting}
              />
            </section>
            <section className="grid gap-2">
              <h3 className="text-sm font-medium text-foreground">2. Backup password</h3>
              <BackupPasswordFields
                password={password}
                confirmation={confirmation}
                errors={errors}
                disabled={submitting}
                onPasswordChange={setPasswordValue}
                onConfirmationChange={setConfirmation}
              />
              <p className="text-xs text-muted-foreground">
                Every backup is encrypted with this password. You need it to restore, and Codenine
                cannot recover it.
              </p>
              <label className="flex cursor-pointer items-start gap-2 text-sm">
                <Checkbox
                  checked={saved}
                  disabled={submitting}
                  aria-invalid={errors.saved !== undefined}
                  aria-describedby={errors.saved === undefined ? undefined : `${id}-saved-error`}
                  onCheckedChange={(checked) => setSaved(checked)}
                />
                I saved this password somewhere safe, like a password manager
              </label>
              <FieldError id={`${id}-saved-error`} message={errors.saved} />
            </section>
            <section className="grid gap-2">
              <h3 id={`${id}-cadence`} className="text-sm font-medium text-foreground">
                3. How often
              </h3>
              <RadioGroup
                aria-labelledby={`${id}-cadence`}
                value={cadence}
                disabled={submitting}
                onValueChange={(value) => {
                  const next = CADENCES.find((candidate) => candidate === value);
                  if (next !== undefined) setCadence(next);
                }}
              >
                {CADENCES.map((candidate) => (
                  <RadioCard
                    key={candidate}
                    value={candidate}
                    title={cadenceLabel(candidate, format)}
                    selected={cadence === candidate}
                  />
                ))}
              </RadioGroup>
              <p className="text-xs text-muted-foreground">
                Keeps the last {settings.keep} backups. You can change this later in Settings ›
                Backup.
              </p>
            </section>
            {submitError === null ? null : (
              <p role="alert" className="text-sm text-destructive-foreground">
                {submitError}
              </p>
            )}
          </form>
        </WizardPanel>
        <WizardFooter>
          <Button variant="outline" size="sm" disabled={submitting} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={`${id}-form`} size="sm" disabled={submitting}>
            {submitting ? "Turning on…" : "Turn on and back up now"}
          </Button>
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}
