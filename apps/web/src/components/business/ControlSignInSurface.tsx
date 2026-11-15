import type { PasskeyAssertion, PasskeyRequestOptions } from "@codenine/contracts/control";
import React, { useState } from "react";

import { callControl, controlErrorMessage } from "../../business/control";
import { businessDesktopScheme } from "../../business/desktopSignIn";
import { passkeyErrorMessage, passkeysAvailable, signWithPasskey } from "../../business/passkeys";
import { DesktopBrowserSignIn } from "./DesktopBrowserSignIn";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";

type Step =
  | { readonly kind: "password" }
  | {
      readonly kind: "code";
      readonly ticket: string;
      readonly authenticator: boolean;
      readonly passkey: PasskeyRequestOptions | undefined;
    }
  | { readonly kind: "forgot" }
  | { readonly kind: "link-sent" };

const codeDescription = (authenticator: boolean, passkey: boolean) =>
  passkey
    ? authenticator
      ? "Use your passkey, or enter the 6-digit code from your authenticator app or a recovery code."
      : "Use your passkey, or enter one of your recovery codes."
    : authenticator
      ? "Enter the 6-digit code from your authenticator app, or one of your recovery codes."
      : "Enter one of your recovery codes.";

/** Marks a failure in the browser's passkey prompt, which the control server never saw. */
class PasskeyPromptError {
  constructor(readonly cause: unknown) {}
}

const DESCRIPTIONS: Record<Exclude<Step["kind"], "code">, string> = {
  password: "Use the email address and password your administrator set you up with.",
  forgot:
    "We will email you a link to choose a new password. You will also need your passkey, authenticator app or a recovery code.",
  "link-sent": "Check your email for a link to choose a new password.",
};

/** Signs in at the control server: a password, then an authenticator or recovery code. */
export function ControlSignInSurface({ onSignedIn }: { readonly onSignedIn: () => void }) {
  const [desktopScheme] = useState(businessDesktopScheme);
  const [step, setStep] = useState<Step>({ kind: "password" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const submitPassword = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSubmitting(true);
    setErrorMessage("");
    const result = await callControl((client) =>
      client.account.signIn({ payload: { email, password } }),
    ).then(
      (started) => ({ started, message: "" }),
      (error) => ({ started: null, message: controlErrorMessage(error) }),
    );
    setIsSubmitting(false);
    if (result.started === null) {
      setErrorMessage(result.message);
      return;
    }
    setPassword("");
    setStep({
      kind: "code",
      ticket: result.started.ticket,
      authenticator: result.started.authenticator,
      passkey: passkeysAvailable() ? result.started.passkey : undefined,
    });
  };

  const requestLink = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSubmitting(true);
    setErrorMessage("");
    const message = await callControl((client) =>
      client.account.requestPasswordReset({ payload: { email } }),
    ).then(
      () => "",
      (error: unknown) => controlErrorMessage(error),
    );
    setIsSubmitting(false);
    if (message !== "") {
      setErrorMessage(message);
      return;
    }
    setStep({ kind: "link-sent" });
  };

  const backToPassword = () => {
    setErrorMessage("");
    setStep({ kind: "password" });
  };

  const submitSecondStep = async (
    ticket: string,
    proof: () => Promise<{ readonly code: string } | { readonly passkey: PasskeyAssertion }>,
  ) => {
    setIsSubmitting(true);
    setErrorMessage("");
    const failure = await proof()
      .then(
        (answer) =>
          callControl((client) =>
            client.account.completeSignIn({ payload: { ticket, ...answer } }),
          ),
        (error: unknown) => Promise.reject(new PasskeyPromptError(error)),
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    setIsSubmitting(false);
    if (failure === null) {
      onSignedIn();
      return;
    }
    setCode("");
    setErrorMessage(
      failure instanceof PasskeyPromptError
        ? passkeyErrorMessage(failure.cause)
        : controlErrorMessage(failure),
    );
    // A spent or expired ticket means starting again from the password.
    if (typeof failure === "object" && "reason" in failure && failure.reason === "invalid-ticket") {
      setStep({ kind: "password" });
    }
  };

  return (
    <StandalonePage>
      <StandalonePageHeader
        title={
          step.kind === "forgot" || step.kind === "link-sent"
            ? "Forgot your password?"
            : "Sign in to Codenine"
        }
        description={
          step.kind === "code"
            ? codeDescription(step.authenticator, step.passkey !== undefined)
            : DESCRIPTIONS[step.kind]
        }
      />

      {step.kind === "link-sent" ? (
        <div className="mt-6 space-y-4">
          <Alert variant="info">
            <AlertDescription>
              If an account uses {email}, we have emailed it a link. The link works for an hour.
            </AlertDescription>
          </Alert>
          <Button onClick={backToPassword} size="sm" variant="outline">
            Back to sign-in
          </Button>
        </div>
      ) : step.kind === "forgot" ? (
        <form className="mt-6 space-y-4" onSubmit={(event) => void requestLink(event)}>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="control-email">
              Email address
            </label>
            <Input
              id="control-email"
              autoComplete="username"
              disabled={isSubmitting}
              nativeInput
              onChange={(event) => setEmail(event.currentTarget.value)}
              required
              type="email"
              value={email}
            />
          </div>
          {errorMessage ? (
            <Alert variant="error">
              <AlertDescription>{errorMessage}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button disabled={isSubmitting} size="sm" type="submit">
              {isSubmitting ? "Sending..." : "Email me a link"}
            </Button>
            <Button disabled={isSubmitting} onClick={backToPassword} size="sm" variant="outline">
              Back
            </Button>
          </div>
        </form>
      ) : step.kind === "password" ? (
        <form className="mt-6 space-y-4" onSubmit={(event) => void submitPassword(event)}>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="control-email">
              Email address
            </label>
            <Input
              id="control-email"
              autoComplete="username"
              disabled={isSubmitting}
              nativeInput
              onChange={(event) => setEmail(event.currentTarget.value)}
              required
              type="email"
              value={email}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="control-password">
              Password
            </label>
            <Input
              id="control-password"
              autoComplete="current-password"
              disabled={isSubmitting}
              nativeInput
              onChange={(event) => setPassword(event.currentTarget.value)}
              required
              type="password"
              value={password}
            />
          </div>
          {errorMessage ? (
            <Alert variant="error">
              <AlertDescription>{errorMessage}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={isSubmitting} size="sm" type="submit">
              {isSubmitting ? "Checking..." : "Continue"}
            </Button>
            <Button
              disabled={isSubmitting}
              onClick={() => {
                setErrorMessage("");
                setStep({ kind: "forgot" });
              }}
              size="sm"
              variant="link"
            >
              Forgot your password?
            </Button>
          </div>
        </form>
      ) : (
        <form
          className="mt-6 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submitSecondStep(step.ticket, async () => ({ code }));
          }}
        >
          {step.passkey === undefined ? null : (
            <Button
              disabled={isSubmitting}
              onClick={() => {
                const options = step.passkey;
                if (options === undefined) return;
                void submitSecondStep(step.ticket, async () => ({
                  passkey: await signWithPasskey(options),
                }));
              }}
              size="sm"
              type="button"
            >
              Use a passkey
            </Button>
          )}
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="control-code">
              {step.authenticator ? "Code" : "Recovery code"}
            </label>
            <Input
              id="control-code"
              autoCapitalize="none"
              autoComplete="one-time-code"
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
            <Button
              disabled={isSubmitting}
              size="sm"
              type="submit"
              variant={step.passkey === undefined ? "default" : "outline"}
            >
              {isSubmitting ? "Signing in..." : "Sign in"}
            </Button>
            <Button disabled={isSubmitting} onClick={backToPassword} size="sm" variant="outline">
              Back
            </Button>
          </div>
        </form>
      )}
      {step.kind === "password" && desktopScheme !== null ? (
        <DesktopBrowserSignIn onSignedIn={onSignedIn} scheme={desktopScheme} />
      ) : null}
    </StandalonePage>
  );
}
