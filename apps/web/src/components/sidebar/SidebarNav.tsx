import {
  FolderCodeIcon,
  FolderPlusIcon,
  InboxIcon,
  ListChecksIcon,
  MessageCircleIcon,
  SquarePenIcon,
  UsersIcon,
} from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuShortcut, MenuTrigger } from "../ui/menu";
import { SidebarMenuButton } from "../ui/sidebar";

/** Every way to start something new, behind one button. */
export function SidebarNewMenu(props: {
  newChatShortcutLabel: string | null;
  newChatDisabled: boolean;
  /** Shift-click starts the chat in the current project. */
  onNewChat: (event: ReactMouseEvent) => void;
  onNewTeamTask: (() => void) | null;
  onNewProject: () => void;
  onNewFolder: () => void;
}) {
  return (
    <Menu>
      <MenuTrigger render={<Button size="icon-sm" variant="outline" aria-label="New" />}>
        <SquarePenIcon />
      </MenuTrigger>
      <MenuPopup align="end" className="w-60">
        <MenuItem disabled={props.newChatDisabled} onClick={props.onNewChat}>
          <MessageCircleIcon />
          New chat
          {props.newChatShortcutLabel ? (
            <MenuShortcut>{props.newChatShortcutLabel}</MenuShortcut>
          ) : null}
        </MenuItem>
        <MenuItem disabled={props.onNewTeamTask === null} onClick={() => props.onNewTeamTask?.()}>
          <UsersIcon />
          New task with a team
        </MenuItem>
        <MenuSeparator />
        <MenuItem onClick={props.onNewProject}>
          <FolderCodeIcon />
          New project
        </MenuItem>
        <MenuItem onClick={props.onNewFolder}>
          <FolderPlusIcon />
          New chat folder
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/** Inbox and Tasks: the pages for work across every project. */
export function SidebarNavRows(props: {
  current: "inbox" | "tasks" | null;
  inboxCount: number;
  openTaskCount: number;
  onOpenInbox: () => void;
  onOpenTasks: () => void;
}) {
  return (
    <nav aria-label="Main" className="flex flex-col gap-px">
      <SidebarMenuButton isActive={props.current === "inbox"} onClick={props.onOpenInbox}>
        <InboxIcon />
        <span className="min-w-0 flex-1 truncate">Inbox</span>
        {props.inboxCount > 0 ? (
          <span
            aria-label={`${props.inboxCount} waiting for you`}
            className="ml-auto flex h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-2xs font-semibold text-primary-foreground tabular-nums"
          >
            {props.inboxCount}
          </span>
        ) : null}
      </SidebarMenuButton>
      <SidebarMenuButton isActive={props.current === "tasks"} onClick={props.onOpenTasks}>
        <ListChecksIcon />
        <span className="min-w-0 flex-1 truncate">Tasks</span>
        {props.openTaskCount > 0 ? (
          <span className="ml-auto shrink-0 text-xs text-sidebar-muted-foreground">
            {props.openTaskCount} active
          </span>
        ) : null}
      </SidebarMenuButton>
    </nav>
  );
}

/** A quiet label over a part of the list, with optional buttons at its end. */
export function SidebarSectionLabel(props: {
  icon?: ReactNode;
  label: string;
  actions?: ReactNode;
}) {
  return (
    <li className="mt-2 flex h-7 list-none items-center gap-1.5 pr-1 pl-(--sidebar-row-content-inset) text-xs font-medium text-sidebar-muted-foreground first:mt-0 [&>svg]:size-3.5 [&>svg]:shrink-0">
      {props.icon}
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      {props.actions}
    </li>
  );
}
