// Workspace state: one JSON document on disk, written atomically after each change, plus
// workbook bytes as files. Every change bumps `rev` and tells subscribers so clients refetch.

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const USERS = [
  {
    id: "priya",
    name: "Priya Sharma",
    title: "Business Analyst",
    email: "priya.sharma@contoso.example",
    initials: "PS",
    color: "#2563eb",
  },
  {
    id: "marcus",
    name: "Marcus Lee",
    title: "Operations Manager",
    email: "marcus.lee@contoso.example",
    initials: "ML",
    color: "#b45309",
  },
  {
    id: "dana",
    name: "Dana Okafor",
    title: "Team Lead, North Region",
    email: "dana.okafor@contoso.example",
    initials: "DO",
    color: "#047857",
  },
  {
    id: "sam",
    name: "Sam Rivera",
    title: "Finance Business Partner",
    email: "sam.rivera@contoso.example",
    initials: "SR",
    color: "#7c3aed",
  },
];

function initialState() {
  return {
    schema: 1,
    rev: 1,
    org: { name: "Contoso Fulfilment", domain: "contoso.example" },
    workspace: {
      id: "ws-ops",
      name: "Operations · Weekly business review",
      members: [
        { userId: "priya", role: "owner", addedAt: null },
        { userId: "marcus", role: "approver", addedAt: null },
        { userId: "dana", role: "viewer", addedAt: null },
      ],
    },
    library: [
      {
        id: "lib-w47",
        name: "contoso-fulfilment-2026-W47.xlsx",
        folder: "Operations / Weekly data",
        sample: "contoso-fulfilment-2026-W47.xlsx",
        modifiedBy: "Warehouse data export",
        modifiedAt: "2026-11-23T06:10:00Z",
        week: "2026-W47",
      },
      {
        id: "lib-w48",
        name: "contoso-fulfilment-2026-W48.xlsx",
        folder: "Operations / Weekly data",
        sample: "contoso-fulfilment-2026-W48.xlsx",
        modifiedBy: "Warehouse data export",
        modifiedAt: "2026-11-30T06:10:00Z",
        week: "2026-W48",
        arrivesOnRun: true,
      },
    ],
    dataset: null,
    datasetHistory: [],
    cellEdits: [],
    briefings: [],
    automations: [],
    runs: [],
    pins: [],
    activity: [],
    notifications: [],
    requests: [],
    sharedFiles: [],
  };
}

export function createStore(dataDir) {
  const filesDir = NodePath.join(dataDir, "files");
  const statePath = NodePath.join(dataDir, "state.json");
  NodeFS.mkdirSync(filesDir, { recursive: true });
  let state = NodeFS.existsSync(statePath)
    ? JSON.parse(NodeFS.readFileSync(statePath, "utf8"))
    : initialState();
  const listeners = new Set();

  const persist = () => {
    const temp = `${statePath}.${process.pid}.tmp`;
    NodeFS.writeFileSync(temp, JSON.stringify(state));
    NodeFS.renameSync(temp, statePath);
  };
  persist();

  return {
    get state() {
      return state;
    },
    users: USERS,
    user: (id) => USERS.find((user) => user.id === id) ?? null,
    roleOf: (userId) => state.workspace.members.find((m) => m.userId === userId)?.role ?? null,
    /** Runs `change` against the state, then saves and notifies once. */
    update(change) {
      const result = change(state);
      state.rev += 1;
      persist();
      for (const listener of listeners) listener(state.rev);
      return result;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    saveFile(bytes, extension) {
      const id = `${NodeCrypto.randomUUID()}.${extension}`;
      NodeFS.writeFileSync(NodePath.join(filesDir, id), bytes);
      return id;
    },
    readFile: (id) => NodeFS.readFileSync(NodePath.join(filesDir, id.replace(/[^\w.-]/g, ""))),
    reset() {
      NodeFS.rmSync(filesDir, { recursive: true, force: true });
      NodeFS.mkdirSync(filesDir, { recursive: true });
      const rev = state.rev;
      state = initialState();
      state.rev = rev + 1;
      persist();
      for (const listener of listeners) listener(state.rev);
    },
  };
}

export const id = (prefix) => `${prefix}-${NodeCrypto.randomUUID().slice(0, 8)}`;

export function logActivity(state, entry) {
  state.activity.unshift({ id: id("act"), at: new Date().toISOString(), ...entry });
  state.activity.length = Math.min(state.activity.length, 300);
}

export function notify(state, userIds, entry) {
  const at = new Date().toISOString();
  for (const userId of new Set(userIds)) {
    state.notifications.unshift({ id: id("ntf"), userId, at, read: false, ...entry });
  }
  state.notifications.length = Math.min(state.notifications.length, 300);
}

/** A simulated Microsoft Graph or Power BI call, kept so the UI can show what production sends. */
export function logRequest(state, request) {
  state.requests.unshift({ id: id("req"), at: new Date().toISOString(), ...request });
  state.requests.length = Math.min(state.requests.length, 200);
}
