import { RegistryProvider } from "@effect/atom-react";
import type { KeybindingRule } from "@codenine/contracts";
import { compileResolvedKeybindingsConfig } from "@codenine/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent, type Locator } from "vite-plus/test/browser";

import { render } from "../../../test/render";

function testEnvironment(environmentId: string, keybindings: ReadonlyArray<KeybindingRule> = []) {
  return {
    environmentId,
    label: environmentId,
    connection: { phase: "connected" as const, error: null, traceId: null },
    serverConfig: {
      keybindings: compileResolvedKeybindingsConfig(keybindings),
      keybindingsConfigPath: null,
      availableEditors: [],
    },
  };
}

const mocks = vi.hoisted(() => ({
  environments: [] as Array<ReturnType<typeof testEnvironment>>,
  writableIds: new Set<string>(),
  commands: new Map<unknown, ReturnType<typeof vi.fn>>(),
}));

// The mocked shortcutEnvironmentIdAtom names "env" as the source of this client's shortcuts.
function setup({
  environments = [testEnvironment("env")],
  writableIds = environments.map(({ environmentId }) => environmentId),
}: {
  environments?: Array<ReturnType<typeof testEnvironment>>;
  writableIds?: ReadonlyArray<string>;
} = {}) {
  mocks.environments = environments;
  mocks.writableIds = new Set(writableIds);
  mocks.commands.clear();
}

vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: ((environmentId: string | null) =>
    environmentId !== null && mocks.writableIds.has(environmentId)) as never,
  readEnvironmentScope: ((environmentId: string) => mocks.writableIds.has(environmentId)) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironment: ((environmentId: string | null) =>
    mocks.environments.find((environment) => environment.environmentId === environmentId) ??
    null) as never,
}));
vi.mock(import("../../state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  return { ...(await original()), shortcutEnvironmentIdAtom: Atom.make("env") as never };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => {
    const existing = mocks.commands.get(command);
    if (existing) return existing;
    const created = vi.fn(async () => ({ _tag: "Success", value: undefined }));
    mocks.commands.set(command, created);
    return created;
  }) as never,
}));

import { serverEnvironment } from "../../state/server";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { KeybindingsSettingsPanel } from "./KeybindingsSettings";

// The modal dialog's inert layer swallows pointer events in this harness, so drive the DOM.
async function activate(locator: Locator, action: "click" | "focus") {
  await expect.element(locator).toBeVisible();
  (locator.element() as HTMLElement)[action]();
}

const existingField = page.getByRole("textbox", { name: "Keybinding for Sidebar: Toggle" });
const existingPill = page.getByRole("button", { name: /^Edit shortcut for Sidebar: Toggle:/ });
const newField = page.getByRole("textbox", { name: "Keybinding for new keybinding" });

describe("Esc in a shortcut recorder", () => {
  it.each<{
    name: string;
    field: Locator;
    open: () => Promise<void>;
    expectReset: () => Promise<void>;
  }>([
    {
      name: "existing binding",
      field: existingField,
      open: () => activate(existingPill, "click"),
      expectReset: async () => {
        await expect.element(existingField).not.toBeInTheDocument();
        await expect.element(existingPill).toHaveFocus();
        await expect.element(page.getByRole("button", { name: "Save" })).not.toBeInTheDocument();
      },
    },
    {
      name: "new binding",
      field: newField,
      open: async () => {
        await activate(page.getByRole("button", { name: "Add keybinding" }), "click");
        await activate(newField, "focus");
      },
      expectReset: async () => {
        await expect.element(newField).toHaveValue("");
        await expect.element(newField).toHaveAttribute("placeholder", "Unassigned");
      },
    },
  ])("leaves the $name field without closing Settings", async ({ field, open, expectReset }) => {
    setup();
    const onOpenChange = vi.fn();
    await using _screen = await render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogPopup>
          <DialogTitle>Settings</DialogTitle>
          <KeybindingsSettingsPanel />
        </DialogPopup>
      </Dialog>,
    );

    await open();
    await userEvent.keyboard("{Control>}k{/Control}");
    await expect.element(field).not.toHaveValue("");
    await userEvent.tab();
    await activate(field, "focus");
    await expect.element(field).toHaveAttribute("placeholder", "Press shortcut");

    await userEvent.keyboard("{Escape}");

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(document.activeElement?.matches("[data-keybinding-capture]")).toBe(false);
    await expectReset();

    await userEvent.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything());
  });
});

it("re-enables Save when a When editor closes on an expression it could not parse", async () => {
  setup();
  await using screen = await render(
    <RegistryProvider>
      <KeybindingsSettingsPanel />
    </RegistryProvider>,
  );
  const whenTrigger = screen.getByRole("button", { name: "Edit when clause for Terminal: Toggle" });
  const expression = screen.getByRole("textbox", { name: "When expression" });

  await whenTrigger.click();
  await userEvent.type(expression, "terminalFocus");
  await userEvent.type(expression, " &&");
  await expect.element(screen.getByRole("button", { name: "Save" })).toBeDisabled();

  await userEvent.keyboard("{Escape}");
  await whenTrigger.click();

  await expect.element(expression).toHaveValue("terminalFocus");
  await expect.element(screen.getByRole("button", { name: "Save" })).toBeEnabled();
});

it("edits only the keybindings of the environment this client takes its shortcuts from", async () => {
  setup({
    environments: [
      testEnvironment("env", [{ command: "chat.new", key: "mod+shift+y" }]),
      testEnvironment("read-only remote"),
    ],
    writableIds: ["env"],
  });
  await using screen = await render(
    <RegistryProvider>
      <KeybindingsSettingsPanel />
    </RegistryProvider>,
  );

  await expect
    .element(screen.getByText("This connection can view keybindings but cannot change them."))
    .not.toBeInTheDocument();
  await screen.getByRole("button", { name: /^Edit shortcut for Sidebar: Toggle:/ }).click();
  await userEvent.keyboard("{Control>}k{/Control}");
  await screen.getByRole("button", { name: "Save" }).click();
  await screen.getByRole("button", { name: "Actions for Chat: New" }).click();
  await page.getByRole("menuitem", { name: "Remove" }).click();

  expect(mocks.commands.get(serverEnvironment.upsertKeybinding)?.mock.calls).toEqual([
    [
      {
        environmentId: "env",
        input: expect.objectContaining({ command: "sidebar.toggle", key: "mod+k" }),
      },
    ],
  ]);
  expect(mocks.commands.get(serverEnvironment.removeKeybinding)?.mock.calls).toEqual([
    [{ environmentId: "env", input: { command: "chat.new", key: "mod+shift+y" } }],
  ]);
});
