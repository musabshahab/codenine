import { isAtomCommandInterrupted } from "@codenine/client-runtime/state/runtime";
import { type EnvironmentId, skillTitle } from "@codenine/contracts";
import { useId, useState } from "react";

import { commandErrorMessage } from "../../lib/commandError";
import { skillsEnvironment } from "../../state/skills";
import { useAtomCommand } from "../../state/use-atom-command";
import { TextField } from "../TextField";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup } from "../ui/wizard";

/** Copies a skill folder on the server's computer into the Codenine folder. */
export function ImportSkillDialog({
  environmentId,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
}) {
  const formId = useId();
  const importSkill = useAtomCommand(skillsEnvironment.import, { reportFailure: false });
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (submitting) return;
    if (path.trim() === "") {
      setError("Enter the skill's folder.");
      return;
    }
    setError(undefined);
    setSubmitting(true);
    const result = await importSkill({ environmentId, input: { path: path.trim() } });
    setSubmitting(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setError(commandErrorMessage(result, "The skill was not imported."));
      }
      return;
    }
    toastManager.add({ type: "success", title: `Added ${skillTitle(result.value.name)}` });
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
          title="Import a skill"
          description="Codenine copies the folder into your skills; the original stays where it is."
        />
        <WizardPanel>
          <form
            id={formId}
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <TextField
              label="Skill folder"
              placeholder="~/.claude/skills/pdf-tools"
              hint="The folder that holds its SKILL.md, on the computer Codenine runs on."
              value={path}
              error={error}
              disabled={submitting}
              onChange={setPath}
            />
          </form>
        </WizardPanel>
        <WizardFooter>
          <Button variant="outline" size="sm" disabled={submitting} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} size="sm" disabled={submitting}>
            {submitting ? "Importing…" : "Import"}
          </Button>
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}
