import type { ReactNode } from "react";

import { isElectron } from "../../env";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

/** A full page in the main panel, such as Inbox or Tasks: a titled bar over a scrolling body. */
export function WorkspacePage(props: {
  area: string;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const label = typeof props.title === "string" ? props.title : props.area;
  return (
    <SidebarInset
      {...workspaceAreaProps(props.area, 1, label)}
      role="main"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      <WorkspacePageHeader electron={isElectron} className="border-b border-border">
        <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
          <h1 className="min-w-0 truncate font-medium text-foreground">{props.title}</h1>
          {props.subtitle ? (
            <span className="min-w-0 truncate text-muted-foreground">{props.subtitle}</span>
          ) : null}
        </div>
        {props.actions ? (
          <div className="flex shrink-0 items-center gap-2 [-webkit-app-region:no-drag]">
            {props.actions}
          </div>
        ) : null}
      </WorkspacePageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">{props.children}</div>
    </SidebarInset>
  );
}
