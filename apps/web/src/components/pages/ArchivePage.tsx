import {
  presentThreadShell,
  type EnvironmentThreadShell,
} from "@codenine/client-runtime/state/models";
import { scopeThreadRef } from "@codenine/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@codenine/client-runtime/state/runtime";
import { ArchiveIcon, ChevronDownIcon } from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useCompletedThreads } from "../../hooks/useWorkLists";
import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import { useConnectedEnvironmentIds } from "../../state/environments";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatElapsedDurationLabel } from "../../timestampFormat";
import { ThreadKindIcon } from "../ThreadKindIcon";
import { resolveThreadKind } from "../threadKind.logic";
import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { useThreadPlaceLabel } from "./threadPlace";
import { WorkspacePage } from "./WorkspacePage";

const PAGE_SIZE = 50;

/** Finished work: threads marked done, and archived threads, each one click from coming back. */
export function ArchivePage() {
  const [shown, setShown] = useState<"completed" | "archived">("completed");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const completed = useCompletedThreads(visibleCount, shown === "completed");
  const environmentIds = useConnectedEnvironmentIds();
  const archived = useArchivedThreadSnapshots(environmentIds);
  const archivedThreads = archived.snapshots
    .flatMap(({ environmentId, snapshot }) =>
      snapshot.threads.map((thread) => presentThreadShell(environmentId, thread)),
    )
    .toSorted(
      (left, right) => Date.parse(right.archivedAt ?? "") - Date.parse(left.archivedAt ?? ""),
    );
  const { unsettleThread, unarchiveThread } = useThreadActions();
  const restore = (thread: EnvironmentThreadShell) => {
    const ref = scopeThreadRef(thread.environmentId, thread.id);
    void (shown === "completed" ? unsettleThread(ref) : unarchiveThread(ref)).then(
      (result: AtomCommandResult<unknown, unknown>) => {
        if (result._tag === "Success") {
          if (shown === "archived") archived.refresh();
          return;
        }
        if (isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title:
            shown === "archived"
              ? "Could not unarchive the chat"
              : "Could not mark the chat not done",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      },
    );
  };
  const rows = shown === "completed" ? completed.threads : archivedThreads;
  return (
    <WorkspacePage
      area="archive"
      title="Completed & archived"
      actions={
        <ToggleGroup
          aria-label="Show"
          variant="segmented"
          value={[shown]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "completed" || value === "archived") setShown(value);
          }}
        >
          <Toggle value="completed">
            Completed<span className="max-sm:hidden"> · {completed.total}</span>
          </Toggle>
          <Toggle value="archived">
            Archived
            {archived.isLoading ? null : (
              <span className="max-sm:hidden"> · {archivedThreads.length}</span>
            )}
          </Toggle>
        </ToggleGroup>
      }
    >
      {rows.length === 0 ? (
        <Empty className="h-full">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ArchiveIcon />
            </EmptyMedia>
            <EmptyTitle>
              {shown === "completed"
                ? "Nothing is done yet"
                : archived.isLoading
                  ? "Loading archived chats"
                  : archived.error
                    ? "Archived chats could not load"
                    : "Nothing is archived"}
            </EmptyTitle>
            {shown === "archived" && archived.isLoading ? null : (
              <EmptyDescription>
                {shown === "completed"
                  ? "Chats and tasks you mark done, or that finish and sit idle, move here."
                  : archived.error
                    ? "Check that the machine is connected, then try again."
                    : "Chats and tasks you archive move here."}
              </EmptyDescription>
            )}
          </EmptyHeader>
          {shown === "archived" && !archived.isLoading && archived.error ? (
            <EmptyContent>
              <Button size="sm" variant="outline" onClick={archived.refresh}>
                Try again
              </Button>
            </EmptyContent>
          ) : null}
        </Empty>
      ) : (
        <ArchiveRows rows={rows} archived={shown === "archived"} onRestore={restore} />
      )}
      {shown === "completed" && completed.total > completed.threads.length ? (
        <div className="px-4 pb-4">
          <Button
            variant="ghost-muted"
            size="sm"
            disabled={completed.loading}
            onClick={() => {
              if (completed.failed) completed.retry();
              setVisibleCount((count) => count + PAGE_SIZE);
            }}
          >
            <ChevronDownIcon />
            {completed.loading
              ? "Loading"
              : completed.failed
                ? "Could not load older chats. Retry"
                : "Show more"}
          </Button>
        </div>
      ) : null}
    </WorkspacePage>
  );
}

function ArchiveRows(props: {
  rows: ReadonlyArray<EnvironmentThreadShell>;
  archived: boolean;
  onRestore: (thread: EnvironmentThreadShell) => void;
}) {
  const router = useRouter();
  const placeOf = useThreadPlaceLabel();
  const nowMinute = useNowMinute();
  const nowMs = Date.parse(`${nowMinute}Z`);
  const action = props.archived ? "Unarchive" : "Mark not done";
  return (
    <ul className="flex flex-col gap-px p-2">
      {props.rows.map((thread) => {
        const when = props.archived ? thread.archivedAt : (thread.settledAt ?? thread.updatedAt);
        return (
          <li
            key={`${thread.environmentId}:${thread.id}`}
            className="group/archive-row relative flex min-h-10 items-center gap-3 rounded-md px-3 py-1.5 hover:bg-accent"
          >
            {props.archived ? (
              <ArchiveIcon
                aria-label="Archived"
                className="size-4 shrink-0 text-muted-foreground"
              />
            ) : (
              <ThreadKindIcon kind={resolveThreadKind(thread)} className="size-4" />
            )}
            <button
              type="button"
              onClick={() =>
                void router.navigate({
                  to: "/$environmentId/$threadId",
                  params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
                })
              }
              className="min-w-0 flex-1 cursor-pointer truncate text-left text-sm text-foreground outline-none after:absolute after:inset-0 after:rounded-md focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring"
            >
              {thread.title}
            </button>
            <span className="hidden min-w-0 max-w-48 truncate text-xs text-muted-foreground sm:block">
              {placeOf(thread)}
            </span>
            <span className="w-12 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
              {when ? formatElapsedDurationLabel(when, nowMs) : ""}
            </span>
            <span className="relative z-10">
              <Button
                variant="outline"
                size="xs"
                aria-label={`${action}: ${thread.title}`}
                onClick={() => props.onRestore(thread)}
              >
                {action}
              </Button>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
