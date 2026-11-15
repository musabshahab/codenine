import type {
  ControlEnrolment,
  PasskeyAssertion,
  PasskeyRegistration,
} from "@codenine/contracts/control";
import React, { useEffect, useEffectEvent, useRef, useState } from "react";

import { callControl, controlErrorMessage } from "../../business/control";
import {
  createPasskey,
  passkeyErrorMessage,
  passkeysAvailable,
  signWithPasskey,
} from "../../business/passkeys";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { QRCodeSvg } from "../ui/qr-code";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

const MIN_PASSWORD_LENGTH = 12;

type SecondFactor =
  | { readonly code: string }
  | { readonly newPasskey: PasskeyRegistration }
  | { readonly passkey: PasskeyAssertion };

type Stage =
  | { readonly kind: "loading" }
  | { readonly kind: "unusable"; readonly message: string }
  | { readonly kind: "set-up"; readonly enrolment: ControlEnrolment }
  | { readonly kind: "done"; readonly recoveryCodes: ReadonlyArray<string> };

/**
 * Opens a set-up link. Invitations and resets set up a password, a passkey or
 * an authenticator app, and recovery codes; a forgotten-password link changes
 * only the password, after the person's passkey or code.
 */
export function ControlEnrolSurface({
  token,
  onFinished,
}: {
  /** From the link's fragment; empty when the link has none. */
  readonly token: string;
  readonly onFinished: () => void;
}) {
  const [stage, setStage] = useState<Stage>(
    token === ""
      ? {
          kind: "unusable",
          message: "This link is incomplete. Open it again from your invitation.",
        }
      : { kind: "loading" },
  );
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [code, setCode] = useState("");
  const [chosenMethod, setChosenMethod] = useState<"passkey" | "authenticator" | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const startedRef = useRef(false);

  const start = useEffectEvent(async () => {
    const next = await callControl((client) =>
      client.account.startEnrolment({ payload: { token } }),
    ).then(
      (enrolment): Stage => ({ kind: "set-up", enrolment }),
      (error): Stage => ({ kind: "unusable", message: controlErrorMessage(error) }),
    );
    setStage(next);
  });

  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- opens the link with the control server once, when the page loads
  useEffect(() => {
    if (token === "" || startedRef.current) {
      return;
    }
    startedRef.current = true;
    void start();
  }, [token]);

  /** Sends the password with a second factor, which may come from a passkey prompt first. */
  const submit = async (secondFactor: () => Promise<SecondFactor>) => {
    if (password.length < MIN_PASSWORD_LENGTH) {
      setErrorMessage(`Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirmation) {
      setErrorMessage("The two passwords are different.");
      return;
    }
    setIsSubmitting(true);
    setErrorMessage("");
    const proof = await secondFactor().then(
      (value) => ({ value, message: "" }),
      (error: unknown) => ({ value: null, message: passkeyErrorMessage(error) }),
    );
    if (proof.value === null) {
      setIsSubmitting(false);
      setErrorMessage(proof.message);
      return;
    }
    const factor = proof.value;
    const result = await callControl((client) =>
      client.account.finishEnrolment({ payload: { token, password, ...factor } }),
    ).then(
      ({ recoveryCodes }) => ({ recoveryCodes, message: "" }),
      (error) => ({ recoveryCodes: null, message: controlErrorMessage(error) }),
    );
    setIsSubmitting(false);
    if (result.recoveryCodes === null) {
      setCode("");
      setErrorMessage(result.message);
      return;
    }
    if (result.recoveryCodes.length === 0) {
      onFinished();
      return;
    }
    setStage({ kind: "done", recoveryCodes: result.recoveryCodes });
  };

  if (stage.kind === "loading") {
    return (
      <StandalonePage>
        <StandalonePageHeader title="Set up your sign-in" description="Opening your link..." />
      </StandalonePage>
    );
  }

  if (stage.kind === "unusable") {
    return (
      <StandalonePage>
        <StandalonePageHeader
          title="This link cannot be used"
          description="Ask your administrator for a new invitation or reset link."
        />
        <Alert className="mt-6" variant="error">
          <AlertDescription>{stage.message}</AlertDescription>
        </Alert>
      </StandalonePage>
    );
  }

  if (stage.kind === "done") {
    return <RecoveryCodes codes={stage.recoveryCodes} onFinished={onFinished} />;
  }

  const { enrolment } = stage;
  const { authenticator, passkeySetup, passkeyCheck } = enrolment;
  const canUsePasskeys = passkeysAvailable();
  const offersPasskeySetup = canUsePasskeys && passkeySetup !== undefined;
  const method = chosenMethod ?? (offersPasskeySetup ? "passkey" : "authenticator");
  const createsPasskey = authenticator !== undefined && method === "passkey";
  const codeInput = (label: string, numeric: boolean) => (
    <div className="space-y-2">
      <label className="text-sm font-medium" htmlFor="enrol-code">
        {label}
      </label>
      <Input
        id="enrol-code"
        autoComplete="one-time-code"
        disabled={isSubmitting}
        font="mono"
        inputMode={numeric ? "numeric" : "text"}
        nativeInput
        onChange={(event) => setCode(event.currentTarget.value)}
        required
        value={code}
      />
    </div>
  );

  return (
    <StandalonePage>
      <StandalonePageHeader
        title={
          enrolment.purpose === "password"
            ? "Choose a new password"
            : enrolment.purpose === "reset"
              ? "Set up your sign-in again"
              : "Welcome to Codenine"
        }
        description={
          authenticator === undefined
            ? `For ${enrolment.email}. Confirm it is you as you do when you sign in.`
            : `Set a password for ${enrolment.email}, and a passkey or an authenticator app to confirm it is you.`
        }
      />

      <form
        className="mt-6 space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(async () =>
            createsPasskey && passkeySetup !== undefined
              ? { newPasskey: await createPasskey(passkeySetup) }
              : { code },
          );
        }}
      >
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="enrol-password">
            1. Choose {authenticator === undefined ? "a new" : "a"} password
          </label>
          <Input
            id="enrol-password"
            autoComplete="new-password"
            disabled={isSubmitting}
            nativeInput
            onChange={(event) => setPassword(event.currentTarget.value)}
            required
            type="password"
            value={password}
          />
          <Input
            aria-label="Type the password again"
            autoComplete="new-password"
            disabled={isSubmitting}
            nativeInput
            onChange={(event) => setConfirmation(event.currentTarget.value)}
            placeholder="Type it again"
            required
            type="password"
            value={confirmation}
          />
        </div>

        {authenticator === undefined ? (
          <div className="space-y-3">
            <p className="text-sm font-medium">2. Confirm it is you</p>
            {canUsePasskeys && passkeyCheck !== undefined ? (
              <Button
                disabled={isSubmitting}
                onClick={() =>
                  void submit(async () => ({ passkey: await signWithPasskey(passkeyCheck) }))
                }
                size="sm"
                type="button"
                variant="outline"
              >
                Use a passkey
              </Button>
            ) : null}
            {codeInput("Code from your authenticator app, or a recovery code", false)}
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm font-medium">2. Choose how you confirm it is you</p>
            {offersPasskeySetup ? (
              <ToggleGroup
                aria-label="How you confirm it is you"
                value={[method]}
                onValueChange={(next) => {
                  const value = next[0];
                  if (value === "passkey" || value === "authenticator") setChosenMethod(value);
                }}
              >
                <Toggle value="passkey">Passkey</Toggle>
                <Toggle value="authenticator">Authenticator app</Toggle>
              </ToggleGroup>
            ) : null}
            {method === "passkey" ? (
              <p className="text-xs text-muted-foreground">
                Your device keeps a passkey and asks for your fingerprint, face or screen lock each
                time you sign in.
              </p>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  Scan this code with an authenticator app.
                </p>
                <div className="w-fit rounded-xl bg-white p-3">
                  <QRCodeSvg
                    level="M"
                    marginSize={1}
                    size={168}
                    title="Authenticator set-up code"
                    value={authenticator.uri}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Or type this key into the app:{" "}
                  <code className="font-mono break-all">{authenticator.secret}</code>
                </p>
                {codeInput("Enter the 6-digit code the app shows", true)}
              </>
            )}
          </div>
        )}

        {errorMessage ? (
          <Alert variant="error">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        <Button disabled={isSubmitting} size="sm" type="submit">
          {isSubmitting
            ? "Saving..."
            : authenticator === undefined
              ? "Change password"
              : createsPasskey
                ? "Create passkey and finish"
                : "Finish set-up"}
        </Button>
      </form>
    </StandalonePage>
  );
}

function RecoveryCodes({
  codes,
  onFinished,
}: {
  readonly codes: ReadonlyArray<string>;
  readonly onFinished: () => void;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  return (
    <StandalonePage>
      <StandalonePageHeader
        title="Save your recovery codes"
        description="Each code signs you in once if you lose your authenticator. They are shown only now."
      />
      <ul className="mt-6 grid grid-cols-2 gap-2 font-mono text-sm">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="mt-6 flex flex-wrap gap-2">
        <Button onClick={() => copyToClipboard(codes.join("\n"))} size="sm" variant="outline">
          {isCopied ? "Copied" : "Copy codes"}
        </Button>
        <Button onClick={onFinished} size="sm">
          I have saved them
        </Button>
      </div>
    </StandalonePage>
  );
}
