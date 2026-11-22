import { act, fakeTimers, render } from "../../../test/render";
import { userEvent } from "vite-plus/test/browser";
import { RegistryProvider } from "@effect/atom-react";
import { DEFAULT_SERVER_SETTINGS, type StorageCleanupReport } from "@codenine/contracts";
import { type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  settings: {} as typeof DEFAULT_SERVER_SETTINGS,
  targets: [] as Array<{ environmentId: string; settings: typeof DEFAULT_SERVER_SETTINGS }>,
  run: vi.fn(),
  update: vi.fn(),
  report: null as StorageCleanupReport | null,
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const report = Atom.make(() => ({ _tag: "Success", value: state.report, waiting: false }));
  const allowed = Atom.make(true);
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      storageCleanupReport: (() => report) as never,
      runStorageCleanup: {
        ...actual.serverEnvironment.runStorageCleanup,
        permissionAtom: () => allowed,
      },
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.run) as never,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => {
    const environments = state.targets.map(({ environmentId, settings }) => ({
      environmentId,
      label: environmentId,
      serverConfig: {
        settings,
        environment: {
          capabilities: {
            storageCleanup: true,
            storageCleanupRun: true,
            settledWorktreeCleanup: true,
          },
        },
      },
    }));
    return {
      scope: { kind: "all" },
      environments,
      connectedEnvironments: environments,
      targets: state.targets.map((target) => ({ ...target, sources: {} })),
      target: null,
    };
  }) as never,
}));
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => state.settings) as never,
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => state.update,
  useClearScopedSettings: () => vi.fn(),
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsPageContainer: (({ children }: { children: ReactNode }) => children) as never,
  SettingsRow: ({ title, description, status, control, children }) => (
    <div>
      <h3>{title}</h3>
      {description}
      {status && <div data-testid="logs-retention-status">{status}</div>}
      {control}
      {children}
    </div>
  ),
  SettingResetButton: (() => null) as never,
}));
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: vi.fn() } };
});

import { StorageCleanupSections, WorktreeCleanupSection } from "./StorageSettings";

function setup() {
  state.settings = {
    ...DEFAULT_SERVER_SETTINGS,
    storageCleanup: {
      worktreeKeepWhen: "uncommitted-changes",
      worktreeAfterDays: null,
      worktreeSettledAfterDays: null,
      worktreeOnMerge: false,
      worktreeOnDelete: false,
      worktreeUnchanged: false,
      logsAfterDays: null,
    },
    projectSettingsOverrides: {},
  };
  state.targets = ["env-a", "env-b"].map((environmentId) => ({
    environmentId,
    settings: state.settings,
  }));
  state.report = null;
  state.run.mockReset();
  state.update.mockReset();
}

function setRetentionValues(
  logDays: ReadonlyArray<number | null>,
  environmentIds: readonly string[] = ["env-a", "env-b"],
) {
  state.targets = logDays.map((logsAfterDays, index) => ({
    environmentId: environmentIds[index]!,
    settings: {
      ...state.settings,
      storageCleanup: {
        ...state.settings.storageCleanup,
        logsAfterDays,
      },
    },
  }));
  state.settings = state.targets[0]?.settings ?? state.settings;
}

const panel = () => (
  <RegistryProvider>
    <StorageCleanupSections />
  </RegistryProvider>
);
const deleteButton = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Delete now",
  )!;

it("keeps cleanup disabled when settled retention and all other rules are off", async () => {
  setup();
  await using screen = await render(panel());
  const button = deleteButton(screen.container);

  expect(button.disabled).toBe(true);
  await act(async () => button.click());
  expect(state.run).not.toHaveBeenCalled();
});

it("settles the mixed log retention status across selected machines", async () => {
  setup();
  using _timers = fakeTimers();
  await using screen = await render(panel());
  const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

  await advance(300);
  setRetentionValues([8, null]);
  await screen.rerender(panel());
  await advance(125);
  await expect.element(screen.getByTestId("logs-retention-status")).not.toBeInTheDocument();
  await advance(175);
  await expect
    .element(screen.getByTestId("logs-retention-status"))
    .toHaveTextContent("Mixed across selected machines");

  setRetentionValues([null, null]);
  await screen.rerender(panel());
  await advance(300);
  await expect.element(screen.getByTestId("logs-retention-status")).not.toBeInTheDocument();

  setRetentionValues([8], ["env-c"]);
  await screen.rerender(panel());
  await expect.element(screen.getByTestId("logs-retention-status")).not.toBeInTheDocument();
});

it("saves a switched-on day rule only when its days are committed", async () => {
  setup();
  await using screen = await render(<WorktreeCleanupSection />);
  const rule = screen.getByRole("switch", { name: "Delete inactive worktrees" });
  const days = screen.getByRole("textbox", { name: "Delete inactive worktrees in days" });
  const elsewhere = screen.getByRole("heading", { name: "Delete inactive worktrees" });
  // Without the app's CSS the switch has no size, so Playwright cannot click it.
  const toggle = () =>
    act(() => rule.element().dispatchEvent(new MouseEvent("click", { bubbles: true })));
  const saved = (worktreeAfterDays: number | null) => [
    { storageCleanup: { worktreeAfterDays } },
    worktreeAfterDays === null ? undefined : { onFailed: expect.any(Function) },
  ];
  const fail = () => act(() => state.update.mock.lastCall![1].onFailed());

  await toggle();
  expect(state.update).not.toHaveBeenCalled();
  await expect.element(days).toHaveFocus();
  await expect.element(days).toHaveValue("30");
  await userEvent.click(elsewhere);
  expect(state.update.mock.calls).toEqual([saved(30)]);
  await expect.element(rule).toBeChecked();

  // A rejected save turns the rule back off rather than showing days that were never saved.
  await fail();
  await expect.element(rule).not.toBeChecked();
  await expect.element(days).not.toBeInTheDocument();

  await toggle();
  await userEvent.keyboard("14");
  await userEvent.click(elsewhere);
  expect(state.update.mock.calls).toEqual([saved(30), saved(14)]);

  // Switched off before the saved 14 comes back, the rule opens a fresh draft when switched on.
  await toggle();
  await toggle();
  await expect.element(days).toHaveFocus();
  // A click moves focus to the switch before it turns the draft off, which saves nothing.
  await act(() => rule.element().focus());
  await toggle();
  await expect.element(rule).not.toBeChecked();
  expect(state.update.mock.calls).toEqual([saved(30), saved(14), saved(null)]);

  await toggle();
  await userEvent.keyboard("21{Enter}");
  await userEvent.click(elsewhere);
  expect(state.update.mock.calls).toEqual([saved(30), saved(14), saved(null), saved(21)]);
});
