import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@codenine/client-runtime/state/runtime";
import {
  AuthProvidersManageScope,
  ProviderDriverKind,
  type EnvironmentId,
  type ProviderInstanceId,
} from "@codenine/contracts";
import { useState } from "react";

import {
  useEnvironmentSettings,
  usePersistEnvironmentProviderInstanceMutation,
} from "../../hooks/useSettings";
import { agentSetupState } from "../../onboarding/welcomePage.logic";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { AgentSetupCard } from "../onboarding/AgentSetupCard";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup } from "../ui/wizard";
import {
  codenineAccountsFolder,
  planSignInAccount,
  type SignInAccountDriver,
} from "./addAccount.logic";
import { MultipleAccountsNote } from "./MultipleAccountsNote";
import { SettingsRow } from "./settingsLayout";

const COPY = {
  claudeAgent: {
    title: "Add Claude account",
    description:
      "Sign in with your Claude plan. Each Claude account keeps its own login and chat history.",
  },
  codex: {
    title: "Add Codex CLI account",
    description:
      "Signs in through the Codex command line, with every speed your plan includes, such as Fast. Codex CLI accounts share chat history, so a chat can move between them.",
  },
} as const satisfies Record<SignInAccountDriver, { title: string; description: string }>;

/**
 * Names an account, gives it a login of its own, and signs it in with the provider's own command.
 * Nothing to type but a name: Codenine picks the folder each login lives in.
 */
export function AddSignInAccountDialog({
  environmentId,
  driver,
  onClose,
  onAccountCreated,
}: {
  readonly environmentId: EnvironmentId;
  readonly driver: SignInAccountDriver;
  readonly onClose: () => void;
  readonly onAccountCreated?: ((instanceId: ProviderInstanceId) => void) | undefined;
}) {
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const settings = useEnvironmentSettings(environmentId);
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const persistProviderInstance = usePersistEnvironmentProviderInstanceMutation(environmentId);
  const [name, setName] = useState("Personal");
  const [instanceId, setInstanceId] = useState<ProviderInstanceId | null>(null);
  const [pending, setPending] = useState(false);
  const provider = providers?.find((candidate) => candidate.instanceId === instanceId);
  // Closes itself once the account is signed in; the owner unmounts it after the close animation.
  const signedIn = provider !== undefined && agentSetupState(provider, settings) === "ready";
  const copy = COPY[driver];

  const createAccount = async () => {
    if (pending || !name.trim() || !readEnvironmentScope(environmentId, AuthProvidersManageScope))
      return;
    setPending(true);
    const plan = planSignInAccount({
      driver,
      name,
      providerInstances: settings.providerInstances,
      providers: providers ?? [],
      accountsFolder: codenineAccountsFolder(serverConfig),
      agentHomesFound: serverConfig?.agentHomesFound,
    });
    const result = await persistProviderInstance(plan);
    setPending(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not add the account",
        description: error instanceof Error ? error.message : "The settings update failed.",
      });
      return;
    }
    onAccountCreated?.(plan.instanceId);
    setInstanceId(plan.instanceId);
  };

  return (
    <Dialog
      open={!signedIn}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onOpenChangeComplete={(open) => {
        if (!open && signedIn) onClose();
      }}
    >
      <WizardPopup size="wide">
        <WizardHeader
          title={instanceId ? name.trim() : copy.title}
          description={copy.description}
        />
        <WizardPanel>
          {instanceId ? (
            <AgentSetupCard environmentId={environmentId} driver={driver} instanceId={instanceId} />
          ) : (
            <form
              id="add-sign-in-account"
              className="grid gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void createAccount();
              }}
            >
              <SettingsRow
                title="Account name"
                description="Shown in the account list and model picker."
                control={
                  <Input
                    aria-label="Account name"
                    value={name}
                    disabled={pending}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="e.g. Personal or Work"
                  />
                }
              />
              <MultipleAccountsNote
                environmentId={environmentId}
                driver={ProviderDriverKind.make(driver)}
              />
            </form>
          )}
        </WizardPanel>
        <WizardFooter>
          {instanceId ? (
            <Button variant="outline" onClick={onClose}>
              Finish later
            </Button>
          ) : (
            <>
              <Button variant="outline" disabled={pending} onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                form="add-sign-in-account"
                disabled={pending || !name.trim() || !canManageProviders}
              >
                {pending ? "Adding account…" : "Continue"}
              </Button>
            </>
          )}
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}
