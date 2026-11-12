import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProviderInstanceId } from "@codenine/contracts";

import {
  AGENT_SETUP_DRIVERS,
  type AgentSetupDriver,
} from "../../onboarding/providerReadiness.logic";
import { welcomeCardInstanceId } from "../../onboarding/welcomePage.logic";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { AgentSetupCard, agentSetupName } from "./AgentSetupCard";

/** The Welcome page's agent cards, for agents that stopped working later. */
export default function AgentSetupDialog({
  environmentId,
  agent,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  /** One agent's card; without it, the Claude Code and Codex cards the Welcome page shows. */
  readonly agent?: { readonly driver: AgentSetupDriver; readonly instanceId: ProviderInstanceId };
  readonly onClose: () => void;
}) {
  const { environments } = useEnvironments();
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const agents =
    agent !== undefined
      ? [agent]
      : AGENT_SETUP_DRIVERS.map((driver) => ({
          driver,
          instanceId: welcomeCardInstanceId(providers, driver, serverConfig?.settings),
        }));
  const label =
    environments.find((environment) => environment.environmentId === environmentId)?.label ??
    "this computer";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {agent !== undefined
              ? `Set up ${agentSetupName(agent.driver, agent.instanceId)}`
              : "Set up your agents"}
          </DialogTitle>
          <DialogDescription>
            Install and sign in on <span className="text-foreground">{label}</span>.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            {agents.map(({ driver, instanceId }) => (
              <AgentSetupCard
                key={instanceId}
                environmentId={environmentId}
                driver={driver}
                instanceId={instanceId}
              />
            ))}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
