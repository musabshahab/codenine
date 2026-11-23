import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

// Styles put the folder browser above the dialog under it, so its buttons take clicks.
import "~/index.css";

import { act, render } from "../../test/render";
import type { NewProjectPlan } from "./NewProjectDialog.logic";

const created = vi.hoisted(() => ({
  plans: [] as NewProjectPlan[],
  // Each test starts with no plans left by an earlier one.
  setup() {
    this.plans = [];
  },
}));

vi.mock(import("../hooks/useNewProject"), async (original) => ({
  ...(await original()),
  useNewProject: (() => async (plan: NewProjectPlan, options?: { onCreated?: () => void }) => {
    created.plans.push(plan);
    options?.onCreated?.();
    return { ok: true };
  }) as never,
}));
vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({
    environments: [
      {
        environmentId: "local",
        label: "Local",
        connection: { phase: "connected" },
        entry: { target: { _tag: "PrimaryConnectionTarget" } },
        serverConfig: {
          environment: {
            platform: { os: "linux", arch: "x64" },
            capabilities: { workspaceKinds: true },
          },
          settings: { addProjectBaseDirectory: "", ghqCloneLayout: false, environmentIcon: null },
          homeDirectory: "/home/me",
          newProjectsRoot: "/home/me/.codenine/projects",
        },
      },
    ],
  })) as never,
  useEnvironmentProviders: (() => new Map()) as never,
}));

// Folders the fake machine holds, keyed by the path a listing is asked for.
const folders = vi.hoisted(() => ({
  listings: new Map<string, unknown>(),
  byPath: {
    "/home/me/": ["clients", "notes"],
    "/home/me/clients/": ["acme"],
    "/home/me/clients/acme/": [],
  } as Record<string, ReadonlyArray<string>>,
}));
vi.mock(import("../state/filesystem"), async (original) => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const real = await original();
  const listing = (partialPath: string) => {
    const parentPath = partialPath.replace(/\/$/, "");
    const names = folders.byPath[partialPath];
    return Atom.make(
      names === undefined
        ? AsyncResult.fail({ pathMissing: true, message: "missing" })
        : AsyncResult.success({
            parentPath,
            entries: names.map((name) => ({
              name,
              fullPath: `${parentPath}/${name}`,
              ...(name === "acme" ? { isGitRepository: true } : {}),
            })),
          }),
    );
  };
  return {
    ...real,
    useFilesystemReadAccess: (() => ({
      canReadFiles: true,
      isPending: false,
      error: null,
    })) as never,
    filesystemEnvironment: {
      ...real.filesystemEnvironment,
      browse: ((target: { input: { partialPath: string } }) => {
        const key = target.input.partialPath;
        if (!folders.listings.has(key)) folders.listings.set(key, listing(key));
        return folders.listings.get(key);
      }) as never,
    },
  };
});

import { openNewProjectDialog, useNewProjectDialogStore } from "../newProjectDialogStore";
import { NewProjectDialogHost } from "./NewProjectDialog";

it("clones a repository under its own name when Enter is pressed in its field", async () => {
  created.setup();
  useNewProjectDialogStore.setState(useNewProjectDialogStore.getInitialState(), true);
  await using _screen = await render(<NewProjectDialogHost />);

  await act(() => openNewProjectDialog({ source: "clone" }));
  await expect.element(page.getByLabelText("Repository")).toHaveFocus();
  await userEvent.keyboard("acme/rocket");
  await expect.element(page.getByLabelText("Name")).toHaveValue("rocket");
  await userEvent.keyboard("{Enter}");

  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(created.plans).toEqual([
    {
      kind: "clone",
      environmentId: "local",
      title: "rocket",
      workspaceKind: "code",
      remoteUrl: "https://github.com/acme/rocket.git",
      destinationPath: "/home/me/.codenine/projects/rocket",
      projectIcon: null,
      defaultModelSelection: null,
    },
  ]);
});

it("browses the machine's folders by keyboard and puts the chosen one in the path box", async () => {
  created.setup();
  useNewProjectDialogStore.setState(useNewProjectDialogStore.getInitialState(), true);
  await using _screen = await render(<NewProjectDialogHost />);

  await act(() => openNewProjectDialog({ source: "folder" }));
  await page.getByRole("button", { name: "Browse" }).click();
  const browser = page.getByRole("dialog", { name: "Choose a folder" });
  const filter = browser.getByRole("combobox", { name: "Filter folders" });
  await expect.element(filter).toHaveFocus();
  // It opens at home, which the path box's empty value falls back to.
  await expect.element(browser.getByRole("option", { name: "clients" })).toBeVisible();

  await userEvent.keyboard("{ArrowDown}{ArrowUp}{Enter}");
  await expect.element(browser.getByRole("option", { name: /^acme/ })).toBeVisible();
  await userEvent.keyboard("{Enter}");
  await expect.element(browser.getByText(/No folders in here/)).toBeVisible();
  // Backspace in the empty filter goes up; typing narrows the list before Enter opens it.
  await userEvent.keyboard("{Backspace}");
  await expect.element(browser.getByRole("option", { name: /^acme/ })).toBeVisible();
  await userEvent.keyboard("ac{Enter}");
  await expect.element(browser.getByText(/No folders in here/)).toBeVisible();
  await browser.getByRole("button", { name: "Use this folder" }).click();

  await expect.element(browser).not.toBeInTheDocument();
  await expect
    .element(page.getByLabelText("Folder", { exact: true }))
    .toHaveValue("/home/me/clients/acme");
  await expect.element(page.getByLabelText("Name")).toHaveValue("acme");

  // The path box and the browser agree: it reopens where the box points, and a path that is
  // not there says so in place.
  await page.getByLabelText("Folder", { exact: true }).fill("/home/me/gone");
  await page.getByRole("button", { name: "Browse" }).click();
  await expect.element(browser.getByText("This folder does not exist.")).toBeVisible();
  await browser.getByRole("button", { name: "Go up" }).click();
  await expect.element(browser.getByRole("option", { name: "notes" })).toBeVisible();
});
