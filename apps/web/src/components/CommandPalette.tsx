import { threadPullRequestLinkMode } from "@codenine/client-runtime/thread-pull-request-compatibility";

import { latestReplyText, useSaveReplyStore } from "./work/saveReplyStore";
import { useCanSaveReply } from "./work/SaveReplyDialog";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@codenine/client-runtime/environment";
import { canCreateProjectInEnvironment } from "@codenine/client-runtime/operations/projects";
import { sourceControlClients } from "@codenine/client-runtime/source-control-clients";
import { resolveThreadReferenceCopyTarget } from "@codenine/client-runtime/thread-reference";
import {
  canPreloadBrowsePath,
  createBrowseNavigationCoordinator,
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
  getFilesystemBrowseTabCompletion,
} from "@codenine/client-runtime/state/filesystem";
import { squashAtomCommandFailure } from "@codenine/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  AuthFilesystemReadScope,
  type EnvironmentId,
  type FilesystemBrowseResult,
} from "@codenine/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArrowLeftIcon,
  BotIcon,
  ChartNoAxesColumnIcon,
  CornerLeftUpIcon,
  DatabaseBackupIcon,
  FileSearchIcon,
  FolderGit2Icon,
  FolderIcon,
  FolderPlusIcon,
  MessageSquareDashedIcon,
  LinkIcon,
  MessageSquareIcon,
  PaletteIcon,
  RotateCcwIcon,
  SettingsIcon,
  MonitorIcon,
  PinIcon,
  PinOffIcon,
  PlugIcon,
  SparklesIcon,
  SquarePenIcon,
  TextSearchIcon,
  FileDownIcon,
} from "lucide-react";
import { openThreadFind } from "./chat/threadFindStore";
import {
  useDeferredValue,
  useEffect,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { LegendListRef } from "@legendapp/list/react";
import { useAtomValue } from "@effect/atom-react";

import { agentModelProblem } from "./agents/agents.logic";
import { useAgents } from "./agents/useAgents";
import { useStartAgentChat } from "./agents/useStartAgentChat";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { copyThreadReference } from "../lib/copyThreadReference";
import {
  queueWorkspaceFocusFromPalette,
  restoreWorkspaceFocusFromPalette,
} from "../lib/workspaceFocus";
import {
  composerPromptLink,
  copyPromptLink,
  promptLinkRepositoryOf,
} from "./promptLinks/copyPromptLink";
import { useStableCallback } from "../hooks/useStableCallback";
import { configuredHostedAppUrl } from "../hostedPairing";
import { desktopLocalBackendId } from "../connection/desktopLocal";
import { filesystemEnvironment, useFilesystemReadAccess } from "../state/filesystem";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { useScratchProject } from "../hooks/useScratchProject";
import { useNewProject } from "../hooks/useNewProject";
import { useProjectFolderPicker } from "../hooks/useProjectFolderPicker";
import { useOrderWhileOpen } from "../hooks/useOrderWhileOpen";
import { useProjectPin } from "../hooks/useProjectGroupUpdate";
import {
  useEnvironmentProviders,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../state/environments";
import {
  useAnyEnvironmentHiding,
  useHiddenThreadKeys,
  useEnvironmentThreadRefs,
  useProjects,
  useServerConfigs,
  useVisibleThreadShells,
} from "../state/entities";
import { visibleLinkedThreads } from "@codenine/client-runtime/state/threads";
import { resolveThreadActionProjectRef, startNewThreadFromContext } from "../lib/chatThreadActions";
import {
  appendBrowsePathSegment,
  getBrowseDirectoryPath,
  hasTrailingPathSeparator,
  inferProjectTitleFromPath,
  isExplicitRelativeProjectPath,
  isFilesystemBrowseQuery,
  isScratchProject,
  isUnsupportedWindowsProjectPath,
  resolveProjectPathForDispatch,
} from "@codenine/client-runtime/state/projects";
import { resolvePastedPath } from "@codenine/shared/path";
import {
  dispatchCommandPalette,
  getCommandPaletteReturnFocus,
  useCommandPaletteMount,
  useCommandPaletteStore,
} from "../commandPaletteStore";
import { openNewProjectDialog, useNewProjectDialogStore } from "../newProjectDialogStore";
import { projectPreset } from "../workspaceKind";
import { getLatestThreadForProject, sortThreads } from "@codenine/client-runtime/state/thread-sort";
import { cn, getLocalFileManagerName, isMacPlatform } from "../lib/utils";
import { buildThreadRouteParams } from "../threadRoutes";
import { useAvailableSettingsSearchItems } from "./settings/useAvailableSettingsSearchItems";
import {
  resolveCommandPaletteProject,
  ADDON_ICON_CLASS,
  browseInputEndPaddingClass,
  buildBrowseGroups,
  buildRootGroups,
  buildLinkedThreadActionItems,
  buildCommandPaletteRows,
  enumerateCommandPaletteItems,
  newThreadNoProjectIndex,
  findHighlightedCommandPaletteItem,
  type CommandPaletteActionItem,
  type CommandPaletteOpenIntent,
  type CommandPaletteProject,
  type CommandPaletteReturnContext,
  type CommandPaletteSubmenuItem,
  type CommandPaletteView,
  filterCommandPaletteGroups,
  buildNestedSearchItems,
  getCommandPaletteInputPlaceholder,
  getCommandPaletteMode,
  ITEM_ICON_CLASS,
  RECENT_THREAD_LIMIT,
  createCommandPaletteSearchState,
  getEnvironmentBrowsePlatform,
  reduceCommandPaletteSearchState,
  type SearchOverlayMode,
} from "./CommandPalette.logic";
import { isSidebarHiddenThread } from "./Sidebar.logic";
import { CommandPaletteContent, type PendingInputSelection } from "./CommandPaletteContent";
import {
  useEnvironmentLookups,
  useProjectLookups,
  useSortedProjectGroups,
} from "./CommandPaletteLookups";
import {
  buildNewThreadInProjectItems,
  buildProjectSearchItems,
} from "./CommandPaletteProjectItems";
import { CommandPaletteSubmitButton } from "./CommandPaletteAddProject";
import { useCommandPaletteThreadItems } from "./CommandPaletteThreadItems";
import { useCommandPaletteThemeItems } from "./CommandPaletteThemeItems";
import {
  CommandPaletteVirtualizedResults,
  scrollCommandPaletteRowIntoView,
} from "./CommandPaletteResults";
import { newProjectMachines } from "./NewProjectDialog.logic";
import { ProjectFilePicker } from "./files/ProjectFilePicker";
import { openLinkPullRequestDialog } from "./pullRequest/LinkPullRequestDialog";
import { openUseInAnotherApp } from "./mcp/UseInAnotherAppDialog";
import { ProjectContentSearchDialog } from "./search/ProjectContentSearchDialog";
import { settingsForThisPlatform, SETTINGS_SECTION_LABELS } from "./settings/settingsSearch";
import { primaryServerKeybindingsAtom } from "../state/server";
import { resolveShortcutCommand, threadJumpIndexFromCommand } from "../keybindings";
import { CommandDialog, CommandDialogPopup, CommandFooterAction } from "./ui/command";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { ComposerHandleContext, useComposerHandleContext } from "../composerHandleContext";
import type { ChatComposerHandle } from "./chat/ChatComposer";
import { pickableProjectGroups } from "@codenine/client-runtime/state/project-grouping";
import { buildSidebarProjectPickerEntries } from "../sidebarProjectGrouping";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { threadRecentUse } from "@codenine/shared/paletteSearch";

const EMPTY_BROWSE_ENTRIES: FilesystemBrowseResult["entries"] = [];
const NEW_THREAD_IN_GROUP = "projects";

/** The submenu an open intent starts in; its groups resolve while rendering. */
function openIntentView(intent: CommandPaletteOpenIntent | null): CommandPaletteView | null {
  switch (intent?.kind) {
    case "new-thread-in":
      return {
        addonIcon: <SquarePenIcon className={ADDON_ICON_CLASS} />,
        groups: [{ value: NEW_THREAD_IN_GROUP, label: "Workspaces", items: [] }],
      };
    case "change-theme":
      return {
        addonIcon: <PaletteIcon className={ADDON_ICON_CLASS} />,
        groups: [{ value: "themes", label: "Change theme", items: [] }],
      };
    case "search":
    case undefined:
      return null;
  }
}

const NEW_THREAD_NO_PROJECT_VALUE = "new-thread-in:no-project";

export function CommandPalette({ children }: { children: ReactNode }) {
  useCommandPaletteMount();
  const state = useCommandPaletteStore();
  const setOpen = (open: boolean) => dispatchCommandPalette({ _tag: "SetOpen", open });
  const openChildSearch = (mode: "files" | "content", context: CommandPaletteReturnContext) =>
    dispatchCommandPalette({ _tag: "OpenChildSearch", mode, context });
  const composerHandleRef = useRef<ChatComposerHandle | null>(null);

  return (
    <ComposerHandleContext value={composerHandleRef}>
      <CommandDialog
        open={state.open}
        onOpenChange={(open, eventDetails) => {
          if (!open && eventDetails.reason === "escape-key" && state.mode !== "command") {
            eventDetails.cancel();
            dispatchCommandPalette({ _tag: "BackToCommand" });
            return;
          }
          setOpen(open);
        }}
      >
        <div className="contents" inert={state.open}>
          {children}
        </div>
        <CommandPaletteDialog
          mode={state.mode}
          session={state.session}
          openIntent={state.openIntent}
          setOpen={setOpen}
          openChildSearch={openChildSearch}
          initialContext={state.restoredSearch}
        />
      </CommandDialog>
    </ComposerHandleContext>
  );
}

function CommandPaletteDialog(props: {
  readonly mode: SearchOverlayMode;
  readonly session: number;
  readonly openIntent: CommandPaletteOpenIntent | null;
  readonly setOpen: (open: boolean) => void;
  readonly openChildSearch: (
    mode: "files" | "content",
    context: CommandPaletteReturnContext,
  ) => void;
  readonly initialContext: CommandPaletteReturnContext | undefined;
}) {
  const composerHandleRef = useComposerHandleContext();

  return (
    <CommandDialogPopup
      aria-label={
        props.mode === "files"
          ? "File picker"
          : props.mode === "content"
            ? "Search workspace contents"
            : "Command palette"
      }
      className={cn("overflow-hidden", props.mode === "content" && "h-105")}
      data-command-palette="true"
      data-palette-mode={props.mode}
      data-testid="command-palette"
      finalFocus={() => {
        if (restoreWorkspaceFocusFromPalette()) return false;
        // A command that opened the New workspace dialog leaves focus to it.
        if (useNewProjectDialogStore.getState().open) return false;
        const returnFocus = getCommandPaletteReturnFocus();
        if (returnFocus === false) return false;
        const composer = composerHandleRef?.current;
        // Behind the Settings modal the composer is inert and cannot take focus.
        if (!composer || document.querySelector("[data-app-modal]")) return returnFocus;
        composer.focusAtEnd();
        return false;
      }}
      onBackdropPointerDown={() => {
        props.setOpen(false);
      }}
    >
      {props.mode === "files" ? (
        <ProjectFilePicker setOpen={props.setOpen} />
      ) : props.mode === "content" ? (
        <ProjectContentSearchDialog onOpenChange={props.setOpen} />
      ) : (
        <OpenCommandPaletteDialog
          key={props.session}
          openIntent={props.openIntent}
          setOpen={props.setOpen}
          openChildSearch={props.openChildSearch}
          initialContext={props.initialContext}
        />
      )}
    </CommandDialogPopup>
  );
}

function OpenCommandPaletteDialog(props: {
  readonly openIntent: CommandPaletteOpenIntent | null;
  readonly setOpen: (open: boolean) => void;
  readonly openChildSearch: (
    mode: "files" | "content",
    context: CommandPaletteReturnContext,
  ) => void;
  readonly initialContext: CommandPaletteReturnContext | undefined;
}) {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { openChildSearch, setOpen } = props;
  // Keyed by palette session: the intent and restored search only seed this
  // mount, and closing must not change what the closing palette shows.
  const [initialSearch] = useState(
    () =>
      props.initialContext ?? {
        query: props.openIntent?.kind === "search" ? props.openIntent.query : "",
        linkedThreadSearch: props.openIntent?.kind === "search" ? props.openIntent : null,
      },
  );
  const linkedThreadSearch = initialSearch.linkedThreadSearch;
  // Rows were captured when the palette opened; drop any hidden since then.
  const hiddenKeys = useHiddenThreadKeys();
  const linkedEnvironmentId = linkedThreadSearch?.linkedThreads?.environmentId ?? null;
  const hidingAnywhere = useAnyEnvironmentHiding();
  const linkedThreadRefs = useEnvironmentThreadRefs(linkedEnvironmentId);
  const { environments } = useEnvironments();
  const [searchState, dispatchSearch] = useReducer(reduceCommandPaletteSearchState, null, () => {
    const view = props.initialContext ? null : openIntentView(props.openIntent);
    return view
      ? { query: "", views: [{ view, parentQuery: "" }] }
      : createCommandPaletteSearchState(initialSearch.query);
  });
  const { query, views: viewStack } = searchState;
  const setQuery = (query: string) => dispatchSearch({ type: "query", query });
  const deferredQuery = useDeferredValue(query);
  const isActionsOnly = deferredQuery.startsWith(">");
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const resultListRef = useRef<LegendListRef | null>(null);
  // A pushed view drops the typed highlight until the user moves it again.
  const highlightClearedRef = useRef(viewStack.length > 0);
  // Entering or leaving browse mode remounts the input; carry the caret across it.
  const remountSelectionRef = useRef<PendingInputSelection | null>(null);
  function clearTypedHighlight(): void {
    highlightClearedRef.current = true;
    setHighlightedItemValue(null);
  }
  const createProject = useNewProject();
  const folderPicker = useProjectFolderPicker();
  const { scratchEnvironmentId, scratchWorkspaceRootFor, startScratchThread } = useScratchProject();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const loadBrowsePath = useAtomQueryRunner(filesystemEnvironment.browse, {
    reportFailure: false,
    reportDefect: false,
  });
  const stopThreadSession = useAtomCommand(threadEnvironment.stopSession, {
    reportFailure: false,
  });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const availableSettingsSearchItems = useAvailableSettingsSearchItems();
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread } =
    useHandleNewThread();
  const paletteRouteTarget = useThreadRouteTarget();
  const projects = useProjects();
  const referenceThreadRef = activeThread
    ? scopeThreadRef(activeThread.environmentId, activeThread.id)
    : null;
  const activeThreadServerConfig = useServerConfigs().get(
    activeThread?.environmentId ?? ("" as EnvironmentId),
  );
  const activeThreadReferenceCopyTarget =
    referenceThreadRef === null
      ? null
      : resolveThreadReferenceCopyTarget({
          threadRef: referenceThreadRef,
          title: activeThread?.title ?? "",
          pullRequests: activeThread?.pullRequests,
          linkedPullRequestUrl:
            activeThread?.linkedPullRequest?.url ?? activeThread?.branchPullRequest?.url ?? null,
          hostedAppUrl: configuredHostedAppUrl(),
        });
  const copyActiveThreadReference = async () => {
    if (activeThreadReferenceCopyTarget === null) return;
    await copyThreadReference(activeThreadReferenceCopyTarget);
  };
  // Side chats and subagents open inside their parent, so opening a project never lands on one.
  const threads = useVisibleThreadShells().filter((thread) => !isSidebarHiddenThread(thread));
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const providersByEnvironment = useEnvironmentProviders();
  const { changeThemeItem, changeAppearanceItem, themeEditorItem } = useCommandPaletteThemeItems();
  const currentView = viewStack.at(-1)?.view ?? null;
  const threadSearchQuery = currentView === null && !isActionsOnly ? deferredQuery : "";
  const [browseGeneration, setBrowseGeneration] = useState(0);
  const [browseNavigation] = useState(createBrowseNavigationCoordinator);
  const [isPickingProjectFolder, setIsPickingProjectFolder] = useState(false);
  const { environmentLabelById, projectEnvironmentLocationById } = useEnvironmentLookups();
  const projectGroups = useSortedProjectGroups(environmentLabelById);
  const contextualProjectRef = resolveThreadActionProjectRef({
    activeDraftThread,
    activeThread: activeThread ?? undefined,
    defaultProjectRef,
    handleNewThread,
  });
  const projectPickerEntries = buildSidebarProjectPickerEntries({
    groups: pickableProjectGroups(projectGroups),
    preferredProjectRef: contextualProjectRef,
  });
  const pickerProjects = projectPickerEntries.map(({ group, targetProject }) => ({
    ...targetProject,
    displayName: group.displayName,
  }));
  const projectGroupByTargetKey = new Map(
    projectPickerEntries.map(({ group, targetProject }) => [
      `${targetProject.environmentId}:${targetProject.id}`,
      group,
    ]),
  );
  const { canPinProjectGroup, toggleProjectGroupPin } = useProjectPin();
  // A row's target record can change when another machine's copy loads, so the kept
  // order follows the project group instead.
  const rowOrderKey = (prefix: string) => (item: CommandPaletteActionItem) =>
    projectGroupByTargetKey.get(item.value.slice(prefix.length + 1))?.projectKey ?? item.value;
  const projectPin = (project: CommandPaletteProject) => {
    const group = projectGroupByTargetKey.get(`${project.environmentId}:${project.id}`);
    return group && canPinProjectGroup(group)
      ? {
          name: group.displayName,
          pinned: group.pinned,
          toggle: () => toggleProjectGroupPin(group),
        }
      : null;
  };

  // Typing a path browses the first connected machine, this device first.
  const projectMachines = newProjectMachines(environments);
  const browseEnvironmentId = projectMachines[0]?.environmentId ?? null;
  const wslMachine =
    projectMachines.find((machine) => {
      const environment = environments.find(
        (candidate) => candidate.environmentId === machine.environmentId,
      );
      return environment
        ? desktopLocalBackendId(environment.entry.target)?.startsWith("wsl:") === true
        : false;
    }) ?? null;
  const canCreateProject = useEnvironmentScope(browseEnvironmentId, AuthOrchestrationOperateScope);
  const browseEnvironment =
    environments.find((environment) => environment.environmentId === browseEnvironmentId) ?? null;
  const browseEnvironmentPlatform = getEnvironmentBrowsePlatform(
    browseEnvironment?.serverConfig?.environment.platform.os,
  );
  const browsePath = getFilesystemBrowsePath(
    query,
    browseEnvironmentPlatform,
    browseEnvironmentId !== null,
  );
  const isBrowsing = browsePath.isBrowsing;
  const browseDirectoryPath = browsePath.directoryPath;
  const paletteMode = getCommandPaletteMode({ currentView, isBrowsing });

  const { projectByKey } = useProjectLookups();

  const activeThreadKey = activeThread
    ? scopedThreadKey(scopeThreadRef(activeThread.environmentId, activeThread.id))
    : null;
  const supportsThreadFind =
    environments.find((environment) => environment.environmentId === activeThread?.environmentId)
      ?.serverConfig?.threadFind === true;
  const currentProjectEnvironmentId =
    activeThread?.environmentId ?? activeDraftThread?.environmentId ?? null;
  const currentProjectId = activeThread?.projectId ?? activeDraftThread?.projectId ?? null;
  const scratchTargetEnvironmentId = scratchEnvironmentId(currentProjectEnvironmentId);
  // Agents on the chat's machine, else this one's.
  const agentsEnvironmentId = currentProjectEnvironmentId ?? primaryEnvironmentId;
  const { agents: paletteAgents } = useAgents(agentsEnvironmentId);
  const startAgentChat = useStartAgentChat();
  const currentProject = resolveCommandPaletteProject(
    projectByKey,
    currentProjectEnvironmentId,
    currentProjectId,
  );
  const currentProjectCwd = currentProject?.workspaceRoot ?? null;
  // The same test as the reply's own save button, so the two never disagree.
  const savesReplies = useCanSaveReply(
    activeThread?.environmentId ?? null,
    activeThread ? (activeThread.worktreePath ?? currentProjectCwd ?? undefined) : undefined,
  );
  const currentProjectCwdForBrowse =
    browseEnvironmentId && currentProjectEnvironmentId === browseEnvironmentId
      ? currentProjectCwd
      : null;
  const relativePathNeedsActiveProject =
    isExplicitRelativeProjectPath(query.trim()) && currentProjectCwdForBrowse === null;
  const browseAccess = useFilesystemReadAccess(browseEnvironmentId);
  const hasBrowseTarget =
    isBrowsing &&
    browsePath.directoryPath.length > 0 &&
    browseEnvironmentId !== null &&
    !relativePathNeedsActiveProject;
  const browseQuery = useEnvironmentQuery(
    browseAccess.canReadFiles && hasBrowseTarget
      ? filesystemEnvironment.browse({
          environmentId: browseEnvironmentId,
          input: {
            partialPath: browsePath.directoryPath,
            ...(currentProjectCwdForBrowse ? { cwd: currentProjectCwdForBrowse } : {}),
          },
        })
      : null,
  );
  const browseResult = browseQuery.data;
  const isBrowsePending = hasBrowseTarget && (browseAccess.isPending || browseQuery.isPending);
  const browseAccessError =
    hasBrowseTarget && !browseAccess.isPending && !browseAccess.canReadFiles
      ? (browseAccess.error ?? "This connection cannot browse host folders.")
      : null;
  const browseEntries = browseResult?.entries ?? EMPTY_BROWSE_ENTRIES;
  const { visibleEntries: visibleBrowseEntries, exactEntry: exactBrowseEntry } =
    filterFilesystemBrowseEntries(browseEntries, browsePath.filterQuery);

  const prefetchBrowsePath = async (partialPath: string): Promise<void> => {
    if (
      browseEnvironmentId === null ||
      !readEnvironmentScope(browseEnvironmentId, AuthFilesystemReadScope) ||
      !canPreloadBrowsePath(browseEnvironment?.connection.phase)
    ) {
      return;
    }

    await loadBrowsePath({
      environmentId: browseEnvironmentId,
      input: {
        partialPath,
        ...(currentProjectCwdForBrowse ? { cwd: currentProjectCwdForBrowse } : {}),
      },
    });
  };

  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- invalidates the browse navigation coordinator when the palette session unmounts
  useEffect(() => () => browseNavigation.invalidate(), [browseNavigation]);

  const openProjectFromSearch = async (project: (typeof projects)[number]) => {
    const group = projectGroupByTargetKey.get(`${project.environmentId}:${project.id}`);
    const groupedProjectKeys = group
      ? new Set(
          group.memberProjectRefs.map(
            (projectRef) => `${projectRef.environmentId}:${projectRef.projectId}`,
          ),
        )
      : null;
    const latestThread = groupedProjectKeys
      ? (sortThreads(
          threads.filter(
            (thread) =>
              thread.archivedAt === null &&
              groupedProjectKeys.has(`${thread.environmentId}:${thread.projectId}`),
          ),
          "updated_at",
        )[0] ?? null)
      : getLatestThreadForProject(
          threads.filter((thread) => thread.environmentId === project.environmentId),
          project.id,
          "updated_at",
        );
    if (latestThread) {
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(latestThread.environmentId, latestThread.id)),
      });
      return;
    }

    await handleNewThread(scopeProjectRef(project.environmentId, project.id));
  };

  // Pinning from a row keeps rows in place while the palette is open.
  const projectSearchItems = useOrderWhileOpen(
    buildProjectSearchItems({
      projects: pickerProjects,
      projectGroupByTargetKey,
      locationByEnvironmentId: projectEnvironmentLocationById,
      runProject: openProjectFromSearch,
      pin: projectPin,
    }),
    rowOrderKey("project"),
    true,
  );

  const openingOrderThreadItems = useOrderWhileOpen(
    (() => {
      const isScratch = (project: CommandPaletteProject) =>
        isScratchProject(project, scratchWorkspaceRootFor(project.environmentId));
      const currentEntry =
        currentProjectId === null
          ? undefined
          : projectPickerEntries.find((entry) => entry.isPreferred);
      const projectItems = buildNewThreadInProjectItems({
        projects: pickerProjects.filter((project) => !isScratch(project)),
        currentProjectKey: currentEntry
          ? `${currentEntry.targetProject.environmentId}:${currentEntry.targetProject.id}`
          : null,
        projectGroupByTargetKey,
        locationByEnvironmentId: projectEnvironmentLocationById,
        pin: projectPin,
        runProject: async (project) => {
          const group = projectGroupByTargetKey.get(`${project.environmentId}:${project.id}`);
          const contextualRefBelongsToGroup =
            contextualProjectRef !== null &&
            group?.memberProjectRefs.some(
              (projectRef) =>
                projectRef.environmentId === contextualProjectRef.environmentId &&
                projectRef.projectId === contextualProjectRef.projectId,
            );
          await handleNewThread(
            contextualRefBelongsToGroup
              ? contextualProjectRef
              : scopeProjectRef(project.environmentId, project.id),
          );
        },
      });
      if (scratchTargetEnvironmentId === null) return projectItems;

      const noProjectIndex = newThreadNoProjectIndex(
        projectPickerEntries.map(({ group, targetProject, isPreferred }) => ({
          isScratch: isScratchProject(
            targetProject,
            scratchWorkspaceRootFor(targetProject.environmentId),
          ),
          pinned: group.pinned,
          isPreferred,
        })),
      );
      return [
        ...projectItems.slice(0, noProjectIndex),
        {
          kind: "action" as const,
          value: NEW_THREAD_NO_PROJECT_VALUE,
          searchTerms: ["no project", "without project", "none"],
          title: "Personal",
          icon: <MessageSquareDashedIcon className={ITEM_ICON_CLASS} />,
          shortcutCommand: "chat.newWithoutProject" as const,
          run: () => startScratchThread(scratchTargetEnvironmentId),
        },
        ...projectItems.slice(noProjectIndex),
      ];
    })(),
    rowOrderKey("new-thread-in"),
    true,
  );
  // Jump shortcuts follow the rows as shown, so a pin cannot move a number to another row.
  const projectJumpItems = new Map(
    enumerateCommandPaletteItems(
      openingOrderThreadItems.filter((item) => item.value !== NEW_THREAD_NO_PROJECT_VALUE),
    ).map((item) => [item.value, item] as const),
  );
  const projectThreadItems = openingOrderThreadItems.map(
    (item) => projectJumpItems.get(item.value) ?? item,
  );

  const {
    threadItems: allThreadItems,
    threadMessageItems,
    now: searchNow,
    isSearchPending: isThreadSearchPending,
  } = useCommandPaletteThreadItems({ activeThread: activeThread ?? null, threadSearchQuery });
  // Recent means used recently: written in or opened, whichever is later. The
  // open thread would always lead that list, so it is left out.
  const activeThreadValue = activeThread
    ? `thread:${activeThread.environmentId}:${activeThread.id}`
    : null;
  const recentThreadItems = allThreadItems
    .filter((item) => item.value !== activeThreadValue)
    .toSorted(
      (left, right) =>
        (right.threadSearch ? threadRecentUse(right.threadSearch) : 0) -
        (left.threadSearch ? threadRecentUse(left.threadSearch) : 0),
    )
    .slice(0, RECENT_THREAD_LIMIT);

  const pushPaletteView = useStableCallback((view: CommandPaletteView): void => {
    browseNavigation.invalidate();
    dispatchSearch({ type: "push", view });
    highlightClearedRef.current = true;
    setHighlightedItemValue(null);
  });

  function popView(): void {
    browseNavigation.invalidate();
    dispatchSearch({ type: "back" });
    setHighlightedItemValue(null);
  }

  function handleQueryChange(nextQuery: string, source: EventTarget | null): void {
    browseNavigation.invalidate();
    clearTypedHighlight();
    const canBrowsePaths = browseEnvironmentId !== null;
    const resolvedQuery = canBrowsePaths ? resolvePastedPath(query, nextQuery) : nextQuery;
    // A rewritten paste has no matching offsets, so its caret lands at the end.
    if (
      source instanceof HTMLInputElement &&
      resolvedQuery === nextQuery &&
      (canBrowsePaths && isFilesystemBrowseQuery(resolvedQuery, browseEnvironmentPlatform)) !==
        isBrowsing
    ) {
      remountSelectionRef.current = {
        value: resolvedQuery,
        start: source.selectionStart,
        end: source.selectionEnd,
        direction: source.selectionDirection,
      };
    }
    setQuery(resolvedQuery);
    if (nextQuery === "" && currentView?.initialQuery) {
      popView();
    }
  }

  const actionItems: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [];

  if (projects.length > 0) {
    const activeProjectTitle =
      projectPickerEntries.find((entry) => entry.isPreferred)?.group.displayName ??
      currentProject?.title ??
      null;

    if (activeProjectTitle) {
      actionItems.push({
        kind: "action",
        value: "action:new-thread",
        searchTerms: ["new thread", "chat", "create", "draft"],
        title: (
          <>
            New chat in <span className="font-semibold">{activeProjectTitle}</span>
          </>
        ),
        searchTitle: `New chat in ${activeProjectTitle}`,
        icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
        shortcutCommand: "chat.newLocal",
        run: async () => {
          await startNewThreadFromContext({
            activeDraftThread,
            activeThread: activeThread ?? undefined,
            defaultProjectRef,
            handleNewThread,
          });
        },
      });
    }

    actionItems.push({
      kind: "submenu",
      value: "action:new-thread-in",
      searchTerms: ["new thread", "new chat", "project", "workspace", "pick", "choose", "select"],
      title: "New chat in...",
      icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
      addonIcon: <SquarePenIcon className={ADDON_ICON_CLASS} />,
      groups: [{ value: NEW_THREAD_IN_GROUP, label: "Workspaces", items: projectThreadItems }],
    });
  }

  if (scratchTargetEnvironmentId !== null) {
    actionItems.push({
      kind: "action",
      value: "action:new-thread-without-project",
      searchTerms: ["new thread", "no project", "without project", "none", "chat"],
      title: "New chat in Personal",
      icon: <MessageSquareDashedIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "chat.newWithoutProject",
      run: () => startScratchThread(scratchTargetEnvironmentId),
    });
  }

  if (activeThread && savesReplies) {
    const replyThreadRef = scopeThreadRef(activeThread.environmentId, activeThread.id);
    actionItems.push({
      kind: "action",
      value: "action:save-reply-as-file",
      title: "Save last reply as file",
      searchTerms: ["save", "reply", "export", "markdown", "pdf", "spreadsheet", "xlsx", "file"],
      icon: <FileDownIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        const reply = latestReplyText(replyThreadRef);
        if (reply === null) {
          toastManager.add({ type: "info", title: "This chat has no reply to save yet" });
          return;
        }
        useSaveReplyStore.getState().open(replyThreadRef, reply);
      },
    });
  }

  if (activeThreadKey !== null && supportsThreadFind) {
    actionItems.push({
      kind: "action",
      value: "find-current-thread",
      title: "Find in current chat",
      searchTerms: ["find", "search", "messages", "plans"],
      icon: <TextSearchIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "chat.find",
      run: async () => {
        openThreadFind(activeThreadKey);
      },
    });
  }

  const promptLinkTarget = paletteRouteTarget
    ? paletteRouteTarget.kind === "server"
      ? paletteRouteTarget.threadRef
      : paletteRouteTarget.draftId
    : null;
  const promptLinkProjectRef = activeThread ?? activeDraftThread;
  const promptLinkInput =
    promptLinkTarget === null
      ? null
      : {
          target: promptLinkTarget,
          project: projects.find(
            (project) =>
              project.environmentId === promptLinkProjectRef?.environmentId &&
              project.id === promptLinkProjectRef.projectId,
          ),
          providers:
            (promptLinkProjectRef
              ? providersByEnvironment.get(promptLinkProjectRef.environmentId)
              : undefined) ?? [],
          threadModelSelection: activeThread?.modelSelection ?? null,
        };
  const plainPromptLink = promptLinkInput
    ? composerPromptLink({ ...promptLinkInput, withContext: false })
    : null;
  if (promptLinkInput !== null && plainPromptLink !== null) {
    actionItems.push({
      kind: "action",
      value: "action:copy-prompt-link",
      searchTerms: ["copy", "share", "prompt", "link"],
      title: "Copy prompt link",
      icon: <LinkIcon className={ITEM_ICON_CLASS} />,
      run: () => copyPromptLink(plainPromptLink),
    });
    if (promptLinkRepositoryOf(promptLinkInput.project) !== null) {
      const contextLink = composerPromptLink({ ...promptLinkInput, withContext: true });
      if (contextLink !== null) {
        actionItems.push({
          kind: "action",
          value: "action:copy-prompt-link-with-context",
          searchTerms: ["copy", "share", "prompt", "link", "repository", "model"],
          title: "Copy prompt link with repo and model",
          icon: <LinkIcon className={ITEM_ICON_CLASS} />,
          run: () => copyPromptLink(contextLink),
        });
      }
    }
  }

  if (activeThreadReferenceCopyTarget !== null) {
    actionItems.push({
      kind: "action",
      value: "action:copy-thread-reference",
      searchTerms:
        activeThreadReferenceCopyTarget.kind === "pull-request"
          ? ["copy", "pull request", "link", "reference"]
          : ["copy", "chat", "link", "thread", "thread id", "reference"],
      title:
        activeThreadReferenceCopyTarget.kind === "pull-request" ? "Copy PR link" : "Copy chat link",
      description: activeThreadReferenceCopyTarget.description,
      icon: <LinkIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "thread.copyReference",
      run: copyActiveThreadReference,
    });
  }

  if (
    activeThread !== null &&
    projectPreset(
      projectByKey.get(`${activeThread.environmentId}:${activeThread.projectId}`),
      activeThread.worktreePath,
    ).composerControls.gitActions &&
    threadPullRequestLinkMode(activeThreadServerConfig?.environment.capabilities) !== "unsupported"
  ) {
    const threadRef = scopeThreadRef(activeThread.environmentId, activeThread.id);
    actionItems.push({
      kind: "action",
      value: "action:link-pull-request",
      searchTerms: ["link", "pull request", "pr", "attach", "stack"],
      title: "Link pull request to chat",
      icon: <PullRequestGlyph.link className={ITEM_ICON_CLASS} />,
      run: async () => {
        openLinkPullRequestDialog(threadRef);
      },
    });
  }

  if (activeThread !== null) {
    const thread = activeThread;
    actionItems.push({
      kind: "action",
      value: "action:restart-agent-session",
      searchTerms: ["restart", "reset", "reload", "agent", "session", "skills", "plugins", "mcp"],
      title: "Restart agent session",
      icon: <RotateCcwIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        const { environmentId } = thread;
        if (thread.runtime !== null) {
          const stopped = await stopThreadSession({
            environmentId,
            input: { threadId: thread.id },
          });
          if (stopped._tag === "Failure") throw squashAtomCommandFailure(stopped);
        }
        toastManager.add({
          type: "success",
          title: "Agent session will restart",
          description: "Your next message starts a fresh session.",
        });
        const project = projectByKey.get(`${environmentId}:${thread.projectId}`);
        if (!project) return;
        const refreshed = await refreshProviders({
          environmentId,
          input: {
            instanceId: thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId,
            cwd: thread.worktreePath ?? project.workspaceRoot,
            fresh: true,
          },
        });
        if (refreshed._tag === "Failure") throw squashAtomCommandFailure(refreshed);
      },
    });
  }

  actionItems.push({
    kind: "action",
    value: "action:open-file-picker",
    searchTerms: ["go to file", "open file", "file picker", "find file", "quick open"],
    title: "Go to file",
    icon: <FileSearchIcon className={ITEM_ICON_CLASS} />,
    keepOpen: true,
    shortcutCommand: "filePicker.toggle",
    run: async () => {
      openChildSearch("files", { query, linkedThreadSearch });
    },
  });

  actionItems.push({
    kind: "action",
    value: "action:search-project-contents",
    searchTerms: ["search project", "find in files", "grep", "content search", "text search"],
    title: "Search workspace contents",
    icon: <TextSearchIcon className={ITEM_ICON_CLASS} />,
    keepOpen: true,
    shortcutCommand: "projectSearch.toggle",
    run: async () => {
      openChildSearch("content", { query, linkedThreadSearch });
    },
  });

  actionItems.push({
    kind: "action",
    value: "action:new-project",
    searchTerms: [
      "new workspace",
      "new project",
      "create project",
      "empty",
      "repository",
      "repo",
      "git init",
    ],
    title: "New workspace",
    icon: <FolderGit2Icon className={ITEM_ICON_CLASS} />,
    run: async () => {
      openNewProjectDialog();
    },
  });

  const addProjectAction: CommandPaletteActionItem = {
    kind: "action",
    value: "action:add-project",
    searchTerms: [
      "add workspace",
      "folder",
      "directory",
      "browse",
      "clone",
      "remote",
      "repository",
      "repo",
      "git",
      ...sourceControlClients.definitions.flatMap((definition) =>
        definition.pickerLabel
          .toLowerCase()
          .split(/[^a-z0-9]+/u)
          .filter(Boolean),
      ),
      "url",
      "environment",
    ],
    title: "Add existing workspace",
    icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      openNewProjectDialog({ source: "folder" });
    },
  };
  actionItems.push(addProjectAction);

  if (wslMachine) {
    actionItems.push({
      kind: "action",
      value: "action:add-project:wsl-folder",
      searchTerms: ["add project", "open", "wsl", "linux", "folder", "directory"],
      title: "Open WSL folder",
      description: wslMachine.label,
      icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        openNewProjectDialog({ environmentId: wslMachine.environmentId, source: "folder" });
      },
    });
  }

  actionItems.push(changeThemeItem);
  actionItems.push(changeAppearanceItem);

  actionItems.push(themeEditorItem);

  actionItems.push({
    kind: "action",
    value: "action:use-in-another-app",
    searchTerms: [
      "mcp",
      "connector",
      "another app",
      "poke",
      "claude",
      "claude code",
      "codex",
      "chatgpt",
      "grok",
      "muse",
      "instinct",
      "openclaw",
      "hermes",
    ],
    title: "Use Codenine in another app (MCP)",
    icon: <PlugIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      openUseInAnotherApp(
        currentProjectEnvironmentId ??
          (paletteRouteTarget?.kind === "server"
            ? paletteRouteTarget.threadRef.environmentId
            : null),
      );
    },
  });

  actionItems.push({
    kind: "action",
    value: "action:usage",
    searchTerms: ["usage", "use", "tokens", "cost", "spend", "limits", "stats", "analytics"],
    title: "Open usage",
    icon: <ChartNoAxesColumnIcon className={ITEM_ICON_CLASS} />,
    shortcutCommand: "usage.open",
    run: async () => {
      await navigate({ to: "/usage" });
    },
  });

  for (const direction of [1, -1] as const) {
    const title = direction === 1 ? "Focus Next Workspace Area" : "Focus Previous Workspace Area";
    actionItems.push({
      kind: "action",
      value: `action:workspace-focus:${direction}`,
      title,
      searchTerms: [title, "accessibility", "navigation", "focus", "F6"],
      icon: <MonitorIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: direction === 1 ? "workspace.focusNext" : "workspace.focusPrevious",
      run: async () => {
        queueWorkspaceFocusFromPalette(direction);
      },
    });
  }

  actionItems.push({
    kind: "action",
    value: "action:settings",
    searchTerms: ["settings", "preferences", "configuration", "keybindings"],
    title: "Open settings",
    icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({ to: "/settings" });
    },
  });

  actionItems.push({
    kind: "action",
    value: "action:backup",
    searchTerms: ["backup", "back up", "restore", "recover", "move computer", "migrate"],
    title: "Back up or restore",
    icon: <DatabaseBackupIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({ to: "/settings/backup" });
    },
  });

  actionItems.push({
    kind: "action",
    value: "action:archive",
    searchTerms: [
      "archived chats",
      "archive",
      "unarchive",
      "restore",
      "delete archived",
      "threads",
    ],
    title: "Open archived chats",
    icon: <ArchiveIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({ to: "/archive", search: { show: "archived" } });
    },
  });

  // Build pages open on the chat's machine and workspace when there is one.
  const buildPageSearch = {
    machine: currentProjectEnvironmentId ?? undefined,
    workspace: currentProjectId ?? undefined,
  };
  actionItems.push({
    kind: "action",
    value: "action:connectors",
    searchTerms: ["connectors", "connect", "mcp", "gmail", "slack", "github", "sign in", "apps"],
    title: "Open connectors",
    icon: <PlugIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({ to: "/connectors", search: { machine: buildPageSearch.machine } });
    },
  });
  actionItems.push({
    kind: "action",
    value: "action:skills",
    searchTerms: ["skills", "skill", "instructions", "know-how", "library", "import"],
    title: "Open skills",
    icon: <SparklesIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({ to: "/skills", search: buildPageSearch });
    },
  });
  actionItems.push({
    kind: "action",
    value: "action:new-skill",
    searchTerms: ["new skill", "create skill", "write skill", "add skill"],
    title: "New skill",
    icon: <SparklesIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({ to: "/skills/new", search: buildPageSearch });
    },
  });
  actionItems.push({
    kind: "action",
    value: "action:agents",
    searchTerms: ["agents", "agent", "specialist", "assistant", "persona"],
    title: "Open agents",
    icon: <BotIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({ to: "/agents", search: buildPageSearch });
    },
  });
  actionItems.push({
    kind: "action",
    value: "action:new-agent",
    searchTerms: ["new agent", "create agent", "make agent", "add agent"],
    title: "New agent",
    icon: <BotIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({ to: "/agents/new", search: buildPageSearch });
    },
  });
  const agentChatWorkspace =
    projects.find(
      (project) =>
        project.environmentId === agentsEnvironmentId &&
        project.id === currentProjectId &&
        project.archivedAt == null,
    ) ?? null;
  for (const agent of paletteAgents) {
    if (agentsEnvironmentId === null || agentModelProblem(agent.modelStatus) !== null) continue;
    actionItems.push({
      kind: "action",
      value: `action:agent-chat:${agent.name}`,
      searchTerms: ["chat with", "agent", agent.title, agent.description],
      title: `Chat with ${agent.title}`,
      description: agent.description,
      icon: <BotIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await startAgentChat({
          environmentId: agentsEnvironmentId,
          agent,
          workspace: agentChatWorkspace,
        });
      },
    });
  }

  // Every group, so an archived project's thread still opens its own settings.
  const currentProjectGroup =
    (contextualProjectRef
      ? projectGroups.find((group) =>
          group.memberProjectRefs.some(
            (ref) =>
              ref.environmentId === contextualProjectRef.environmentId &&
              ref.projectId === contextualProjectRef.projectId,
          ),
        )
      : null) ?? null;
  if (currentProjectGroup && canPinProjectGroup(currentProjectGroup)) {
    actionItems.push({
      kind: "action",
      value: "action:project-pin",
      searchTerms: ["pin", "unpin", "project", "favorite"],
      title: currentProjectGroup.pinned ? "Unpin workspace" : "Pin workspace",
      description: currentProjectGroup.displayName,
      icon: currentProjectGroup.pinned ? (
        <PinOffIcon className={ITEM_ICON_CLASS} />
      ) : (
        <PinIcon className={ITEM_ICON_CLASS} />
      ),
      run: async () => toggleProjectGroupPin(currentProjectGroup),
    });
  }
  const contextualProjectGroup = currentProjectGroup ?? projectGroups[0] ?? null;
  if (contextualProjectGroup) {
    actionItems.push({
      kind: "action",
      value: "action:project-settings",
      searchTerms: [
        "project",
        "settings",
        "name",
        "icon",
        "scripts",
        "model",
        "workspace",
        "grouping",
        "checkout",
        "remove",
        "codenine.json",
      ],
      title: "Workspace settings",
      description: contextualProjectGroup.displayName,
      icon: <FolderIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate({
          to: "/projects/$projectKey",
          params: { projectKey: contextualProjectGroup.projectKey },
        });
      },
    });
  }

  const rootGroups = buildRootGroups({ actionItems, recentThreadItems });
  // Every setting goes to the palette's own matcher, so settings get the same
  // word starts and typo tolerance as threads.
  const settingsSearchItems: CommandPaletteActionItem[] = settingsForThisPlatform(
    availableSettingsSearchItems,
  ).map((item) => ({
    kind: "action",
    value: `setting:${item.id}`,
    searchTerms: [item.title, SETTINGS_SECTION_LABELS[item.to], ...(item.searchTerms ?? [])],
    title: item.title,
    description: `Settings · ${SETTINGS_SECTION_LABELS[item.to]}`,
    ...(item.secondary ? { secondary: true } : {}),
    icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({
        to: item.to,
        hash: item.targetId ?? item.id,
        replace: pathname === item.to,
        hashScrollIntoView: false,
      });
    },
  }));
  const activeGroups =
    currentView?.groups[0]?.value === NEW_THREAD_IN_GROUP
      ? [
          {
            value: NEW_THREAD_IN_GROUP,
            label: "Workspaces",
            // Every project archived and no "No project" home leaves only adding one.
            items: projectThreadItems.length > 0 ? projectThreadItems : [addProjectAction],
          },
        ]
      : currentView?.groups[0]?.value === "themes"
        ? changeThemeItem.groups
        : currentView?.groups[0]?.value === "appearance"
          ? changeAppearanceItem.groups
          : (currentView?.groups ?? rootGroups);

  const isLinkedThreadSearch =
    linkedThreadSearch?.linkedThreads !== undefined && deferredQuery === linkedThreadSearch.query;
  const filteredGroups = filterCommandPaletteGroups({
    activeGroups,
    query: deferredQuery,
    isInSubmenu: currentView !== null,
    ...(deferredQuery.trim().length > 0
      ? {
          allOptions: {
            rootGroups,
            nestedItems: buildNestedSearchItems(actionItems, deferredQuery),
          },
        }
      : {}),
    projectSearchItems: projectSearchItems,
    settingsSearchItems,
    threadSearchItems:
      isLinkedThreadSearch && linkedThreadSearch?.linkedThreads
        ? buildLinkedThreadActionItems({
            ...linkedThreadSearch.linkedThreads,
            threads: visibleLinkedThreads(
              linkedThreadSearch.linkedThreads.threads,
              linkedThreadSearch.linkedThreads.environmentId,
              linkedThreadRefs,
              hiddenKeys,
              hidingAnywhere,
            ),
            query: linkedThreadSearch.query,
            icon: <MessageSquareIcon className={ITEM_ICON_CLASS} />,
            runThread: async (thread) => {
              await navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
              });
            },
          })
        : allThreadItems,
    threadMessageItems: isLinkedThreadSearch ? [] : threadMessageItems,
    now: searchNow,
  });

  const handleAddProjectForEnvironment = async (input: {
    readonly environmentId: EnvironmentId;
    readonly rawCwd: string;
    readonly platform: string;
    readonly currentProjectCwd: string | null;
  }) => {
    const environment = environments.find(
      (candidate) => candidate.environmentId === input.environmentId,
    );
    if (!canCreateProjectInEnvironment(environment?.connection.phase)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Environment unavailable",
          description: `${environment?.label ?? "The selected environment"} is not connected.`,
        }),
      );
      return;
    }
    const rawCwd = input.rawCwd;

    if (isUnsupportedWindowsProjectPath(rawCwd.trim(), input.platform)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to add workspace",
          description: "Windows-style paths are only supported on Windows.",
        }),
      );
      return;
    }

    if (isExplicitRelativeProjectPath(rawCwd.trim()) && !input.currentProjectCwd) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to add workspace",
          description: "Relative paths require an active workspace.",
        }),
      );
      return;
    }

    const cwd = resolveProjectPathForDispatch(rawCwd, input.currentProjectCwd);
    if (cwd.length === 0) return;

    const result = await createProject({
      kind: "folder",
      environmentId: input.environmentId,
      title: inferProjectTitleFromPath(cwd),
      workspaceRoot: cwd,
      workspaceKind: "code",
      projectIcon: null,
      defaultModelSelection: null,
    });
    if (result.ok) {
      setOpen(false);
    } else if (result.message !== null) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to add workspace",
          description: result.message,
        }),
      );
    }
  };

  const handleAddProject = async (rawCwd: string) => {
    if (!browseEnvironmentId) return;
    await handleAddProjectForEnvironment({
      environmentId: browseEnvironmentId,
      rawCwd,
      platform: browseEnvironmentPlatform,
      currentProjectCwd: currentProjectCwdForBrowse,
    });
  };

  const browseTo = async (name: string): Promise<void> => {
    const nextQuery = appendBrowsePathSegment(query, name);
    await browseNavigation.run(
      () => prefetchBrowsePath(getBrowseDirectoryPath(nextQuery)),
      () => {
        setHighlightedItemValue(null);
        setQuery(nextQuery);
        setBrowseGeneration((generation) => generation + 1);
      },
    );
  };

  const browseUp = async (): Promise<void> => {
    const parentPath = browsePath.parentPath;
    if (parentPath === null) {
      return;
    }

    await browseNavigation.run(
      () => prefetchBrowsePath(parentPath),
      () => {
        setHighlightedItemValue(null);
        setQuery(parentPath);
        setBrowseGeneration((generation) => generation + 1);
      },
    );
  };

  const resolvedAddProjectPath = hasTrailingPathSeparator(query)
    ? (browseResult?.parentPath ?? query.trim())
    : (exactBrowseEntry?.fullPath ?? query.trim());

  const canBrowseUp = !relativePathNeedsActiveProject && browsePath.canBrowseUp;

  const browseGroups = buildBrowseGroups({
    browseEntries: visibleBrowseEntries,
    browseQuery: query,
    canBrowseUp,
    upIcon: <CornerLeftUpIcon className={ITEM_ICON_CLASS} />,
    directoryIcon: <FolderIcon className={ITEM_ICON_CLASS} />,
    browseUp,
    browseTo,
  });
  const displayedGroups: CommandPaletteView["groups"] = isBrowsing
    ? relativePathNeedsActiveProject
      ? []
      : browseGroups
    : filteredGroups;
  const resultRows = buildCommandPaletteRows(displayedGroups);
  const autoHighlightsFirstRow = !isBrowsing;

  const inputPlaceholder = getCommandPaletteInputPlaceholder(paletteMode);
  const isSubmenu = paletteMode === "submenu" || paletteMode === "submenu-browse";
  const hasHighlightedBrowseItem = highlightedItemValue?.startsWith("browse:") ?? false;
  const canSubmitBrowsePath =
    isBrowsing &&
    !relativePathNeedsActiveProject &&
    canCreateProject &&
    canCreateProjectInEnvironment(browseEnvironment?.connection.phase);
  const willCreateProjectPath =
    canSubmitBrowsePath &&
    !isBrowsePending &&
    browseAccessError === null &&
    query.trim().length > 0 &&
    !hasHighlightedBrowseItem &&
    (hasTrailingPathSeparator(query) ? !browseResult : exactBrowseEntry === null);
  const useMetaForMod = isMacPlatform(navigator.platform);
  const submitModifierLabel = useMetaForMod ? "\u2318" : "Ctrl";
  const submitActionLabel = willCreateProjectPath ? "Create & Add" : "Add";
  const addShortcutLabel = hasHighlightedBrowseItem ? `${submitModifierLabel} Enter` : "Enter";
  const fileManagerName = getLocalFileManagerName(navigator.platform);
  const canOpenProjectFromFileManager =
    isBrowsing && folderPicker.canPickFolder(browseEnvironmentId);
  const fileManagerInitialPath = (() => {
    if (!canOpenProjectFromFileManager) {
      return undefined;
    }

    const trimmedQuery = query.trim();
    if (trimmedQuery.length === 0) {
      return undefined;
    }

    const initialPath = hasTrailingPathSeparator(query)
      ? (browseResult?.parentPath ?? trimmedQuery)
      : browseDirectoryPath || trimmedQuery;

    const resolvedPath = resolveProjectPathForDispatch(initialPath, currentProjectCwdForBrowse);
    return resolvedPath.length > 0 ? resolvedPath : undefined;
  })();

  function isPrimaryModifierPressed(event: KeyboardEvent<HTMLInputElement>): boolean {
    return useMetaForMod ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Enter" && (event.nativeEvent.isComposing || event.keyCode === 229)) {
      // Confirming an IME candidate must not submit a path or select a row.
      (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
      return;
    }

    const command = resolveShortcutCommand(event, keybindings, {
      platform: navigator.platform,
      context: { modelPickerOpen: false, editableFocus: true },
    });
    if (command === "thread.pin") {
      const highlightedItem = findHighlightedCommandPaletteItem(
        displayedGroups,
        highlightedItemValue ??
          (autoHighlightsFirstRow ? (resultRows.itemValues[0] ?? null) : null),
      );
      if (highlightedItem?.kind === "action" && highlightedItem.pin) {
        event.preventDefault();
        event.stopPropagation();
        highlightedItem.pin.toggle();
        return;
      }
    }
    // Global new-thread handlers ignore shortcuts while the palette is open.
    const isJump = threadJumpIndexFromCommand(command ?? "") !== null;
    const isNewThread =
      !event.nativeEvent.isComposing &&
      event.keyCode !== 229 &&
      (command === "chat.new" ||
        command === "chat.newLocal" ||
        command === "chat.newWithoutProject");
    const matchingItem =
      isJump || isNewThread
        ? displayedGroups
            .flatMap((group) => group.items)
            .find((item) => item.shortcutCommand === command)
        : undefined;
    if (isJump || matchingItem) {
      (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
      event.preventDefault();
      event.stopPropagation();
      if (matchingItem) {
        executeItem(matchingItem);
      }
      return;
    }
    if (command === "thread.copyReference") {
      event.preventDefault();
      event.stopPropagation();
      if (activeThreadReferenceCopyTarget === null) return;
      setOpen(false);
      void copyActiveThreadReference();
      return;
    }
    // ChatView ignores shortcuts while the palette is open, so intercept find here.
    if (command === "chat.find" && activeThreadKey !== null && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      if (supportsThreadFind) openThreadFind(activeThreadKey);
      else
        toastManager.add({
          id: "thread-find-unavailable",
          title: "Chat search is unavailable on this environment.",
          description: "Update the server to enable it.",
        });
      return;
    }

    const shouldSubmitBrowsePath =
      canSubmitBrowsePath &&
      event.key === "Enter" &&
      (!hasHighlightedBrowseItem || isPrimaryModifierPressed(event));

    if (shouldSubmitBrowsePath) {
      event.preventDefault();
      void handleAddProject(resolvedAddProjectPath);
      return;
    }

    if (event.key === "Backspace" && query === "" && isSubmenu) {
      event.preventDefault();
      popView();
      return;
    }

    if (event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return;

    if (event.key === "Tab" && isBrowsing && !relativePathNeedsActiveProject) {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
      event.preventDefault();
      if (highlightedItemValue === "browse:up") {
        void browseUp();
        return;
      }
      const highlightedEntry = visibleBrowseEntries.find(
        (entry) => `browse:${entry.fullPath}` === highlightedItemValue,
      );
      const completion = highlightedEntry
        ? { name: highlightedEntry.name, isComplete: true }
        : getFilesystemBrowseTabCompletion(visibleBrowseEntries, browsePath.filterQuery);
      if (completion?.isComplete) {
        void browseTo(completion.name);
      } else if (completion) {
        setHighlightedItemValue(null);
        setQuery(`${getBrowseDirectoryPath(query)}${completion.name}`);
      }
      return;
    }

    const firstItemValue = autoHighlightsFirstRow ? resultRows.itemValues[0] : undefined;
    if (
      event.key === "ArrowDown" &&
      highlightClearedRef.current &&
      firstItemValue &&
      !event.nativeEvent.isComposing
    ) {
      (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
      event.preventDefault();
      highlightClearedRef.current = false;
      setHighlightedItemValue(firstItemValue);
      scrollCommandPaletteRowIntoView(
        resultListRef.current,
        resultRows.rowIndexByItemIndex[0] ?? 0,
      );
      return;
    }

    // Virtualization may unmount the highlighted row; handle Enter directly instead of Base UI's click.
    if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) {
      const highlightedItem = findHighlightedCommandPaletteItem(
        displayedGroups,
        highlightedItemValue ?? firstItemValue ?? null,
      );
      if (highlightedItem) {
        (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
        event.preventDefault();
        event.stopPropagation();
        executeItem(highlightedItem);
      }
    }
  }

  function executeItem(item: CommandPaletteActionItem | CommandPaletteSubmenuItem): void {
    if (item.disabled) {
      return;
    }

    if (item.kind === "submenu") {
      pushPaletteView(item);
      return;
    }

    if (!item.keepOpen) {
      setOpen(false);
    }

    void item.run().catch((error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to run command",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        }),
      );
    });
  }

  const handleOpenProjectFromFileManager = async () => {
    if (!canOpenProjectFromFileManager || isPickingProjectFolder || browseEnvironmentId === null) {
      return;
    }
    setIsPickingProjectFolder(true);
    const picked = await folderPicker.pickFolder({
      environmentId: browseEnvironmentId,
      platform: browseEnvironmentPlatform,
      initialPath: fileManagerInitialPath,
    });
    setIsPickingProjectFolder(false);
    if (picked.kind === "failed") {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not add WSL workspace",
          description: picked.message,
        }),
      );
      return;
    }
    if (picked.kind === "cancelled") return;
    await handleAddProjectForEnvironment({
      environmentId: picked.environmentId,
      rawCwd: picked.path,
      platform: picked.platform,
      currentProjectCwd:
        picked.environmentId === browseEnvironmentId ? currentProjectCwdForBrowse : null,
    });
  };

  const inputAccessory = isBrowsing ? (
    <CommandPaletteSubmitButton
      label={submitActionLabel}
      shortcutLabel={addShortcutLabel}
      ariaLabel={`${submitActionLabel} (${addShortcutLabel})`}
      tooltip={
        canCreateProject
          ? `${submitActionLabel} (${addShortcutLabel})`
          : "This connection cannot add workspaces."
      }
      disabled={
        !canCreateProject ||
        !canCreateProjectInEnvironment(browseEnvironment?.connection.phase) ||
        relativePathNeedsActiveProject
      }
      onSubmit={() => {
        if (relativePathNeedsActiveProject) {
          return;
        }
        void handleAddProject(resolvedAddProjectPath);
      }}
    />
  ) : null;

  const footerActionLabel = !canSubmitBrowsePath || hasHighlightedBrowseItem ? "Select" : undefined;

  const footerTrailing = canOpenProjectFromFileManager ? (
    <CommandFooterAction
      disabled={isPickingProjectFolder}
      onClick={() => {
        void handleOpenProjectFromFileManager();
      }}
    >
      {`Open in ${fileManagerName}`}
    </CommandFooterAction>
  ) : isThreadSearchPending && !isLinkedThreadSearch && !isBrowsing ? (
    // In the footer, so the list keeps its height while message results may
    // still arrive below it.
    <span className="text-muted-foreground text-xs">Searching messages…</span>
  ) : null;

  return (
    <CommandPaletteContent
      key={`${viewStack.length}-${browseGeneration}-${isBrowsing}`}
      aria-label="Command palette"
      autoHighlight={autoHighlightsFirstRow ? "always" : false}
      footerActionLabel={footerActionLabel}
      footerTrailing={footerTrailing}
      inputAccessory={inputAccessory}
      inputProps={{
        className: isBrowsing
          ? browseInputEndPaddingClass({
              willCreateProjectPath,
              hasHighlightedBrowseItem,
            })
          : undefined,
        placeholder: inputPlaceholder,
        ...(isSubmenu
          ? {
              startAddon: (
                <button
                  type="button"
                  className="flex cursor-pointer items-center"
                  aria-label="Back"
                  onClick={popView}
                >
                  <ArrowLeftIcon />
                </button>
              ),
            }
          : isBrowsing
            ? { startAddon: <FolderPlusIcon /> }
            : {}),
        onKeyDown: handleKeyDown,
      }}
      mode="none"
      items={resultRows.itemValues}
      virtualized
      onItemHighlighted={(value, eventDetails) => {
        if (eventDetails.reason === "none" && highlightClearedRef.current) return;
        highlightClearedRef.current = false;
        setHighlightedItemValue(typeof value === "string" ? value : null);
        const rowIndex = resultRows.rowIndexByItemIndex[eventDetails.index];
        if (eventDetails.reason === "keyboard" && rowIndex !== undefined) {
          scrollCommandPaletteRowIntoView(resultListRef.current, rowIndex);
        }
      }}
      onValueChange={(nextQuery, { event }) => handleQueryChange(nextQuery, event.target)}
      pendingSelectionRef={remountSelectionRef}
      showBackHint={isSubmenu}
      value={query}
    >
      {browseAccessError ? (
        <div role="alert" className="px-4 py-3 text-sm text-muted-foreground">
          {browseAccessError}
        </div>
      ) : isBrowsePending && browseResult === null ? (
        <div role="status" className="px-4 py-3 text-sm text-muted-foreground">
          Loading folders...
        </div>
      ) : null}
      <CommandPaletteVirtualizedResults
        rows={resultRows.rows}
        listRef={resultListRef}
        highlightedItemValue={highlightedItemValue}
        isActionsOnly={isActionsOnly}
        keybindings={keybindings}
        onExecuteItem={executeItem}
        {...(relativePathNeedsActiveProject
          ? { emptyStateMessage: "Relative paths require an active workspace." }
          : willCreateProjectPath
            ? { emptyStateMessage: "Press Enter to create this folder and add it as a workspace." }
            : isThreadSearchPending
              ? { emptyStateMessage: "Searching chat messages…" }
              : {})}
      />
    </CommandPaletteContent>
  );
}
