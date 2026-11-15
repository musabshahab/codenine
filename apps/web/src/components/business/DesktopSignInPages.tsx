import { useEffect, useRef, useState } from "react";

import { callControl, controlErrorMessage, fetchControlMe } from "../../business/control";
import {
  browserSignInStarted,
  type DesktopScheme,
  desktopReturnLink,
  forgetBrowserSignIn,
} from "../../business/desktopSignIn";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";

/**
 * In the system browser: once signed in here, hands the desktop app a code
 * through its link, and shows the code in case the link does not open it.
 */
export function DesktopCodePage({
  state,
  scheme,
}: {
  readonly state: string;
  readonly scheme: DesktopScheme;
}) {
  const [issued, setIssued] = useState<{ readonly code: string; readonly link: string } | null>(
    null,
  );
  const [errorMessage, setErrorMessage] = useState("");
  const requested = useRef(false);

  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- asks the control server for one code when the page opens
  useEffect(() => {
    if (requested.current) return;
    requested.current = true;
    void (async () => {
      if ((await fetchControlMe()) === null) {
        const here = `${window.location.pathname}${window.location.search}`;
        window.location.assign(`/admin/sign-in?next=${encodeURIComponent(here)}`);
        return;
      }
      const { code } = await callControl((client) => client.me.createDesktopCode());
      const link = desktopReturnLink(scheme, code, state);
      setIssued({ code, link });
      window.location.href = link;
    })().catch((error: unknown) => setErrorMessage(controlErrorMessage(error)));
  }, [scheme, state]);

  return (
    <StandalonePage>
      <StandalonePageHeader
        title="Sign in to the Codenine app"
        description={
          issued === null
            ? "Getting a code for the app..."
            : "Return to the Codenine app to finish. If it did not open, enter this code there. It works once, for 5 minutes."
        }
      />
      {errorMessage ? (
        <Alert className="mt-6" variant="error">
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      ) : null}
      {issued === null ? null : (
        <div className="mt-6 space-y-4">
          <p className="font-mono text-2xl tracking-widest" aria-label="Code for the app">
            {issued.code}
          </p>
          <Button render={<a href={issued.link} />} size="sm">
            Open the Codenine app
          </Button>
        </div>
      )}
    </StandalonePage>
  );
}

/** In the desktop app: finishes the browser sign-in this window started, from its link. */
export function DesktopReturnPage({ onSignedIn }: { readonly onSignedIn: () => void }) {
  const [link] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return {
      code: params.get("code") ?? "",
      started: browserSignInStarted(params.get("state") ?? ""),
    };
  });
  const [errorMessage, setErrorMessage] = useState(
    link.started ? "" : "This sign-in was not started in this app. Start it again from sign-in.",
  );
  const finished = useRef(false);

  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- redeems the code once, and drops it from the address bar and storage
  useEffect(() => {
    if (finished.current) return;
    finished.current = true;
    window.history.replaceState(null, "", window.location.pathname);
    forgetBrowserSignIn();
    if (!link.started) return;
    void callControl((client) =>
      client.account.desktopSignIn({ payload: { code: link.code } }),
    ).then(onSignedIn, (error: unknown) => setErrorMessage(controlErrorMessage(error)));
  }, [link, onSignedIn]);

  return (
    <StandalonePage>
      <StandalonePageHeader
        title="Signing in"
        description={errorMessage === "" ? "Finishing the sign-in from your browser..." : ""}
      />
      {errorMessage ? (
        <div className="mt-6 space-y-4">
          <Alert variant="error">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
          <Button render={<a href="/admin/sign-in" />} size="sm" variant="outline">
            Back to sign-in
          </Button>
        </div>
      ) : null}
    </StandalonePage>
  );
}
