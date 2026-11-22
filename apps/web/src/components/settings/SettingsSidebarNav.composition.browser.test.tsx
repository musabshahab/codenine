import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import { SettingsSidebarNav } from "./SettingsSidebarNav";

vi.mock("./useAvailableSettingsSearchItems", () => ({
  useAvailableSettingsSearchItems: () => [
    { id: "theme", title: "Theme", to: "/settings/appearance" },
  ],
}));

it("ignores composing keys in the search", async () => {
  await page.viewport(1280, 800);
  await using screen = await render(
    <SidebarProvider defaultOpen>
      <SettingsSidebarNav pathname="/settings/general" />
    </SidebarProvider>,
    { router: "/settings/general" },
  );
  const search = page.getByRole("combobox", { name: "Search settings" });
  await search.fill("theme");
  await expect.element(page.getByRole("option", { name: /Theme/ })).toBeVisible();

  for (const composition of [
    { key: "Enter", isComposing: true, keyCode: 13 },
    { key: "Enter", isComposing: false, keyCode: 229 },
    { key: "Escape", isComposing: true, keyCode: 27 },
    { key: "Escape", isComposing: false, keyCode: 229 },
    { key: "ArrowDown", isComposing: true, keyCode: 40 },
    { key: "ArrowUp", isComposing: true, keyCode: 38 },
  ]) {
    const event = new KeyboardEvent("keydown", { ...composition, bubbles: true, cancelable: true });
    await act(() => search.element().dispatchEvent(event));
    expect(event.defaultPrevented, JSON.stringify(composition)).toBe(false);
    expect(screen.router?.state.location.pathname).toBe("/settings/general");
    await expect.element(search).toHaveValue("theme");
  }

  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() =>
    expect(screen.router?.state.location.pathname).toBe("/settings/appearance"),
  );
});

it("keeps the expanded phone rail open until a page is picked", async () => {
  await page.viewport(390, 844);
  await using screen = await render(
    <SidebarProvider defaultOpen>
      <SettingsSidebarNav pathname="/settings/general" />
    </SidebarProvider>,
    { router: "/settings/general" },
  );
  const search = page.getByRole("combobox", { name: "Search settings" });
  const openSearch = page.getByRole("button", { name: "Search settings" });

  await userEvent.click(openSearch);
  await expect.element(search).toHaveFocus();
  await userEvent.click(page.getByRole("treeitem", { name: "Worktrees" }));
  await vi.waitFor(() =>
    expect(screen.router?.state.location.pathname).toBe("/settings/worktrees"),
  );
  await expect.element(openSearch).toBeVisible();

  await userEvent.click(openSearch);
  await userEvent.tab();
  await expect.element(page.getByRole("treeitem", { name: "General" })).toHaveFocus();
  await expect.element(search).toBeVisible();

  await userEvent.click(screen.getByText("Code", { exact: true }));
  await expect.element(openSearch).toBeVisible();
});
