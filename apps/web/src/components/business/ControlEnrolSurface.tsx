import type { ControlEnrolment } from "@codenine/contracts/control";
import React, { useEffect, useEffectEvent, useRef, useState } from "react";

import { callControl, controlErrorMessage } from "../../business/control";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { QRCodeSvg } from "../ui/qr-code";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";

const MIN_PASSWORD_LENGTH = 12;

type Stage =
  | { readonly kind: "loading" }
  | { readonly kind: "unusable"; readonly message: string }
  | { readonly kind: "set-up"; readonly enrolment: ControlEnrolment }
  | { readonly kind: "done"; readonly recoveryCodes: ReadonlyArray<string> };

/**
 * Opens an invitation or reset link: the person scans an authenticator code,
 * chooses a password, and keeps their recovery codes.
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

  const finish = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
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
    const result = await callControl((client) =>
      client.account.finishEnrolment({ payload: { token, password, code } }),
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
  return (
    <StandalonePage>
      <StandalonePageHeader
        title={enrolment.purpose === "reset" ? "Set up your sign-in again" : "Welcome to Codenine"}
        description={`Set a password and an authenticator app for ${enrolment.email}.`}
      />

      <form className="mt-6 space-y-5" onSubmit={(event) => void finish(event)}>
        <div className="space-y-3">
          <p className="text-sm font-medium">1. Scan this code with an authenticator app</p>
          <div className="w-fit rounded-xl bg-white p-3">
            <QRCodeSvg
              level="M"
              marginSize={1}
              size={168}
              title="Authenticator set-up code"
              value={enrolment.authenticatorUri}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Or type this key into the app:{" "}
            <code className="font-mono break-all">{enrolment.authenticatorSecret}</code>
          </p>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="enrol-password">
            2. Choose a password
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

        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="enrol-code">
            3. Enter the 6-digit code the app shows
          </label>
          <Input
            id="enrol-code"
            autoComplete="one-time-code"
            disabled={isSubmitting}
            font="mono"
            inputMode="numeric"
            nativeInput
            onChange={(event) => setCode(event.currentTarget.value)}
            required
            value={code}
          />
        </div>

        {errorMessage ? (
          <Alert variant="error">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        <Button disabled={isSubmitting} size="sm" type="submit">
          {isSubmitting ? "Setting up..." : "Finish set-up"}
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
