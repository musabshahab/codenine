import {
  BlocksIcon,
  BotIcon,
  FolderPlusIcon,
  InboxIcon,
  ListChecksIcon,
  MessageCircleIcon,
  PlugIcon,
  SparklesIcon,
  SquarePenIcon,
  UsersIcon,
  WorkflowIcon,
} from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuShortcut, MenuTrigger } from "../ui/menu";
import { SidebarMenuButton } from "../ui/sidebar";

/** The full pages the sidebar opens, each at `/<page>`. */
const SIDEBAR_PAGES = [
  "inbox",
  "tasks",
  "agents",
  "workflows",
  "skills",
  "connectors",
  "archive",
] as const;
export type SidebarPage = (typeof SIDEBAR_PAGES)[number];

export function sidebarPageForPath(pathname: string): SidebarPage | null {
  return SIDEBAR_PAGES.find((page) => pathname === `/${page}`) ?? null;
}

/** Every way to start something new, behind one button. */
export function SidebarNewMenu(props: {
  newChatShortcutLabel: string | null;
  newChatDisabled: boolean;
  /** Shift-click starts the chat in the current workspace. */
  onNewChat: (event: ReactMouseEvent) => void;
  onNewTeamTask: (() => void) | null;
  onNewWorkspace: () => void;
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
        <MenuItem onClick={props.onNewWorkspace}>
          <FolderPlusIcon />
          New workspace
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/** Inbox and Tasks: the pages for work across every workspace. */
export function SidebarNavRows(props: {
  current: SidebarPage | null;
  inboxCount: number;
  openTaskCount: number;
  onOpen: (page: SidebarPage) => void;
}) {
  return (
    <nav aria-label="Main" className="flex flex-col gap-px">
      <SidebarMenuButton isActive={props.current === "inbox"} onClick={() => props.onOpen("inbox")}>
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
      <SidebarMenuButton isActive={props.current === "tasks"} onClick={() => props.onOpen("tasks")}>
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

const BUILD_ROWS = [
  { page: "agents", label: "Agents", icon: <BotIcon /> },
  { page: "workflows", label: "Workflows", icon: <WorkflowIcon /> },
  { page: "skills", label: "Skills", icon: <SparklesIcon /> },
  { page: "connectors", label: "Connectors", icon: <PlugIcon /> },
] as const satisfies ReadonlyArray<{ page: SidebarPage; label: string; icon: ReactNode }>;

/** What agents are made of: the agents and workflows themselves, and their skills and connectors. */
export function SidebarBuildRows(props: {
  current: SidebarPage | null;
  onOpen: (page: SidebarPage) => void;
}) {
  return (
    <nav aria-label="Build" className="flex flex-col gap-px">
      <div className="flex h-7 items-center gap-1.5 pl-(--sidebar-row-content-inset) text-xs font-medium text-sidebar-muted-foreground [&>svg]:size-3.5">
        <BlocksIcon aria-hidden />
        Build
      </div>
      {BUILD_ROWS.map((row) => (
        <SidebarMenuButton
          key={row.page}
          isActive={props.current === row.page}
          onClick={() => props.onOpen(row.page)}
        >
          {row.icon}
          <span className="min-w-0 flex-1 truncate">{row.label}</span>
        </SidebarMenuButton>
      ))}
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
