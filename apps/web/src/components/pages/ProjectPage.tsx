import { scopeProjectRef, scopeThreadRef } from "@codenine/client-runtime/environment";
import type { EnvironmentThreadShell } from "@codenine/client-runtime/state/models";
import {
  FolderIcon,
  MessageCirclePlusIcon,
  MonitorIcon,
  SettingsIcon,
  TerminalIcon,
  UsersIcon,
} from "lucide-react";
import { useRouter } from "@tanstack/react-router";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useSidebarProjectGroups } from "../../hooks/useSidebarProjectGroups";
import { openWorkThreads, useTeamTasks } from "../../hooks/useWorkLists";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useQuietThreadShells } from "../../state/entities";
import { useEnvironmentIdentities } from "../../state/environments";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatElapsedDurationLabel } from "../../timestampFormat";
import { ProjectFavicon } from "../ProjectFavicon";
import { ThreadKindIcon } from "../ThreadKindIcon";
import { resolveThreadKind } from "../threadKind.logic";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { teamTaskProgress } from "./tasksPage.logic";
import { WorkspacePage } from "./WorkspacePage";

/** A project's overview: where it lives, its commands, and its open tasks and chats. */
export function ProjectPage(props: { projectKey: string }) {
  const group =
    useSidebarProjectGroups().find((candidate) => candidate.projectKey === props.projectKey) ??
    null;
  if (group === null) {
    return (
      <WorkspacePage area="project" title="Project">
        <Empty className="h-full">
          <EmptyHeader>
            <EmptyTitle>This project is not here</EmptyTitle>
            <EmptyDescription>
              It may have been removed, or its machine is not connected yet.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </WorkspacePage>
    );
  }
  return <ProjectOverview group={group} />;
}

function ProjectOverview({ group }: { group: SidebarProjectSnapshot }) {
  const router = useRouter();
  const handleNewThread = useNewThreadHandler();
  const setTeamRequested = useComposerDraftStore((store) => store.setTeamRequested);
  const environments = useEnvironmentIdentities();
  const nowMinute = useNowMinute();
  const nowMs = Date.parse(`${nowMinute}Z`);
  const memberKeys = new Set(
    group.memberProjectRefs.map((ref) => `${ref.environmentId}:${ref.projectId}`),
  );
  const inProject = (thread: Pick<EnvironmentThreadShell, "environmentId" | "projectId">) =>
    memberKeys.has(`${thread.environmentId}:${thread.projectId}`);
  const tasks = useTeamTasks().filter(inProject);
  const chats = openWorkThreads(useQuietThreadShells(), `${nowMinute}Z`)
    .filter((thread) => inProject(thread) && thread.source.teamSummary == null)
    .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const machines = [
    ...new Set(
      group.memberProjects.map(
        (member) =>
          environments.find((environment) => environment.environmentId === member.environmentId)
            ?.label ?? member.environmentId,
      ),
    ),
  ];
  const startThread = async (team: boolean) => {
    const opened = await handleNewThread(scopeProjectRef(group.environmentId, group.id));
    if (opened && team) setTeamRequested(opened.draftId, true);
  };
  const openThread = (thread: EnvironmentThreadShell) =>
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
    });
  return (
    <WorkspacePage
      area="project"
      title={group.displayName}
      subtitle="Project"
      actions={
        <>
          <Button
            variant="ghost-muted"
            size="icon-sm"
            aria-label="Project settings"
            onClick={() =>
              void router.navigate({
                to: "/settings/projects",
                search: { project: group.projectKey, machine: undefined },
              })
            }
          >
            <SettingsIcon />
          </Button>
          <Button variant="outline" size="sm" onClick={() => void startThread(false)}>
            <MessageCirclePlusIcon />
            New chat
          </Button>
          <Button size="sm" onClick={() => void startThread(true)}>
            <UsersIcon />
            New task
          </Button>
        </>
      }
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-10">
        <ProjectFavicon project={group} className="size-11 rounded-lg" />
        <div className="flex flex-col gap-2">
          <h2 className="text-3xl font-semibold tracking-tight text-foreground">
            {group.displayName}
          </h2>
          <p className="truncate font-mono text-xs text-muted-foreground">{group.workspaceRoot}</p>
        </div>
        <dl className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-x-3 gap-y-3 text-sm">
          <dt className="text-muted-foreground">Details</dt>
          <dd className="flex flex-wrap gap-2">
            <span className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-xs text-foreground">
              <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate font-mono">{group.workspaceRoot}</span>
            </span>
            {machines.map((machine) => (
              <span
                key={machine}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-xs text-foreground"
              >
                <MonitorIcon className="size-3.5 shrink-0 text-muted-foreground" />
                {machine}
              </span>
            ))}
          </dd>
          <dt className="text-muted-foreground">Commands</dt>
          <dd className="flex flex-wrap gap-2">
            {group.scripts.length === 0 ? (
              <span className="text-xs text-muted-foreground">
                None yet. Add them in project settings.
              </span>
            ) : (
              group.scripts.map((script) => (
                <Tooltip key={script.id}>
                  <TooltipTrigger
                    render={
                      <span className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-xs text-foreground" />
                    }
                  >
                    <TerminalIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    {script.name}
                  </TooltipTrigger>
                  <TooltipPopup side="top">
                    <code>{script.command}</code>
                  </TooltipPopup>
                </Tooltip>
              ))
            )}
          </dd>
        </dl>
        <div className="h-px bg-border" />
        <ThreadList
          heading="Tasks"
          empty="No tasks yet. Start one with New task."
          threads={tasks}
          detail={(thread) => teamTaskProgress(thread.source.teamSummary)}
          onOpen={openThread}
        />
        <ThreadList
          heading="Chats in this project"
          empty="No open chats."
          threads={chats}
          detail={(thread) => formatElapsedDurationLabel(thread.updatedAt, nowMs)}
          onOpen={openThread}
        />
      </div>
    </WorkspacePage>
  );
}

function ThreadList(props: {
  heading: string;
  empty: string;
  threads: ReadonlyArray<EnvironmentThreadShell>;
  detail: (thread: EnvironmentThreadShell) => string;
  onOpen: (thread: EnvironmentThreadShell) => void;
}) {
  return (
    <section aria-label={props.heading} className="flex flex-col gap-1">
      <h3 className="pb-1 text-xs font-medium text-muted-foreground">{props.heading}</h3>
      {props.threads.length === 0 ? (
        <p className="text-sm text-muted-foreground">{props.empty}</p>
      ) : (
        <ul className="flex flex-col gap-px">
          {props.threads.map((thread) => (
            <li key={`${thread.environmentId}:${thread.id}`}>
              <button
                type="button"
                onClick={() => props.onOpen(thread)}
                className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <ThreadKindIcon kind={resolveThreadKind(thread)} className="size-4" />
                <span className="min-w-0 flex-1 truncate text-foreground">{thread.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {props.detail(thread)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
