import type { EnvironmentId } from "@codenine/contracts";
import { TriangleAlertIcon } from "lucide-react";

import { openExternalLink } from "../../lib/openExternalLink";
import { useEnvironmentHttpBaseUrl } from "../../state/environments";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { servicesAcceptOrigin, signInReturnOrigin } from "./connectors.logic";

/** Where this app's sign-ins on `environmentId` come back to, or null when there is nowhere. */
export function useSignInReturnOrigin(environmentId: EnvironmentId): string | null {
  const serverHttpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  return signInReturnOrigin(window.location.origin, serverHttpBaseUrl);
}

/**
 * Holds a tab for a sign-in page from the click that started it: browsers block a tab
 * opened after the request returns. The desktop app opens the system browser instead.
 */
export function reserveSignInTab() {
  const tab = window.desktopBridge ? null : window.open("", "_blank");
  if (tab) tab.opener = null;
  return {
    open: async (url: string): Promise<boolean> => {
      if (tab && !tab.closed) {
        tab.location.href = url;
        return true;
      }
      return openExternalLink(url).then(
        () => true,
        () => false,
      );
    },
    cancel: () => tab?.close(),
  };
}

/** Shown before a sign-in that the service would refuse to send back to this address. */
export function SignInAddressWarning({
  returnOrigin,
  service,
}: {
  readonly returnOrigin: string | null;
  readonly service: string;
}) {
  if (returnOrigin !== null && servicesAcceptOrigin(returnOrigin)) return null;
  return (
    <Alert variant="warning" controlAlignment="first-line">
      <TriangleAlertIcon />
      <AlertTitle>{service} will not accept this address</AlertTitle>
      <AlertDescription>
        Sign-ins only come back to Codenine opened on this computer (localhost) or at an https
        address. Open Codenine on the computer it runs on, or at its https address, then connect.
      </AlertDescription>
    </Alert>
  );
}
