import { AuthOrchestrationOperateScope, EnvironmentId, type EditorId } from "@codenine/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import type { RemoteOpenState } from "../../remoteOpen";

const state = vi.hoisted(() => ({
  remote: { mode: "local-exec" } as RemoteOpenState,
  canOperate: true,
  run: vi.fn(),
}));

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => environmentId,
}));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const config = Atom.make(() => serverConfig);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => config) as never },
  };
});
vi.mock(import("../../remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenResolution: () => ({ state: state.remote, isResolved: true }),
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: ((_: EnvironmentId, scope: string) =>
    scope !== AuthOrchestrationOperateScope || state.canOperate) as never,
  useEnvironmentScope: ((_: EnvironmentId, scope: string) =>
    scope !== AuthOrchestrationOperateScope || state.canOperate) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.run) as never,
}));

import { CodenineFolderSettings } from "./CodenineFolderSettings";

const environmentId = EnvironmentId.make("primary");
const serverConfig = {
  codenineHome: "/home/me/.codenine",
  homeDirectory: "/home/me",
  availableEditors: ["file-manager"] as readonly EditorId[],
};

function setup(remote: RemoteOpenState, canOperate: boolean) {
  state.remote = remote;
  state.canOperate = canOperate;
  state.run.mockReset().mockResolvedValue(AsyncResult.success(undefined));
}

it.each([
  { remote: { mode: "remote-unavailable" }, canOperate: true, open: "hidden" },
  {
    remote: { mode: "remote-links", host: { kind: "ssh-alias", host: "box" } },
    canOperate: true,
    open: "hidden",
  },
  { remote: { mode: "local-exec" }, canOperate: false, open: "disabled" },
  { remote: { mode: "local-exec" }, canOperate: true, open: "enabled" },
] satisfies ReadonlyArray<{
  remote: RemoteOpenState;
  canOperate: boolean;
  open: "hidden" | "disabled" | "enabled";
}>)(
  "shows Open as $open for a $remote.mode client that can operate: $canOperate",
  async ({ remote, canOperate, open }) => {
    setup(remote, canOperate);
    await using screen = await render(<CodenineFolderSettings />);

    await expect.element(screen.getByRole("button", { name: "Copy path" })).toBeVisible();
    const button = screen.getByRole("button", { name: "Open", exact: true });
    if (open === "hidden") {
      await expect.element(button).not.toBeInTheDocument();
      return;
    }
    if (open === "disabled") {
      await expect.element(button).toBeDisabled();
      return;
    }
    await button.click();
    expect(state.run).toHaveBeenCalledWith({
      environmentId,
      input: { cwd: serverConfig.codenineHome, editor: "file-manager" },
    });
  },
);
