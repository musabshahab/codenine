import { AuthStandardClientScopes, type AuthGrantScope } from "@codenine/contracts";
import type { ControlRole } from "@codenine/contracts/control";

const CONTROL_SERVER_SCOPES: ReadonlyArray<AuthGrantScope> = [
  "access:read",
  "access:write",
  "relay:read",
  "relay:write",
  "environment:maintain",
];

/**
 * What a person may do in a managed workspace. Who gets in, Codenine Connect
 * and server upkeep belong to the control server and the operator.
 */
export const WORKSPACE_SCOPES: ReadonlyArray<AuthGrantScope> = AuthStandardClientScopes.filter(
  (scope) => !CONTROL_SERVER_SCOPES.includes(scope),
);

/** What everyone can still do while the licence does not allow work: look, not change. */
export const READ_ONLY_WORKSPACE_SCOPES: ReadonlyArray<AuthGrantScope> = [
  "orchestration:read",
  "terminal:read",
  "filesystem:read",
  "diagnostics:read",
];

const ROLE_WORKSPACE_SCOPES: Record<ControlRole, ReadonlyArray<AuthGrantScope>> = {
  owner: WORKSPACE_SCOPES,
  admin: WORKSPACE_SCOPES,
  "department-admin": WORKSPACE_SCOPES,
  member: WORKSPACE_SCOPES,
  // Agents work for them, but no terminal, no source control and files read-only.
  restricted: [
    "orchestration:read",
    "orchestration:operate",
    "providers:manage",
    "preview:operate",
    "diagnostics:read",
    "filesystem:read",
  ],
  auditor: READ_ONLY_WORKSPACE_SCOPES,
};

const TERMINAL_SCOPES: ReadonlyArray<AuthGrantScope> = ["terminal:read", "terminal:operate"];

/**
 * What a role may do in its workspace: only looking while the licence does not
 * allow work, and members without a terminal where their profile blocks it.
 */
export const workspaceScopes = (
  role: ControlRole,
  canWork: boolean,
  profile: { readonly terminal: boolean },
) =>
  ROLE_WORKSPACE_SCOPES[role].filter(
    (scope) =>
      (canWork || READ_ONLY_WORKSPACE_SCOPES.includes(scope)) &&
      (profile.terminal || role !== "member" || !TERMINAL_SCOPES.includes(scope)),
  );
