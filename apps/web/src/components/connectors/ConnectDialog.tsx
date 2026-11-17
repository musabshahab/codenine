import { isAtomCommandInterrupted } from "@codenine/client-runtime/state/runtime";
import {
  CONNECTOR_OAUTH_CALLBACK_PATH,
  type ConnectionId,
  type ConnectionSnapshot,
  type ConnectorCatalogEntry,
  type ConnectorOwnApp,
  type EnvironmentId,
} from "@codenine/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, ExternalLinkIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { commandErrorMessage } from "../../lib/commandError";
import { connectorsEnvironment } from "../../state/connectors";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button, InlineButton } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { TextField } from "../TextField";
import { toastManager } from "../ui/toast";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup } from "../ui/wizard";
import {
  type ConnectFormErrors,
  type ConnectFormValues,
  libraryConnectRequest,
  needsOwnAppSetup,
  OWN_APP_COMPANY,
  webPageUrl,
} from "./connectors.logic";
import { reserveSignInTab, SignInAddressWarning, useSignInReturnOrigin } from "./signIn";

const EMPTY_VALUES: ConnectFormValues = { inputs: {}, token: "", clientId: "", clientSecret: "" };

const OWN_APP_GUIDE: Record<
  ConnectorOwnApp,
  {
    readonly consoleName: string;
    readonly consoleUrl: string;
    readonly create: (service: string) => string;
    readonly signInNote: string;
  }
> = {
  google: {
    consoleName: "Google Cloud",
    consoleUrl: "https://console.cloud.google.com/apis/credentials",
    create: (service) =>
      `In Google Cloud, create a project and turn on the ${service} API and the ${service} MCP API. Set up the consent screen: choose Internal if you use Google Workspace; otherwise publish the app, because in Testing Google signs you out every 7 days. Then create an OAuth client of type Web application, with this redirect address:`,
    signInNote:
      "Google shows what Codenine may do. You can change what runs automatically after connecting.",
  },
  slack: {
    consoleName: "Slack",
    consoleUrl: "https://api.slack.com/apps",
    create: () =>
      "In Slack, create an app from scratch for your workspace. Under OAuth & Permissions, add this redirect address, then install the app to your workspace:",
    signInNote:
      "Slack shows what Codenine may do in your workspace. You can change what runs automatically after connecting.",
  },
};

/** Connects a library connector: its own app's setup, a token, its questions, or a sign-in. */
export function ConnectDialog({
  environmentId,
  entry,
  savedApps,
  connections,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly entry: ConnectorCatalogEntry;
  readonly savedApps: ReadonlyArray<ConnectorOwnApp>;
  readonly connections: ReadonlyArray<Pick<ConnectionSnapshot, "id" | "status" | "statusDetail">>;
  readonly onClose: () => void;
}) {
  const formId = useId();
  const navigate = useNavigate();
  const connect = useAtomCommand(connectorsEnvironment.connect, { reportFailure: false });
  const returnOrigin = useSignInReturnOrigin(environmentId);
  const [values, setValues] = useState(EMPTY_VALUES);
  const [errors, setErrors] = useState<ConnectFormErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [signingIn, setSigningIn] = useState<{
    readonly connectionId: ConnectionId;
    readonly url: string;
    readonly opened: boolean;
  } | null>(null);
  const ownApp = entry.auth === "own-app" ? (entry.ownApp ?? "google") : null;
  // Setting the app up again replaces the saved one, such as after a mistyped secret.
  const [replaceApp, setReplaceApp] = useState(false);
  const appsInUse = replaceApp ? savedApps.filter((app) => app !== ownApp) : savedApps;
  const setupApp = needsOwnAppSetup(entry, appsInUse);
  const signsIn = entry.auth === "sign-in" || entry.auth === "own-app";
  const company = ownApp === null ? entry.name : OWN_APP_COMPANY[ownApp];
  const tokenHelpUrl = webPageUrl(entry.tokenHelpUrl);
  const pending =
    signingIn === null ? null : connections.find((c) => c.id === signingIn.connectionId);

  const submit = async () => {
    if (submitting) return;
    const request = libraryConnectRequest(entry, values, { savedApps: appsInUse, returnOrigin });
    if (request.errors !== undefined) {
      setErrors(request.errors);
      return;
    }
    setErrors({});
    setSubmitting(true);
    const tab = signsIn ? reserveSignInTab() : null;
    const result = await connect({ environmentId, input: request.input });
    setSubmitting(false);
    if (result._tag === "Failure") {
      tab?.cancel();
      if (!isAtomCommandInterrupted(result)) {
        setErrors({ form: commandErrorMessage(result, `Could not connect ${entry.name}.`) });
      }
      return;
    }
    const { connectionId } = result.value;
    if (result.value.authorizeUrl === null) {
      tab?.cancel();
      toastManager.add({ type: "success", title: `${entry.name} is connected` });
      onClose();
      return;
    }
    const authorizeUrl = webPageUrl(result.value.authorizeUrl);
    if (authorizeUrl === null) {
      tab?.cancel();
      setErrors({ form: `${entry.name} gave a sign-in address that is not a web page.` });
      return;
    }
    const opened = tab === null ? false : await tab.open(authorizeUrl);
    setSigningIn({ connectionId, url: authorizeUrl, opened });
  };

  const field = (key: "token" | "clientId" | "clientSecret") => ({
    value: values[key],
    onChange: (value: string) => setValues((current) => ({ ...current, [key]: value })),
  });

  if (signingIn !== null) {
    const done = pending?.status === "connected";
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <WizardPopup>
          <WizardHeader
            title={done ? `${entry.name} is connected` : `Finish signing in to ${company}`}
            description={
              done
                ? "Agents and chats can use it now. Choose what runs on its own on its page."
                : `Sign in in the ${company} page that opened. This updates when you are done.`
            }
          />
          {done ? null : (
            <WizardPanel>
              <div className="flex flex-col items-start gap-2 text-sm">
                {pending?.statusDetail ? (
                  <p className="text-muted-foreground">{pending.statusDetail}</p>
                ) : null}
                <Button
                  variant="outline"
                  size="sm"
                  render={<a href={signingIn.url} target="_blank" rel="noopener noreferrer" />}
                >
                  {signingIn.opened ? "Open the sign-in page again" : "Open the sign-in page"}
                  <ExternalLinkIcon aria-hidden />
                </Button>
              </div>
            </WizardPanel>
          )}
          <WizardFooter>
            {done ? (
              <>
                <Button variant="outline" size="sm" onClick={onClose}>
                  Done
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    onClose();
                    void navigate({
                      to: "/connectors/$connectionId",
                      params: { connectionId: signingIn.connectionId },
                      search: { machine: environmentId },
                    });
                  }}
                >
                  Choose what it can do
                </Button>
              </>
            ) : (
              <Button variant="outline" size="sm" onClick={onClose}>
                Close
              </Button>
            )}
          </WizardFooter>
        </WizardPopup>
      </Dialog>
    );
  }

  const appSteps = ownApp !== null && setupApp;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting) onClose();
      }}
    >
      <WizardPopup>
        <WizardHeader
          title={`Connect ${entry.name}`}
          description={
            ownApp === null
              ? signsIn
                ? `Sign in to ${entry.name} in a new tab. You can change what runs automatically after connecting.`
                : entry.description
              : setupApp
                ? `${company} asks each person to connect through their own ${company} app. It takes about five minutes, once.`
                : `Uses the ${company} app you set up before.`
          }
        />
        <WizardPanel>
          <form
            id={formId}
            noValidate
            className="grid gap-5"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {signsIn ? (
              <SignInAddressWarning returnOrigin={returnOrigin} service={company} />
            ) : null}
            {ownApp !== null && !setupApp ? (
              <p className="text-sm text-muted-foreground">
                Set it up with the wrong details?{" "}
                <InlineButton disabled={submitting} onClick={() => setReplaceApp(true)}>
                  Use a different {company} app
                </InlineButton>
              </p>
            ) : null}
            {appSteps ? (
              <ol className="grid gap-5">
                <GuideStep
                  number={1}
                  title={`Create the app in ${OWN_APP_GUIDE[ownApp].consoleName}`}
                >
                  <p className="text-sm text-muted-foreground">
                    {OWN_APP_GUIDE[ownApp].create(entry.name)}
                  </p>
                  <RedirectAddress returnOrigin={returnOrigin} />
                  <Button
                    variant="link"
                    size="xs"
                    render={
                      <a
                        href={OWN_APP_GUIDE[ownApp].consoleUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      />
                    }
                  >
                    Open {OWN_APP_GUIDE[ownApp].consoleName}
                    <ExternalLinkIcon aria-hidden />
                  </Button>
                </GuideStep>
                <GuideStep number={2} title="Paste the app's details">
                  <TextField
                    label="Client ID"
                    error={errors.clientId}
                    disabled={submitting}
                    {...field("clientId")}
                  />
                  <TextField
                    label="Client secret"
                    secret
                    error={errors.clientSecret}
                    disabled={submitting}
                    {...field("clientSecret")}
                  />
                  <p className="text-xs text-muted-foreground">
                    Saved with your other Codenine keys. One {company} app works for every {company}{" "}
                    connector.
                  </p>
                </GuideStep>
                <GuideStep number={3} title={`Sign in with ${company}`}>
                  <p className="text-sm text-muted-foreground">
                    {OWN_APP_GUIDE[ownApp].signInNote}
                  </p>
                </GuideStep>
              </ol>
            ) : null}
            {entry.auth === "token" ? (
              <div className="grid gap-1.5">
                <TextField
                  label={entry.tokenLabel?.trim() || "Access token"}
                  secret
                  error={errors.token}
                  disabled={submitting}
                  {...field("token")}
                />
                {tokenHelpUrl === null ? null : (
                  <Button
                    variant="link"
                    size="xs"
                    className="self-start"
                    render={<a href={tokenHelpUrl} target="_blank" rel="noopener noreferrer" />}
                  >
                    Where to get one
                    <ExternalLinkIcon aria-hidden />
                  </Button>
                )}
              </div>
            ) : null}
            {entry.inputs.map((input) => (
              <TextField
                key={input.key}
                label={input.required ? input.label : `${input.label} (optional)`}
                secret={input.secret}
                placeholder={input.placeholder}
                hint={input.help}
                error={errors[input.key]}
                disabled={submitting}
                value={values.inputs[input.key] ?? ""}
                onChange={(value) =>
                  setValues((current) => ({
                    ...current,
                    inputs: { ...current.inputs, [input.key]: value },
                  }))
                }
              />
            ))}
            {errors.form === undefined ? null : (
              <p role="alert" className="text-sm text-destructive-foreground">
                {errors.form}
              </p>
            )}
          </form>
        </WizardPanel>
        <WizardFooter
          leading={
            entry.auth === "none" ? undefined : (
              <p className="text-xs text-muted-foreground">
                Your sign-in stays in Codenine. Model providers never see it.
              </p>
            )
          }
        >
          <Button variant="outline" size="sm" disabled={submitting} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} size="sm" disabled={submitting}>
            {submitting ? "Connecting…" : signsIn ? `Sign in with ${company}` : "Connect"}
          </Button>
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}

function GuideStep(props: { number: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden
        className="grid size-6 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary"
      >
        {props.number}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <h3 className="text-sm font-medium text-foreground">{props.title}</h3>
        {props.children}
      </div>
    </li>
  );
}

/** The address the app must send sign-ins back to, ready to copy into the service's setup. */
function RedirectAddress({ returnOrigin }: { readonly returnOrigin: string | null }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  if (returnOrigin === null) return null;
  const address = `${returnOrigin}${CONNECTOR_OAUTH_CALLBACK_PATH}`;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <code className="min-w-0 rounded-md border border-border bg-muted px-2 py-1.5 font-mono text-xs break-all text-foreground">
        {address}
      </code>
      <Button variant="outline" size="xs" onClick={() => copyToClipboard(address, undefined)}>
        {isCopied ? <CheckIcon aria-hidden /> : null}
        {isCopied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
