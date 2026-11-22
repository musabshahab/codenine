import { EnvironmentId } from "@codenine/contracts";
import type { ReactNode } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const state = vi.hoisted(() => ({
  snapshots: [] as Array<{ environmentId: string; snapshot: { threads: unknown[] } }>,
  environmentIds: [] as string[],
}));

vi.mock("./WorkspacePage", () => ({
  WorkspacePage: (props: { readonly actions: ReactNode; readonly children: ReactNode }) => (
    <>
      {props.actions}
      {props.children}
    </>
  ),
}));
vi.mock(import("@codenine/client-runtime/state/models"), async (original) => ({
  ...(await original()),
  presentThreadShell: ((environmentId: string, thread: object) => ({
    ...thread,
    environmentId,
  })) as never,
}));
vi.mock("../../hooks/useWorkLists", () => ({
  useCompletedThreads: () => ({
    threads: [],
    total: 0,
    loading: false,
    failed: false,
    retry: () => {},
  }),
}));
vi.mock("../../lib/archivedThreadsState", () => ({
  useArchivedThreadSnapshots: () => ({
    snapshots: state.snapshots,
    error: null,
    isLoading: false,
    refresh: () => {},
  }),
}));
vi.mock("../../state/environments", () => ({
  useConnectedEnvironmentIds: () => state.environmentIds,
  useEnvironments: () => ({
    environments: [
      { environmentId: "local", label: "Laptop" },
      { environmentId: "remote", label: "Build box" },
    ],
  }),
}));
vi.mock("../../hooks/useThreadActions", () => ({
  useThreadActions: () => ({
    unsettleThread: vi.fn(),
    unarchiveThread: vi.fn(),
    confirmAndDeleteThread: vi.fn(),
  }),
}));
vi.mock("./threadPlace", () => ({ useThreadPlaceLabel: () => () => "Repo" }));

import { ArchivePage } from "./ArchivePage";

function archivedChats(environmentId: EnvironmentId, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${environmentId}-${index}`,
    projectId: "project",
    title: `${environmentId} chat ${index}`,
    archivedAt: new Date(Date.UTC(2026, 0, 1, 0, count - index)).toISOString(),
  }));
}

function setup(environments: ReadonlyArray<[EnvironmentId, number]>) {
  state.environmentIds = environments.map(([environmentId]) => environmentId);
  state.snapshots = environments.map(([environmentId, count]) => ({
    environmentId,
    snapshot: { threads: archivedChats(environmentId, count) },
  }));
}

it("opens on the archived chats and shows them 50 at a time", async () => {
  setup([[local, 60]]);
  await using _screen = await render(<ArchivePage show="archived" />);
  const unarchive = page.getByRole("button", { name: /^Unarchive: / });
  await expect.element(unarchive.nth(49)).toBeInTheDocument();
  expect(unarchive.elements()).toHaveLength(50);
  await expect.element(page.getByText("local chat 0", { exact: true })).toBeInTheDocument();
  await expect.element(page.getByText("local chat 50", { exact: true })).not.toBeInTheDocument();
  await expect.element(page.getByText("Repo", { exact: true }).first()).toBeInTheDocument();

  await userEvent.click(page.getByRole("button", { name: "Show more" }));
  await expect.element(unarchive.nth(59)).toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Show more" })).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Delete: local chat 59" }))
    .toBeInTheDocument();
});

it("names each chat's environment when several are connected", async () => {
  setup([
    [local, 1],
    [remote, 1],
  ]);
  await using _screen = await render(<ArchivePage show="archived" />);
  await expect.element(page.getByText("Repo · Laptop", { exact: true })).toBeInTheDocument();
  await expect.element(page.getByText("Repo · Build box", { exact: true })).toBeInTheDocument();
});
