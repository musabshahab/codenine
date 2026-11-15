import {
  assignableRoles,
  ControlPermission,
  type ControlPermissionReach,
  ControlRole,
  permissionReach,
} from "@codenine/contracts/control";
import type { AuthGrantScope } from "@codenine/contracts";
import { describe, expect, it } from "@effect/vitest";

import { workspaceScopes } from "./roles.ts";

const EVERYTHING: ReadonlyArray<AuthGrantScope> = [
  "orchestration:read",
  "orchestration:operate",
  "settings:write",
  "providers:manage",
  "preview:operate",
  "diagnostics:read",
  "terminal:read",
  "terminal:operate",
  "source-control:write",
  "filesystem:read",
  "filesystem:write",
];
const LOOK: ReadonlyArray<AuthGrantScope> = [
  "orchestration:read",
  "terminal:read",
  "filesystem:read",
  "diagnostics:read",
];

/**
 * Each role's workspace with a working licence and without one, what it may
 * do on the control server, and the roles it may give.
 */
const ROLES: Record<
  ControlRole,
  {
    readonly workspace: ReadonlyArray<AuthGrantScope>;
    readonly withoutLicence: ReadonlyArray<AuthGrantScope>;
    /** Where their department's profile blocks the terminal; only members lose it. */
    readonly withoutTerminal?: ReadonlyArray<AuthGrantScope>;
    readonly permissions: Partial<Record<ControlPermission, ControlPermissionReach>>;
    readonly gives: ReadonlyArray<ControlRole>;
  }
> = {
  owner: {
    workspace: EVERYTHING,
    withoutLicence: LOOK,
    permissions: {
      "licence:manage": "all",
      "licence:read": "all",
      "security:manage": "all",
      "people:manage": "all",
      "departments:manage": "all",
      "audit:read": "all",
    },
    gives: ["owner", "admin", "department-admin", "member", "restricted", "auditor"],
  },
  admin: {
    workspace: EVERYTHING,
    withoutLicence: LOOK,
    permissions: {
      "licence:read": "all",
      "people:manage": "all",
      "departments:manage": "all",
      "audit:read": "all",
    },
    gives: ["admin", "department-admin", "member", "restricted", "auditor"],
  },
  "department-admin": {
    workspace: EVERYTHING,
    withoutLicence: LOOK,
    permissions: {
      "people:manage": "own-department",
      "departments:manage": "own-department",
      "audit:read": "own-department",
    },
    gives: ["member", "restricted"],
  },
  member: {
    workspace: EVERYTHING,
    withoutLicence: LOOK,
    withoutTerminal: EVERYTHING.filter((scope) => !scope.startsWith("terminal:")),
    permissions: {},
    gives: [],
  },
  restricted: {
    workspace: [
      "orchestration:read",
      "orchestration:operate",
      "providers:manage",
      "preview:operate",
      "diagnostics:read",
      "filesystem:read",
    ],
    withoutLicence: ["orchestration:read", "diagnostics:read", "filesystem:read"],
    permissions: {},
    gives: [],
  },
  auditor: {
    workspace: LOOK,
    withoutLicence: LOOK,
    permissions: { "audit:read": "all" },
    gives: [],
  },
};

describe("roles", () => {
  it.each(ControlRole.literals)("%s", (role) => {
    const expected = ROLES[role];
    const terminal = { terminal: true };
    expect(workspaceScopes(role, true, terminal).toSorted()).toEqual(expected.workspace.toSorted());
    expect(workspaceScopes(role, false, terminal).toSorted()).toEqual(
      expected.withoutLicence.toSorted(),
    );
    expect(workspaceScopes(role, true, { terminal: false }).toSorted()).toEqual(
      (expected.withoutTerminal ?? expected.workspace).toSorted(),
    );
    for (const permission of ControlPermission.literals) {
      expect([permission, permissionReach(role, permission)]).toEqual([
        permission,
        expected.permissions[permission] ?? null,
      ]);
    }
    expect(assignableRoles(role).toSorted()).toEqual(expected.gives.toSorted());
  });
});
