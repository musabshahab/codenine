import {
  type AgentDetail,
  ConnectionId,
  type ConnectionSnapshot,
  ConnectorCatalogId,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type WorkspaceKind,
} from "@codenine/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@codenine/contracts/settings";
import { AsyncResult } from "effect/reactivity";
import { page, userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import type { AgentModelCatalog } from "./useAgents";

const state = vi.hoisted(() => ({
  save: vi.fn(),
  connections: [] as ReadonlyArray<ConnectionSnapshot>,
  catalog: null as AgentModelCatalog | null,
  workspaceKind: null as WorkspaceKind | null,
}));

vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.save }));
vi.mock("../../state/agents", async () => {
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return { agentsEnvironment: { save: { permissionAtom: () => allowed }, delete: {} } };
});
vi.mock("../../state/connectors", () => ({ connectorsEnvironment: { state: () => null } }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: { connections: state.connections }, error: null }),
}));
vi.mock("../chat/useComposerSkills", () => ({ useCodenineSkills: () => [] }));
vi.mock("./useStartAgentChat", () => ({
  useStartAgentChat: () => () => Promise.resolve(true),
  useAgentChatWorkspace: () =>
    state.workspaceKind === null ? null : { kind: state.workspaceKind },
}));
vi.mock(import("./useAgents"), async (original) => ({
  ...(await original()),
  useAgentModelCatalog: () => state.catalog as AgentModelCatalog,
}));

import { AgentForm } from "./AgentForm";
import { NO_ABILITIES } from "./agents.logic";

const environmentId = EnvironmentId.make("local");
const claude = ProviderInstanceId.make("claudeAgent");
const gmail = ConnectionId.make("gmail");
const agent: AgentDetail = {
  name: "gmail",
  title: "Gmail",
  description: "Reading, sorting and drafting email.",
  instructions: "Keep replies short.",
  model: { instanceId: claude, model: "claude-sonnet-5-5", effort: "medium" },
  skills: ["write-clear-emails"],
  connectors: [{ id: gmail, approvals: {} }],
  abilities: NO_ABILITIES,
  path: "/codenine/agents/gmail",
  updatedAt: "2026-11-01T00:00:00.000Z",
  modelStatus: "ready",
};
const connection: ConnectionSnapshot = {
  id: gmail,
  catalogId: ConnectorCatalogId.make("gmail"),
  name: "Gmail",
  description: "Search, read and draft email.",
  category: "email-calendar",
  auth: "own-app",
  runsLocally: false,
  address: null,
  status: "connected",
  statusDetail: null,
  account: "alex@example.com",
  onByDefault: true,
  approvals: { read: "auto", change: "auto", irreversible: "ask" },
  toolCount: 12,
  inputs: {},
  secretInputsSet: [],
  connectedAt: "2026-11-01T00:00:00.000Z",
  lastUsedAt: null,
};

function setup() {
  state.save.mockReset().mockResolvedValue(AsyncResult.success({ ...agent, title: "Mail helper" }));
  state.connections = [connection];
  state.workspaceKind = null;
  state.catalog = {
    settings: DEFAULT_UNIFIED_SETTINGS,
    entries: deriveProviderInstanceEntries([
      {
        instanceId: claude,
        driver: ProviderDriverKind.make("claudeAgent"),
        enabled: true,
        installed: true,
        version: null,
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-11-01T00:00:00.000Z",
        models: [
          {
            slug: "claude-sonnet-5-5",
            name: "Claude Sonnet 5.5",
            isCustom: false,
            capabilities: null,
            info: { usesTools: true, readsImages: true, price: null },
          },
        ],
        slashCommands: [],
        skills: [],
        agentAbilities: ["readFiles", "editFiles", "runCommands"],
      },
    ]),
  };
}

it("saves what it shows under the agent's own name, leaving untouched connector groups to the connector", async () => {
  setup();
  await using _screen = await render(
    <AgentForm environmentId={environmentId} workspace={null} agent={agent} connected />,
  );
  await expect.element(page.getByText("Claude Sonnet 5.5")).toBeVisible();
  await expect
    .element(page.getByText(/^Stays on with .+, which can't turn it off\.$/))
    .toBeVisible();
  await expect
    .element(page.getByRole("combobox", { name: "Gmail, can't be undone actions" }))
    .toHaveTextContent("Ask every time");

  await page.getByRole("combobox", { name: "Gmail, change actions" }).click();
  await page.getByRole("option", { name: "Ask every time" }).click();
  await expect
    .element(page.getByRole("combobox", { name: "Gmail, change actions" }))
    .toHaveTextContent("Ask every time");
  await page.getByRole("switch", { name: "Run commands" }).click();
  await page.getByRole("button", { name: "Max" }).click();
  await userEvent.clear(page.getByLabelText("Name"));
  await userEvent.type(page.getByLabelText("Name"), "Mail helper");
  await expect.element(page.getByText("Saved as gmail")).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await vi.waitFor(() => expect(state.save).toHaveBeenCalledTimes(1));
  expect(state.save).toHaveBeenCalledWith({
    environmentId,
    input: {
      previousName: "gmail",
      agent: {
        name: "gmail",
        title: "Mail helper",
        description: "Reading, sorting and drafting email.",
        instructions: "Keep replies short.",
        model: { instanceId: claude, model: "claude-sonnet-5-5", effort: "max" },
        skills: ["write-clear-emails"],
        connectors: [{ id: gmail, approvals: { change: "ask" } }],
        abilities: { ...NO_ABILITIES, runCommands: true },
      },
    },
  });
});

it("follows a newer read until it is edited, then keeps the edits and offers the newer agent", async () => {
  setup();
  const form = (read: AgentDetail) => (
    <AgentForm environmentId={environmentId} workspace={null} agent={read} connected />
  );
  await using screen = await render(form(agent));
  await expect.element(page.getByLabelText("Instructions")).toHaveValue("Keep replies short.");

  await screen.rerender(form({ ...agent, instructions: "Ask before sending." }));
  await expect.element(page.getByLabelText("Instructions")).toHaveValue("Ask before sending.");

  await userEvent.fill(page.getByLabelText("Name"), "Mail helper");
  await screen.rerender(form({ ...agent, title: "Inbox", instructions: "Never send." }));
  await expect.element(page.getByLabelText("Name")).toHaveValue("Mail helper");
  await expect.element(page.getByLabelText("Instructions")).toHaveValue("Ask before sending.");

  await page.getByRole("button", { name: "Load the newer agent" }).click();
  await expect.element(page.getByLabelText("Name")).toHaveValue("Inbox");
  await expect.element(page.getByLabelText("Instructions")).toHaveValue("Never send.");
  await expect
    .element(page.getByRole("button", { name: "Load the newer agent" }))
    .not.toBeInTheDocument();
});

it.each([
  { kind: "code", on: [] },
  { kind: "work", on: ["Read files", "Search the web"] },
  { kind: "create", on: ["Read files", "Edit files"] },
] as const)("a new agent in a $kind workspace starts with that type's abilities", async (row) => {
  setup();
  state.workspaceKind = row.kind;
  await using _screen = await render(
    <AgentForm environmentId={environmentId} workspace={null} agent={null} connected />,
  );
  for (const name of ["Read files", "Edit files", "Run commands", "Search the web"] as const) {
    const ability = page.getByRole("switch", { name });
    const on: ReadonlyArray<string> = row.on;
    if (on.includes(name)) await expect.element(ability).toBeChecked();
    else await expect.element(ability).not.toBeChecked();
  }
});

it("a new agent takes its workspace's abilities when the workspace loads after the form", async () => {
  setup();
  await using screen = await render(
    <AgentForm environmentId={environmentId} workspace={null} agent={null} connected />,
  );
  const readFiles = page.getByRole("switch", { name: "Read files" });
  const searchWeb = page.getByRole("switch", { name: "Search the web" });
  await expect.element(readFiles).not.toBeChecked();
  await page.getByLabelText("Name").fill("Mail helper");

  state.workspaceKind = "work";
  await screen.rerender(
    <AgentForm environmentId={environmentId} workspace={null} agent={null} connected />,
  );
  await expect.element(readFiles).toBeChecked();
  await expect.element(searchWeb).toBeChecked();

  // A choice the user made is theirs, whatever the workspace turns out to be.
  await searchWeb.click();
  state.workspaceKind = "create";
  await screen.rerender(
    <AgentForm environmentId={environmentId} workspace={null} agent={null} connected />,
  );
  await expect.element(readFiles).toBeChecked();
  await expect.element(searchWeb).not.toBeChecked();
  await expect.element(page.getByRole("switch", { name: "Edit files" })).not.toBeChecked();
});
