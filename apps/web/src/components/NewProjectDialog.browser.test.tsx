import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

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
