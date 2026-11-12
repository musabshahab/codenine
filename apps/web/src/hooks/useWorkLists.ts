import type { EnvironmentThreadShell } from "@codenine/client-runtime/state/models";
import { selectNeedsYou } from "@codenine/client-runtime/state/thread-inbox";
import { effectiveSnoozed } from "@codenine/client-runtime/state/thread-settled";
import { sortSettledThreads } from "@codenine/client-runtime/state/thread-sort";

import { filterSidebarV2VisibleThreads } from "../components/Sidebar.logic";
import { useQuietThreadShells } from "../state/entities";
import { useConnectedEnvironmentIds } from "../state/environments";
import { useOlderSettledShelf, useOlderSettledShelfGrowth } from "../state/olderSettledShelf";
import { useNowMinute } from "./useNowMinute";

/** Listed threads that are still open work: not done, archived, or snoozed. */
export function openWorkThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  now: string,
): EnvironmentThreadShell[] {
  return filterSidebarV2VisibleThreads(threads, null).filter(
    (thread) => thread.settledOverride !== "settled" && !effectiveSnoozed(thread, { now }),
  );
}

/** Threads that wait on the user, across every project and chat, most pressing first. */
export function useNeedsYouEntries() {
  const threads = useQuietThreadShells();
  const nowMinute = useNowMinute();
  return selectNeedsYou(openWorkThreads(threads, `${nowMinute}Z`));
}

/** Task threads, which lead a team: every thread with a team plan, newest first. */
export function useTeamTasks(): ReadonlyArray<EnvironmentThreadShell> {
  const threads = useQuietThreadShells();
  return filterSidebarV2VisibleThreads(threads, null)
    .filter((thread) => thread.source.teamSummary != null)
    .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

/** Done threads across every environment, older ones the client has not loaded included. */
export function useCompletedThreads(visibleCount: number, expanded: boolean) {
  const threads = useQuietThreadShells();
  const environmentIds = useConnectedEnvironmentIds();
  const shelf = useOlderSettledShelf({
    scopes: environmentIds.map((environmentId) => ({ environmentId, projectIds: null })),
    expanded,
    visibleCount,
  });
  const visible = filterSidebarV2VisibleThreads(threads, null);
  const settled = sortSettledThreads(
    visible.filter((thread) => thread.settledOverride === "settled"),
  );
  const listed = settled.filter(shelf.isListed);
  useOlderSettledShelfGrowth(shelf, listed);
  return {
    threads: listed.slice(0, visibleCount),
    total: settled.length + shelf.unloadedCount(visible),
    loading: shelf.loading,
    failed: shelf.failed,
    retry: shelf.retry,
  };
}
