import type { EnvironmentId, WorkspaceKind } from "@codenine/contracts";
import { PanelLeftCloseIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { WorkspaceKindBadge } from "~/components/WorkspaceKindBadge";
import { cn } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

import FileBrowserPanel from "./FileBrowserPanel";

/**
 * The left column of document view: the workspace and its files, with the open one marked. It is
 * the only list of them; the tabs above the stage hold what is open.
 */
export function DocumentRail(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly projectName: string;
  readonly kind: WorkspaceKind | null;
  readonly selectedPath: string | null;
  readonly workspaceMutationId: string | null;
  readonly onOpenFile: (relativePath: string) => void;
  readonly onCollapse: () => void;
}) {
  return (
    <aside
      aria-label="Workspace documents"
      data-document-rail
      className="flex h-full min-h-0 w-58 shrink-0 flex-col border-r border-border bg-background"
    >
      <div
        className={cn(
          "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-2 border-b pr-1.5 pl-3",
          COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
      >
        <span className="min-w-0 truncate text-sm font-semibold">{props.projectName}</span>
        {props.kind === null ? null : <WorkspaceKindBadge kind={props.kind} />}
        <span className="flex-1" />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-xs"
                variant="ghost-muted"
                aria-label="Hide documents"
                onClick={props.onCollapse}
              />
            }
          >
            <PanelLeftCloseIcon />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Hide documents</TooltipPopup>
        </Tooltip>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <FileBrowserPanel
          key={`${props.environmentId}:${props.cwd}`}
          environmentId={props.environmentId}
          cwd={props.cwd}
          projectName={props.projectName}
          selectedPath={props.selectedPath}
          selectedPathRevealId={0}
          onOpenFile={props.onOpenFile}
          workspaceMutationId={props.workspaceMutationId}
        />
      </div>
    </aside>
  );
}
