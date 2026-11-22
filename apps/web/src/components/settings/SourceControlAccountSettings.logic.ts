import * as Option from "effect/Option";
import type { SourceControlProviderAuth } from "@codenine/contracts";
import type { HostCredentialSettings } from "@codenine/client-runtime/source-control-clients";

export type DiscoveredAccount = NonNullable<SourceControlProviderAuth["accounts"]>[number];

export interface HostAccountGroup {
  readonly host: string;
  readonly activeAccount: string | null;
  readonly selectable: ReadonlyArray<string>;
  readonly broken: ReadonlyArray<DiscoveredAccount>;
  readonly environmentVariable: string | null;
}

/** Hosts turned off in `choices` stay listed without logins, so they can be turned back on. */
export function groupHostAccounts(
  accounts: ReadonlyArray<DiscoveredAccount>,
  choices: HostCredentialSettings["hosts"] = {},
): ReadonlyArray<HostAccountGroup> {
  const disabled = Object.keys(choices).filter((host) => choices[host]?.enabled === false);
  const hosts = [...new Set([...accounts.map((entry) => entry.host), ...disabled])];
  return hosts.map((host) => {
    const entries = accounts.filter((entry) => entry.host === host);
    const stored = entries.filter((entry) => entry.environmentVariable === undefined);
    const selectable = stored.filter((entry) => entry.authenticated);
    return {
      host,
      activeAccount: (selectable.find((entry) => entry.active) ?? selectable[0])?.account ?? null,
      selectable: selectable.map((entry) => entry.account),
      broken: stored.filter((entry) => !entry.authenticated),
      environmentVariable:
        entries.find((entry) => entry.environmentVariable)?.environmentVariable ?? null,
    };
  });
}

export function nextHostAccountChoices(
  current: HostCredentialSettings["hosts"],
  host: string,
  change: { readonly enabled?: boolean; readonly account?: string | null },
): HostCredentialSettings["hosts"] {
  const previous = current[host];
  const enabled = change.enabled ?? previous?.enabled ?? true;
  const account = change.account === undefined ? previous?.account : (change.account ?? undefined);
  const { [host]: _replaced, ...rest } = current;
  if (enabled && account === undefined) return rest;
  return { ...rest, [host]: { enabled, ...(account === undefined ? {} : { account }) } };
}

/**
 * The server's own diagnosis of a credential it reads (refused, unreadable, host turned off), which
 * names its fix. gh's sign-in advice and its login errors have no host or match a listed login.
 */
export function credentialProblem(auth: SourceControlProviderAuth): string | null {
  const detail = Option.getOrNull(auth.detail);
  if (auth.status !== "unauthenticated" || Option.isNone(auth.host) || detail === null) return null;
  return auth.accounts?.some((entry) => entry.error === detail) ? null : detail;
}
