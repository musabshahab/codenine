import { scopeProjectRef, scopeThreadRef } from "@codenine/client-runtime/environment";
import type { EnvironmentThreadShell } from "@codenine/client-runtime/state/models";
import { withoutUnlinkedWorkflowRuns } from "@codenine/client-runtime/state/team-threads";
import { resolveThreadActivityTimestamp } from "@codenine/client-runtime/state/thread-sort";
import { useAtomValue } from "@effect/atom-react";
import {
  FolderIcon,
  GitBranchIcon,
  MessageCirclePlusIcon,
  MonitorIcon,
  SettingsIcon,
  UsersIcon,
} from "lucide-react";
import { Link, useRouter } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";

import { resolveProjectScripts } from "@codenine/shared/projectScripts";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useSidebarProjectGroups } from "../../hooks/useSidebarProjectGroups";
import { useTeamTasks } from "../../hooks/useWorkLists";
import { useRightPanelStore } from "../../rightPanelStore";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useQuietThreadShells } from "../../state/entities";
import { useEnvironmentIdentities, useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { vcsEnvironment } from "../../state/vcs";
import { buildThreadRouteParams } from "../../threadRoutes";
import { projectPreset } from "../../workspaceKind";
import { HomeRecentFiles } from "../projectHome/HomeRecentFiles";
import {
  HomeCheckoutCard,
  HomeCommandsCard,
  HomeConnectorsCard,
  HomeSkillsCard,
} from "../projectHome/HomeSide";
import { HomeStarter } from "../projectHome/HomeStarter";
import { HomeChats, HomeTasks } from "../projectHome/HomeThreads";
import { ProjectFavicon } from "../ProjectFavicon";
import { filterSidebarV2VisibleThreads } from "../Sidebar.logic";
import { Button, InlineButton } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspaceKindBadge } from "../WorkspaceKindBadge";
import { folderChipLabel, selectHomeChats } from "./projectHome.logic";
import { WorkspacePage } from "./WorkspacePage";

/** A workspace's home: where work in it starts, and what is going on in it. */
export function ProjectPage(props: { projectKey: string }) {
  const group =
    useSidebarProjectGroups().find((candidate) => candidate.projectKey === props.projectKey) ??
    null;
  if (group === null) {
    return (
      <WorkspacePage area="project" title="Workspace">
        <Empty className="h-full">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderIcon />
            </EmptyMedia>
            <EmptyTitle>This workspace is not here</EmptyTitle>
            <EmptyDescription>
              It may have been removed, or its environment is not connected yet.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" variant="outline" render={<Link to="/settings/connections" />}>
              Open Environments
            </Button>
          </EmptyContent>
        </Empty>
      </WorkspacePage>
    );
  }
  return <ProjectOverview group={group} />;
}

const activeAt = (thread: EnvironmentThreadShell) =>
  resolveThreadActivityTimestamp(thread) ?? thread.updatedAt;

function ProjectOverview({ group }: { group: SidebarProjectSnapshot }) {
  const router = useRouter();
  const handleNewThread = useNewThreadHandler();
  const setTeamRequested = useComposerDraftStore((store) => store.setTeamRequested);
  const environments = useEnvironmentIdentities();
  const nowMinute = useNowMinute();
  const nowMs = Date.parse(`${nowMinute}Z`);
  const [chatFilter, setChatFilter] = useState("");
  const scratch = group.isScratch === true;
  const preset = projectPreset(group);
  const { environmentId, workspaceRoot } = group;
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const connected =
    useEnvironments().environments.find(
      (environment) => environment.environmentId === environmentId,
    )?.connection.phase === "connected";
  // Saved commands live in settings, the same source the thread header's command button reads.
  const scripts = resolveProjectScripts(useEnvironmentSettings(environmentId), group);
  // Personal has no folder of its own: each of its chats works in its own.
  const git = useEnvironmentQuery(
    scratch ? null : vcsEnvironment.status({ environmentId, input: { cwd: workspaceRoot } }),
  );
  const gitStatus = git.data;
  const branch = gitStatus?.isRepo ? gitStatus.refName : null;
  const memberKeys = new Set(
    group.memberProjectRefs.map((ref) => `${ref.environmentId}:${ref.projectId}`),
  );
  const inProject = (thread: Pick<EnvironmentThreadShell, "environmentId" | "projectId">) =>
    memberKeys.has(`${thread.environmentId}:${thread.projectId}`);
  const tasks = useTeamTasks().filter(inProject);
  const projectChats = withoutUnlinkedWorkflowRuns(
    filterSidebarV2VisibleThreads(useQuietThreadShells(), null),
  ).filter(
    (thread) =>
      inProject(thread) &&
      thread.source.teamSummary == null &&
      thread.source.teamTask === undefined,
  );
  const chats = selectHomeChats({ threads: projectChats, activeAt, filter: chatFilter });
  const machines = [
    ...new Set(
      group.memberProjects.map(
        (member) =>
          environments.find((environment) => environment.environmentId === member.environmentId)
            ?.label ?? member.environmentId,
      ),
    ),
  ];
  const projectRef = scopeProjectRef(environmentId, group.id);
  const startThread = async (team: boolean, prompt?: string) => {
    const opened = await handleNewThread(
      projectRef,
      prompt === undefined || prompt === "" ? undefined : { prompt },
    );
    if (opened && team) setTeamRequested(opened.draftId, true);
    return opened;
  };
  // A file opens beside a chat, so opening one from here starts the workspace's new chat.
  const openFile = async (path: string) => {
    const opened = await startThread(false);
    if (opened) {
      useRightPanelStore.getState().openFile(scopeThreadRef(environmentId, opened.threadId), path);
    }
  };
  const browseFiles = async () => {
    const opened = await startThread(false);
    if (opened) {
      useRightPanelStore.getState().open(scopeThreadRef(environmentId, opened.threadId), "files");
    }
  };
  const openThread = (thread: EnvironmentThreadShell) =>
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
    });
  const openSettings = () =>
    void router.navigate({
      to: "/settings/projects",
      search: { project: group.projectKey, machine: undefined },
    });
  return (
    <WorkspacePage
      area="project"
      title={group.displayName}
      subtitle="Workspace"
      actions={
        <>
          <Button
            variant="ghost-muted"
            size="icon-sm"
            aria-label="Workspace settings"
            onClick={openSettings}
          >
            <SettingsIcon />
          </Button>
          <Button variant="outline" size="sm" onClick={() => void startThread(false)}>
            <MessageCirclePlusIcon />
            <span className="max-sm:sr-only">New chat</span>
          </Button>
          <Button size="sm" onClick={() => void startThread(true)}>
            <UsersIcon />
            <span className="max-sm:sr-only">New task</span>
          </Button>
        </>
      }
    >
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10">
        <header className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <ProjectFavicon project={group} className="size-10 rounded-lg" />
            <h2 className="min-w-0 truncate font-semibold text-2xl text-foreground tracking-tight">
              {group.displayName}
            </h2>
            {scratch ? null : <WorkspaceKindBadge kind={group.kind ?? "code"} />}
          </div>
          {scratch ? (
            <p className="text-muted-foreground text-sm">
              Chats started without a workspace. Each one works in its own folder.
            </p>
          ) : (
            <ul aria-label="Details" className="flex flex-wrap gap-1.5">
              <DetailChip icon={<FolderIcon />} label="Folder" tip={workspaceRoot} mono>
                {folderChipLabel(workspaceRoot, serverConfig?.homeDirectory)}
              </DetailChip>
              {machines.map((machine) => (
                <DetailChip key={machine} icon={<MonitorIcon />} label="Machine">
                  {machine}
                </DetailChip>
              ))}
              {branch === null || !preset.composerControls.checkout ? null : (
                <DetailChip icon={<GitBranchIcon />} label="Branch">
                  {branch}
                </DetailChip>
              )}
            </ul>
          )}
        </header>
        {/* The tools sit beside everything on a wide page, and above the long lists on a narrow one. */}
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_17rem] lg:grid-rows-[auto_1fr]">
          <div className="flex min-w-0 flex-col gap-8">
            <HomeStarter
              startScreen={preset.startScreen}
              onStart={(prompt, team) => void startThread(team, prompt)}
            />
            {scratch ? null : (
              <HomeRecentFiles
                environmentId={environmentId}
                workspaceRoot={workspaceRoot}
                connected={connected}
                checkout={preset.composerControls.checkout}
                git={gitStatus}
                gitError={git.error}
                fileActivity={serverConfig?.environment.capabilities.fileActivity === true}
                nowMs={nowMs}
                onOpen={(path) => void openFile(path)}
                onBrowse={() => void browseFiles()}
              />
            )}
          </div>
          {scratch ? null : (
            <aside
              aria-label="Workspace tools"
              className="grid min-w-0 content-start gap-3 sm:grid-cols-2 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:grid-cols-1"
            >
              {preset.composerControls.checkout ? (
                <>
                  <HomeCheckoutCard
                    status={gitStatus}
                    connected={connected}
                    error={git.error}
                    onRetry={git.refresh}
                  />
                  <HomeCommandsCard scripts={scripts} onOpenSettings={openSettings} />
                </>
              ) : null}
              <HomeConnectorsCard
                environmentId={environmentId}
                connected={connected}
                suggested={preset.suggestedConnectors}
              />
              <HomeSkillsCard
                environmentId={environmentId}
                projectId={group.id}
                connected={connected}
                suggested={preset.suggestedSkills}
              />
            </aside>
          )}
          <div className="flex min-w-0 flex-col gap-8 lg:col-start-1">
            <HomeChats
              chats={chats.chats}
              total={projectChats.length}
              counts={chats.counts}
              moreCount={chats.moreCount}
              filter={chatFilter}
              onFilterChange={setChatFilter}
              activeAt={activeAt}
              nowMs={nowMs}
              onOpen={openThread}
            />
            <HomeTasks
              tasks={tasks}
              empty={
                <>
                  No tasks yet. A task gives the work to a team of agents you approve first.{" "}
                  <InlineButton onClick={() => void startThread(true)}>Start a task</InlineButton>
                </>
              }
              onOpen={openThread}
            />
          </div>
        </div>
      </div>
    </WorkspacePage>
  );
}

function DetailChip(props: {
  readonly icon: ReactNode;
  /** Read out before the value, which on its own is just a path or a name. */
  readonly label: string;
  /** The whole value, for a chip that may cut it short. */
  readonly tip?: string;
  readonly mono?: boolean;
  readonly children: ReactNode;
}) {
  const chip = (
    <span className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-foreground text-xs [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground">
      {props.icon}
      <span className="sr-only">{props.label}: </span>
      <span className={props.mono ? "truncate font-mono" : "truncate"}>{props.children}</span>
    </span>
  );
  return (
    <li className="flex max-w-full min-w-0">
      {props.tip === undefined ? (
        chip
      ) : (
        <Tooltip>
          <TooltipTrigger render={chip} />
          <TooltipPopup side="bottom">
            <code>{props.tip}</code>
          </TooltipPopup>
        </Tooltip>
      )}
    </li>
  );
}
