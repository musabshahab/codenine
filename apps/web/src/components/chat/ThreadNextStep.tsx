import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@codenine/client-runtime/state/models";
import { sourceControlClients } from "@codenine/client-runtime/source-control-clients";
import {
  canRetryTeamTask,
  teamStatusText,
  teamTaskOfThread,
  type ThreadTeam,
} from "@codenine/client-runtime/team";
import type { ScopedThreadRef, TeamPlan, TeamTaskRef } from "@codenine/contracts";
import { scopeThreadRef } from "@codenine/client-runtime/environment";
import { teamPlanSummary } from "@codenine/shared/team";

import { useOpenPrLink } from "../../lib/openPullRequestLink";
import { environmentThreadDetails } from "../../state/threads";
import GitActionsControl from "../GitActionsControl";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { openPullRequestOf } from "../threadKind.logic";
import { Button } from "../ui/button";
import { useTeamPlanActions } from "./useTeamPlanActions";

/**
 * The one button for what a thread needs next: approve its team, retry the agent that failed,
 * see the team at work, then open or view its pull request.
 */
export function ThreadNextStep(props: {
  threadRef: ScopedThreadRef;
  team: ThreadTeam | null;
  /** On a team agent's thread: the task it runs, so Retry picks that agent first. */
  teamTask: TeamTaskRef | null;
  working: boolean;
  pullRequests: EnvironmentThreadShell["pullRequests"];
  gitCwd: string | null;
  onOpenTask: () => void;
}) {
  const { team } = props;
  const summary = team?.summary ?? null;
  if (team !== null && summary !== null) {
    const leadRef = scopeThreadRef(props.threadRef.environmentId, team.leadThreadId);
    if (summary.status === "proposed" && team.role === "lead") {
      return <TeamPlanStep leadRef={leadRef} teamTask={null} onOpenTask={props.onOpenTask} />;
    }
    const watching = summary.status === "running" || summary.status === "failed";
    if (watching && summary.failed > 0) {
      return (
        <TeamPlanStep leadRef={leadRef} teamTask={props.teamTask} onOpenTask={props.onOpenTask} />
      );
    }
    if (summary.status === "running") {
      return (
        <TeamRunningPill
          progress={teamStatusText(summary).progress}
          onOpenTask={props.onOpenTask}
        />
      );
    }
  }
  const pullRequest = openPullRequestOf(props.pullRequests);
  if (pullRequest !== null) {
    return (
      <ViewPullRequest
        threadRef={props.threadRef}
        url={pullRequest.url}
        number={pullRequest.number}
      />
    );
  }
  if (props.working || props.gitCwd === null) return null;
  return (
    <GitActionsControl
      presentation="next-step"
      gitCwd={props.gitCwd}
      activeThreadRef={props.threadRef}
    />
  );
}

function TeamRunningPill(props: { progress: string | null; onOpenTask: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onOpenTask}
      className="flex h-6.5 shrink-0 cursor-pointer items-center gap-1.5 rounded-full bg-primary/16 px-2.5 text-xs font-medium whitespace-nowrap text-foreground outline-none transition-colors hover:bg-primary/24 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <span aria-hidden className="size-1.5 rounded-full bg-primary" />
      {props.progress === null ? "Running" : `Running · ${props.progress}`}
    </button>
  );
}

function TeamPlanStep(props: {
  leadRef: ScopedThreadRef;
  teamTask: TeamTaskRef | null;
  onOpenTask: () => void;
}) {
  const plan = useAtomValue(environmentThreadDetails.teamAtom(props.leadRef));
  if (plan === null) return null;
  return <TeamPlanStepButton {...props} plan={plan} />;
}

function TeamPlanStepButton(props: {
  leadRef: ScopedThreadRef;
  plan: TeamPlan;
  teamTask: TeamTaskRef | null;
  onOpenTask: () => void;
}) {
  const { plan, onOpenTask } = props;
  const actions = useTeamPlanActions(props.leadRef, plan);
  if (plan.status === "proposed") {
    return (
      <Button
        size="xs"
        disabled={actions.pending !== null}
        onClick={() => {
          // The Task tab shows why a team cannot start yet, and any error approving it.
          if (actions.issue !== null || !actions.canOperate) return onOpenTask();
          void actions.approve().then((approved) => approved || onOpenTask());
        }}
      >
        {actions.pending === "approve" ? "Approving…" : "Approve team"}
      </Button>
    );
  }
  const ownTask = props.teamTask === null ? null : teamTaskOfThread(plan, props.teamTask);
  const task =
    ownTask !== null && !ownTask.superseded && canRetryTeamTask(plan, ownTask.task)
      ? ownTask.task
      : plan.tasks.find((candidate) => canRetryTeamTask(plan, candidate));
  if (task === undefined) {
    return plan.status === "running" ? (
      <TeamRunningPill
        progress={teamStatusText(teamPlanSummary(plan)).progress}
        onOpenTask={onOpenTask}
      />
    ) : null;
  }
  const agent = plan.agents.find((candidate) => candidate.id === task.agentId)?.label ?? task.title;
  return (
    <Button
      size="xs"
      disabled={actions.pending !== null}
      onClick={() => {
        if (!actions.canOperate) return onOpenTask();
        void actions.retry(task).then((retried) => retried || onOpenTask());
      }}
    >
      {actions.pending === `retry:${task.id}` ? "Retrying…" : `Retry ${agent}`}
    </Button>
  );
}

function ViewPullRequest(props: { threadRef: ScopedThreadRef; url: string; number: number }) {
  const openPrLink = useOpenPrLink(props.threadRef);
  const { shortLabel } = (
    sourceControlClients.parseChangeRequestUrl(props.url)?.definition ??
    sourceControlClients.get(undefined)
  ).changeRequest;
  return (
    <Button
      size="xs"
      variant="outline"
      render={<a href={props.url} target="_blank" rel="noreferrer" />}
      onClick={(event) => openPrLink(event, props.url)}
    >
      <PullRequestGlyph.pullRequest aria-hidden />
      View {shortLabel} #{props.number}
    </Button>
  );
}
