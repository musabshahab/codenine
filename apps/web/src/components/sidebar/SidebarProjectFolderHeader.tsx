import type { EnvironmentThreadShell } from "@codenine/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@codenine/client-runtime/environment";
import {
  ChevronDownIcon,
  FolderIcon,
  FolderOpenIcon,
  HistoryIcon,
  SquarePenIcon,
} from "lucide-react";
import { memo, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useUiStateStore } from "../../uiStateStore";
import { resolveSidebarFolderDot, resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarAttentionDot } from "./SidebarTeamTasks";

/** The folder's sidebar tree row; its thread rows name it as their parent. */
export function sidebarFolderRowId(folderKey: string) {
  return `folder:${folderKey}`;
}

/**
 * A folder in the sidebar: a chevron that opens and closes it, then its icon and name, with its
 * count and a status dot while it is closed, so a closed folder still says when a hidden thread
 * needs you. With `onOpen`, the name opens the folder's own page and only the chevron toggles.
 */
function SidebarFolderHeaderRow(props: {
  testId: string;
  rowId: string;
  icon: ReactNode;
  label: string;
  newChatLabel: string;
  collapsed: boolean;
  /** Nothing to show when open, such as a folder whose chats are all pinned. */
  empty: boolean;
  hiddenThreads: readonly EnvironmentThreadShell[];
  onToggle: () => void;
  onOpen: (() => void) | null;
  onNewChat: (() => void) | null;
  onContextMenu: ((position: { x: number; y: number }) => void) | null;
}) {
  const { rowId, collapsed, hiddenThreads, newChatLabel, onOpen } = props;
  const localLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const dot = collapsed
    ? resolveSidebarFolderDot(
        hiddenThreads.map((thread) => ({
          ...thread,
          lastVisitedAt: resolveThreadLastVisitedAt(
            thread.lastVisitedAt,
            localLastVisitedAtById[
              scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
            ],
          ),
        })),
      )
    : null;
  const handleContextMenu = (event: ReactMouseEvent) => {
    if (props.onContextMenu === null) return;
    event.preventDefault();
    props.onContextMenu({ x: event.clientX, y: event.clientY });
  };
  const name = (
    <>
      {props.icon}
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground/90">
        {props.label}
      </span>
      {dot ? <SidebarAttentionDot attention={dot} /> : null}
      {collapsed && hiddenThreads.length > 0 ? (
        <span className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground group-hover/project-folder:invisible pointer-coarse:invisible">
          {hiddenThreads.length}
        </span>
      ) : null}
    </>
  );
  return (
    <li
      data-testid={props.testId}
      className="group/project-folder relative mt-1 list-none first:mt-0"
    >
      <div className="flex w-full items-center rounded-(--control-radius) hover:bg-sidebar-row-hover">
        <button
          type="button"
          data-sidebar-row={rowId}
          aria-expanded={props.empty ? undefined : !collapsed}
          aria-label={onOpen ? `Show or hide ${props.label}` : undefined}
          onClick={props.onToggle}
          onContextMenu={handleContextMenu}
          className={cn(
            "flex h-8 cursor-pointer items-center rounded-(--control-radius) outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            onOpen
              ? "w-6 shrink-0 justify-center ps-1"
              : "min-w-0 flex-1 gap-2 ps-1.5 pe-(--sidebar-row-content-inset) text-left",
          )}
        >
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-3 shrink-0 text-sidebar-muted-foreground transition-transform",
              (collapsed || props.empty) && "-rotate-90",
              props.empty && "invisible",
            )}
          />
          {onOpen ? null : name}
        </button>
        {onOpen ? (
          <button
            type="button"
            data-sidebar-action-for={rowId}
            onClick={onOpen}
            onContextMenu={handleContextMenu}
            className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-(--control-radius) pe-(--sidebar-row-content-inset) text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            {name}
          </button>
        ) : null}
      </div>
      {/* Sits over the count, which hides on hover. */}
      {props.onNewChat === null ? null : (
        <span className="absolute inset-y-0 right-1.5 flex items-center opacity-0 focus-within:opacity-100 group-hover/project-folder:opacity-100 pointer-coarse:opacity-100">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  data-sidebar-action-for={rowId}
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={newChatLabel}
                  onClick={props.onNewChat}
                />
              }
            >
              <SquarePenIcon aria-hidden />
            </TooltipTrigger>
            <TooltipPopup>{newChatLabel}</TooltipPopup>
          </Tooltip>
        </span>
      )}
    </li>
  );
}

/** A project folder in the sidebar grouped by project. */
export const SidebarProjectFolderHeader = memo(function SidebarProjectFolderHeader(props: {
  group: SidebarProjectSnapshot;
  collapsed: boolean;
  empty: boolean;
  hiddenThreads: readonly EnvironmentThreadShell[];
  onToggle: (group: SidebarProjectSnapshot) => void;
  onOpen: (group: SidebarProjectSnapshot) => void;
  onNewThread: (group: SidebarProjectSnapshot) => void;
  onContextMenu: (group: SidebarProjectSnapshot, position: { x: number; y: number }) => void;
}) {
  const { group } = props;
  return (
    <SidebarFolderHeaderRow
      testId="sidebar-project-folder"
      rowId={sidebarFolderRowId(group.projectKey)}
      icon={<ProjectFavicon project={group} className="size-4 shrink-0" />}
      label={group.isScratch ? "Chats without a project" : group.displayName}
      newChatLabel={
        group.isScratch ? "New chat without a project" : `New chat in ${group.displayName}`
      }
      collapsed={props.collapsed}
      empty={props.empty}
      hiddenThreads={props.hiddenThreads}
      onToggle={() => props.onToggle(group)}
      onOpen={group.isScratch ? null : () => props.onOpen(group)}
      onNewChat={() => props.onNewThread(group)}
      onContextMenu={(position) => props.onContextMenu(group, position)}
    />
  );
});

/** A folder of chats without a project; `name` is null for the chats in no folder. */
export const SidebarChatFolderHeader = memo(function SidebarChatFolderHeader(props: {
  folderKey: string;
  name: string | null;
  collapsed: boolean;
  empty: boolean;
  hiddenThreads: readonly EnvironmentThreadShell[];
  onToggle: (folderKey: string) => void;
  onNewChat: () => void;
  onContextMenu: ((name: string, position: { x: number; y: number }) => void) | null;
}) {
  const { name, onContextMenu } = props;
  const FolderGlyph = props.collapsed || props.empty ? FolderIcon : FolderOpenIcon;
  return (
    <SidebarFolderHeaderRow
      testId="sidebar-chat-folder"
      rowId={sidebarFolderRowId(props.folderKey)}
      icon={
        name === null ? (
          <HistoryIcon aria-hidden className="size-4 shrink-0 text-(--sidebar-icon-color)" />
        ) : (
          <FolderGlyph aria-hidden className="size-4 shrink-0 text-(--sidebar-icon-color)" />
        )
      }
      label={name ?? "Recent"}
      newChatLabel="New chat"
      collapsed={props.collapsed}
      empty={props.empty}
      hiddenThreads={props.hiddenThreads}
      onToggle={() => props.onToggle(props.folderKey)}
      onOpen={null}
      // A new chat is a draft, which joins a folder only once it is sent and moved.
      onNewChat={name === null ? props.onNewChat : null}
      onContextMenu={
        name === null || onContextMenu === null ? null : (position) => onContextMenu(name, position)
      }
    />
  );
});
