import { compileResolvedKeybindingsConfig } from "@codenine/shared/keybindings";
import { expect, it, vi } from "vite-plus/test";

import { isSidebarToggleShortcut } from "./AppSidebarLayout";

it("matches sidebar.toggle against the focused terminal", () => {
  using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  const keybindings = compileResolvedKeybindingsConfig([
    { key: "mod+b", command: "sidebar.toggle", when: "!terminalFocus" },
  ]);
  const terminal = document.createElement("div");
  terminal.dataset.terminalOwner = "drawer";
  terminal.tabIndex = -1;
  using _terminal = { [Symbol.dispose]: () => terminal.remove() };
  document.body.append(terminal);
  const press = () =>
    isSidebarToggleShortcut(
      new KeyboardEvent("keydown", { key: "b", code: "KeyB", ctrlKey: true }),
      keybindings,
      false,
    );

  expect(press()).toBe(true);
  terminal.focus();
  expect(press()).toBe(false);
});
