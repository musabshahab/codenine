import type { EnvironmentThreadShell } from "@codenine/client-runtime/state/models";
import { resolveSidebarThreadStatus } from "@codenine/client-runtime/state/thread-inbox";
import type { TeamAgentHeader } from "@codenine/client-runtime/team";

export type ThreadKind = "chat" | "running" | "approval" | "question" | "failed" | "done" | "pr";

type ThreadKindInput = Parameters<typeof resolveSidebarThreadStatus>[0] &
  Pick<EnvironmentThreadShell, "pullRequests"> & {
    readonly source: Pick<EnvironmentThreadShell["source"], "teamSummary">;
  };

/** The pull request a thread's work waits in, if one is open. */
export function openPullRequestOf<Link extends EnvironmentThreadShell["pullRequests"][number]>(
  pullRequests: ReadonlyArray<Link>,
): Link | null {
  return (
    pullRequests.find(
      (link) => link.snapshot?.state === "open" && link.source !== "stack-dismissed",
    ) ?? null
  );
}

/**
 * What a thread's icon says at a glance: what it waits on, then a task's team, then its pull
 * request. A thread with none of these reads as a chat.
 */
export function resolveThreadKind(thread: ThreadKindInput): ThreadKind {
  const status = resolveSidebarThreadStatus(thread);
  if (status === "approval") return "approval";
  if (status === "input") return "question";
  const hasOpenPullRequest = openPullRequestOf(thread.pullRequests) !== null;
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

/** A team agent's thread reads as its task: done, failed, or cancelled once it stops. */
export function resolveAgentThreadKind(
  thread: ThreadKindInput,
  agent: Pick<TeamAgentHeader, "taskStatus"> | null,
): ThreadKind {
  const kind = resolveThreadKind(thread);
  if (kind !== "chat" || agent === null) return kind;
  if (agent.taskStatus === "completed") return "done";
  if (agent.taskStatus === "failed" || agent.taskStatus === "cancelled") return "failed";
  return kind;
}
