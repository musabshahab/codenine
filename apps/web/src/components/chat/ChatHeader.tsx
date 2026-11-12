import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
} from "@codenine/contracts";
import { scopeThreadRef } from "@codenine/client-runtime/environment";
import type { EnvironmentProject } from "@codenine/client-runtime/state/shell";
import type { TeamAgentHeader } from "@codenine/client-runtime/team";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@codenine/client-runtime/state/runtime";
import { ChevronDownIcon, EllipsisIcon, FolderIcon, FolderInputIcon, PinIcon } from "lucide-react";
import {
  memo,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import { isTrailingDoubleClick } from "../Sidebar.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { useThreadActionMenu } from "~/hooks/useThreadActionMenu";
import { readChatFolderNames, useChatFolders } from "~/hooks/useChatFolders";
import { useThreadActions } from "~/hooks/useThreadActions";
import { useQuietThreadShell } from "../../state/entities";
import { buildChatFolderMenuItems, resolveThreadFolderChoice } from "../threadActionMenu.logic";
import { Button } from "../ui/button";
import { readLocalApi } from "~/localApi";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { textDirection } from "~/textDirection";
import { useThreadProjectGroup } from "../pages/threadPlace";
import { ThreadKindIcon } from "../ThreadKindIcon";
import { resolveAgentThreadKind } from "../threadKind.logic";
import { TeamAgentHeaderLine } from "./TeamAgentThread";
import { useClientSettings } from "../../hooks/useSettings";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  activeThreadTitle: string;
  isServerThread: boolean;
  activeProject: EnvironmentProject | null;
  /** A subagent's parent, or the task (lead thread) a team agent works for. */
  parentThreadLink: { threadId: ThreadId; title: string; task: boolean } | null;
  /** On a team agent's thread: its name, which the last crumb shows, and its place in the team. */
  teamAgent: TeamAgentHeader | null;
  onOpenThread: (threadId: ThreadId) => void;
  rightPanelOpen: boolean;
  onOpenProjectSettings?: (() => void) | undefined;
  onFindInThread?: ((threadRef: ScopedThreadRef) => void) | undefined;
  /** The project command and panel toggles, between the title and the More button. */
  tools?: ReactNode;
  /** The one button for what the thread needs next, at the end of the header. */
  nextStep?: ReactNode;
}

function resolveRenameCommit(input: {
  readonly title: string;
  readonly originalTitle: string;
}): { action: "commit"; title: string } | { action: "reject-empty" } | { action: "noop" } {
  const trimmed = input.title.trim();
  if (trimmed.length === 0) return { action: "reject-empty" };
  if (trimmed === input.originalTitle) return { action: "noop" };
  return { action: "commit", title: trimmed };
}

/** Pins a chat to the top of Chats, like Linear's star beside a title. */
function ChatPinToggle(props: { threadRef: ScopedThreadRef; pinned: boolean; disabled: boolean }) {
  const { pinThread, confirmAndUnpinThread } = useThreadActions();
  const { threadRef, pinned } = props;
  const label = pinned ? "Unpin chat" : "Pin chat";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-xs"
            variant="ghost-muted"
            aria-label={label}
            aria-pressed={pinned}
            disabled={props.disabled}
            onClick={() => {
              void (pinned ? confirmAndUnpinThread(threadRef) : pinThread(threadRef)).then(
                (result) => {
                  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
                  const error = squashAtomCommandFailure(result);
                  toastManager.add({
                    type: "error",
                    title: pinned ? "Failed to unpin chat" : "Failed to pin chat",
                    description: error instanceof Error ? error.message : "An error occurred.",
                  });
                },
              );
            }}
          />
        }
      >
        <PinIcon aria-hidden fill={pinned ? "currentColor" : "none"} />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

// Delay the input-swallowing native menu through the double-click rename interval.
const TITLE_MENU_OPEN_DELAY_MS = 500;
export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadId,
  activeThreadTitle,
  isServerThread,
  activeProject,
  parentThreadLink,
  teamAgent,
  onOpenThread,
  rightPanelOpen,
  onOpenProjectSettings,
  onFindInThread,
  tools,
  nextStep,
}: ChatHeaderProps) {
  const isChat = activeProject?.isScratch === true;
  const activeThreadRef = scopeThreadRef(activeThreadEnvironmentId, activeThreadId);
  const threadShell = useQuietThreadShell(isServerThread ? activeThreadRef : null);
  const chatFolder = isChat ? (threadShell?.folder ?? null) : null;
  const projectGroupOf = useThreadProjectGroup();
  const projectGroup =
    activeProject === null || isChat
      ? null
      : projectGroupOf({ environmentId: activeThreadEnvironmentId, projectId: activeProject.id });
  const navigate = useNavigate();
  // A chat names its folder where a thread names its project.
  const activeProjectName = isChat ? (chatFolder ?? "Chats") : activeProject?.title;
  // A team agent's crumb names the agent; its title, the task it runs, stays in the tooltip.
  const crumbTitle = teamAgent?.label ?? activeThreadTitle;
  const activeProjectCwd = activeProject?.workspaceRoot ?? null;
  const interfaceFont = useClientSettings((settings) => settings.fontFamilySans);
  const breadcrumbContainerRef = useRef<HTMLDivElement>(null);
  const [collapseParentTitle, setCollapseParentTitle] = useState(false);
  const canOperateThread = useEnvironmentScope(
    activeThreadEnvironmentId,
    AuthOrchestrationOperateScope,
  );
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const [renaming, setRenaming] = useState<{
    threadId: ThreadId;
    environmentId: EnvironmentId;
    title: string;
  } | null>(null);
  if (
    renaming !== null &&
    (renaming.threadId !== activeThreadId ||
      renaming.environmentId !== activeThreadEnvironmentId ||
      !canOperateThread)
  ) {
    setRenaming(null);
  }
  const renamingTitle =
    canOperateThread &&
    renaming?.threadId === activeThreadId &&
    renaming.environmentId === activeThreadEnvironmentId
      ? renaming.title
      : null;
  const isRenamingTitle = renamingTitle !== null;
  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- measures the breadcrumb list DOM via ResizeObserver, a frame and font loads to collapse the parent title
  useEffect(() => {
    const list = breadcrumbContainerRef.current?.querySelector("ol");
    if (!list || !parentThreadLink) return;
    const measure = () => {
      const gap = Number.parseFloat(getComputedStyle(list).columnGap) || 0;
      const width = Array.from(list.children).reduce(
        (total, item) => {
          const label = item.querySelector('[data-slot="workspace-breadcrumb-text"]');
          const ellipsis = item.querySelector("[data-parent-breadcrumb-ellipsis]");
          return (
            total +
            (item.firstElementChild?.getBoundingClientRect().width ?? 0) +
            (label && getComputedStyle(label).maxWidth === "none"
              ? label.scrollWidth - label.clientWidth
              : 0) -
            (ellipsis?.getBoundingClientRect().width ?? 0)
          );
        },
        gap * (list.children.length - 1),
      );
      setCollapseParentTitle(width > list.clientWidth);
    };
    measure();
    const frame = requestAnimationFrame(measure);
    document.fonts.addEventListener("loadingdone", measure);
    const stopObserving = observeResize(list, measure);
    return () => {
      cancelAnimationFrame(frame);
      document.fonts.removeEventListener("loadingdone", measure);
      stopObserving();
    };
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Title, font and rename changes resize the breadcrumb text without resizing the list, so it re-measures.
    activeProjectName,
    crumbTitle,
    parentThreadLink,
    interfaceFont,
    isRenamingTitle,
  ]);
  const renameCommittedRef = useRef(false);
  const startRename = () => {
    if (
      !isServerThread ||
      !readEnvironmentScope(activeThreadEnvironmentId, AuthOrchestrationOperateScope)
    )
      return;
    renameCommittedRef.current = false;
    setRenaming({
      environmentId: activeThreadEnvironmentId,
      threadId: activeThreadId,
      title: activeThreadTitle,
    });
  };
  const commitRename = (title: string) => {
    setRenaming(null);
    if (!readEnvironmentScope(activeThreadEnvironmentId, AuthOrchestrationOperateScope)) return;
    const resolution = resolveRenameCommit({
      title,
      originalTitle: renamingTitle ?? activeThreadTitle,
    });
    if (resolution.action === "reject-empty") {
      toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
      return;
    }
    if (resolution.action === "noop") return;
    void updateThreadMetadata({
      environmentId: activeThreadEnvironmentId,
      input: { threadId: activeThreadId, title: resolution.title },
    }).then((result) => {
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Failed to rename thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    });
  };
  const { openMenu, closeMenu } = useThreadActionMenu({
    threadRef: isServerThread ? activeThreadRef : null,
    projectCwd: activeProjectCwd,
    onStartRename: startRename,
    onFind: onFindInThread,
  });
  const titleButtonRef = useRef<HTMLButtonElement | null>(null);
  const titleMenuTimerRef = useRef<number | null>(null);
  const cancelPendingTitleMenu = () => {
    if (titleMenuTimerRef.current === null) return;
    clearTimeout(titleMenuTimerRef.current);
    titleMenuTimerRef.current = null;
  };
  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- clears the pending title-menu timer when the thread switches or the header unmounts
  useEffect(
    () => () => {
      if (titleMenuTimerRef.current === null) return;
      clearTimeout(titleMenuTimerRef.current);
      titleMenuTimerRef.current = null;
    },
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A pending title menu belongs to the thread that was clicked, so switching threads drops it.
    [activeThreadEnvironmentId, activeThreadId],
  );
  const openTitleMenuNow = () => {
    cancelPendingTitleMenu();
    const rect = titleButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    openMenu({ x: rect.left, y: rect.bottom + 4 });
  };
  const openMenuFromTitle = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (isTrailingDoubleClick(event.detail)) return;
    const clickedChevron =
      (event.target as HTMLElement).closest("[data-thread-title-chevron]") !== null;
    if (event.detail === 0 || clickedChevron || window.desktopBridge === undefined) {
      openTitleMenuNow();
      return;
    }
    cancelPendingTitleMenu();
    titleMenuTimerRef.current = window.setTimeout(() => {
      titleMenuTimerRef.current = null;
      openTitleMenuNow();
    }, TITLE_MENU_OPEN_DELAY_MS);
  };
  const handleTitleDoubleClick = (event: ReactMouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if ((event.target as HTMLElement).closest("[data-thread-title-chevron]") !== null) return;
    cancelPendingTitleMenu();
    closeMenu();
    startRename();
  };
  const handleHeaderContextMenu = (event: ReactMouseEvent) => {
    if (renamingTitle !== null) return;
    if (!isServerThread && onOpenProjectSettings === undefined) return;
    cancelPendingTitleMenu();
    event.preventDefault();
    if (!isServerThread) {
      const api = readLocalApi();
      if (!api) return;
      void api.contextMenu
        .show([{ id: "project-settings", label: "Project settings", icon: "settings" }], {
          x: event.clientX,
          y: event.clientY,
        })
        .then((action) => {
          if (action === "project-settings") onOpenProjectSettings?.();
        });
      return;
    }
    openMenu({ x: event.clientX, y: event.clientY });
  };
  const chatFolders = useChatFolders();
  const openFolderMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const api = readLocalApi();
    if (!api) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const names = readChatFolderNames();
    void api.contextMenu
      .show(buildChatFolderMenuItems({ names, current: chatFolder }), {
        x: rect.left,
        y: rect.bottom + 4,
      })
      .then((action) => {
        const choice = action === null ? null : resolveThreadFolderChoice(action, names);
        if (choice === "new") void chatFolders.moveToNewFolder(activeThreadRef);
        else if (choice !== null) void chatFolders.moveToFolder(activeThreadRef, choice.folder);
      });
  };
  const movesChat = isChat && isServerThread && canOperateThread;
  const handleRenameKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      renameCommittedRef.current = true;
      commitRename(event.currentTarget.value);
    } else if (event.key === "Escape") {
      renameCommittedRef.current = true;
      setRenaming(null);
    }
  };
  const openMoreMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    openMenu({ x: rect.left, y: rect.bottom + 4 });
  };
  return (
    <div
      className={cn("flex min-w-0 flex-1 items-center gap-3", rightPanelOpen ? "pr-0" : "pr-10")}
      onContextMenu={handleHeaderContextMenu}
    >
      <div ref={breadcrumbContainerRef} className="flex min-w-0 flex-1 flex-col justify-center">
        <WorkspaceBreadcrumb
          ariaLabel="Thread breadcrumb"
          className="overflow-clip [overflow-clip-margin:2px]"
        >
          {activeProject ? (
            <>
              <WorkspaceBreadcrumbItem
                className={cn("shrink", isChat && "hidden @md/header-actions:flex")}
              >
                {isChat ? (
                  <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
                    {chatFolder === null ? null : (
                      <FolderIcon aria-hidden className="size-3.5 shrink-0" />
                    )}
                    <WorkspaceBreadcrumbText className="max-w-40">
                      {activeProjectName}
                    </WorkspaceBreadcrumbText>
                  </span>
                ) : (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          aria-label={`Open project ${activeProjectName}`}
                          disabled={projectGroup === null}
                          onClick={() => {
                            if (projectGroup === null) return;
                            void navigate({
                              to: "/project/$projectKey",
                              params: { projectKey: projectGroup.projectKey },
                            });
                          }}
                          className="inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default"
                        />
                      }
                    >
                      <ProjectFavicon project={activeProject} className="size-4" />
                      <WorkspaceBreadcrumbText className="hidden max-w-40 @3xl/header-actions:block">
                        {activeProjectName}
                      </WorkspaceBreadcrumbText>
                    </TooltipTrigger>
                    <TooltipPopup side="top">Open project</TooltipPopup>
                  </Tooltip>
                )}
              </WorkspaceBreadcrumbItem>
              <WorkspaceBreadcrumbSeparator
                {...(isChat ? { className: "hidden @md/header-actions:flex" } : {})}
              />
            </>
          ) : null}
          {parentThreadLink ? (
            <>
              <WorkspaceBreadcrumbItem>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label={`${parentThreadLink.task ? "Open task" : "Open parent thread"}: ${parentThreadLink.title}`}
                        onClick={() => onOpenThread(parentThreadLink.threadId)}
                        className="inline-flex min-w-0 max-w-full cursor-pointer items-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      />
                    }
                  >
                    <WorkspaceBreadcrumbText
                      aria-hidden
                      className={collapseParentTitle ? "w-0" : undefined}
                    >
                      {parentThreadLink.title}
                    </WorkspaceBreadcrumbText>
                    {collapseParentTitle ? (
                      <span aria-hidden data-parent-breadcrumb-ellipsis>
                        ...
                      </span>
                    ) : null}
                  </TooltipTrigger>
                  <TooltipPopup side="top">{parentThreadLink.title}</TooltipPopup>
                </Tooltip>
              </WorkspaceBreadcrumbItem>
              <WorkspaceBreadcrumbSeparator />
            </>
          ) : null}
          <WorkspaceBreadcrumbItem current className="min-w-10 flex-1 gap-2">
            {threadShell === null ? null : (
              <ThreadKindIcon kind={resolveAgentThreadKind(threadShell, teamAgent)} />
            )}
            {renamingTitle !== null ? (
              <input
                autoFocus
                dir="auto"
                aria-label="Thread title"
                className="min-w-0 flex-1 rounded-sm bg-transparent text-sm font-medium text-foreground outline-none ring-1 ring-inset ring-ring/50 focus:ring-ring"
                defaultValue={renamingTitle}
                onBlur={(event) => {
                  if (renameCommittedRef.current) return;
                  if (
                    event.relatedTarget instanceof HTMLElement &&
                    event.relatedTarget.closest("button")
                  ) {
                    setRenaming(null);
                    return;
                  }
                  commitRename(event.currentTarget.value);
                }}
                onFocus={(event) => event.currentTarget.select()}
                onKeyDown={handleRenameKeyDown}
              />
            ) : isServerThread ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      ref={titleButtonRef}
                      type="button"
                      aria-label={`Thread actions for ${crumbTitle}`}
                      aria-haspopup="menu"
                      onClick={openMenuFromTitle}
                      onDoubleClick={canOperateThread ? handleTitleDoubleClick : undefined}
                      onBlur={cancelPendingTitleMenu}
                      className="group/thread-title inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-sm text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    />
                  }
                >
                  <h2 className="min-w-0" dir={textDirection(crumbTitle)}>
                    <WorkspaceBreadcrumbText>{crumbTitle}</WorkspaceBreadcrumbText>
                  </h2>
                  <ChevronDownIcon
                    aria-hidden
                    data-thread-title-chevron
                    className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/thread-title:opacity-100 group-focus-visible/thread-title:opacity-100"
                  />
                </TooltipTrigger>
                <TooltipPopup side="top">{activeThreadTitle}</TooltipPopup>
              </Tooltip>
            ) : (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <h2
                      aria-label={activeThreadTitle}
                      className="min-w-0 flex-1"
                      dir={textDirection(activeThreadTitle)}
                    />
                  }
                >
                  <WorkspaceBreadcrumbText>{activeThreadTitle}</WorkspaceBreadcrumbText>
                </TooltipTrigger>
                <TooltipPopup side="top">{activeThreadTitle}</TooltipPopup>
              </Tooltip>
            )}
            {isChat && threadShell !== null && renamingTitle === null ? (
              <span className="hidden @md/header-actions:flex">
                <ChatPinToggle
                  threadRef={activeThreadRef}
                  pinned={threadShell.pinnedAt != null}
                  disabled={!canOperateThread}
                />
              </span>
            ) : null}
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
        {isServerThread && teamAgent !== null ? (
          <div className="flex min-w-0 max-w-full items-start gap-1 text-xs leading-4 text-muted-foreground">
            <TeamAgentHeaderLine
              environmentId={activeThreadEnvironmentId}
              projectId={activeProject?.id ?? null}
              header={teamAgent}
            />
          </div>
        ) : null}
      </div>
      <div
        role="toolbar"
        aria-label="Thread tools"
        className="flex shrink-0 items-center gap-0.5 [-webkit-app-region:no-drag]"
      >
        {movesChat ? (
          <span className="hidden @md/header-actions:flex">
            <Button
              size="xs"
              variant="outline"
              aria-haspopup="menu"
              aria-label={
                chatFolder === null ? "Move to folder" : `Move to folder, now in ${chatFolder}`
              }
              onClick={openFolderMenu}
            >
              <FolderInputIcon aria-hidden />
              Move to folder
              <ChevronDownIcon aria-hidden />
            </Button>
          </span>
        ) : null}
        {tools}
        {isServerThread ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost-muted"
                  aria-label="More"
                  aria-haspopup="menu"
                  onClick={openMoreMenu}
                />
              }
            >
              <EllipsisIcon aria-hidden />
            </TooltipTrigger>
            <TooltipPopup side="bottom">More</TooltipPopup>
          </Tooltip>
        ) : null}
        {nextStep ? (
          <span data-next-step className="ms-1.5 flex shrink-0 items-center empty:hidden">
            {nextStep}
          </span>
        ) : null}
      </div>
    </div>
  );
});
