import type { EnvironmentThreadShell } from "@codenine/client-runtime/state/models";
import type { TeamPlanStatus } from "@codenine/contracts";
import { SearchIcon } from "lucide-react";
import type { ReactNode } from "react";

import { formatElapsedDurationLabel } from "~/timestampFormat";

import {
  HOME_CHAT_FILTER_THRESHOLD,
  HOME_CHAT_STATE_LABELS,
  type HomeChatState,
} from "../pages/projectHome.logic";
import { teamTaskProgress } from "../pages/tasksPage.logic";
import { ThreadKindIcon } from "../ThreadKindIcon";
import { resolveThreadKind } from "../threadKind.logic";
import { Badge } from "../ui/badge";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { HomeEmpty, HomeSection } from "./HomeSection";

const STATE_BADGE = {
  "needs-you": "warning",
  running: "info",
  done: "success",
} as const;

const TASK_STATE: Readonly<Record<TeamPlanStatus, HomeChatState>> = {
  proposed: "needs-you",
  failed: "needs-you",
  running: "running",
  completed: "done",
  cancelled: "done",
};

function StateBadge({ state, label }: { state: HomeChatState; label?: string }) {
  const text = label ?? HOME_CHAT_STATE_LABELS[state];
  return state === "open" || text === null ? null : (
    <Badge variant={STATE_BADGE[state]} size="sm">
      {text}
    </Badge>
  );
}

function ThreadRow(props: {
  readonly thread: EnvironmentThreadShell;
  readonly badge: ReactNode;
  readonly detail: string;
  readonly onOpen: (thread: EnvironmentThreadShell) => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => props.onOpen(props.thread)}
        className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-start text-sm outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ThreadKindIcon kind={resolveThreadKind(props.thread)} className="size-4" />
        <span className="min-w-0 flex-1 truncate text-foreground">{props.thread.title}</span>
        {props.badge}
        <span className="shrink-0 text-muted-foreground text-xs tabular-nums">{props.detail}</span>
      </button>
    </li>
  );
}

/** The workspace's chats: what needs the user first, with a filter once there are many. */
export function HomeChats(props: {
  readonly chats: ReadonlyArray<{
    readonly thread: EnvironmentThreadShell;
    readonly state: HomeChatState;
  }>;
  readonly total: number;
  readonly counts: Readonly<Record<HomeChatState, number>>;
  readonly moreCount: number;
  readonly filter: string;
  readonly onFilterChange: (filter: string) => void;
  readonly activeAt: (thread: EnvironmentThreadShell) => string;
  readonly nowMs: number;
  readonly onOpen: (thread: EnvironmentThreadShell) => void;
}) {
  const summary = [
    props.counts["needs-you"] > 0 ? `${props.counts["needs-you"]} need you` : null,
    props.counts.running > 0 ? `${props.counts.running} running` : null,
  ].filter((part) => part !== null);
  return (
    <HomeSection
      title="Chats"
      note={props.total === 0 ? null : [props.total, ...summary].join(" · ")}
      actions={
        props.total > HOME_CHAT_FILTER_THRESHOLD ? (
          <div className="w-44 sm:w-56">
            <InputGroup>
              <InputGroupAddon>
                <SearchIcon aria-hidden />
              </InputGroupAddon>
              <InputGroupInput
                type="search"
                size="sm"
                aria-label="Filter chats"
                placeholder="Filter chats"
                value={props.filter}
                onChange={(event) => props.onFilterChange(event.currentTarget.value)}
              />
            </InputGroup>
          </div>
        ) : null
      }
    >
      {props.total === 0 ? (
        <HomeEmpty>No chats yet. Describe what you need above to start one.</HomeEmpty>
      ) : props.chats.length === 0 ? (
        <HomeEmpty>No chat here has "{props.filter.trim()}" in its title.</HomeEmpty>
      ) : (
        <ul className="flex flex-col gap-px">
          {props.chats.map(({ thread, state }) => (
            <ThreadRow
              key={`${thread.environmentId}:${thread.id}`}
              thread={thread}
              badge={<StateBadge state={state} />}
              detail={formatElapsedDurationLabel(props.activeAt(thread), props.nowMs)}
              onOpen={props.onOpen}
            />
          ))}
        </ul>
      )}
      {props.moreCount > 0 ? (
        <p className="px-2.5 text-muted-foreground text-xs">
          {props.moreCount} more. Filter to find one, or open the workspace in the sidebar.
        </p>
      ) : null}
    </HomeSection>
  );
}

/** The workspace's team tasks, newest first, each with where its team stands. */
export function HomeTasks(props: {
  readonly tasks: ReadonlyArray<EnvironmentThreadShell>;
  readonly empty: ReactNode;
  readonly onOpen: (thread: EnvironmentThreadShell) => void;
}) {
  return (
    <HomeSection title="Tasks" note={props.tasks.length === 0 ? null : props.tasks.length}>
      {props.tasks.length === 0 ? (
        <HomeEmpty>{props.empty}</HomeEmpty>
      ) : (
        <ul className="flex flex-col gap-px">
          {props.tasks.map((thread) => {
            const summary = thread.source.teamSummary;
            return (
              <ThreadRow
                key={`${thread.environmentId}:${thread.id}`}
                thread={thread}
                badge={
                  summary == null ? null : (
                    <StateBadge
                      state={TASK_STATE[summary.status]}
                      {...(summary.status === "cancelled" ? { label: "Cancelled" } : {})}
                    />
                  )
                }
                detail={summary?.status === "cancelled" ? "" : teamTaskProgress(summary)}
                onOpen={props.onOpen}
              />
            );
          })}
        </ul>
      )}
    </HomeSection>
  );
}
