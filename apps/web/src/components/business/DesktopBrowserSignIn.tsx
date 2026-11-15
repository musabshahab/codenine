import React, { useState } from "react";

import { callControl, controlErrorMessage } from "../../business/control";
import { type DesktopScheme, startBrowserSignIn } from "../../business/desktopSignIn";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

/** In the business desktop app: sign in with the system browser, which can use passkeys. */
export function DesktopBrowserSignIn({
  scheme,
  onSignedIn,
}: {
  readonly scheme: DesktopScheme;
  readonly onSignedIn: () => void;
}) {
  const [started, setStarted] = useState(false);
  const [code, setCode] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const submit = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSubmitting(true);
    setErrorMessage("");
    const message = await callControl((client) =>
      client.account.desktopSignIn({ payload: { code } }),
    ).then(() => "", controlErrorMessage);
    setIsSubmitting(false);
    if (message === "") {
      onSignedIn();
    } else {
      setErrorMessage(message);
    }
  };

  const openBrowser = () => {
    startBrowserSignIn(scheme);
    setStarted(true);
  };

  return (
    <div className="mt-8 space-y-4 border-t border-border/70 pt-6">
      {started ? (
        <form className="space-y-4" onSubmit={(event) => void submit(event)}>
          <p className="text-sm text-muted-foreground">
            Finish signing in in your browser. It brings you back here; if it does not, enter the
            code it shows.
          </p>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="desktop-code">
              Code from your browser
            </label>
            <Input
              id="desktop-code"
              autoCapitalize="characters"
              autoComplete="off"
              autoCorrect="off"
              disabled={isSubmitting}
              font="mono"
              nativeInput
              onChange={(event) => setCode(event.currentTarget.value)}
              required
              spellCheck={false}
              value={code}
            />
          </div>
          {errorMessage ? (
            <Alert variant="error">
              <AlertDescription>{errorMessage}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button disabled={isSubmitting} size="sm" type="submit">
              {isSubmitting ? "Signing in..." : "Sign in"}
            </Button>
            <Button disabled={isSubmitting} onClick={openBrowser} size="sm" variant="outline">
              Open the browser again
            </Button>
          </div>
        </form>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            To use a passkey, sign in with your browser instead.
          </p>
          <Button onClick={openBrowser} size="sm" variant="outline">
            Sign in with your browser
          </Button>
        </>
      )}
    </div>
  );
}
