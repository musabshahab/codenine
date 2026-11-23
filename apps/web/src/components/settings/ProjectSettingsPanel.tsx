import { useComposerMenuState } from "../chat/useComposerMenuState";
import { AuthOrchestrationOperateScope } from "@codenine/contracts";
import { useEnvironmentsWithScope } from "../../state/session";
import { type EnvironmentId, type SidebarProjectGroupingMode } from "@codenine/contracts";
import { useProjectGroupUpdate, type ProjectGroupUpdate } from "../../hooks/useProjectGroupUpdate";
import { useProjectRemoval } from "../../hooks/useProjectRemoval";
import { Link, Navigate, useLocation, useNavigate } from "@tanstack/react-router";
import { Trash2Icon } from "lucide-react";
import { Fragment, lazy, Suspense, useRef, useState, type ReactNode } from "react";

import { persistClientSettingsUpdate, useClientSettings } from "../../hooks/useSettings";
import { derivePhysicalProjectKey } from "@codenine/client-runtime/state/project-grouping";
import {
  PROJECT_GROUPING_MODE_LABELS,
  withProjectGroupingOverride,
  type SidebarProjectGroupMember,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button, InlineButton } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import {
  canPickExternalProjectFavicon,
  ProjectFaviconPickerDialog,
} from "./ProjectFaviconPickerDialog";
import { ProjectActionsSettings } from "./ProjectActionsSettings";
import { ProjectDefaultsSettings } from "./ProjectDefaultsSettings";
import {
  defaultProjectIcon,
  hasDefaultProjectIcon,
  isPersonalWorkspace,
  projectGroupKind,
  projectGroupTitleNeedsUpdate,
} from "./ProjectSettingsPanel.logic";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";
import { isWorkspaceKind, WORKSPACE_KIND_OPTIONS, workspaceKindOption } from "../../workspaceKind";
import {
  SETTINGS_NAV_GROUPS,
  SETTINGS_SECTION_LABELS,
  SETTINGS_WORKSPACE_SCOPE_PATHS,
} from "./settingsSearch";
import { settingsScopeEnvironmentLabels } from "./settingsScopeAxis";

const WORKSPACE_OVERRIDE_PAGES = SETTINGS_NAV_GROUPS.flatMap((group) => group.paths).filter(
  (path) => path !== "/settings/projects" && SETTINGS_WORKSPACE_SCOPE_PATHS.has(path),
);

const ProjectIconPickerDialog = lazy(() =>
  import("./ProjectIconPickerDialog").then((module) => ({
    default: module.ProjectIconPickerDialog,
  })),
);

function isGroupingSelection(value: unknown): value is SidebarProjectGroupingMode | "inherit" {
  return (
    value === "inherit" ||
    value === "repository" ||
    value === "repository_path" ||
    value === "separate"
  );
}

// Grouping overrides are client settings, so they stay editable without project write access.
function CheckoutGroupingSelect({ member }: { member: SidebarProjectGroupMember }) {
  const overrideKey = derivePhysicalProjectKey(member);
  const globalMode = useClientSettings((settings) => settings.sidebarProjectGroupingMode);
  const selection = useClientSettings(
    (settings) => settings.sidebarProjectGroupingOverrides?.[overrideKey] ?? "inherit",
  );
  return (
    <Select
      value={selection}
      onValueChange={(value) => {
        if (!isGroupingSelection(value)) return;
        persistClientSettingsUpdate((current) => ({
          ...current,
          sidebarProjectGroupingOverrides: withProjectGroupingOverride(
            current.sidebarProjectGroupingOverrides,
            overrideKey,
            value,
          ),
        })).catch((error) => {
          console.error("Failed to save checkout grouping rule", error);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not save grouping rule",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        });
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label={`Grouping rule for ${member.workspaceRoot} on ${
          member.environmentLabel
            ? `${member.environmentLabel} (${member.environmentId})`
            : member.environmentId
        }`}
      >
        <SelectValue>
          {selection === "inherit"
            ? `Default (${PROJECT_GROUPING_MODE_LABELS[globalMode]})`
            : PROJECT_GROUPING_MODE_LABELS[selection]}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        <SelectItem hideIndicator value="inherit">
          Use global default
        </SelectItem>
        <SelectItem hideIndicator value="repository">
          {PROJECT_GROUPING_MODE_LABELS.repository}
        </SelectItem>
        <SelectItem hideIndicator value="repository_path">
          {PROJECT_GROUPING_MODE_LABELS.repository_path}
        </SelectItem>
        <SelectItem hideIndicator value="separate">
          {PROJECT_GROUPING_MODE_LABELS.separate}
        </SelectItem>
      </SelectPopup>
    </Select>
  );
}

export type ProjectSettingsCategory = "general" | "source-control" | "project";

interface ProjectSelection {
  readonly key: string;
  readonly environmentId: EnvironmentId | null;
  readonly checkoutKey: string | null;
  readonly memberKeys: ReadonlyArray<string>;
}

function sameProjectSelection(a: ProjectSelection | null, b: ProjectSelection): boolean {
  return (
    a !== null &&
    a.key === b.key &&
    a.environmentId === b.environmentId &&
    a.checkoutKey === b.checkoutKey &&
    a.memberKeys.length === b.memberKeys.length &&
    a.memberKeys.every((key, index) => key === b.memberKeys[index])
  );
}

export function ProjectSettingsPanel({
  projectKey,
  environmentId = null,
  checkoutKey = null,
  unavailable,
}: {
  projectKey: string;
  environmentId?: EnvironmentId | null;
  checkoutKey?: string | null;
  unavailable?: ReactNode;
}) {
  const groups = useSettingsProjectGroups();
  const pathname = useLocation({ select: (location) => location.pathname });

  const selected = groups.find((group) => group.projectKey === projectKey) ?? null;
  const members =
    selected?.memberProjects.filter(
      (member) =>
        (environmentId === null || member.environmentId === environmentId) &&
        (checkoutKey === null || member.physicalProjectKey === checkoutKey),
    ) ?? [];

  // Retain group members so grouping-rule changes can follow the project to its new group.
  const [lastSelection, setLastSelection] = useState<ProjectSelection | null>(null);
  if (selected && members.length > 0) {
    const current: ProjectSelection = {
      key: selected.projectKey,
      environmentId,
      checkoutKey,
      memberKeys: members.map((member) => member.physicalProjectKey),
    };
    if (!sameProjectSelection(lastSelection, current)) setLastSelection(current);
  }

  const successor =
    members.length === 0 &&
    lastSelection?.key === projectKey &&
    lastSelection.environmentId === environmentId &&
    lastSelection.checkoutKey === checkoutKey
      ? groups.find((group) =>
          group.memberProjects.some((member) =>
            lastSelection.memberKeys.includes(member.physicalProjectKey),
          ),
        )
      : undefined;
  if (successor) {
    return (
      <Navigate
        to={pathname}
        search={{
          project: successor.projectKey,
          machine: environmentId ?? undefined,
          checkout: checkoutKey ?? undefined,
        }}
        replace
        hashScrollIntoView={false}
      />
    );
  }

  if ((!selected || members.length === 0) && unavailable != null) return unavailable;

  if (!selected) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
        {groups.length === 0
          ? "Add a workspace from the sidebar to configure it here."
          : "This workspace is no longer available."}
      </div>
    );
  }
  if (members.length === 0)
    return (
      <p className="p-8 text-sm text-muted-foreground">
        This checkout is no longer available in the selected workspace and environment.
      </p>
    );
  const scopedGroup = {
    ...selected,
    memberProjects: members,
    environmentId: members[0]!.environmentId,
    id: members[0]!.id,
  };
  return (
    <ProjectDetail
      key={`${selected.projectKey}:${environmentId ?? "all"}:${checkoutKey ?? "all"}`}
      group={scopedGroup}
      allMembers={selected.memberProjects}
      hasOtherMembers={members.length < selected.memberProjects.length}
    />
  );
}

function ProjectDetail({
  group,
  allMembers,
  hasOtherMembers,
}: {
  group: SidebarProjectSnapshot;
  /** Name, icon, pin and archive belong to the whole workspace, even when one environment is picked. */
  allMembers: ReadonlyArray<SidebarProjectGroupMember>;
  hasOtherMembers: boolean;
}) {
  const navigate = useNavigate({ from: "/settings" });
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const environmentById = new Map(
    environments.map((environment) => [environment.environmentId, environment]),
  );
  const editableIds = useEnvironmentsWithScope(allMembers, AuthOrchestrationOperateScope);
  const canEditGroup = group.memberProjects.every((member) =>
    editableIds.has(member.environmentId),
  );
  const canEditShared = allMembers.every((member) => editableIds.has(member.environmentId));
  const representative =
    group.memberProjects.find(
      (member) => environmentById.get(member.environmentId)?.serverConfig != null,
    ) ?? group.memberProjects[0]!;
  const removeProject = useProjectRemoval();
  const projectNameEditedRef = useRef(false);

  const faviconPath = representative.faviconPath ?? null;
  const projectIcon = representative.projectIcon ?? null;
  const pickProjectFavicon =
    typeof window !== "undefined" &&
    allMembers.every(
      (member) =>
        member.environmentId === primaryEnvironmentId &&
        canPickExternalProjectFavicon(member.workspaceRoot, navigator.platform),
    )
      ? window.desktopBridge?.pickProjectFavicon
      : undefined;

  const { updateProjectGroup, canOrganizeProjectGroup, canSetProjectGroupKind } =
    useProjectGroupUpdate();
  const sharedKind = projectGroupKind(allMembers.map((member) => member.kind));
  const updateAllMembers = (
    input: ProjectGroupUpdate | ((member: SidebarProjectGroupMember) => ProjectGroupUpdate),
    failureTitle: string,
  ) => updateProjectGroup(allMembers, input, failureTitle);
  const canOrganize = canEditShared && canOrganizeProjectGroup(allMembers);
  const [isOrganizing, setIsOrganizing] = useState(false);
  const organize = async (input: ProjectGroupUpdate, failureTitle: string) => {
    setIsOrganizing(true);
    await updateProjectGroup(allMembers, input, failureTitle);
    setIsOrganizing(false);
  };

  const renameGroup = async (input: HTMLInputElement, wasEdited: boolean) => {
    const title = input.value.trim();
    if (!title) {
      input.value = group.displayName;
      toastManager.add({ type: "warning", title: "Workspace name cannot be empty" });
      return;
    }
    if (
      !projectGroupTitleNeedsUpdate(
        allMembers.map((member) => member.title),
        title,
        wasEdited,
      )
    ) {
      return;
    }
    await updateAllMembers({ title }, "Failed to rename workspace");
  };

  const [faviconPickerOpen, setFaviconPickerOpen] = useComposerMenuState(!canEditShared);
  const [iconPickerOpen, setIconPickerOpen] = useComposerMenuState(!canEditShared);
  const [isSavingFavicon, setIsSavingFavicon] = useState(false);
  const savingFaviconRef = useRef(false);
  const setProjectIcon = async (input: Parameters<typeof updateAllMembers>[0]) => {
    if (savingFaviconRef.current) return;
    savingFaviconRef.current = true;
    setIsSavingFavicon(true);
    await updateAllMembers(input, "Failed to update workspace icon");
    savingFaviconRef.current = false;
    setIsSavingFavicon(false);
  };

  const isPersonal = isPersonalWorkspace(group.memberProjects);
  const hasDefaultIcon = allMembers.every(hasDefaultProjectIcon);
  const hasMultipleCheckouts = group.memberProjects.length > 1;
  // Codenine owns the folder of chats without a project; the server refuses to delete it.
  const folderMembers = group.memberProjects.filter(
    (member) =>
      !member.isScratch &&
      environmentById.get(member.environmentId)?.serverConfig?.environment.capabilities
        .projectFolderDeletion === true,
  );

  const removeMembers = async (
    members: ReadonlyArray<SidebarProjectGroupMember>,
    options?: { readonly deleteFolder?: boolean },
  ) => {
    const removed = await removeProject({
      members,
      groupMemberCount: group.memberProjects.length,
      hasOtherMembers,
      displayName: group.displayName,
      ...options,
    });
    if (removed && members.length === group.memberProjects.length && !hasOtherMembers) {
      void navigate({
        to: "/settings/projects",
        search: ({ machine }) => ({ project: undefined, machine, checkout: undefined }),
        replace: true,
      });
    }
  };

  const checkoutsByEnvironment = new Map<EnvironmentId, SidebarProjectGroupMember[]>();
  for (const member of group.memberProjects) {
    const members = checkoutsByEnvironment.get(member.environmentId);
    if (members) members.push(member);
    else checkoutsByEnvironment.set(member.environmentId, [member]);
  }
  // A lone checkout is removed from the Danger section, but it still needs its grouping
  // rule here so "Keep separate" can be undone. Personal's folder is not a repository.
  const checkoutControls = (member: SidebarProjectGroupMember) =>
    isPersonal ? undefined : (
      <div className="flex w-full min-w-0 items-center gap-2 @min-[32rem]/settings-row:w-auto">
        <div className="min-w-0 flex-1 @min-[32rem]/settings-row:w-72 @min-[32rem]/settings-row:flex-none">
          <CheckoutGroupingSelect member={member} />
        </div>
        {hasMultipleCheckouts ? (
          <Button
            size="sm"
            variant="outline"
            disabled={!editableIds.has(member.environmentId)}
            onClick={() => void removeMembers([member])}
            aria-label={`Remove checkout ${member.workspaceRoot}`}
          >
            Remove
          </Button>
        ) : null}
      </div>
    );
  const checkoutChoices = (
    <SettingsSection title={isPersonal ? "Location" : "Checkouts"}>
      {isPersonal ? null : (
        <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
          Grouping rule decides how each checkout joins workspace groups in the sidebar. Changing it
          can move a checkout to a different workspace.
        </p>
      )}
      {Array.from(checkoutsByEnvironment, ([environmentId, members]) => {
        if (checkoutsByEnvironment.size === 1) {
          return members.map((member) => (
            <SettingsRow
              key={member.physicalProjectKey}
              title={member.environmentLabel ?? "Environment"}
              description={member.workspaceRoot}
              control={checkoutControls(member)}
            />
          ));
        }
        const firstMember = members[0]!;
        const hasMultiple = members.length > 1;
        const environment = environmentById.get(environmentId);
        const labels = environment
          ? settingsScopeEnvironmentLabels(environment, environments)
          : { primary: firstMember.environmentLabel ?? "Environment", secondary: environmentId };
        return (
          <SettingsRow
            key={environmentId}
            title={labels.primary}
            description={
              <>
                {labels.secondary ? (
                  <span className="block truncate">{labels.secondary}</span>
                ) : null}
                {!hasMultiple ? (
                  <Tooltip>
                    <TooltipTrigger render={<span className="block truncate" />}>
                      {firstMember.workspaceRoot}
                    </TooltipTrigger>
                    <TooltipPopup>{firstMember.workspaceRoot}</TooltipPopup>
                  </Tooltip>
                ) : null}
              </>
            }
            control={hasMultiple ? undefined : checkoutControls(firstMember)}
          >
            {hasMultiple ? (
              <div className="space-y-3 pb-2 pt-1">
                {members.map((member) => (
                  <div
                    key={member.physicalProjectKey}
                    className="flex min-w-0 flex-col gap-1.5 @min-[36rem]/settings-row:flex-row @min-[36rem]/settings-row:items-center @min-[36rem]/settings-row:justify-between @min-[36rem]/settings-row:gap-3"
                  >
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span className="min-w-0 max-w-full truncate text-xs text-muted-foreground/80" />
                        }
                      >
                        {member.workspaceRoot}
                      </TooltipTrigger>
                      <TooltipPopup>{member.workspaceRoot}</TooltipPopup>
                    </Tooltip>
                    <div className="shrink-0">{checkoutControls(member)}</div>
                  </div>
                ))}
              </div>
            ) : null}
          </SettingsRow>
        );
      })}
    </SettingsSection>
  );

  return (
    <>
      <SettingsPageContainer className="gap-6">
        <p className="px-3 text-sm text-muted-foreground sm:px-4">
          More settings for {group.displayName}:{" "}
          {WORKSPACE_OVERRIDE_PAGES.map((to, index) => (
            <Fragment key={to}>
              {index > 0 ? " · " : null}
              <InlineButton render={<Link to={to} />}>{SETTINGS_SECTION_LABELS[to]}</InlineButton>
            </Fragment>
          ))}
        </p>
        <SettingsSection id="project-overview" title="Workspace" hideTitle>
          {!canEditShared ? (
            <p className="px-3 py-2 text-sm text-muted-foreground sm:px-4">
              {allMembers.length > 1
                ? "Shared settings require permission to change every checkout in this group."
                : "This connection cannot change this workspace."}
            </p>
          ) : null}
          <SettingsRow
            title="Name"
            description={
              isPersonal
                ? "Holds chats started without a workspace."
                : "Shown in the sidebar, workspace pickers and chat headers."
            }
            control={
              isPersonal ? (
                <span className="text-sm">{group.displayName}</span>
              ) : (
                <Input
                  key={`${group.projectKey}:${group.displayName}`}
                  size="sm"
                  className="w-full sm:w-64"
                  aria-label="Workspace name"
                  disabled={!canEditShared}
                  defaultValue={group.displayName}
                  onChange={() => {
                    projectNameEditedRef.current = true;
                  }}
                  onBlur={(event) => {
                    const wasEdited = projectNameEditedRef.current;
                    projectNameEditedRef.current = false;
                    void renameGroup(event.currentTarget, wasEdited);
                  }}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
              )
            }
          />
          {isPersonal || !canSetProjectGroupKind(allMembers) ? null : (
            <SettingsRow
              title="Type"
              description={
                sharedKind === null
                  ? "This workspace's checkouts have different types. Pick one for all of them."
                  : workspaceKindOption(sharedKind).description
              }
              control={
                <Select
                  value={sharedKind}
                  disabled={!canEditShared}
                  onValueChange={(kind) => {
                    if (!isWorkspaceKind(kind) || kind === sharedKind) return;
                    void updateAllMembers({ kind }, "Failed to change workspace type");
                  }}
                >
                  <SelectTrigger size="sm" aria-label="Workspace type">
                    <SelectValue>
                      {sharedKind === null ? "Mixed" : workspaceKindOption(sharedKind).label}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {WORKSPACE_KIND_OPTIONS.map((option) => (
                      <SelectItem key={option.kind} hideIndicator value={option.kind}>
                        <span className="flex flex-col">
                          <span>{option.label}</span>
                          <span className="text-muted-foreground text-xs">
                            {option.description}
                          </span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />
          )}
          <SettingsRow
            title="Workspace icon"
            description={
              isPersonal && hasDefaultIcon
                ? "Default"
                : projectIcon?.kind === "lucide"
                  ? `${projectIcon.name} · ${projectIcon.color}`
                  : projectIcon?.kind === "monogram"
                    ? `${projectIcon.text} · ${projectIcon.color}`
                    : projectIcon?.kind === "emoji"
                      ? projectIcon.emoji
                      : (faviconPath ?? "Automatic")
            }
            resetAction={
              !hasDefaultIcon ? (
                <SettingResetButton
                  label="workspace icon"
                  disabled={isSavingFavicon || !canEditShared}
                  onClick={() => void setProjectIcon(defaultProjectIcon)}
                />
              ) : null
            }
            control={
              <div className="flex items-center gap-2">
                <ProjectFavicon project={representative} className="size-6" />
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  aria-label="Choose a workspace icon"
                  disabled={isSavingFavicon || !canEditShared}
                  onClick={() => setIconPickerOpen(true)}
                >
                  Choose icon
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  aria-label="Choose a workspace icon file"
                  disabled={isSavingFavicon || !canEditShared}
                  onClick={() => setFaviconPickerOpen(true)}
                >
                  Choose file
                </Button>
              </div>
            }
          />
          {canOrganize ? (
            <>
              <SettingsRow
                title="Pin"
                description="Pinned workspaces come first in workspace pickers."
                control={
                  <Switch
                    checked={group.pinned}
                    disabled={isOrganizing}
                    onCheckedChange={(checked) =>
                      void organize(
                        { pinned: Boolean(checked) },
                        checked ? "Failed to pin workspace" : "Failed to unpin workspace",
                      )
                    }
                    aria-label="Pin workspace"
                  />
                }
              />
              {isPersonal && !group.archived ? null : (
                <SettingsRow
                  title="Archive"
                  description={
                    group.archived
                      ? "Hidden from workspace pickers. Chats and files are kept."
                      : "Hides the workspace from workspace pickers. Chats and files are kept."
                  }
                  control={
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isOrganizing}
                      onClick={() =>
                        void organize(
                          { archived: !group.archived },
                          group.archived
                            ? "Failed to unarchive workspace"
                            : "Failed to archive workspace",
                        )
                      }
                    >
                      {group.archived ? "Unarchive" : "Archive"}
                    </Button>
                  }
                />
              )}
            </>
          ) : null}
        </SettingsSection>
        <ProjectDefaultsSettings category="project" />
        <ProjectActionsSettings />
        {checkoutChoices}
        {isPersonal ? null : (
          <SettingsSection title="Danger">
            <SettingsRow
              title={
                hasOtherMembers
                  ? "Remove checkout"
                  : group.memberProjects.length > 1
                    ? "Remove this workspace everywhere"
                    : "Remove workspace"
              }
              description={
                hasOtherMembers
                  ? "Deletes the selected environment's checkout entries and their chats. Other environments and files on disk are not touched."
                  : group.memberProjects.length > 1
                    ? `Deletes all ${group.memberProjects.length} checkout entries and their chats on every environment. Files on disk are not touched.`
                    : "Deletes the workspace entry and its chats. Files on disk are not touched."
              }
              control={
                <Button
                  size="sm"
                  variant="destructive-outline"
                  disabled={!canEditGroup}
                  onClick={() => void removeMembers(group.memberProjects)}
                >
                  <Trash2Icon />
                  {hasOtherMembers
                    ? "Remove checkout"
                    : group.memberProjects.length > 1
                      ? "Remove all entries"
                      : "Remove workspace"}
                </Button>
              }
            />
            {folderMembers.length > 0 ? (
              <SettingsRow
                title={
                  hasMultipleCheckouts
                    ? "Delete a checkout and its folder"
                    : hasOtherMembers
                      ? "Delete checkout and folder"
                      : "Delete workspace and folder"
                }
                description={
                  hasMultipleCheckouts
                    ? "Deletes one checkout entry, its chats, and its folder in that environment, including uncommitted work. Other checkouts are not touched."
                    : hasOtherMembers
                      ? "Deletes the selected environment's checkout entry, its chats, and its folder there, including uncommitted work. Other environments are not touched."
                      : "Deletes the workspace entry, its chats, and its folder on disk, including uncommitted work."
                }
                control={
                  hasMultipleCheckouts ? undefined : (
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={!canEditGroup}
                      onClick={() => void removeMembers(folderMembers, { deleteFolder: true })}
                    >
                      <Trash2Icon />
                      {hasOtherMembers
                        ? "Delete checkout and folder"
                        : "Delete workspace and folder"}
                    </Button>
                  )
                }
              >
                {hasMultipleCheckouts ? (
                  <div className="space-y-3 pb-2 pt-1">
                    {folderMembers.map((member) => {
                      const location = [member.environmentLabel, member.workspaceRoot]
                        .filter(Boolean)
                        .join(" · ");
                      return (
                        <div
                          key={member.physicalProjectKey}
                          className="flex min-w-0 items-center justify-between gap-3"
                        >
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <span className="min-w-0 truncate text-xs text-muted-foreground/80" />
                              }
                            >
                              {location}
                            </TooltipTrigger>
                            <TooltipPopup>{location}</TooltipPopup>
                          </Tooltip>
                          <div className="shrink-0">
                            <Button
                              size="sm"
                              variant="destructive"
                              disabled={!editableIds.has(member.environmentId)}
                              onClick={() => void removeMembers([member], { deleteFolder: true })}
                              aria-label={`Delete checkout and folder ${member.workspaceRoot}`}
                            >
                              Delete folder
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </SettingsRow>
            ) : null}
          </SettingsSection>
        )}
      </SettingsPageContainer>

      <ProjectFaviconPickerDialog
        key={`${representative.environmentId}:${representative.workspaceRoot}:${faviconPickerOpen}`}
        cwd={representative.workspaceRoot}
        environmentId={representative.environmentId}
        onOpenChange={setFaviconPickerOpen}
        {...(pickProjectFavicon
          ? { onPickExternal: () => pickProjectFavicon(representative.workspaceRoot) }
          : {})}
        onSelect={(path) => void setProjectIcon({ faviconPath: path, projectIcon: null })}
        open={faviconPickerOpen && canEditShared}
        projectName={group.displayName}
      />
      {iconPickerOpen && canEditShared ? (
        <Suspense fallback={null}>
          <ProjectIconPickerDialog
            current={projectIcon}
            projectName={group.displayName}
            open
            onOpenChange={setIconPickerOpen}
            onSelect={(icon) => void setProjectIcon({ faviconPath: null, projectIcon: icon })}
          />
        </Suspense>
      ) : null}
    </>
  );
}
