import {
  type AgentSummary,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  TeamAgentId,
  type TeamPlan,
  TeamPlanId,
  TeamTaskId,
  ThreadId,
} from "@codenine/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@codenine/contracts/settings";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import type { TeamModelCatalog } from "./TeamAgentModel";

const state = vi.hoisted(() => ({
  plan: null as unknown,
  agents: [] as ReadonlyArray<AgentSummary>,
  catalog: null as unknown,
  dispatch: vi.fn(),
}));

vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useQuietThreadShell: (() => ({
    title: "Release notes",
    projectId: null,
    modelSelection: null,
    source: {},
  })) as never,
  useThreadStatus: (() => "live") as never,
}));
vi.mock(import("../../state/threads"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentThreadDetails: {
      ...actual.environmentThreadDetails,
      teamAtom: (() => state.plan) as never,
    },
  };
});
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: (() => true) as never,
}));
vi.mock(import("../../state/orchestration"), async (original) => {
  const { Atom: AtomModule } = await import("effect/reactivity");
  const allowed = AtomModule.make(true);
  return {
    ...(await original()),
    orchestrationEnvironment: {
      v2: { dispatchCommand: { permissionAtom: () => allowed } },
    } as never,
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.dispatch) as never,
}));
vi.mock(import("./TeamAgentModel"), async (original) => ({
  ...(await original()),
  useTeamModelCatalog: (() => state.catalog) as never,
}));
vi.mock(import("../agents/useAgents"), async (original) => ({
  ...(await original()),
  useAgents: (() => ({
    agents: state.agents,
    data: { agents: state.agents },
    error: null,
  })) as never,
}));

import { TaskPanel } from "./TaskPanel";

const environmentId = EnvironmentId.make("local");
const leadRef = { environmentId, threadId: ThreadId.make("thread:lead") };
const claude = ProviderInstanceId.make("claudeAgent");
const haiku = { instanceId: claude, model: "claude-haiku-5-5" };

function setup() {
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
  state.catalog = {
    environmentId,
    entries,
    modelOptionsByInstance: new Map([
      [
        claude,
        [
          { slug: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", isCustom: false },
          { slug: "claude-haiku-5-5", name: "Claude Haiku 5.5", isCustom: false },
        ],
      ],
    ]),
    effortDisplay: DEFAULT_UNIFIED_SETTINGS.effortDisplay,
  } satisfies TeamModelCatalog;
  state.agents = [
    agentSummary("writer", "Writer", "Drafting release notes."),
    agentSummary("source-checker", "Source checker", "Checking claims against their sources."),
  ];
  state.dispatch.mockReset().mockResolvedValue(AsyncResult.success({}));
  const plan: TeamPlan = {
    id: TeamPlanId.make("plan-1"),
    revision: 1,
    status: "proposed",
    goal: "Write the release notes",
    agents: [
      {
        id: TeamAgentId.make("writer"),
        label: "Writer",
        role: "implement",
        modelSelection: haiku,
        workspace: "shared",
        agent: "writer",
      },
      {
        id: TeamAgentId.make("checker"),
        label: "Fact checker",
        role: "review",
        modelSelection: haiku,
        workspace: "shared",
        suggestion: {
          title: "Fact checker",
          description: "Checking every claim in the notes.",
          instructions: "Check each claim.",
          connectors: [],
        },
      },
    ],
    tasks: [task("draft", "writer", []), task("check", "checker", [TeamTaskId.make("draft")])],
    maxParallelPerProvider: 2,
    proposedAt: "2026-11-17T10:00:00.000Z",
    updatedAt: "2026-11-17T10:00:00.000Z",
  };
  state.plan = Atom.make(plan);
}

function agentSummary(name: string, title: string, description: string): AgentSummary {
  return {
    name,
    title,
    description,
    model: { instanceId: claude, model: "claude-sonnet-5-5", effort: "high" },
    skills: [],
    connectors: [],
    abilities: { readFiles: true, editFiles: false, runCommands: false, searchWeb: true },
    path: `/codenine/agents/${name}`,
    updatedAt: "2026-11-01T00:00:00.000Z",
    modelStatus: "ready",
  };
}

function task(id: string, agentId: string, dependsOn: ReadonlyArray<TeamTaskId>) {
  return {
    id: TeamTaskId.make(id),
    title: `Step ${id}`,
    brief: `Do ${id}.`,
    agentId: TeamAgentId.make(agentId),
    dependsOn,
    status: "pending" as const,
    attempt: 1,
    threadId: null,
    result: null,
    startedAt: null,
    completedAt: null,
  };
}

it("waits for an agent for each suggested member, then approves the team it chose", async () => {
  setup();
  await using screen = await render(<TaskPanel threadRef={leadRef} onViewChanges={undefined} />);
  const approve = screen.getByRole("button", { name: "Approve and start" });
  await expect.element(approve).toBeDisabled();
  await expect
    .element(screen.getByText("Create or choose an agent for Fact checker first."))
    .toBeVisible();

  await screen.getByRole("button", { name: "Choose agent for Fact checker" }).click();
  await page.getByRole("menuitemradio", { name: /Source checker/ }).click();

  await expect.element(approve).toBeEnabled();
  await expect
    .element(screen.getByRole("button", { name: "Change agent for Source checker" }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Choose agent for Fact checker" }))
    .not.toBeInTheDocument();
  await approve.click();

  await vi.waitFor(() => expect(state.dispatch).toHaveBeenCalledTimes(2));
  const [edit, approval] = state.dispatch.mock.calls.map(([call]) => call.input);
  expect(edit).toMatchObject({ type: "team.edit", expectedRevision: 1 });
  expect(edit.agents[1]).toEqual({
    id: "checker",
    label: "Source checker",
    role: "review",
    modelSelection: {
      instanceId: claude,
      model: "claude-sonnet-5-5",
      options: [{ id: "effort", value: "high" }],
    },
    workspace: "shared",
    agent: "source-checker",
  });
  expect(approval).toMatchObject({ type: "team.approve", expectedRevision: 2 });
});
