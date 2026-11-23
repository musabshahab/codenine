import { EnvironmentId } from "@codenine/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { act, render } from "../../../test/render";

// Folders the fake machine holds, keyed by the path a listing is asked for. "loading" never
// answers, as a slow machine would not yet have.
const machineState = vi.hoisted(() => ({
  listings: new Map<string, unknown>(),
  create: null as unknown,
  byPath: {
    "/home/me/": ["clients", "notes"],
    "/home/me/clients/": "loading",
    "/home/me/notes/": ["drafts"],
    "/home/me/notes/drafts/": [],
    "/home/me/reports/": [],
  } as Record<string, ReadonlyArray<string> | "loading">,
}));
vi.mock(import("../../state/filesystem"), async (original) => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const real = await original();
  const allowed = Atom.make(true);
  const listing = (partialPath: string) => {
    const parentPath = partialPath.replace(/\/$/, "");
    const names = machineState.byPath[partialPath];
    return Atom.make(
      names === undefined
        ? AsyncResult.fail({ pathMissing: true, message: "missing" })
        : names === "loading"
          ? AsyncResult.initial(true)
          : AsyncResult.success({
              parentPath,
              entries: names.map((name) => ({ name, fullPath: `${parentPath}/${name}` })),
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
      createDirectory: { permissionAtom: () => allowed } as never,
      browse: ((target: { input: { partialPath: string } }) => {
        const key = target.input.partialPath;
        if (!machineState.listings.has(key)) machineState.listings.set(key, listing(key));
        return machineState.listings.get(key);
      }) as never,
    },
  };
});
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => machineState.create,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: () => [],
}));

import { FolderBrowserDialog, type FolderBrowserMachine } from "./FolderBrowserDialog";

const machine: FolderBrowserMachine = {
  environmentId: EnvironmentId.make("local"),
  label: "Local",
  platform: "linux",
  homeDirectory: "/home/me",
  newProjectsRoot: null,
  addProjectBaseDirectory: "",
  folderCreation: true,
};
const browser = page.getByRole("dialog", { name: "Choose a folder" });
const chosen = (path: string) => browser.getByText(`This folder: ${path}`);

it("opens only folders of the listing on screen, and takes only a folder it could read", async () => {
  const onUse = vi.fn();
  await using _screen = await render(
    <FolderBrowserDialog machine={machine} typedPath="" onOpenChange={() => {}} onUse={onUse} />,
  );
  await expect.element(chosen("/home/me")).toBeVisible();

  // Holding Backspace to clear the filter stops at the empty box; a fresh press goes up.
  await browser.getByRole("option", { name: "notes" }).click();
  await browser.getByRole("option", { name: "drafts" }).click();
  await expect.element(chosen("/home/me/notes/drafts")).toBeVisible();
  await userEvent.keyboard("x{Backspace>4/}");
  await expect.element(chosen("/home/me/notes/drafts")).toBeVisible();
  await userEvent.keyboard("{Backspace}");
  await expect.element(chosen("/home/me/notes")).toBeVisible();
  await userEvent.keyboard("{Backspace}");
  await expect.element(chosen("/home/me")).toBeVisible();

  // While the next folder loads, the rows of the one before stay but do not open: a second
  // click, as in a double click, must not join the new place with an old name.
  const clients = browser.getByRole("option", { name: "clients" });
  await clients.click();
  await expect.element(chosen("/home/me/clients")).toBeVisible();
  act(() => (clients.element() as HTMLElement).click());
  await userEvent.keyboard("{Enter}");
  await expect.element(chosen("/home/me/clients")).toBeVisible();

  // The keyboard takes no folder the button refuses.
  await browser.getByRole("button", { name: "Up one folder" }).click();
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  expect(onUse).toHaveBeenLastCalledWith("/home/me");
});

it("refuses the keyboard shortcut on a folder that is not there", async () => {
  const onUse = vi.fn();
  await using _screen = await render(
    <FolderBrowserDialog
      machine={machine}
      typedPath="/home/me/gone"
      onOpenChange={() => {}}
      onUse={onUse}
    />,
  );
  await expect.element(browser.getByText("This folder does not exist.")).toBeVisible();
  await expect.element(browser.getByRole("button", { name: "Use this folder" })).toBeDisabled();
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  expect(onUse).not.toHaveBeenCalled();
});

it("makes a folder where the browser is and opens it, on machines that can", async () => {
  const create = vi.fn(async () => ({ _tag: "Success", value: { path: "/home/me/reports" } }));
  machineState.create = create;
  await using screen = await render(
    <FolderBrowserDialog
      machine={{ ...machine, folderCreation: false }}
      typedPath=""
      onOpenChange={() => {}}
      onUse={() => {}}
    />,
  );
  await expect.element(chosen("/home/me")).toBeVisible();
  // An older server has no way to make one, so it is not offered.
  await expect.element(browser.getByRole("button", { name: "New folder" })).not.toBeInTheDocument();

  await screen.rerender(
    <FolderBrowserDialog machine={machine} typedPath="" onOpenChange={() => {}} onUse={() => {}} />,
  );
  await browser.getByRole("button", { name: "New folder" }).click();
  await userEvent.keyboard("notes{Enter}");
  await expect.element(browser.getByText("notes already exists in this folder.")).toBeVisible();
  expect(create).not.toHaveBeenCalled();
  await browser.getByLabelText("New folder name").fill("reports");
  await userEvent.keyboard("{Enter}");

  await expect.element(chosen("/home/me/reports")).toBeVisible();
  expect(create).toHaveBeenCalledWith({
    environmentId: "local",
    input: { parentPath: "/home/me", name: "reports" },
  });
});
