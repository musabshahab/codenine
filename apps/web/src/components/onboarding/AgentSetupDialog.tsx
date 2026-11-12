import type { EnvironmentId, ProviderInstanceId } from "@codenine/contracts";

import type { AgentSetupDriver } from "../../onboarding/providerReadiness.logic";
import { useEnvironments } from "../../state/environments";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { AgentSetupCard, agentSetupName } from "./AgentSetupCard";

/** The Welcome page's agent card, for an agent that stopped working later. */
export default function AgentSetupDialog({
  environmentId,
  driver,
  instanceId,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly driver: AgentSetupDriver;
  readonly instanceId: ProviderInstanceId;
  readonly onClose: () => void;
}) {
  const { environments } = useEnvironments();
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
          <DialogTitle>Set up {agentSetupName(driver, instanceId)}</DialogTitle>
          <DialogDescription>
            Install and sign in on <span className="text-foreground">{label}</span>.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <AgentSetupCard environmentId={environmentId} driver={driver} instanceId={instanceId} />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
