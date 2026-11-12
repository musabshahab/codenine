import { squashAtomCommandFailure } from "@codenine/client-runtime/state/runtime";
import {
  AuthProvidersManageScope,
  type EnvironmentId,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@codenine/contracts";
import { openRouterModelName } from "@codenine/shared/openRouter";
import { useId, useState } from "react";

import {
  useEnvironmentSettings,
  usePersistEnvironmentProviderInstanceMutation,
} from "../../hooks/useSettings";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Dialog } from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup } from "../ui/wizard";
import { buildOpenRouterInstance, OPENROUTER_STARTER_MODELS } from "./AddOpenRouterDialog.logic";
import { SecretInput } from "./SecretInput";

const LINK_CLASS_NAME = "underline underline-offset-2 hover:text-foreground";

/** Adds an OpenRouter instance: Claude Code with an OpenRouter API key instead of a Claude sign-in. */
export function AddOpenRouterDialog({
  environmentId,
  environmentLabel,
  onClose,
  onCreated,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly onClose: () => void;
  readonly onCreated?:
    | ((instanceId: ProviderInstanceId, driver: ProviderDriverKind) => void)
    | undefined;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const persistProviderInstance = usePersistEnvironmentProviderInstanceMutation(environmentId);
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const formId = useId();
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<ReadonlySet<string>>(
    () => new Set(OPENROUTER_STARTER_MODELS),
  );
  const [isSaving, setIsSaving] = useState(false);
  const canSave = canManageProviders && !isSaving && apiKey.trim() !== "" && models.size > 0;

  const toggleModel = (model: string, checked: boolean) =>
    setModels((current) => {
      const next = new Set(current);
      if (checked) next.add(model);
      else next.delete(model);
      return next;
    });

  const save = async () => {
    if (!canSave || !readEnvironmentScope(environmentId, AuthProvidersManageScope)) return;
    setIsSaving(true);
    const { instanceId, instance } = buildOpenRouterInstance({
      apiKey,
      models: OPENROUTER_STARTER_MODELS.filter((model) => models.has(model)),
      settings,
    });
    const result = await persistProviderInstance({ operation: "create", instanceId, instance });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setIsSaving(false);
      toastManager.add({
        type: "error",
        title: "Could not add OpenRouter",
        description: error instanceof Error ? error.message : "The settings update failed.",
      });
      return;
    }
    onCreated?.(instanceId, instance.driver);
    toastManager.add({
      type: "success",
      title: "OpenRouter added",
      description: `Codenine is checking the API key on ${environmentLabel}.`,
    });
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <WizardPopup>
        <WizardHeader
          title="Add OpenRouter"
          description={
            <>
              Run agents on {environmentLabel} with models from many providers, paid with one
              OpenRouter API key.
            </>
          }
        />
        <WizardPanel>
          <form
            id={formId}
            className="grid gap-5"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">API key</span>
              <SecretInput
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="sk-or-…"
                disabled={isSaving}
                autoFocus
              />
              <span className="mt-1.5 block text-xs text-muted-foreground">
                Create one at{" "}
                <a
                  href="https://openrouter.ai/keys"
                  target="_blank"
                  rel="noreferrer"
                  className={LINK_CLASS_NAME}
                >
                  openrouter.ai/keys
                </a>
                . Codenine stores it as a secret.
              </span>
            </label>
            <fieldset>
              <legend className="mb-1.5 text-xs font-medium text-foreground">Models</legend>
              <div className="rounded-lg border">
                {OPENROUTER_STARTER_MODELS.map((model) => (
                  <label
                    key={model}
                    className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 not-last:border-b has-disabled:cursor-not-allowed has-disabled:opacity-64"
                  >
                    <Checkbox
                      checked={models.has(model)}
                      disabled={isSaving}
                      onCheckedChange={(checked) => toggleModel(model, checked)}
                    />
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {openRouterModelName({ slug: model, name: model })?.name ?? model}
                    </span>
                    <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                      {model}
                    </span>
                  </label>
                ))}
              </div>
              <span className="mt-1.5 block text-xs text-muted-foreground">
                Add others later by their ID from{" "}
                <a
                  href="https://openrouter.ai/models"
                  target="_blank"
                  rel="noreferrer"
                  className={LINK_CLASS_NAME}
                >
                  openrouter.ai/models
                </a>{" "}
                in Settings → Providers.
              </span>
            </fieldset>
            <p className="text-xs text-muted-foreground">
              OpenRouter runs through Claude Code, so Claude Code must be installed on{" "}
              {environmentLabel}. You do not need to sign in to Claude.
            </p>
          </form>
        </WizardPanel>
        <WizardFooter>
          <Button variant="outline" size="sm" disabled={isSaving} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} size="sm" disabled={!canSave}>
            {isSaving ? "Adding…" : "Add OpenRouter"}
          </Button>
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}
