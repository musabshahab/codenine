import { isAtomCommandInterrupted } from "@codenine/client-runtime/state/runtime";
import { AuthEnvironmentMaintainScope, type EnvironmentId } from "@codenine/contracts";
import { useId, useState } from "react";

import { backupEnvironment } from "../../state/backup";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { toastManager } from "../ui/toast";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup } from "../ui/wizard";
import { passwordErrors, type PasswordErrors } from "./backup.logic";
import { commandErrorMessage } from "./commandError";

export function FieldError({
  id,
  message,
}: {
  readonly id: string;
  readonly message?: string | undefined;
}) {
  return message === undefined ? null : (
    <p id={id} className="text-xs text-destructive-foreground">
      {message}
    </p>
  );
}

/** The backup password typed twice, so a typo cannot lock the user out of their backups. */
export function BackupPasswordFields({
  password,
  confirmation,
  errors,
  disabled,
  onPasswordChange,
  onConfirmationChange,
}: {
  readonly password: string;
  readonly confirmation: string;
  readonly errors: PasswordErrors;
  readonly disabled: boolean;
  readonly onPasswordChange: (value: string) => void;
  readonly onConfirmationChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-password`}>Password</Label>
        <Input
          id={`${id}-password`}
          type="password"
          autoComplete="new-password"
          value={password}
          disabled={disabled}
          aria-invalid={errors.password !== undefined}
          aria-describedby={errors.password === undefined ? undefined : `${id}-password-error`}
          onChange={(event) => onPasswordChange(event.target.value)}
        />
        <FieldError id={`${id}-password-error`} message={errors.password} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-confirmation`}>Type it again</Label>
        <Input
          id={`${id}-confirmation`}
          type="password"
          autoComplete="new-password"
          value={confirmation}
          disabled={disabled}
          aria-invalid={errors.confirmation !== undefined}
          aria-describedby={
            errors.confirmation === undefined ? undefined : `${id}-confirmation-error`
          }
          onChange={(event) => onConfirmationChange(event.target.value)}
        />
        <FieldError id={`${id}-confirmation-error`} message={errors.confirmation} />
      </div>
    </div>
  );
}

export function BackupPasswordDialog({
  environmentId,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
}) {
  const formId = useId();
  const setPassword = useAtomCommand(backupEnvironment.setPassword, { reportFailure: false });
  const [password, setPasswordValue] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [errors, setErrors] = useState<PasswordErrors>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const save = async () => {
    const problems = passwordErrors(password, confirmation);
    setErrors(problems);
    if (Object.keys(problems).length > 0 || saving) return;
    if (!readEnvironmentScope(environmentId, AuthEnvironmentMaintainScope)) {
      setSaveError("This connection cannot change the backup password.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    const result = await setPassword({ environmentId, input: { password } });
    setSaving(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setSaveError(commandErrorMessage(result, "The password was not changed."));
      }
      return;
    }
    toastManager.add({ type: "success", title: "Backup password changed" });
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <WizardPopup>
        <WizardHeader
          title="Change backup password"
          description="New backups use this password. Backups you already have still open with the one they were made with."
        />
        <WizardPanel>
          <form
            id={formId}
            noValidate
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <BackupPasswordFields
              password={password}
              confirmation={confirmation}
              errors={errors}
              disabled={saving}
              onPasswordChange={setPasswordValue}
              onConfirmationChange={setConfirmation}
            />
            <p className="text-xs text-muted-foreground">
              You need it to restore. Codenine cannot recover it, so keep it in a password manager.
            </p>
            {saveError === null ? null : (
              <p role="alert" className="text-sm text-destructive-foreground">
                {saveError}
              </p>
            )}
          </form>
        </WizardPanel>
        <WizardFooter>
          <Button variant="outline" size="sm" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} size="sm" disabled={saving}>
            {saving ? "Changing…" : "Change password"}
          </Button>
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}
