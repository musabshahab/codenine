import { scopeThreadRef } from "@codenine/client-runtime/environment";
import type { EnvironmentThreadShell } from "@codenine/client-runtime/state/models";
import { ListChecksIcon } from "lucide-react";
import { useRouter } from "@tanstack/react-router";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useTeamTasks } from "../../hooks/useWorkLists";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatElapsedDurationLabel } from "../../timestampFormat";
import { ProjectFavicon } from "../ProjectFavicon";
import { ThreadKindIcon } from "../ThreadKindIcon";
import { resolveThreadKind } from "../threadKind.logic";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { groupTeamTasks, teamTaskProgress } from "./tasksPage.logic";
import { useThreadProjectGroup } from "./threadPlace";
import { WorkspacePage } from "./WorkspacePage";

/** Every task, the threads that lead a team, grouped by what they need. */
export function TasksPage() {
  const router = useRouter();
  const tasks = useTeamTasks();
  const groupOf = useThreadProjectGroup();
  const nowMinute = useNowMinute();
  const nowMs = Date.parse(`${nowMinute}Z`);
  const open = (thread: EnvironmentThreadShell) =>
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
    });
  return (
    <WorkspacePage area="tasks" title="Tasks" subtitle="Across all projects">
      {tasks.length === 0 ? (
        <Empty className="h-full">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ListChecksIcon />
            </EmptyMedia>
            <EmptyTitle>No tasks yet</EmptyTitle>
            <EmptyDescription>
              Turn on Team in a project's composer and the lead proposes a team for the task.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-5 px-4 py-4">
          {groupTeamTasks(tasks, (thread) => thread.source.teamSummary?.status ?? null).map(
            (group) => (
              <section key={group.label} aria-label={group.label} className="flex flex-col gap-px">
                <h2 className="px-2 pb-1 text-xs font-medium text-muted-foreground">
                  {group.label} · {group.tasks.length}
                </h2>
                <ul className="flex flex-col gap-px">
                  {group.tasks.map((thread) => {
                    const project = groupOf(thread);
                    return (
                      <li key={`${thread.environmentId}:${thread.id}`}>
                        <button
                          type="button"
                          onClick={() => open(thread)}
                          className="flex min-h-9 w-full cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        >
                          <ThreadKindIcon kind={resolveThreadKind(thread)} className="size-4" />
                          <span className="min-w-40 flex-1 truncate text-foreground">
                            {thread.title}
                          </span>
                          {project ? (
                            <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                              <ProjectFavicon project={project} className="size-3.5 shrink-0" />
                              <span className="truncate">{project.displayName}</span>
                            </span>
                          ) : null}
                          <span className="w-40 shrink-0 truncate text-xs text-muted-foreground">
                            {teamTaskProgress(thread.source.teamSummary)}
                          </span>
                          <span className="w-12 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                            {formatElapsedDurationLabel(thread.updatedAt, nowMs)}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ),
          )}
        </div>
      )}
    </WorkspacePage>
  );
}
