import type {
  ControlIssuedLink,
  ControlLicenceOverview,
  ControlMe,
  ControlPerson,
  ControlSessionEntry,
  ControlSignInMethods,
} from "@codenine/contracts/control";
import { Link } from "@tanstack/react-router";
import type * as Effect from "effect/Effect";
import React, { useEffect, useEffectEvent, useRef, useState } from "react";

import {
  callControl,
  type ControlClient,
  controlErrorMessage,
  fetchControlMe,
  lastCoveredDay,
} from "../../business/control";
import { createPasskey, passkeyErrorMessage, passkeysAvailable } from "../../business/passkeys";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";
import { Textarea } from "../ui/textarea";

type ControlCall = (client: ControlClient) => Effect.Effect<unknown, unknown>;

interface AdminData {
  readonly me: ControlMe;
  readonly sessions: ReadonlyArray<ControlSessionEntry>;
  readonly signInMethods: ControlSignInMethods;
  /** Only owners and admins see the licence and people. */
  readonly admin: {
    readonly licence: ControlLicenceOverview;
    readonly people: ReadonlyArray<ControlPerson>;
  } | null;
}

const loadAdminData = async (): Promise<AdminData | null> => {
  const me = await fetchControlMe();
  if (me === null) return null;
  const isAdmin = me.role === "owner" || me.role === "admin";
  const [sessions, signInMethods, admin] = await Promise.all([
    callControl((client) => client.me.sessions()),
    callControl((client) => client.me.signInMethods()),
    isAdmin
      ? Promise.all([
          callControl((client) => client.admin.licence()),
          callControl((client) => client.admin.people()),
        ]).then(([licence, people]) => ({ licence, people }))
      : Promise.resolve(null),
  ]);
  return { me, sessions, signInMethods, admin };
};

/** Licence, people and sessions for a business installation. */
export function ControlAdminSurface({ onSignedOut }: { readonly onSignedOut: () => void }) {
  const [data, setData] = useState<AdminData | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const startedRef = useRef(false);

  const refresh = async () => {
    const result = await loadAdminData().then(
      (loaded) => ({ loaded, message: "" }),
      (error) => ({ loaded: undefined, message: controlErrorMessage(error) }),
    );
    if (result.loaded === null) {
      onSignedOut();
    } else if (result.loaded === undefined) {
      setErrorMessage(result.message);
    } else {
      setData(result.loaded);
    }
  };

  const start = useEffectEvent(() => {
    void refresh();
  });

  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- loads the page's data from the control server once, when it opens
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    start();
  }, []);

  /** Runs one change, then shows its error or reloads the page. */
  const act = async (change: ControlCall) => {
    setErrorMessage("");
    const failure = await callControl(change).then(
      () => null,
      (error) => controlErrorMessage(error),
    );
    if (failure !== null) {
      setErrorMessage(failure);
      return false;
    }
    await refresh();
    return true;
  };

  const signOut = (call: ControlCall) => {
    void callControl(call).then(onSignedOut, onSignedOut);
  };

  if (data === null) {
    return (
      <StandalonePage>
        <StandalonePageHeader title="Administration" description="Loading..." />
        {errorMessage ? (
          <Alert className="mt-6" variant="error">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}
      </StandalonePage>
    );
  }

  return (
    <StandalonePage>
      <StandalonePageHeader
        context={data.me.email}
        title={data.admin === null ? "Your account" : "Administration"}
        description={
          data.admin === null
            ? "How you sign in to Codenine, and where you are signed in."
            : "The licence, the people who use Codenine, and how and where you are signed in."
        }
      />
      <div className="mt-4 flex flex-wrap gap-2">
        <Button render={<Link to="/" />} size="sm" variant="outline">
          Back to Codenine
        </Button>
        <Button onClick={() => signOut((client) => client.me.signOut())} size="sm" variant="ghost">
          Sign out
        </Button>
      </div>

      {errorMessage ? (
        <Alert className="mt-6" variant="error">
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      ) : null}

      {data.admin === null ? null : (
        <>
          <LicenceSection
            licence={data.admin.licence}
            onInstall={(token) =>
              act((client) => client.admin.installLicence({ payload: { token } }))
            }
          />
          <PeopleSection
            meId={data.me.id}
            onAction={act}
            onChanged={refresh}
            people={data.admin.people}
          />
        </>
      )}

      <SignInMethodsSection
        methods={data.signInMethods}
        onAddPasskey={async (name) => {
          const failure = await callControl((client) => client.me.startPasskey())
            .then(({ ticket, options }) =>
              createPasskey(options).then((passkey) =>
                callControl((client) =>
                  client.me.addPasskey({ payload: { ticket, name, passkey } }),
                ),
              ),
            )
            .then(
              () => null,
              (error: unknown) => passkeyErrorMessage(error),
            );
          if (failure === null) await refresh();
          return failure;
        }}
        onRemovePasskey={async (passkeyId) => {
          const failure = await callControl((client) =>
            client.me.removePasskey({ params: { passkeyId } }),
          ).then(
            () => null,
            (error: unknown) => controlErrorMessage(error),
          );
          if (failure === null) await refresh();
          return failure;
        }}
      />

      <SessionsSection
        onRevoke={(sessionId) =>
          act((client) => client.me.revokeSession({ params: { sessionId } }))
        }
        onSignOutEverywhere={() => signOut((client) => client.me.signOutEverywhere())}
        sessions={data.sessions}
      />
    </StandalonePage>
  );
}

function SectionTitle({ children }: { readonly children: React.ReactNode }) {
  return <h2 className="mt-8 text-base font-semibold">{children}</h2>;
}

const LICENCE_STATUS = {
  "not-yet-valid": { label: "Not started", variant: "warning" },
  active: { label: "Active", variant: "success" },
  expiring: { label: "Ending soon", variant: "warning" },
  grace: { label: "Grace period", variant: "warning" },
  expired: { label: "Expired", variant: "error" },
} as const;

function LicenceSection({
  licence,
  onInstall,
}: {
  readonly licence: ControlLicenceOverview;
  readonly onInstall: (token: string) => Promise<boolean>;
}) {
  const [token, setToken] = useState("");
  const [isInstalling, setIsInstalling] = useState(false);
  const summary = licence.licence;

  const install = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsInstalling(true);
    const installed = await onInstall(token.trim());
    setIsInstalling(false);
    if (installed) setToken("");
  };

  return (
    <section>
      <SectionTitle>Licence</SectionTitle>
      {summary._tag === "installed" ? (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Status</dt>
          <dd>
            <Badge variant={LICENCE_STATUS[summary.status].variant}>
              {LICENCE_STATUS[summary.status].label}
            </Badge>
          </dd>
          <dt className="text-muted-foreground">Customer</dt>
          <dd>{summary.customer}</dd>
          <dt className="text-muted-foreground">Seats</dt>
          <dd>
            {summary.seatsUsed} of {summary.seats} in use
          </dd>
          <dt className="text-muted-foreground">Covers</dt>
          <dd>
            {new Date(summary.startsAt).toLocaleDateString(undefined, { timeZone: "UTC" })} to{" "}
            {lastCoveredDay(summary.expiresAt)}, then grace to {lastCoveredDay(summary.graceEndsAt)}
          </dd>
          <dt className="text-muted-foreground">Installation</dt>
          <dd className="font-mono text-xs">{licence.installationId}</dd>
        </dl>
      ) : (
        <Alert className="mt-3" variant="warning">
          <AlertDescription>
            {summary._tag === "missing"
              ? "No licence key is installed, so Codenine is read-only."
              : "The installed licence key cannot be used, so Codenine is read-only."}{" "}
            This installation's ID is <code className="font-mono">{licence.installationId}</code>.
          </AlertDescription>
        </Alert>
      )}
      <form className="mt-4 space-y-2" onSubmit={(event) => void install(event)}>
        <label className="text-sm font-medium" htmlFor="licence-key">
          Install a licence key
        </label>
        <Textarea
          id="licence-key"
          disabled={isInstalling}
          onChange={(event) => setToken(event.currentTarget.value)}
          placeholder="Paste the key you received"
          size="sm"
          spellCheck={false}
          value={token}
        />
        <Button disabled={isInstalling || token.trim() === ""} size="sm" type="submit">
          {isInstalling ? "Installing..." : "Install key"}
        </Button>
      </form>
    </section>
  );
}

const PERSON_STATUS = {
  invited: { label: "Invited", variant: "info" },
  active: { label: "Active", variant: "success" },
  deactivated: { label: "Deactivated", variant: "secondary" },
} as const;

function PeopleSection({
  people,
  meId,
  onAction,
  onChanged,
}: {
  readonly people: ReadonlyArray<ControlPerson>;
  readonly meId: string;
  readonly onAction: (change: ControlCall) => Promise<boolean>;
  readonly onChanged: () => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [isInviting, setIsInviting] = useState(false);
  const [linkError, setLinkError] = useState("");
  const [issuedLink, setIssuedLink] = useState<ControlIssuedLink | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  /** Asks for an invitation or reset link to show the admin. */
  const issue = async (
    call: (client: ControlClient) => Effect.Effect<ControlIssuedLink, unknown>,
  ) => {
    setLinkError("");
    const result = await callControl(call).then(
      (link) => ({ link, message: "" }),
      (error) => ({ link: null, message: controlErrorMessage(error) }),
    );
    if (result.link === null) {
      setLinkError(result.message);
      return false;
    }
    setIssuedLink(result.link);
    await onChanged();
    return true;
  };

  const invite = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsInviting(true);
    const invited = await issue((client) =>
      client.admin.invite({ payload: { email, displayName, role } }),
    );
    setIsInviting(false);
    if (invited) {
      setEmail("");
      setDisplayName("");
    }
  };

  return (
    <section>
      <SectionTitle>People</SectionTitle>
      <ul className="mt-3 divide-y divide-border/70">
        {people.map((person) => (
          <li className="flex flex-wrap items-center gap-2 py-2" key={person.id}>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{person.displayName}</p>
              <p className="truncate text-xs text-muted-foreground">
                {person.email} · {person.role}
              </p>
            </div>
            <Badge variant={PERSON_STATUS[person.status].variant}>
              {PERSON_STATUS[person.status].label}
            </Badge>
            {person.lockedUntil === null ? null : (
              <Button
                onClick={() =>
                  void onAction((client) =>
                    client.admin.unlock({ params: { personId: person.id } }),
                  )
                }
                size="xs"
                variant="outline"
              >
                Unlock
              </Button>
            )}
            {person.status === "deactivated" ? null : (
              <Button
                onClick={() =>
                  void issue((client) => client.admin.reset({ params: { personId: person.id } }))
                }
                size="xs"
                variant="outline"
              >
                {person.status === "invited" ? "New invitation link" : "Reset sign-in"}
              </Button>
            )}
            {person.id === meId ? null : person.status === "deactivated" ? (
              <Button
                onClick={() =>
                  void onAction((client) =>
                    client.admin.reactivate({ params: { personId: person.id } }),
                  )
                }
                size="xs"
                variant="outline"
              >
                Reactivate
              </Button>
            ) : (
              <Button
                onClick={() =>
                  void onAction((client) =>
                    client.admin.deactivate({ params: { personId: person.id } }),
                  )
                }
                size="xs"
                variant="destructive-outline"
              >
                Deactivate
              </Button>
            )}
          </li>
        ))}
      </ul>

      {issuedLink === null ? null : (
        <Alert className="mt-4" variant="info">
          <AlertDescription>
            <p>
              {issuedLink.emailed
                ? `We emailed this link to ${issuedLink.person.email}.`
                : `Send this link to ${issuedLink.person.displayName}.`}{" "}
              It works once: they set a password and an authenticator app, then they are signed in.
            </p>
            <p className="mt-2 font-mono text-xs break-all">{issuedLink.link}</p>
            <div className="mt-2 flex gap-2">
              <Button onClick={() => copyToClipboard(issuedLink.link)} size="xs" variant="outline">
                {isCopied ? "Copied" : "Copy link"}
              </Button>
              <Button onClick={() => setIssuedLink(null)} size="xs" variant="ghost">
                Done
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      <form className="mt-4 space-y-2" onSubmit={(event) => void invite(event)}>
        <p className="text-sm font-medium">Invite someone</p>
        <div className="flex flex-wrap gap-2">
          <div className="min-w-40 flex-1">
            <Input
              aria-label="Email address"
              disabled={isInviting}
              nativeInput
              onChange={(event) => setEmail(event.currentTarget.value)}
              placeholder="Email address"
              required
              type="email"
              value={email}
            />
          </div>
          <div className="min-w-40 flex-1">
            <Input
              aria-label="Name"
              disabled={isInviting}
              nativeInput
              onChange={(event) => setDisplayName(event.currentTarget.value)}
              placeholder="Name"
              value={displayName}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            items={{ member: "Member", admin: "Admin" }}
            onValueChange={(value) => {
              if (value === "member" || value === "admin") setRole(value);
            }}
            value={role}
          >
            <SelectTrigger aria-label="Role" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="member">Member</SelectItem>
              <SelectItem value="admin">Admin</SelectItem>
            </SelectPopup>
          </Select>
          <Button disabled={isInviting} size="sm" type="submit">
            {isInviting ? "Inviting..." : "Invite"}
          </Button>
        </div>
        {linkError ? (
          <Alert variant="error">
            <AlertDescription>{linkError}</AlertDescription>
          </Alert>
        ) : null}
      </form>
    </section>
  );
}

function SignInMethodsSection({
  methods,
  onAddPasskey,
  onRemovePasskey,
}: {
  readonly methods: ControlSignInMethods;
  /** Each resolves to an error message, or null when it worked. */
  readonly onAddPasskey: (name: string) => Promise<string | null>;
  readonly onRemovePasskey: (passkeyId: string) => Promise<string | null>;
}) {
  const [name, setName] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  return (
    <section>
      <SectionTitle>How you sign in</SectionTitle>
      <p className="mt-2 text-sm text-muted-foreground">
        After your password: {methods.authenticator ? "your authenticator app, " : ""}
        {methods.passkeys.length === 0 ? "" : "a passkey, "}
        or one of your {methods.recoveryCodesLeft} unused recovery codes.
      </p>
      <ul className="mt-3 divide-y divide-border/70">
        {methods.passkeys.map((passkey) => (
          <li className="flex items-center gap-2 py-2" key={passkey.id}>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{passkey.name}</p>
              <p className="text-xs text-muted-foreground">
                Added {new Date(passkey.createdAt).toLocaleDateString()}
                {passkey.lastUsedAt === null
                  ? ", not used yet"
                  : `, last used ${new Date(passkey.lastUsedAt).toLocaleString()}`}
              </p>
            </div>
            <Button
              onClick={() => {
                setErrorMessage("");
                void onRemovePasskey(passkey.id).then((failure) => setErrorMessage(failure ?? ""));
              }}
              size="xs"
              variant="outline"
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
      {passkeysAvailable() ? (
        <form
          className="mt-3 flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setIsAdding(true);
            setErrorMessage("");
            void onAddPasskey(name).then((failure) => {
              setIsAdding(false);
              setErrorMessage(failure ?? "");
              if (failure === null) setName("");
            });
          }}
        >
          <Input
            aria-label="Passkey name"
            className="w-56"
            disabled={isAdding}
            nativeInput
            onChange={(event) => setName(event.currentTarget.value)}
            placeholder="This laptop"
            value={name}
          />
          <Button disabled={isAdding} size="sm" type="submit" variant="outline">
            {isAdding ? "Waiting for your device..." : "Add a passkey"}
          </Button>
        </form>
      ) : null}
      {errorMessage ? (
        <Alert className="mt-3" variant="error">
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
}

function SessionsSection({
  sessions,
  onRevoke,
  onSignOutEverywhere,
}: {
  readonly sessions: ReadonlyArray<ControlSessionEntry>;
  readonly onRevoke: (sessionId: string) => Promise<boolean>;
  readonly onSignOutEverywhere: () => void;
}) {
  return (
    <section>
      <SectionTitle>Where you are signed in</SectionTitle>
      <ul className="mt-3 divide-y divide-border/70">
        {sessions.map((session) => (
          <li className="flex items-center gap-2 py-2" key={session.id}>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{session.userAgent ?? "Unknown browser"}</p>
              <p className="text-xs text-muted-foreground">
                Last seen {new Date(session.lastSeenAt).toLocaleString()}
              </p>
            </div>
            {session.current ? (
              <Badge variant="secondary">This browser</Badge>
            ) : (
              <Button onClick={() => void onRevoke(session.id)} size="xs" variant="outline">
                Sign out
              </Button>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-3">
        <Button onClick={onSignOutEverywhere} size="sm" variant="destructive-outline">
          Sign out everywhere
        </Button>
      </div>
    </section>
  );
}
