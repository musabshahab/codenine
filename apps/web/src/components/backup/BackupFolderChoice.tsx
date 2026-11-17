import { useAtomValue } from "@effect/atom-react";
import type { BackupFolderSuggestion, BackupSettings, EnvironmentId } from "@codenine/contracts";
import { AsyncResult } from "effect/reactivity";
import { useId, useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { backupEnvironment } from "../../state/backup";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { Input } from "../ui/input";
import { RadioCard, RadioGroup } from "../ui/radio-group";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup } from "../ui/wizard";
import { cloudFoldersLine, initialFolderChoice, OTHER_CHOICE } from "./backup.logic";

/**
 * The folder choice the setup and Change dialogs share. Suggestions arrive after the dialog
 * opens, so the starting choice follows them until the user picks one.
 */
export function useBackupFolderChoice(environmentId: EnvironmentId, currentFolder: string) {
  const result = useAtomValue(backupEnvironment.suggestedFolders(environmentId));
  const suggestions = AsyncResult.getOrElse(result, () => null);
  const loading = suggestions === null && result._tag !== "Failure";
  const [picked, setPicked] = useState<string | null>(null);
  const [typed, setTyped] = useState<string | null>(null);
  const value = picked ?? (loading ? null : initialFolderChoice(suggestions ?? [], currentFolder));
  const isSuggested = suggestions?.some((suggestion) => suggestion.folder === currentFolder);
  const otherPath = typed ?? (currentFolder !== "" && isSuggested !== true ? currentFolder : "");
  return {
    suggestions,
    loading,
    value,
    otherPath,
    folder: value === OTHER_CHOICE ? otherPath.trim() : (value ?? ""),
    choose: setPicked,
    setOtherPath: setTyped,
  };
}

export function BackupFolderChoice({
  choice,
  labelledBy,
  error,
  disabled = false,
}: {
  readonly choice: ReturnType<typeof useBackupFolderChoice>;
  readonly labelledBy: string;
  readonly error?: string | undefined;
  readonly disabled?: boolean;
}) {
  const id = useId();
  const suggestions: ReadonlyArray<BackupFolderSuggestion> = choice.suggestions ?? [];
  return (
    <div className="flex flex-col gap-2">
      <RadioGroup
        aria-labelledby={labelledBy}
        aria-describedby={error === undefined ? undefined : `${id}-error`}
        value={choice.value}
        disabled={disabled}
        onValueChange={(value) => {
          if (typeof value === "string") choice.choose(value);
        }}
      >
        {suggestions.map((suggestion) => (
          <RadioCard
            key={suggestion.folder}
            value={suggestion.folder}
            title={
              <span className="flex flex-wrap items-center gap-1.5">
                {suggestion.label}
                {suggestion.recommended ? (
                  <Badge size="sm" variant="secondary">
                    Recommended
                  </Badge>
                ) : null}
              </span>
            }
            description={<span className="break-all">{suggestion.folder}</span>}
            selected={choice.value === suggestion.folder}
          />
        ))}
        <RadioCard
          value={OTHER_CHOICE}
          title="Another folder…"
          description="Such as an external drive"
          selected={choice.value === OTHER_CHOICE}
        >
          <Input
            aria-label="Folder for backups"
            value={choice.otherPath}
            placeholder="/Volumes/Backup Drive/Codenine"
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            aria-invalid={error !== undefined}
            onChange={(event) => choice.setOtherPath(event.target.value)}
          />
        </RadioCard>
      </RadioGroup>
      <p className="text-xs text-muted-foreground">
        {choice.loading
          ? "Looking for synced folders on this computer…"
          : choice.suggestions === null
            ? "Could not look for synced folders. Type a path instead."
            : cloudFoldersLine(suggestions)}
      </p>
      {error === undefined ? null : (
        <p id={`${id}-error`} className="text-xs text-destructive-foreground">
          {error}
        </p>
      )}
    </div>
  );
}

/** Change where backups go: a suggested folder or a typed path. */
export function BackupFolderDialog({
  environmentId,
  settings,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly settings: BackupSettings;
  readonly onClose: () => void;
}) {
  const id = useId();
  const choice = useBackupFolderChoice(environmentId, settings.folder);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const save = () => {
    if (choice.folder === "") {
      setError("Choose a folder for your backups.");
      return;
    }
    if (choice.folder === settings.folder) {
      onClose();
      return;
    }
    setSaving(true);
    updateSettings(
      { backup: { ...settings, folder: choice.folder } },
      { onSaved: onClose, onFailed: () => setSaving(false) },
    );
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
          title="Where to keep backups"
          description="Somewhere that survives losing this computer, like a synced cloud folder or an external drive, keeps your backups safe."
        />
        <WizardPanel>
          <form
            id={`${id}-form`}
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <h3 id={`${id}-label`} className="sr-only">
              Folder for backups
            </h3>
            <BackupFolderChoice
              choice={choice}
              labelledBy={`${id}-label`}
              error={error}
              disabled={saving}
            />
          </form>
        </WizardPanel>
        <WizardFooter>
          <Button variant="outline" size="sm" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={`${id}-form`} size="sm" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}
