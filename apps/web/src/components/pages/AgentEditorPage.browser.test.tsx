import { type AgentDetail, EnvironmentId } from "@codenine/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@codenine/contracts/settings";
import type { ReactNode } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { NO_ABILITIES } from "../agents/agents.logic";

const state = vi.hoisted(() => ({
  phase: "connected",
  instructions: "Keep replies short.",
  readAt: 1,
  refresh: (): void => {},
}));
const environmentId = EnvironmentId.make("local");
const agent: AgentDetail = {
  name: "gmail",
  title: "Gmail",
  description: "Reading, sorting and drafting email.",
  instructions: "Keep replies short.",
  model: null,
  skills: [],
  connectors: [],
  abilities: NO_ABILITIES,
  path: "/codenine/agents/gmail",
  updatedAt: "2026-11-01T00:00:00.000Z",
  modelStatus: "no-model",
};

vi.mock(import("../settings/useAccessEnvironment"), async (original) => ({
  ...(await original()),
  useAccessEnvironment: () =>
    ({
      candidates: [],
      label: "This computer",
      environment: { environmentId, connection: { phase: state.phase } },
    }) as never,
}));
vi.mock("./WorkspacePage", () => ({
  WorkspacePage: (props: { readonly children: ReactNode }) => props.children,
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/agents", async () => {
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return {
    agentsEnvironment: { read: () => "read", save: { permissionAtom: () => allowed }, delete: {} },
  };
});
vi.mock("../../state/connectors", () => ({ connectorsEnvironment: { state: () => "state" } }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: unknown) => ({
    data:
      query === "read"
        ? { ...agent, instructions: state.instructions }
        : query === "state"
          ? { connections: [] }
          : null,
    error: null,
    dataUpdatedAt: state.readAt,
    isPending: false,
    isSuccess: true,
    refresh: state.refresh,
  }),
}));
vi.mock("../chat/useTeamPlanActions", () => ({
  changeTeamPlanDraft: vi.fn(),
  useTeamDraftEdit: () => null,
}));
vi.mock("../chat/useComposerSkills", () => ({ useCodenineSkills: () => [] }));
vi.mock("../chat/AddSkillDialog", () => ({ AddSkillDialog: () => null }));
vi.mock("../agents/AgentModelDialog", () => ({ AgentModelDialog: () => null }));
vi.mock("../agents/useStartAgentChat", () => ({
  useStartAgentChat: () => () => Promise.resolve(true),
  useAgentChatWorkspace: () => null,
}));
vi.mock(import("../agents/useAgents"), async (original) => ({
  ...(await original()),
  useAgentModelCatalog: () => ({ settings: DEFAULT_UNIFIED_SETTINGS, entries: [] }),
}));

import { AgentEditorPage } from "./AgentEditorPage";

function setup() {
  state.phase = "connected";
  state.instructions = agent.instructions;
  state.readAt = 0;
  state.refresh = vi.fn();
}

it("waits for a read made after the page opened instead of editing the cached agent", async () => {
  setup();
  state.readAt = 1;
  const editor = () => (
    <AgentEditorPage
      target={{ kind: "edit", name: agent.name }}
      machine={environmentId}
      workspace={null}
    />
  );
  await using screen = await render(editor());
  await expect.element(page.getByText("Loading…")).toBeVisible();
  await expect.element(page.getByLabelText("Instructions")).not.toBeInTheDocument();
  expect(state.refresh).toHaveBeenCalledTimes(1);

  state.instructions = "Ask before sending.";
  state.readAt = 2;
  await screen.rerender(editor());
  await expect.element(page.getByLabelText("Instructions")).toHaveValue("Ask before sending.");
});

it("keeps what was typed while the computer reconnects, and saves only once it is back", async () => {
  setup();
  const editor = () => (
    <AgentEditorPage
      target={{ kind: "edit", name: agent.name }}
      machine={environmentId}
      workspace={null}
    />
  );
  await using screen = await render(editor());
  state.readAt = 1;
  await screen.rerender(editor());
  await userEvent.fill(page.getByLabelText("Instructions"), "A long unsaved draft.");
  const save = page.getByRole("button", { name: "Save", exact: true });
  await expect.element(save).toBeEnabled();

  state.phase = "backoff";
  await screen.rerender(editor());
  await expect.element(page.getByLabelText("Instructions")).toHaveValue("A long unsaved draft.");
  await expect.element(save).toBeDisabled();
  await expect.element(page.getByText(/^This computer is not connected\./)).toBeVisible();

  state.phase = "connected";
  await screen.rerender(editor());
  await expect.element(page.getByLabelText("Instructions")).toHaveValue("A long unsaved draft.");
  await expect.element(save).toBeEnabled();
});
