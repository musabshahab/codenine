import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadActionMenuItems,
  resolveThreadFolderChoice,
  type ThreadActionMenuState,
} from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
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

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
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

  it("moves a chat between its folders, into a new one, or out", () => {
    const names = ["Ideas", "Research"];
    const menu = buildThreadActionMenuItems({
      ...baseState,
      chatFolders: { names, current: "Research" },
    }).find((item) => item.id === "move-to-folder");
    expect(menu?.children?.map((child) => [child.label, child.checked ?? false])).toEqual([
      ["Ideas", false],
      ["Research", true],
      ["New folder…", false],
      ["Remove from folder", false],
    ]);
    expect(menu?.children?.map((child) => resolveThreadFolderChoice(child.id, names))).toEqual([
      { folder: "Ideas" },
      { folder: "Research" },
      "new",
      { folder: null },
    ]);
    // Projects have their own folders, so their threads get no folder menu.
    expect(buildThreadActionMenuItems(baseState).some((item) => item.id === "move-to-folder")).toBe(
      false,
    );
  });
});
