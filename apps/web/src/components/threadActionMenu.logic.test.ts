import { RunId, RuntimeRequestId, type ContextMenuItem } from "@codenine/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../test-fixtures";
import type { Thread } from "../types";
import {
  buildThreadActionMenuItems,
  threadActionMenuThreadState,
  type ThreadActionMenuId,
  type ThreadActionMenuState,
} from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  hasPath: true,
  hasProject: true,
  isPinned: false,
  isSettled: false,
  canSettleNow: true,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  canMarkUnread: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

/** The menu as its labels, a submenu after "›", and "—" for a separator. */
function outline(items: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>>): string[] {
  return items.flatMap((item) => [
    ...(item.separatorBefore ? ["—"] : []),
    item.children
      ? `${item.label} › ${item.children.map((child) => child.label).join(", ")}`
      : item.label,
  ]);
}

describe("buildThreadActionMenuItems", () => {
  it("groups the chat's state, the chat, its workspace, then removal", () => {
    expect(
      outline(buildThreadActionMenuItems({ ...baseState, canFind: true, branch: "main" })),
    ).toEqual([
      "Pin chat",
      "Mark done",
      "Snooze › In 1 hour (3:00 PM), Custom…",
      "Mark unread",
      "Mark done automatically › As set in Settings, Never",
      "—",
      "Find in chat",
      "Rename chat",
      "Regenerate title",
      "Copy › Chat link, Thread ID, Path, Branch",
      "—",
      "New chat on main",
      "Workspace settings",
      "—",
      "Archive chat",
      "Delete chat",
    ]);
    expect(
      outline(
        buildThreadActionMenuItems({
          ...baseState,
          isPinned: true,
          isSettled: true,
          isSnoozed: true,
          projectFilter: { label: "Personal", isActive: false },
          canTurnIntoProject: true,
        }),
      ),
    ).toEqual([
      "Unpin chat",
      "Mark not done",
      "Wake now",
      "Mark unread",
      "Mark done automatically › As set in Settings, Never",
      "—",
      "Rename chat",
      "Regenerate title",
      "Copy › Chat link, Thread ID, Path",
      "—",
      "Turn into workspace",
      "Filter by Personal",
      "Workspace settings",
      "—",
      "Archive chat",
      "Delete chat",
    ]);
  });

  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        canFind: true,
        branch: "main",
        projectFilter: { label: "Personal", isActive: false },
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "mark-unread",
            "auto-settle",
            "rename",
            "regenerate-title",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "mark-unread",
            "auto-settle",
            "rename",
            "regenerate-title",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("disables archive and turning into a project while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
  });

  it.each([
    ["mark-unread", { canMarkUnread: false }],
    ["settle", { canSettleNow: false }],
  ] as const)("disables %s while the server would refuse it", (id, state) => {
    const items = buildThreadActionMenuItems({ ...baseState, ...state });
    expect(items.find((item) => item.id === id)?.disabled).toBe(true);
  });

  it("leaves out what has nothing to act on", () => {
    expect(
      outline(buildThreadActionMenuItems({ ...baseState, hasPath: false, hasProject: false })),
    ).toEqual([
      "Pin chat",
      "Mark done",
      "Snooze › In 1 hour (3:00 PM), Custom…",
      "Mark unread",
      "Mark done automatically › As set in Settings, Never",
      "—",
      "Rename chat",
      "Regenerate title",
      "Copy › Chat link, Thread ID",
      "—",
      "Archive chat",
      "Delete chat",
    ]);
  });
});

describe("threadActionMenuThreadState", () => {
  const now = "2026-08-07T12:00:00.000Z";
  const finishedRun = {
    runId: RunId.make("run"),
    status: "completed" as const,
    requestedAt: "2026-08-07T11:00:00.000Z",
    startedAt: "2026-08-07T11:00:00.000Z",
    completedAt: "2026-08-07T11:05:00.000Z",
    assistantMessageId: null,
  };
  const withSource = (source: Partial<Thread["source"]>, thread = makeThreadFixture()) => ({
    ...thread,
    source: { ...thread.source, ...source },
  });
  const pendingRequest = (kind: "command" | "user_input", blocking: boolean) => ({
    pendingRuntimeRequest: {
      id: RuntimeRequestId.make("request"),
      kind,
      createdAt: DateTime.makeUnsafe(now),
      blocking,
    },
  });

  it("keeps a snoozed chat that is marked done reading as done", () => {
    const state = threadActionMenuThreadState(
      makeThreadFixture({
        settledOverride: "settled",
        snoozedAt: "2026-08-07T11:00:00.000Z",
        snoozedUntil: "2026-08-08T09:00:00.000Z",
      }),
      { now, configLoaded: true },
    );
    expect(state).toMatchObject({ isSettled: true, isSnoozed: true });
  });

  it.each([
    ["no run", null, false],
    ["a running run", { ...finishedRun, status: "running" as const, completedAt: null }, false],
    ["a finished run", finishedRun, true],
  ])("offers Mark unread after %s", (_case, latestRun, canMarkUnread) => {
    expect(
      threadActionMenuThreadState(makeThreadFixture({ latestRun }), { now, configLoaded: true })
        .canMarkUnread,
    ).toBe(canMarkUnread);
  });

  it.each([
    ["an idle chat", makeThreadFixture(), true],
    ["a running chat", withSource({ activityRunStatus: "running" }), false],
    ["a chat waiting in its run", withSource({ activityRunStatus: "waiting" }), false],
    ["a pending approval", withSource(pendingRequest("command", true)), false],
    ["a question the run went on past", withSource(pendingRequest("user_input", false)), true],
    [
      "a message queued a moment ago",
      makeThreadFixture({ latestUserMessageAt: "2026-08-07T11:59:30.000Z" }),
      false,
    ],
  ])("offers Mark done for %s", (_case, thread, canSettleNow) => {
    expect(threadActionMenuThreadState(thread, { now, configLoaded: true }).canSettleNow).toBe(
      canSettleNow,
    );
  });
});
