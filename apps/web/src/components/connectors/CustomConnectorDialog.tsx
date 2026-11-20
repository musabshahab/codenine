import { isAtomCommandInterrupted } from "@codenine/client-runtime/state/runtime";
import type { EnvironmentId } from "@codenine/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { useId, useState } from "react";

import { commandErrorMessage } from "../../lib/commandError";
import { connectorsEnvironment } from "../../state/connectors";
import { useAtomCommand } from "../../state/use-atom-command";
import { TextField } from "../TextField";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { RadioCard, RadioGroup } from "../ui/radio-group";
import { toastManager } from "../ui/toast";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup } from "../ui/wizard";
import {
  type ConnectFormErrors,
  type CustomConnectorAuth,
  customConnectRequest,
  servicesAcceptOrigin,
  webPageUrl,
} from "./connectors.logic";
import { reserveSignInTab, SignInAddressWarning, useSignInReturnOrigin } from "./signIn";

const AUTH_CHOICES: ReadonlyArray<{
  readonly value: CustomConnectorAuth;
  readonly title: string;
  readonly description: string;
}> = [
  {
    value: "none",
    title: "No sign-in",
    description: "It needs no account, or the command has one.",
  },
  { value: "sign-in", title: "Sign in", description: "The service shows its own sign-in page." },
  { value: "token", title: "Access token", description: "Paste a token or API key it gave you." },
];

/** Any MCP server, by its web address or a command that runs on the server's computer. */
export function CustomConnectorDialog({
  environmentId,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
}) {
  const formId = useId();
  const authId = useId();
  const connect = useAtomCommand(connectorsEnvironment.connect, { reportFailure: false });
  const returnOrigin = useSignInReturnOrigin(environmentId);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [auth, setAuth] = useState<CustomConnectorAuth>("none");
  const [token, setToken] = useState("");
  const [errors, setErrors] = useState<ConnectFormErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [signInUrl, setSignInUrl] = useState<string | null>(null);

  const submit = async () => {
    if (submitting) return;
    const request = customConnectRequest({ name, address, auth, token }, returnOrigin);
    if (request.errors !== undefined) {
      setErrors(request.errors);
      return;
    }
    setErrors({});
    setSubmitting(true);
    const tab = auth === "sign-in" ? reserveSignInTab() : null;
    const result = await connect({ environmentId, input: request.input });
    setSubmitting(false);
    if (result._tag === "Failure") {
      tab?.cancel();
      if (!isAtomCommandInterrupted(result)) {
        setErrors({ form: commandErrorMessage(result, "Could not add the connector.") });
      }
      return;
    }
    if (result.value.authorizeUrl === null) {
      tab?.cancel();
      toastManager.add({ type: "success", title: `${name.trim()} is connected` });
      onClose();
      return;
    }
    const url = webPageUrl(result.value.authorizeUrl);
    if (url === null) {
      tab?.cancel();
      setErrors({ form: "Its sign-in address is not a web page, so Codenine will not open it." });
      return;
    }
    if (tab !== null && (await tab.open(url))) {
      toastManager.add({
        type: "info",
        title: `Finish signing in to ${name.trim()}`,
        description: "Its sign-in page opened in a new tab.",
      });
      onClose();
      return;
    }
    setSignInUrl(url);
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
          title="Add custom connector"
          description="Any MCP server, by its web address or a command that runs on the computer Codenine runs on."
        />
        <WizardPanel>
          <form
            id={formId}
            noValidate
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <TextField
              label="Name"
              placeholder="Team wiki"
              value={name}
              error={errors.name}
              disabled={submitting}
              onChange={setName}
            />
            <TextField
              label="Web address or command"
              placeholder="https://mcp.example.com/mcp or npx -y some-mcp-server"
              value={address}
              error={errors.address}
              disabled={submitting}
              onChange={setAddress}
            />
            <div className="grid gap-2">
              <h3 id={authId} className="text-sm font-medium text-foreground">
                How it signs in
              </h3>
              <RadioGroup
                aria-labelledby={authId}
                value={auth}
                disabled={submitting}
                onValueChange={(value) => {
                  const next = AUTH_CHOICES.find((choice) => choice.value === value);
                  if (next !== undefined) setAuth(next.value);
                }}
              >
                {AUTH_CHOICES.map((choice) => (
                  <RadioCard
                    key={choice.value}
                    value={choice.value}
                    title={choice.title}
                    description={choice.description}
                    selected={auth === choice.value}
                  >
                    {choice.value === "token" ? (
                      <TextField
                        label="Access token"
                        secret
                        value={token}
                        error={errors.token}
                        disabled={submitting}
                        onChange={setToken}
                      />
                    ) : choice.value === "sign-in" &&
                      (returnOrigin === null || !servicesAcceptOrigin(returnOrigin)) ? (
                      <SignInAddressWarning returnOrigin={returnOrigin} service="The service" />
                    ) : undefined}
                  </RadioCard>
                ))}
              </RadioGroup>
            </div>
            {signInUrl === null ? null : (
              <Button
                variant="outline"
                size="sm"
                className="justify-self-start"
                render={<a href={signInUrl} target="_blank" rel="noopener noreferrer" />}
              >
                Open the sign-in page
                <ExternalLinkIcon aria-hidden />
              </Button>
            )}
            {errors.form === undefined ? null : (
              <p role="alert" className="text-sm text-destructive-foreground">
                {errors.form}
              </p>
            )}
          </form>
        </WizardPanel>
        <WizardFooter>
          <Button variant="outline" size="sm" disabled={submitting} onClick={onClose}>
            {signInUrl === null ? "Cancel" : "Close"}
          </Button>
          {signInUrl === null ? (
            <Button type="submit" form={formId} size="sm" disabled={submitting}>
              {submitting ? "Adding…" : "Add connector"}
            </Button>
          ) : null}
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}
