import {
  type ControlAiAccount,
  type ControlBudgetRequest,
  assignableRoles,
  type ControlAuditEntry,
  type ControlAuditPage,
  type ControlDepartment,
  type ControlIssuedLink,
  type ControlLicenceOverview,
  type ControlMe,
  type ControlPerson,
  type ControlProfile,
  type ControlProfileException,
  type ControlProvisioning,
  type ControlRole,
  type ControlSession,
  type ControlSessionEntry,
  type ControlSsoConnection,
  type ControlSignInMethods,
  permissionReach,
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
  openWorkspace,
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
import { type ControlCall, ROLE_LABELS, SectionTitle } from "./adminParts";
import { DepartmentsSection } from "./ControlDepartments";
import { ProfilesSection } from "./ControlProfiles";
import { AiAccountsSection } from "./ControlAiAccounts";
import { BudgetRequestsSection } from "./ControlBudgetRequests";
import { ProvisioningSection } from "./ControlProvisioning";
import { SingleSignOnSection } from "./ControlSingleSignOn";

interface AdminData {
  readonly me: ControlMe;
  readonly sessions: ReadonlyArray<ControlSessionEntry>;
  readonly signInMethods: ControlSignInMethods;
  /** Null when the person's role does not show it. */
  readonly licence: ControlLicenceOverview | null;
  readonly people: ReadonlyArray<ControlPerson> | null;
  readonly departments: ReadonlyArray<ControlDepartment> | null;
  readonly audit: ControlAuditPage | null;
  readonly provisioning: ControlProvisioning | null;
  readonly ssoConnections: ReadonlyArray<ControlSsoConnection> | null;
  readonly aiAccounts: ReadonlyArray<ControlAiAccount> | null;
  readonly budgetRequests: ReadonlyArray<ControlBudgetRequest> | null;
  readonly profiles: ReadonlyArray<ControlProfile> | null;
  readonly exceptions: ReadonlyArray<ControlProfileException> | null;
}

const loadAdminData = async (): Promise<AdminData | null> => {
  const me = await fetchControlMe();
  if (me === null) return null;
  const owns = permissionReach(me.role, "security:manage") !== null;
  const [
    sessions,
    signInMethods,
    licence,
    people,
    departments,
    audit,
    provisioning,
    sso,
    profiles,
    exceptions,
    aiAccounts,
    budgetRequests,
  ] = await Promise.all([
    callControl((client) => client.me.sessions()),
    callControl((client) => client.me.signInMethods()),
    permissionReach(me.role, "licence:read") === null
      ? null
      : callControl((client) => client.admin.licence()),
    permissionReach(me.role, "people:manage") === null
      ? null
      : callControl((client) => client.admin.people()),
    permissionReach(me.role, "departments:manage") === null
      ? null
      : callControl((client) => client.admin.departments()),
    permissionReach(me.role, "audit:read") === null
      ? null
      : callControl((client) => client.admin.audit({ query: {} })),
    owns ? callControl((client) => client.admin.provisioning()) : null,
    owns ? callControl((client) => client.admin.ssoConnections()) : null,
    permissionReach(me.role, "departments:manage") === null
      ? null
      : callControl((client) => client.admin.profiles()),
    permissionReach(me.role, "people:manage") === null
      ? null
      : callControl((client) => client.admin.exceptions()),
    permissionReach(me.role, "ai:manage") === null
      ? null
      : callControl((client) => client.admin.aiAccounts()),
    permissionReach(me.role, "departments:manage") === null
      ? null
      : callControl((client) => client.admin.budgetRequests()),
  ]);
  return {
    me,
    sessions,
    signInMethods,
    licence,
    people,
    departments,
    audit,
    provisioning,
    ssoConnections: sso,
    profiles,
    exceptions,
    aiAccounts,
    budgetRequests,
  };
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

  const shown = [
    data.licence === null ? null : "the licence",
    data.people === null ? null : "the people you manage",
    data.audit === null ? null : "the audit log",
  ].filter((part) => part !== null);
  return (
    <StandalonePage>
      <StandalonePageHeader
        context={`${data.me.email} · ${ROLE_LABELS[data.me.role]}`}
        title={shown.length > 0 ? "Administration" : "Your account"}
        description={
          shown.length > 0
            ? `${shown.join(", ").replace(/^t/u, "T")}, and how and where you are signed in.`
            : "How you sign in to Codenine, and where you are signed in."
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

      {data.licence === null ? null : (
        <LicenceSection
          licence={data.licence}
          onInstall={
            permissionReach(data.me.role, "licence:manage") === null
              ? null
              : (token) => act((client) => client.admin.installLicence({ payload: { token } }))
          }
        />
      )}
      {data.people === null ? null : (
        <PeopleSection
          departments={data.departments ?? []}
          me={data.me}
          onAction={act}
          onChanged={refresh}
          people={data.people}
        />
      )}

      {data.departments === null ? null : (
        <DepartmentsSection
          canCreate={permissionReach(data.me.role, "departments:manage") === "all"}
          departments={data.departments}
          onAction={act}
          people={data.people ?? []}
        />
      )}

      {data.profiles === null || data.profiles.length === 0 ? null : (
        <ProfilesSection
          departments={data.departments ?? []}
          exceptions={data.exceptions ?? []}
          onAction={act}
          people={data.people ?? []}
          profiles={data.profiles}
        />
      )}

      {data.budgetRequests === null ? null : (
        <BudgetRequestsSection onAction={act} requests={data.budgetRequests} />
      )}

      {data.aiAccounts === null ? null : (
        <AiAccountsSection accounts={data.aiAccounts} onAction={act} />
      )}

      {data.ssoConnections === null ? null : (
        <SingleSignOnSection
          connections={data.ssoConnections}
          onAction={act}
          owners={(data.people ?? []).filter(
            (person) => person.role === "owner" && person.status === "active",
          )}
        />
      )}

      {data.provisioning === null ? null : (
        <ProvisioningSection
          onCreateToken={async () => {
            setErrorMessage("");
            const created = await callControl((client) =>
              client.admin.createProvisioningToken(),
            ).then(
              ({ token }) => token,
              (error: unknown) => {
                setErrorMessage(controlErrorMessage(error));
                return null;
              },
            );
            if (created !== null) await refresh();
            return created;
          }}
          onRevokeToken={() => act((client) => client.admin.revokeProvisioningToken())}
          provisioning={data.provisioning}
        />
      )}

      {data.audit === null ? null : (
        <AuditSection firstPage={data.audit} key={data.audit.entries[0]?.id ?? 0} />
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
  /** Null for people who may see the licence but not install one. */
  readonly onInstall: ((token: string) => Promise<boolean>) | null;
}) {
  const [token, setToken] = useState("");
  const [isInstalling, setIsInstalling] = useState(false);
  const summary = licence.licence;

  const install = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (onInstall === null) return;
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
      {onInstall === null ? null : (
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
      )}
    </section>
  );
}

/** Enough to scan; a search finds anyone else. */
const PEOPLE_SHOWN = 100;

const PERSON_STATUS = {
  invited: { label: "Invited", variant: "info" },
  active: { label: "Active", variant: "success" },
  deactivated: { label: "Deactivated", variant: "secondary" },
} as const;

function PeopleSection({
  people,
  departments,
  me,
  onAction,
  onChanged,
}: {
  readonly people: ReadonlyArray<ControlPerson>;
  readonly departments: ReadonlyArray<ControlDepartment>;
  readonly me: ControlMe;
  readonly onAction: (change: ControlCall) => Promise<boolean>;
  readonly onChanged: () => Promise<void>;
}) {
  // Department admins invite into one of their departments; others may leave it empty.
  const needsDepartment = permissionReach(me.role, "people:manage") === "own-department";
  const [department, setDepartment] = useState(needsDepartment ? (departments[0]?.id ?? "") : "");
  const departmentNames = (personId: string) =>
    departments
      .filter((candidate) => candidate.members.includes(personId))
      .map((candidate) => candidate.name);
  // Someone manages the people whose role they could give, as the control server checks.
  const givable = assignableRoles(me.role);
  const roleItems = Object.fromEntries(givable.map((role) => [role, ROLE_LABELS[role]]));
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<ControlRole>(
    givable.includes("member") ? "member" : (givable[0] ?? "member"),
  );
  const [isInviting, setIsInviting] = useState(false);
  const [linkError, setLinkError] = useState("");
  const [issuedLink, setIssuedLink] = useState<ControlIssuedLink | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const [search, setSearch] = useState("");
  // Owners may look at someone's workspace in an emergency, with a reason the person is told.
  const canOpenWorkspaces = permissionReach(me.role, "security:manage") !== null;
  const [opening, setOpening] = useState<{
    readonly personId: string;
    readonly departmentId: string | null;
    readonly reason: string;
  } | null>(null);
  const [openSessions, setOpenSessions] = useState<{
    readonly personId: string;
    readonly sessions: ReadonlyArray<ControlSession>;
  } | null>(null);
  const searched = search.trim().toLowerCase();
  const matching =
    searched === ""
      ? people
      : people.filter((person) =>
          [person.displayName, person.email, ...departmentNames(person.id)]
            .join(" ")
            .toLowerCase()
            .includes(searched),
        );
  const shownPeople = matching.slice(0, PEOPLE_SHOWN);

  const toggleSessions = async (personId: string) => {
    if (openSessions?.personId === personId) {
      setOpenSessions(null);
      return;
    }
    setLinkError("");
    await callControl((client) => client.admin.personSessions({ params: { personId } })).then(
      (sessions) => setOpenSessions({ personId, sessions }),
      (error: unknown) => setLinkError(controlErrorMessage(error)),
    );
  };

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
      client.admin.invite({
        payload: { email, displayName, role, departments: department === "" ? [] : [department] },
      }),
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
      <div className="mt-3">
        <Input
          aria-label="Search people"
          onChange={(event) => setSearch(event.currentTarget.value)}
          placeholder="Search by name, email or department"
          size="sm"
          type="search"
          value={search}
        />
      </div>
      <ul className="mt-2 divide-y divide-border/70">
        {shownPeople.map((person) => {
          const manages = givable.includes(person.role);
          return (
            <li className="flex flex-wrap items-center gap-2 py-2" key={person.id}>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{person.displayName}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {person.email}
                  {manages && person.id !== me.id ? "" : ` · ${ROLE_LABELS[person.role]}`}
                  {departmentNames(person.id).length === 0
                    ? ""
                    : ` · ${departmentNames(person.id).join(", ")}`}
                </p>
              </div>
              {manages && person.id !== me.id ? (
                <div className="w-40">
                  <Select
                    items={roleItems}
                    onValueChange={(value) => {
                      const chosen = givable.find((candidate) => candidate === value);
                      if (chosen === undefined || chosen === person.role) return;
                      void onAction((client) =>
                        client.admin.setRole({
                          params: { personId: person.id },
                          payload: { role: chosen },
                        }),
                      );
                    }}
                    value={person.role}
                  >
                    <SelectTrigger aria-label={`Role of ${person.displayName}`} size="xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {givable.map((option) => (
                        <SelectItem key={option} value={option}>
                          {ROLE_LABELS[option]}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              ) : null}
              <Badge variant={PERSON_STATUS[person.status].variant}>
                {PERSON_STATUS[person.status].label}
              </Badge>
              {!manages ? null : person.lockedUntil === null ? null : (
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
              {!manages || person.status === "deactivated" ? null : (
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
              {!canOpenWorkspaces || person.id === me.id || person.status === "invited" ? null : (
                <Button
                  aria-expanded={opening?.personId === person.id}
                  onClick={() =>
                    setOpening(
                      opening?.personId === person.id
                        ? null
                        : {
                            personId: person.id,
                            departmentId:
                              departments.find((d) => d.members.includes(person.id))?.id ?? null,
                            reason: "",
                          },
                    )
                  }
                  size="xs"
                  variant="ghost"
                >
                  Open workspace
                </Button>
              )}
              {!manages || person.id === me.id || person.status === "deactivated" ? null : (
                <Button
                  aria-expanded={openSessions?.personId === person.id}
                  onClick={() => void toggleSessions(person.id)}
                  size="xs"
                  variant="ghost"
                >
                  Sessions
                </Button>
              )}
              {!manages || person.id === me.id ? null : person.status === "deactivated" ? (
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
              {opening?.personId === person.id ? (
                <form
                  className="basis-full space-y-2 rounded-md border border-border/70 p-2 text-xs"
                  onSubmit={(event) => {
                    event.preventDefault();
                    setLinkError("");
                    openWorkspace(opening.personId, opening.departmentId, opening.reason).catch(
                      (error: unknown) => setLinkError(controlErrorMessage(error)),
                    );
                  }}
                >
                  <p className="text-muted-foreground">
                    You see their workspace as they left it, without changing anything, for an hour.
                    They get an email with your reason, and the audit log records it.
                  </p>
                  {departments.some((d) => d.members.includes(person.id)) ? (
                    <Select
                      items={Object.fromEntries(
                        departments
                          .filter((d) => d.members.includes(person.id))
                          .map((d) => [d.id, d.name]),
                      )}
                      onValueChange={(value) =>
                        setOpening({
                          ...opening,
                          departmentId: typeof value === "string" ? value : null,
                        })
                      }
                      value={opening.departmentId}
                    >
                      <SelectTrigger aria-label="Their workspace in" size="xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup>
                        {departments
                          .filter((d) => d.members.includes(person.id))
                          .map((d) => (
                            <SelectItem key={d.id} value={d.id}>
                              {d.name}
                            </SelectItem>
                          ))}
                      </SelectPopup>
                    </Select>
                  ) : null}
                  <Input
                    aria-label="Why you need it"
                    onChange={(event) =>
                      setOpening({ ...opening, reason: event.currentTarget.value })
                    }
                    placeholder="Why you need it, which they will read"
                    size="sm"
                    value={opening.reason}
                  />
                  <Button disabled={opening.reason.trim().length < 10} size="xs" type="submit">
                    Open their workspace
                  </Button>
                </form>
              ) : null}
              {openSessions?.personId === person.id ? (
                <div className="basis-full space-y-2 rounded-md border border-border/70 p-2 text-xs">
                  {openSessions.sessions.length === 0 ? (
                    <p className="text-muted-foreground">Not signed in anywhere.</p>
                  ) : (
                    <ul className="space-y-1">
                      {openSessions.sessions.map((session) => (
                        <li key={session.id}>
                          {session.userAgent ?? "Unknown browser"} · last seen{" "}
                          {new Date(session.lastSeenAt).toLocaleString()}
                        </li>
                      ))}
                    </ul>
                  )}
                  {openSessions.sessions.length === 0 ? null : (
                    <Button
                      onClick={() =>
                        void onAction((client) =>
                          client.admin.signOutPerson({ params: { personId: person.id } }),
                        ).then((signedOut) => {
                          if (signedOut) setOpenSessions(null);
                        })
                      }
                      size="xs"
                      variant="destructive-outline"
                    >
                      Sign out everywhere
                    </Button>
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {matching.length > shownPeople.length ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Showing {shownPeople.length} of {matching.length}. Search to find someone else.
        </p>
      ) : null}
      {matching.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">Nobody matches.</p>
      ) : null}

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
            items={roleItems}
            onValueChange={(value) => {
              const chosen = givable.find((candidate) => candidate === value);
              if (chosen !== undefined) setRole(chosen);
            }}
            value={role}
          >
            <SelectTrigger aria-label="Role" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {givable.map((option) => (
                <SelectItem key={option} value={option}>
                  {ROLE_LABELS[option]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          {departments.length === 0 ? null : (
            <Select
              items={{
                ...(needsDepartment ? {} : { "": "No department" }),
                ...Object.fromEntries(departments.map(({ id, name }) => [id, name])),
              }}
              onValueChange={(value) => {
                if (typeof value === "string") setDepartment(value);
              }}
              value={department}
            >
              <SelectTrigger aria-label="Department" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {needsDepartment ? null : <SelectItem value="">No department</SelectItem>}
                {departments.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          )}
          <Button
            disabled={isInviting || (needsDepartment && department === "")}
            size="sm"
            type="submit"
          >
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

const AUDIT_ACTIONS: Record<ControlAuditEntry["action"], string> = {
  "licence.install": "installed licence",
  "person.invite": "invited",
  "person.provision": "added",
  "person.update": "changed the email or name of",
  "person.role": "changed the role of",
  "person.deactivate": "deactivated",
  "person.reactivate": "reactivated",
  "person.reset": "reset the sign-in of",
  "person.unlock": "unlocked",
  "person.sign-in": "signed in",
  "person.files-deleted": "deleted the workspace files of",
  "department.create": "created the department",
  "department.rename": "renamed the department",
  "department.delete": "deleted the department",
  "department.add-member": "added to a department",
  "department.remove-member": "removed from a department",
  "team.create": "created the team",
  "team.rename": "renamed the team",
  "team.delete": "deleted the team",
  "team.add-member": "added to a team",
  "team.remove-member": "removed from a team",
  "profile.publish": "published a new version of the profile",
  "profile.test": "started testing a version of the profile",
  "profile.discard": "dropped the version being tested of the profile",
  "profile.rollback": "rolled back the profile",
  "exception.create": "made an exception for",
  "exception.end": "ended an exception for",
  "provisioning.token-create": "created a token for",
  "provisioning.token-revoke": "revoked the token for",
  "person.emergency": "changed whether this owner keeps a password:",
  "person.sign-out": "signed out everywhere",
  "person.workspace-open": "opened the workspace of",
  "person.workspace-close": "left the workspace of",
  "sso.create": "set up single sign-on with",
  "sso.update": "changed single sign-on with",
  "sso.delete": "removed single sign-on with",
  "ai-account.create": "added the AI account",
  "ai-account.update": "changed the AI account",
  "ai-account.delete": "removed the AI account",
  "budget-request.approve": "approved more AI budget for",
  "budget-request.decline": "declined more AI budget for",
};

const auditValue = (value: string | number | boolean | null | undefined) =>
  value === null || value === undefined ? "none" : String(value);

/** What changed, as `key: before → after`, or the new values when nothing came before. */
const auditChanges = ({ before, after }: ControlAuditEntry) =>
  Object.entries(after ?? {})
    .map(([key, value]) =>
      before === null
        ? `${key}: ${auditValue(value)}`
        : `${key}: ${auditValue(before[key])} → ${auditValue(value)}`,
    )
    .join(", ");

/** Changes to people and the licence, and sign-ins, newest first. */
function AuditSection({ firstPage }: { readonly firstPage: ControlAuditPage }) {
  const [entries, setEntries] = useState(firstPage.entries);
  const [next, setNext] = useState(firstPage.next);
  const [errorMessage, setErrorMessage] = useState("");

  const showOlder = async (before: number) => {
    setErrorMessage("");
    const failure = await callControl((client) => client.admin.audit({ query: { before } })).then(
      (page) => {
        setEntries((shown) => [...shown, ...page.entries]);
        setNext(page.next);
        return "";
      },
      (error: unknown) => controlErrorMessage(error),
    );
    setErrorMessage(failure);
  };

  return (
    <section>
      <SectionTitle>Audit log</SectionTitle>
      <ul className="mt-3 divide-y divide-border/70">
        {entries.map((entry) => {
          const changes = auditChanges(entry);
          return (
            <li className="py-2" key={entry.id}>
              <p className="text-sm">
                {entry.actor.label} {AUDIT_ACTIONS[entry.action]}
                {entry.target === null ? "" : ` ${entry.target.label}`}
              </p>
              <p className="text-xs text-muted-foreground">
                {new Date(entry.at).toLocaleString()}
                {entry.source.address === null ? "" : ` · from ${entry.source.address}`}
                {changes === "" ? "" : ` · ${changes}`}
              </p>
            </li>
          );
        })}
      </ul>
      {entries.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">Nothing has been recorded yet.</p>
      ) : null}
      {next === null ? null : (
        <div className="mt-3">
          <Button onClick={() => void showOlder(next)} size="sm" variant="outline">
            Show older
          </Button>
        </div>
      )}
      {errorMessage ? (
        <Alert className="mt-3" variant="error">
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      ) : null}
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
