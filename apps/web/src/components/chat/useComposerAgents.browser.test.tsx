import {
  type AgentSummary,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@codenine/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { deriveProviderInstanceEntries } from "../../providerInstances";

const state = vi.hoisted(() => ({
  agents: [] as ReadonlyArray<AgentSummary>,
  agent: null as string | null,
  setAgent: vi.fn(),
  select: vi.fn(),
}));

vi.mock(import("../agents/useAgents"), async (original) => ({
  ...(await original()),
  useAgents: () => ({
    agents: state.agents,
    data: { agents: state.agents },
    dataUpdatedAt: 0,
    error: null,
    failure: null,
    isPending: false,
    isSuccess: true,
    refresh: () => undefined,
  }),
}));
vi.mock("./useChatChoices", () => ({
  useChatChoices: () => ({ agent: state.agent, setAgent: state.setAgent, canChange: true }),
}));

import { ProviderModelPicker } from "./ProviderModelPicker";
import { useComposerAgents } from "./useComposerAgents";

const environmentId = EnvironmentId.make("local");
const claude = ProviderInstanceId.make("claudeAgent");
const entries = deriveProviderInstanceEntries([
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
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Reasoning",
              type: "select",
              options: [
                { id: "low", label: "Low" },
                { id: "medium", label: "Medium", isDefault: true },
                { id: "high", label: "High" },
                { id: "xhigh", label: "Extra High" },
                { id: "max", label: "Max" },
              ],
            },
          ],
        },
      },
      { slug: "claude-haiku-5-5", name: "Claude Haiku 5.5", isCustom: false, capabilities: null },
    ],
    slashCommands: [],
    skills: [],
  },
]);
const options = new Map([
  [
    claude,
    [
      { slug: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
      { slug: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
    ],
  ],
]);
const agent = (overrides: Partial<AgentSummary>): AgentSummary => ({
  name: "gmail",
  title: "Gmail",
  description: "Reads, sorts and drafts email",
  model: { instanceId: claude, model: "claude-sonnet-5-5", effort: "max" },
  skills: [],
  connectors: [],
  abilities: { readFiles: false, editFiles: false, runCommands: false, searchWeb: false },
  path: "/codenine/agents/gmail",
  updatedAt: "2026-11-01T00:00:00.000Z",
  modelStatus: "ready",
  ...overrides,
});

function setup(chatAgent: string | null) {
  state.agents = [
    agent({}),
    agent({ name: "researcher", title: "Researcher", modelStatus: "account-off" }),
  ];
  state.agent = chatAgent;
  state.setAgent.mockReset();
  state.select.mockReset().mockReturnValue(true);
}

function Composer() {
  const agents = useComposerAgents({
    target: {
      environmentId,
      threadRef: { environmentId, threadId: ThreadId.make("thread-1") },
      onServer: true,
      projectId: null,
      canChange: true,
    },
    providerInstanceEntries: entries,
    modelOptionsByInstance: options,
    getModelDisabledReason: () => null,
    onProviderModelSelect: state.select,
    onMultipleModelSelectionsChange: () => undefined,
  });
  return (
    <ProviderModelPicker
      environmentId={null}
      activeInstanceId={claude}
      model="claude-haiku-5-5"
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={options}
      onInstanceModelChange={() => undefined}
      {...(agents === undefined ? {} : { agents })}
    />
  );
}

it("moves the chat to an agent's model at its effort, then sets the agent", async () => {
  setup(null);
  await using screen = await render(<Composer />);
  await screen.getByRole("button", { name: "Claude Haiku 5.5" }).click();
  await page.getByRole("button", { name: "Agents" }).click();
  await expect
    .element(page.getByText("Its account is off. Choose another model to use it"))
    .toBeVisible();
  await expect
    .element(page.getByRole("option", { name: /Researcher/ }))
    .toHaveAttribute("aria-disabled", "true");

  await page.getByRole("option", { name: /Gmail/ }).click();
  expect(state.select).toHaveBeenCalledWith(claude, "claude-sonnet-5-5", {
    agentOptions: [{ id: "effort", value: "max" }],
    // So a move to another account takes the agent along.
    agent: "gmail",
  });
  expect(state.setAgent).toHaveBeenCalledWith("gmail");
  await expect
    .element(page.getByPlaceholder("Search agents and models..."))
    .not.toBeInTheDocument();
});

it("names the chat's agent, and No agent keeps the model", async () => {
  setup("gmail");
  await using screen = await render(<Composer />);
  await screen.getByRole("button", { name: "Gmail · Claude Haiku 5.5" }).click();
  await page.getByRole("option", { name: /No agent/ }).click();
  expect(state.setAgent).toHaveBeenCalledWith(null);
  expect(state.select).not.toHaveBeenCalled();

  // A chat that can't switch to the agent's model keeps its agent as it was.
  state.select.mockReturnValue(false);
  await screen.getByRole("button", { name: "Gmail · Claude Haiku 5.5" }).click();
  await page.getByRole("option", { name: /Gmail/ }).click();
  expect(state.select).toHaveBeenCalledTimes(1);
  expect(state.setAgent).toHaveBeenCalledTimes(1);
});
