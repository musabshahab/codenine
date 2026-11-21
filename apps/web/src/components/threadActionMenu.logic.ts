import type { ContextMenuItem } from "@codenine/contracts";
import {
  threadRuntimeCanArchive,
  type EnvironmentThreadShell,
} from "@codenine/client-runtime/state/models";
import {
  canSnooze,
  effectiveSnoozed,
  hasQueuedTurnStart,
  type SnoozePreset,
} from "@codenine/client-runtime/state/thread-settled";

export type ThreadActionMenuId =
  | "find"
  | "new-thread-on-branch"
  | "filter-by-project"
  | "turn-into-project"
  | "project-settings"
  | "pin"
  | "unpin"
  | "settle"
  | "unsettle"
  | "auto-settle"
  | "auto-settle:enabled"
  | "auto-settle:disabled"
  | "snooze"
  | `snooze:${string}`
  | "unsnooze"
  | "rename"
  | "regenerate-title"
  | "mark-unread"
  | "copy"
  | "copy-path"
  | "copy-branch"
  | "copy-thread"
  | "copy-thread-id"
  | "archive"
  | "delete";

export type DraftActionMenuId =
  | "copy"
  | "copy-path"
  | "copy-branch"
  | "project-settings"
  | "discard";

export function buildDraftActionMenuItems(options: {
  readonly hasPath: boolean;
  readonly hasBranch: boolean;
  readonly hasProject: boolean;
}): ReadonlyArray<ContextMenuItem<DraftActionMenuId>> {
  return [
    {
      id: "copy",
      label: "Copy",
      icon: "copy",
      disabled: !options.hasPath && !options.hasBranch,
      children: [
        ...(options.hasPath ? [{ id: "copy-path" as const, label: "Path", icon: "folder" }] : []),
        ...(options.hasBranch
          ? [{ id: "copy-branch" as const, label: "Branch", icon: "git-branch" }]
          : []),
      ],
    },
    ...(options.hasProject
      ? [{ id: "project-settings" as const, label: "Workspace settings", icon: "settings" }]
      : []),
    {
      id: "discard",
      label: "Discard draft",
      icon: "trash",
      destructive: true,
      separatorBefore: true,
    },
  ];
}

export interface ThreadActionMenuState {
  readonly canOperate: boolean;
  readonly canFind?: boolean;
  readonly branch: string | null;
  readonly projectFilter: {
    readonly label: string;
    readonly isActive: boolean;
  } | null;
  /** The chat has a folder to copy: its worktree, else its workspace's. */
  readonly hasPath: boolean;
  /** The chat's workspace is known, so its settings can open. */
  readonly hasProject: boolean;
  readonly isPinned: boolean;
  readonly isSettled: boolean;
  readonly canSettleNow: boolean;
  readonly autoSettleEnabled: boolean;
  readonly isSnoozed: boolean;
  readonly canSnoozeNow: boolean;
  readonly canMarkUnread: boolean;
  readonly isRegeneratingTitle: boolean;
  /** Archive rejects attached providers, so disable it while running. */
  readonly isRunning: boolean;
  readonly supports: {
    readonly settlement: boolean;
    readonly autoSettleOptOut: boolean;
    readonly snooze: boolean;
    readonly pinning: boolean;
    readonly titleRegeneration: boolean;
  };
  readonly snoozePresets: ReadonlyArray<SnoozePreset>;
  /** A No project thread with its own folder, on a server that can promote it. */
  readonly canTurnIntoProject?: boolean;
}

const SETTLE_BLOCKING_RUN_STATUSES = new Set(["preparing", "starting", "running", "waiting"]);

/**
 * Mirrors the server's refusal to mark a chat done while it runs, waits on an approval, or has a
 * message queued. A blocking question holds its run open, so the run status covers it.
 */
function canSettleNow(thread: EnvironmentThreadShell, now: string): boolean {
  const request = thread.source.pendingRuntimeRequest;
  return (
    !SETTLE_BLOCKING_RUN_STATUSES.has(
      thread.source.activityRunStatus ?? thread.runtime?.status ?? "idle",
    ) &&
    (request == null || request.kind === "user_input") &&
    !hasQueuedTurnStart(thread, { now })
  );
}

/** The server marks a chat unread only once its latest run has finished. */
export function threadCanMarkUnread(thread: Pick<EnvironmentThreadShell, "latestRun">): boolean {
  return thread.latestRun?.completedAt != null;
}

/** What the chat's own record decides, read the same way by the header and the sidebar. */
export function threadActionMenuThreadState(
  thread: EnvironmentThreadShell,
  options: { readonly now: string; readonly configLoaded: boolean },
) {
  return {
    branch: thread.branch,
    isPinned: thread.pinnedAt != null,
    // Snoozing a done chat leaves it done, so it still offers Mark not done.
    isSettled: options.configLoaded && thread.settledOverride === "settled",
    canSettleNow: canSettleNow(thread, options.now),
    autoSettleEnabled: thread.autoSettleDisabledAt == null,
    isSnoozed: options.configLoaded && effectiveSnoozed(thread, { now: options.now }),
    canSnoozeNow: canSnooze(thread, { now: options.now }),
    canMarkUnread: threadCanMarkUnread(thread),
    isRegeneratingTitle: thread.titleRegeneration != null,
    isRunning: !threadRuntimeCanArchive(thread.runtime),
  } satisfies Partial<ThreadActionMenuState>;
}

/** Read-only clients keep what stays on this client: finding, copying, filtering, opening. */
export function threadActionRequiresOperate(action: ThreadActionMenuId): boolean {
  return ![
    "find",
    "new-thread-on-branch",
    "filter-by-project",
    "project-settings",
    "copy",
    "copy-path",
    "copy-branch",
    "copy-thread",
    "copy-thread-id",
  ].includes(action);
}

type ThreadActionMenuItem = ContextMenuItem<ThreadActionMenuId>;

function stateGroup(state: ThreadActionMenuState): ReadonlyArray<ThreadActionMenuItem> {
  return [
    ...(state.supports.pinning
      ? [
          state.isPinned
            ? { id: "unpin" as const, label: "Unpin chat", icon: "pin-off" }
            : { id: "pin" as const, label: "Pin chat", icon: "pin" },
        ]
      : []),
    ...(state.supports.settlement
      ? [
          state.isSettled
            ? { id: "unsettle" as const, label: "Mark not done", icon: "circle-check" }
            : {
                id: "settle" as const,
                label: "Mark done",
                icon: "circle-check",
                disabled: !state.canSettleNow,
              },
        ]
      : []),
    ...(state.supports.snooze
      ? [
          state.isSnoozed
            ? { id: "unsnooze" as const, label: "Wake now", icon: "clock" }
            : {
                id: "snooze" as const,
                label: "Snooze",
                icon: "clock",
                disabled: !state.canSnoozeNow,
                children: [
                  ...state.snoozePresets.map((preset) => ({
                    id: `snooze:${preset.id}` as const,
                    label: `${preset.label} (${preset.whenLabel})`,
                  })),
                  {
                    id: "snooze:custom" as const,
                    label: "Custom…",
                    separatorBefore: state.snoozePresets.length > 0,
                  },
                ],
              },
        ]
      : []),
    { id: "mark-unread", label: "Mark unread", icon: "mail-open", disabled: !state.canMarkUnread },
    // A team that finishes or is cancelled marks its agents' chats done whatever this is set to.
    ...(state.supports.autoSettleOptOut
      ? [
          {
            id: "auto-settle" as const,
            label: "Mark done automatically",
            icon: "timer",
            children: [
              {
                id: "auto-settle:enabled" as const,
                label: "As set in Settings",
                checked: state.autoSettleEnabled,
              },
              {
                id: "auto-settle:disabled" as const,
                label: "Never",
                checked: !state.autoSettleEnabled,
              },
            ],
          },
        ]
      : []),
  ];
}

function copyItem(state: ThreadActionMenuState): ThreadActionMenuItem {
  return {
    id: "copy",
    label: "Copy",
    icon: "copy",
    children: [
      { id: "copy-thread", label: "Chat link", icon: "message-square" },
      { id: "copy-thread-id", label: "Thread ID", icon: "hash" },
      ...(state.hasPath ? [{ id: "copy-path" as const, label: "Path", icon: "folder" }] : []),
      ...(state.branch
        ? [{ id: "copy-branch" as const, label: "Branch", icon: "git-branch" }]
        : []),
    ],
  };
}

function projectSettingsItems(state: ThreadActionMenuState): ReadonlyArray<ThreadActionMenuItem> {
  return state.hasProject
    ? [{ id: "project-settings", label: "Workspace settings", icon: "settings" }]
    : [];
}

const DELETE_ITEM: ThreadActionMenuItem = {
  id: "delete",
  label: "Delete chat",
  destructive: true,
  icon: "trash",
};

function threadActionMenuGroups(
  state: ThreadActionMenuState,
): ReadonlyArray<ReadonlyArray<ThreadActionMenuItem>> {
  return [
    stateGroup(state),
    [
      ...(state.canFind
        ? [{ id: "find" as const, label: "Find in chat", icon: "text-search" }]
        : []),
      { id: "rename", label: "Rename chat", icon: "pencil" },
      ...(state.supports.titleRegeneration
        ? [
            {
              id: "regenerate-title" as const,
              label: state.isRegeneratingTitle ? "Regenerating…" : "Regenerate title",
              icon: "refresh-cw",
              disabled: state.isRegeneratingTitle,
            },
          ]
        : []),
      copyItem(state),
    ],
    [
      ...(state.branch
        ? [
            {
              id: "new-thread-on-branch" as const,
              label: `New chat on ${state.branch}`,
              icon: "message-square-plus",
            },
          ]
        : []),
      ...(state.canTurnIntoProject
        ? [
            {
              id: "turn-into-project" as const,
              label: "Turn into workspace",
              icon: "folder-plus",
              disabled: state.isRunning,
            },
          ]
        : []),
      ...(state.projectFilter
        ? [
            {
              id: "filter-by-project" as const,
              label: state.projectFilter.isActive
                ? "Show all workspaces"
                : `Filter by ${state.projectFilter.label}`,
              icon: "folder-tree",
            },
          ]
        : []),
      ...projectSettingsItems(state),
    ],
    [
      { id: "archive", label: "Archive chat", icon: "archive", disabled: state.isRunning },
      DELETE_ITEM,
    ],
  ];
}

export function buildThreadActionMenuItems(
  state: ThreadActionMenuState,
): ReadonlyArray<ThreadActionMenuItem> {
  const items = threadActionMenuGroups(state)
    .filter((group) => group.length > 0)
    .flatMap((group, groupIndex) =>
      group.map((item, index) =>
        index === 0 && groupIndex > 0 ? { ...item, separatorBefore: true } : item,
      ),
    );
  return state.canOperate
    ? items
    : items.map((item) =>
        threadActionRequiresOperate(item.id)
          ? {
              ...item,
              disabled: true,
              ...(item.children
                ? { children: item.children.map((child) => ({ ...child, disabled: true })) }
                : {}),
            }
          : item,
      );
}
