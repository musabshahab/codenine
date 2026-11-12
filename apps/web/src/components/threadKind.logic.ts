import type { EnvironmentThreadShell } from "@codenine/client-runtime/state/models";
import { resolveSidebarThreadStatus } from "@codenine/client-runtime/state/thread-inbox";

export type ThreadKind = "chat" | "running" | "approval" | "question" | "failed" | "done" | "pr";

type ThreadKindInput = Parameters<typeof resolveSidebarThreadStatus>[0] &
  Pick<EnvironmentThreadShell, "pullRequests"> & {
    readonly source: Pick<EnvironmentThreadShell["source"], "teamSummary">;
  };

/**
 * What a thread's icon says at a glance: what it waits on, then a task's team, then its pull
 * request. A thread with none of these reads as a chat.
 */
export function resolveThreadKind(thread: ThreadKindInput): ThreadKind {
  const status = resolveSidebarThreadStatus(thread);
  if (status === "approval") return "approval";
  if (status === "input") return "question";
  const hasOpenPullRequest = thread.pullRequests.some((link) => link.snapshot?.state === "open");
  const team = thread.source.teamSummary;
  if (team) {
    if (team.status === "proposed") return "approval";
    if (team.status === "failed") return "failed";
    if (team.status === "running") return "running";
    return hasOpenPullRequest ? "pr" : "done";
  }
  if (status === "working" || status === "preparing") return "running";
  if (status === "failed") return "failed";
  return hasOpenPullRequest ? "pr" : "chat";
}
