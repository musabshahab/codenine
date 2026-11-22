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

it("orders a chat without an archive time by its creation time, then by id", async () => {
  state.environmentIds = [local];
  state.snapshots = [
    {
      environmentId: local,
      snapshot: {
        threads: [
          { id: "a", title: "January", archivedAt: "2026-01-01T00:00:00.000Z" },
          { id: "b", title: "March", archivedAt: null, createdAt: "2026-03-01T00:00:00.000Z" },
          { id: "c", title: "February c", archivedAt: "2026-02-01T00:00:00.000Z" },
          { id: "d", title: "February d", archivedAt: "2026-02-01T00:00:00.000Z" },
        ].map((thread) => ({
          createdAt: "2025-12-01T00:00:00.000Z",
          projectId: "project",
          ...thread,
        })),
      },
    },
  ];
  await using _screen = await render(<ArchivePage show="archived" />);
  const unarchive = page.getByRole("button", { name: /^Unarchive: / });
  await expect.element(unarchive.nth(3)).toBeInTheDocument();
  expect(unarchive.elements().map((button) => button.getAttribute("aria-label"))).toEqual([
    "Unarchive: March",
    "Unarchive: February d",
    "Unarchive: February c",
    "Unarchive: January",
  ]);
});
