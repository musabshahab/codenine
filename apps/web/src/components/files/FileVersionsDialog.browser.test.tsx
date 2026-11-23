import { EnvironmentId, type ProjectFileVersion, ThreadId } from "@codenine/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  restoreFileVersion: vi.fn(),
  versions: [] as ReadonlyArray<ProjectFileVersion>,
}));

vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.restoreFileVersion) as never,
}));
vi.mock(import("~/state/projects"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    projectEnvironment: {
      ...actual.projectEnvironment,
      listFileVersions: (() => "list") as never,
      readFileVersion: ((request: { input: { versionId: string } }) =>
        `read:${request.input.versionId}`) as never,
    },
  };
});
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((atom: string | null) => ({
    data:
      atom === "list"
        ? { tracked: true, versions: state.versions }
        : atom === null
          ? null
          : { contents: `contents of ${atom}`, byteLength: 12 },
    error: null,
    refresh: vi.fn(),
  })) as never,
}));
vi.mock(import("./projectFilesQueryState"), async (original) => ({
  ...(await original()),
  reloadProjectFileQueryData: vi.fn(),
}));

import { FileVersionsDialog } from "./FileVersionsDialog";

const environmentId = EnvironmentId.make("file-versions-test");

function setup() {
  state.restoreFileVersion
    .mockReset()
    .mockResolvedValue(AsyncResult.success({ relativePath: "notes.md", version: "first" }));
  state.versions = [
    {
      id: "3",
      createdAt: "2026-11-20T10:02:00.000Z",
      byteLength: 40,
      state: "stored",
      origin: "user",
      version: "on-disk",
    },
    {
      id: "2",
      createdAt: "2026-11-20T10:01:00.000Z",
      byteLength: 30,
      state: "stored",
      origin: "agent",
      version: "agent",
      threadId: ThreadId.make("thread"),
      turnCount: 2,
    },
    {
      id: "1",
      createdAt: "2026-11-20T10:00:00.000Z",
      byteLength: 5_000_000,
      state: "skipped",
      origin: "external",
    },
  ];
  const onOpenChange = vi.fn();
  const dialog = (currentVersion: string | undefined) => (
    <FileVersionsDialog
      key={String(currentVersion)}
      open
      onOpenChange={onOpenChange}
      environmentId={environmentId}
      cwd="/workspace"
      relativePath="notes.md"
      currentVersion={currentVersion}
      editorHoldsFile
      canRestore
    />
  );
  return { dialog, onOpenChange };
}

it("previews an earlier version and restores it over the version the tab read", async () => {
  const { dialog, onOpenChange } = setup();
  await using screen = await render(dialog("on-disk"));
  const restore = screen.getByRole("button", { name: "Restore this version" });

  // The newest version that differs from the file is selected, not the one already on disk.
  await expect.element(screen.getByText("contents of read:2")).toBeInTheDocument();
  await expect.element(screen.getByText("An agent, turn 2")).toBeInTheDocument();
  await screen.getByRole("button", { name: /Saved in the editor/ }).click();
  await expect.element(restore).toBeDisabled();
  await screen.getByRole("button", { name: /too large to keep/ }).click();
  await expect.element(restore).toBeDisabled();

  await screen.getByRole("button", { name: /An agent, turn 2/ }).click();
  // Tests load no stylesheet, so the dialog's inert layer lies over its unpositioned footer and
  // takes a pointer click.
  (restore.element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  expect(state.restoreFileVersion).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: {
      cwd: "/workspace",
      relativePath: "notes.md",
      versionId: "2",
      expectedVersion: "on-disk",
    },
  });
  await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));

  // Unsaved edits have no disk version to check against, so nothing is restored over them.
  await screen.rerender(dialog(undefined));
  await expect
    .element(screen.getByText("Save your edits before restoring a version."))
    .toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Restore this version" })).toBeDisabled();
});
