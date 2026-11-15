import {
  type ControlPerson,
  ControlRole,
  type ControlSsoConnection,
  type ControlSsoProtocol,
  type ControlSsoSettings,
} from "@codenine/contracts/control";
import React, { useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { type ControlCall, SectionTitle } from "./adminParts";

interface Draft {
  readonly protocol: ControlSsoProtocol;
  readonly name: string;
  readonly domains: string;
  readonly required: boolean;
  readonly createPeople: boolean;
  readonly groupsClaim: string;
  /** One `group = role` a line. */
  readonly roleGroups: string;
  readonly issuer: string;
  readonly clientId: string;
  /** Empty keeps the saved one. */
  readonly clientSecret: string;
  readonly entryPoint: string;
  readonly samlIssuer: string;
  readonly certificate: string;
}

const EMPTY: Draft = {
  protocol: "oidc",
  name: "",
  domains: "",
  required: false,
  createPeople: true,
  groupsClaim: "",
  roleGroups: "",
  issuer: "",
  clientId: "",
  clientSecret: "",
  entryPoint: "",
  samlIssuer: "",
  certificate: "",
};

const draftOf = (connection: ControlSsoConnection): Draft => ({
  ...EMPTY,
  protocol: connection.protocol,
  name: connection.name,
  domains: connection.domains.join(", "),
  required: connection.required,
  createPeople: connection.createPeople,
  groupsClaim: connection.groupsClaim ?? "",
  roleGroups: connection.roleGroups.map(({ group, role }) => `${group} = ${role}`).join("\n"),
  issuer: connection.oidc?.issuer ?? "",
  clientId: connection.oidc?.clientId ?? "",
  entryPoint: connection.saml?.entryPoint ?? "",
  samlIssuer: connection.saml?.issuer ?? "",
  certificate: connection.saml?.certificate ?? "",
});

const roles: ReadonlyArray<string> = ControlRole.literals;

/** The settings a draft makes, or what is wrong with it. */
const settingsOf = (draft: Draft): ControlSsoSettings | string => {
  const roleGroups: Array<ControlSsoSettings["roleGroups"][number]> = [];
  for (const line of draft.roleGroups.split("\n").map((entry) => entry.trim())) {
    if (line === "") continue;
    const [group = "", role = ""] = line.split("=").map((part) => part.trim());
    const known = ControlRole.literals.find((candidate) => candidate === role);
    if (group === "" || known === undefined) {
      return `Write each role group as "group = role", with a role of ${roles.join(", ")}.`;
    }
    roleGroups.push({ group, role: known });
  }
  return {
    name: draft.name.trim(),
    domains: draft.domains
      .split(/[\s,]+/u)
      .map((domain) => domain.trim().toLowerCase())
      .filter((domain) => domain !== ""),
    required: draft.required,
    createPeople: draft.createPeople,
    groupsClaim: draft.groupsClaim.trim() || null,
    roleGroups,
    ...(draft.protocol === "oidc"
      ? {
          oidc: {
            issuer: draft.issuer.trim(),
            clientId: draft.clientId.trim(),
            ...(draft.clientSecret.trim() === ""
              ? {}
              : { clientSecret: draft.clientSecret.trim() }),
          },
        }
      : {
          saml: {
            entryPoint: draft.entryPoint.trim(),
            issuer: draft.samlIssuer.trim(),
            certificate: draft.certificate.trim(),
          },
        }),
  };
};

function Address({ label, value }: { readonly label: string; readonly value: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <code className="font-mono break-all">{value}</code>
      <Button onClick={() => copyToClipboard(value)} size="xs" variant="outline">
        {isCopied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

/** Owners' single sign-on: the identity providers, and who keeps a password. */
export function SingleSignOnSection({
  connections,
  owners,
  onAction,
}: {
  readonly connections: ReadonlyArray<ControlSsoConnection>;
  readonly owners: ReadonlyArray<ControlPerson>;
  readonly onAction: (change: ControlCall) => Promise<boolean>;
}) {
  /** Null while no form is open; an ID while one setup is edited. */
  const [editing, setEditing] = useState<{ readonly id: string | null; draft: Draft } | null>(null);
  const [problem, setProblem] = useState("");

  const save = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (editing === null) return;
    const settings = settingsOf(editing.draft);
    if (typeof settings === "string") {
      setProblem(settings);
      return;
    }
    setProblem("");
    const id = editing.id;
    const saved = await onAction((client) =>
      id === null
        ? client.admin.createSsoConnection({
            payload: { protocol: editing.draft.protocol, settings },
          })
        : client.admin.updateSsoConnection({ params: { connectionId: id }, payload: settings }),
    );
    if (saved) setEditing(null);
  };

  const change = (next: Partial<Draft>) =>
    setEditing((current) =>
      current === null ? current : { ...current, draft: { ...current.draft, ...next } },
    );
  const field = (key: keyof Draft, label: string, placeholder = "") => (
    <Input
      aria-label={label}
      onChange={(event) => change({ [key]: event.currentTarget.value })}
      placeholder={placeholder || label}
      size="sm"
      value={String(editing?.draft[key] ?? "")}
    />
  );

  return (
    <section>
      <SectionTitle>Single sign-on</SectionTitle>
      <p className="mt-2 text-sm text-muted-foreground">
        People sign in through your identity provider over OIDC or SAML. Each setup signs in its own
        email domains, and can be required for them.
      </p>

      <ul className="mt-3 divide-y divide-border/70">
        {connections.map((connection) => (
          <li className="space-y-2 py-3" key={connection.id}>
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium">{connection.name}</p>
              <Badge variant="secondary">{connection.protocol.toUpperCase()}</Badge>
              {connection.required ? <Badge variant="info">Required</Badge> : null}
              <span className="text-xs text-muted-foreground">{connection.domains.join(", ")}</span>
            </div>
            <Address
              label={connection.protocol === "oidc" ? "Redirect URL" : "Reply URL"}
              value={connection.redirectUrl}
            />
            {connection.serviceEntityId === null ? null : (
              <Address label="Entity ID" value={connection.serviceEntityId} />
            )}
            <div className="flex gap-2">
              <Button
                onClick={() => setEditing({ id: connection.id, draft: draftOf(connection) })}
                size="xs"
                variant="outline"
              >
                Edit
              </Button>
              <Button
                onClick={() =>
                  void onAction((client) =>
                    client.admin.deleteSsoConnection({ params: { connectionId: connection.id } }),
                  )
                }
                size="xs"
                variant="ghost"
              >
                Delete
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {connections.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">No identity provider is set up yet.</p>
      ) : null}

      {editing === null ? (
        <Button
          className="mt-3"
          onClick={() => setEditing({ id: null, draft: EMPTY })}
          size="sm"
          variant="outline"
        >
          Add an identity provider
        </Button>
      ) : (
        <form className="mt-4 space-y-2" onSubmit={(event) => void save(event)}>
          <p className="text-sm font-medium">
            {editing.id === null ? "Add an identity provider" : `Change ${editing.draft.name}`}
          </p>
          {editing.id === null ? (
            <Select
              onValueChange={(value) => change({ protocol: value === "saml" ? "saml" : "oidc" })}
              value={editing.draft.protocol}
            >
              <SelectTrigger aria-label="Protocol" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="oidc">OIDC</SelectItem>
                <SelectItem value="saml">SAML 2.0</SelectItem>
              </SelectPopup>
            </Select>
          ) : null}
          {field(
            "name",
            "Name on the sign-in button",
            "Name on the sign-in button, such as Microsoft Entra ID",
          )}
          {field("domains", "Email domains", "Email domains, such as acme.com")}
          {editing.draft.protocol === "oidc" ? (
            <>
              {field("issuer", "Issuer URL")}
              {field("clientId", "Client ID")}
              {field(
                "clientSecret",
                "Client secret",
                editing.id === null ? "Client secret" : "Client secret (leave empty to keep it)",
              )}
            </>
          ) : (
            <>
              {field("entryPoint", "Sign-in URL")}
              {field("samlIssuer", "Identity provider's entity ID")}
              <Textarea
                aria-label="Signing certificate"
                onChange={(event) => change({ certificate: event.currentTarget.value })}
                placeholder="Signing certificate"
                size="sm"
                spellCheck={false}
                value={editing.draft.certificate}
              />
            </>
          )}
          {field("groupsClaim", "Groups claim", "Groups claim or attribute (optional)")}
          <Textarea
            aria-label="Role groups"
            onChange={(event) => change({ roleGroups: event.currentTarget.value })}
            placeholder={"Groups that give a role, one a line, such as\ncodenine-admins = admin"}
            size="sm"
            spellCheck={false}
            value={editing.draft.roleGroups}
          />
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={editing.draft.createPeople}
              onCheckedChange={(checked) => change({ createPeople: checked === true })}
            />
            Add people when they first sign in
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={editing.draft.required}
              onCheckedChange={(checked) => change({ required: checked === true })}
            />
            Require it for these domains
          </label>
          {problem ? (
            <Alert variant="error">
              <AlertDescription>{problem}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex gap-2">
            <Button size="sm" type="submit">
              Save
            </Button>
            <Button onClick={() => setEditing(null)} size="sm" variant="ghost">
              Cancel
            </Button>
          </div>
        </form>
      )}

      <p className="mt-6 text-sm font-medium">Emergency owners</p>
      <p className="mt-1 text-sm text-muted-foreground">
        They keep signing in with a password where single sign-on is required, so you can reach
        Codenine if your identity provider fails.
      </p>
      <ul className="mt-2 space-y-2">
        {owners.map((owner) => (
          <li className="flex items-center gap-3 text-sm" key={owner.id}>
            <Switch
              aria-label={`${owner.displayName} is an emergency owner`}
              checked={owner.emergency}
              onCheckedChange={(emergency) =>
                void onAction((client) =>
                  client.admin.setEmergency({
                    params: { personId: owner.id },
                    payload: { emergency },
                  }),
                )
              }
              size="sm"
            />
            {owner.displayName} <span className="text-muted-foreground">{owner.email}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
