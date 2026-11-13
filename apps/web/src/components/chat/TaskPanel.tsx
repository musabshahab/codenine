import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@codenine/client-runtime/environment";
import {
  canCancelTeam,
  canRetryTeamTask,
  teamDraftChangeCount,
  teamDraftOf,
  teamRunsInSequence,
  teamStatusText,
  teamStepFlows,
  teamStepList,
  teamTaskOfThread,
  teamTaskStatus,
  teamTaskWaitsFor,
} from "@codenine/client-runtime/team";
import type {
  ScopedThreadRef,
  TeamAgent,
  TeamAgentId,
  TeamDraft,
  TeamPlan,
  TeamPlanStatus,
  TeamTask,
  TeamTaskRef,
} from "@codenine/contracts";
import { formatDuration } from "@codenine/shared/orchestrationTiming";
import { teamPlanSummary } from "@codenine/shared/team";
import { formatTokens } from "@codenine/shared/usageFormat";
import { Link } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleSlashIcon,
  CircleXIcon,
  ClockIcon,
  HandIcon,
  InfoIcon,
  type LucideIcon,
  RotateCcwIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { ComposerHandleContext } from "../../composerHandleContext";
import { tickTextContent } from "../../lib/tickTextContent";
import { cn } from "../../lib/utils";
import { useQuietThreadShell, useThreadStatus } from "../../state/entities";
import { environmentThreadDetails } from "../../state/threads";
import { RelativeTime } from "../RelativeTime";
import { Badge } from "../ui/badge";
import { Button, InlineButton } from "../ui/button";
import { Group, GroupSeparator } from "../ui/group";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { TeamModelLabel, useTeamModelCatalog, type TeamModelCatalog } from "./TeamAgentModel";
import { TeamDraftEditor } from "./TeamDraftEditor";
import {
  TeamAgentAvatar,
  TeamSectionHeading,
  TeamStepFlow,
  TeamStepRow,
  type TeamStepState,
} from "./TeamParts";
import { TeamResultText } from "./TeamResultText";
import { useTeamPlanActions, type TeamPlanPendingAction } from "./useTeamPlanActions";

const TEAM_PILL: Record<TeamPlanStatus, { Icon: LucideIcon; label: string; tone: string }> = {
  proposed: {
    Icon: HandIcon,
    label: "Waiting for your approval",
    tone: "bg-warning/12 text-warning-foreground",
  },
  running: {
    Icon: CircleDotIcon,
    label: "Running",
    tone: "bg-primary/16 text-foreground [&>svg]:text-primary",
  },
  failed: { Icon: CircleXIcon, label: "A step failed", tone: "bg-error/12 text-error-foreground" },
  completed: {
    Icon: CircleCheckIcon,
    label: "Done",
    tone: "bg-success/12 text-success-foreground",
  },
  cancelled: { Icon: CircleSlashIcon, label: "Cancelled", tone: "bg-muted text-muted-foreground" },
};

const STEP_SEGMENT: Record<TeamStepState, string> = {
  proposed: "bg-foreground/10",
  running: "bg-primary",
  completed: "bg-success",
  failed: "bg-error",
  waiting: "bg-foreground/10",
  blocked: "bg-foreground/10",
  cancelled: "bg-foreground/10",
  not_started: "bg-foreground/10",
};

/** The Task tab: the team a lead proposed or runs, or the team an agent's thread works for. */
export function TaskPanel(props: {
  threadRef: ScopedThreadRef;
  /** Opens the Changes tab; unset where the thread has no diff to show. */
  onViewChanges: (() => void) | undefined;
}) {
  const shell = useQuietThreadShell(props.threadRef);
  const teamTask = shell?.source.teamTask;
  return (
    // Its pickers hand focus back to their own triggers, not to the composer.
    <ComposerHandleContext value={null}>
      {teamTask === undefined ? (
        <LeadTaskPanel threadRef={props.threadRef} onViewChanges={props.onViewChanges} />
      ) : (
        <AgentTaskPanel
          threadRef={props.threadRef}
          teamTask={teamTask}
          onViewChanges={props.onViewChanges}
        />
      )}
    </ComposerHandleContext>
  );
}

function LeadTaskPanel(props: {
  threadRef: ScopedThreadRef;
  onViewChanges: (() => void) | undefined;
}) {
  const plan = useAtomValue(environmentThreadDetails.teamAtom(props.threadRef));
  const loading = useThreadStatus(props.threadRef) !== "live";
  if (plan === null) {
    return (
      <TaskPanelLayout footer={null}>
        <p className="text-muted-foreground">
          {loading ? "Loading the team…" : "This thread has no team. Ask the agent to propose one."}
        </p>
      </TaskPanelLayout>
    );
  }
  return (
    <TeamPlanView
      leadRef={props.threadRef}
      plan={plan}
      agentTask={null}
      intro={null}
      onViewChanges={props.onViewChanges}
    />
  );
}

/** An agent's thread shows its lead's plan, which it reads from the lead's own thread. */
function AgentTaskPanel(props: {
  threadRef: ScopedThreadRef;
  teamTask: TeamTaskRef;
  onViewChanges: (() => void) | undefined;
}) {
  const { teamTask } = props;
  const leadRef = scopeThreadRef(props.threadRef.environmentId, teamTask.rootThreadId);
  const lead = useQuietThreadShell(leadRef);
  const plan = useAtomValue(environmentThreadDetails.teamAtom(leadRef));
  const loading = useThreadStatus(leadRef) !== "live";
  const agentTask = plan === null ? null : teamTaskOfThread(plan, teamTask);
  const intro = (
    <Link
      to="/$environmentId/$threadId"
      params={{ environmentId: leadRef.environmentId, threadId: leadRef.threadId }}
      className="flex flex-col gap-0.5 rounded-lg border bg-card px-3 py-2.5 outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <span className="text-muted-foreground text-xs">Part of the task</span>
      <span className="flex min-w-0 items-center gap-1.5 font-medium">
        <span className="truncate">{lead?.title ?? "Lead thread"}</span>
        <ArrowUpRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      </span>
    </Link>
  );
  if (plan === null || agentTask === null) {
    return (
      <TaskPanelLayout footer={null}>
        {intro}
        <p className="text-muted-foreground">
          {plan === null && loading
            ? "Loading the team…"
            : "The lead has a different team now, so this agent's task is no longer on it."}
        </p>
      </TaskPanelLayout>
    );
  }
  return (
    <TeamPlanView
      leadRef={leadRef}
      plan={plan}
      agentTask={{ ...agentTask, threadRef: props.threadRef, attempt: teamTask.attempt }}
      intro={intro}
      onViewChanges={props.onViewChanges}
    />
  );
}

interface AgentTask {
  readonly task: TeamTask;
  readonly superseded: boolean;
  readonly attempt: number;
  readonly threadRef: ScopedThreadRef;
}

function TaskPanelLayout(props: { footer: ReactNode; children: ReactNode }) {
  return (
    <section aria-label="Task" className="flex min-h-0 flex-1 flex-col text-sm">
      <ScrollArea scrollFade className="min-h-0 flex-1">
        <div className="flex flex-col gap-5.5 p-4 pb-7">{props.children}</div>
      </ScrollArea>
      {props.footer}
    </section>
  );
}

function TeamPlanView(props: {
  leadRef: ScopedThreadRef;
  plan: TeamPlan;
  /** On an agent's thread: the task it runs, which the list highlights. */
  agentTask: AgentTask | null;
  intro: ReactNode;
  onViewChanges: (() => void) | undefined;
}) {
  const { leadRef, plan, agentTask } = props;
  const lead = useQuietThreadShell(leadRef);
  const catalog = useTeamModelCatalog(leadRef.environmentId, lead?.projectId ?? null);
  const {
    canOperate,
    proposed,
    resolved,
    issue,
    notice: shownNotice,
    error,
    pending,
    busy,
    change,
    discard,
    dismissNotice,
    ...actions
  } = useTeamPlanActions(leadRef, plan);
  const retry = (task: TeamTask, agentId?: TeamAgentId) => void actions.retry(task, agentId);
  const changes = resolved.dirty ? teamDraftChangeCount(teamDraftOf(plan), resolved.draft) : 0;
  const cancelButton = canCancelTeam(plan) ? (
    <Button
      size="xs"
      variant="ghost-destructive"
      disabled={busy}
      onClick={() => void actions.cancel()}
    >
      {pending === "cancel" ? "Cancelling…" : "Cancel team"}
    </Button>
  ) : null;
  const note = footerNote({ plan, proposed, dirty: resolved.dirty, canOperate, agentTask });
  const buttons = proposed ? (
    <>
      {cancelButton}
      <span className="ms-auto flex items-center gap-2">
        {resolved.dirty ? (
          <Button
            size="xs"
            variant="outline"
            disabled={busy || issue !== null}
            onClick={() => void actions.save()}
          >
            {pending === "save" ? "Saving…" : "Save"}
          </Button>
        ) : null}
        <Button size="xs" disabled={busy || issue !== null} onClick={() => void actions.approve()}>
          {pending === "approve" ? "Approving…" : "Approve and start"}
        </Button>
      </span>
    </>
  ) : cancelButton !== null || props.onViewChanges !== undefined ? (
    <>
      {cancelButton}
      {props.onViewChanges === undefined ? null : (
        <span className="ms-auto">
          <Button size="xs" variant="outline" onClick={props.onViewChanges}>
            View changes
          </Button>
        </span>
      )}
    </>
  ) : null;
  const footer = (
    <footer className="flex flex-col gap-2.5 border-t px-4 pt-3 pb-3.5 text-xs">
      {shownNotice !== null ? (
        <div role="status" className="flex items-start gap-2 text-warning-foreground">
          <p className="min-w-0 flex-1">{shownNotice}</p>
          <Button size="xs" variant="ghost" onClick={dismissNotice}>
            Dismiss
          </Button>
        </div>
      ) : null}
      {error !== null ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
      {proposed && resolved.dirty ? (
        <div className="flex items-center gap-2 text-foreground/85">
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" />
          {changes > 0
            ? `${changes} unsaved ${changes === 1 ? "change" : "changes"}`
            : "Unsaved changes"}
          <span className="ms-auto">
            <InlineButton tone="muted" disabled={pending !== null} onClick={discard}>
              Discard
            </InlineButton>
          </span>
        </div>
      ) : null}
      {proposed && issue !== null ? (
        <p role="alert" className="text-destructive">
          {issue}
        </p>
      ) : note === null ? null : (
        <p className="flex items-start gap-1.5 text-muted-foreground">
          <InfoIcon aria-hidden className="mt-px size-3.5 shrink-0" />
          {note}
        </p>
      )}
      {buttons === null ? null : <div className="flex flex-wrap items-center gap-2">{buttons}</div>}
    </footer>
  );

  return (
    <TaskPanelLayout footer={footer}>
      {props.intro}
      <TeamPlanHeader plan={plan} draft={proposed ? resolved.draft : null} />
      {proposed ? (
        <TeamDraftEditor
          draft={resolved.draft}
          catalog={catalog}
          defaultModelSelection={lead?.modelSelection ?? null}
          disabled={busy}
          onChange={change}
        />
      ) : (
        <TeamRunSteps
          plan={plan}
          catalog={catalog}
          agentTask={agentTask}
          environmentId={leadRef.environmentId}
          pendingAction={pending}
          disabled={busy}
          onRetry={retry}
        />
      )}
    </TaskPanelLayout>
  );
}

function footerNote(input: {
  plan: TeamPlan;
  proposed: boolean;
  dirty: boolean;
  canOperate: boolean;
  agentTask: AgentTask | null;
}): string | null {
  const { plan } = input;
  if (input.proposed) {
    if (!input.canOperate) return "This connection cannot change or approve the team.";
    return input.dirty
      ? null
      : "Nothing runs until you approve. To add, reorder or split steps, ask the lead.";
  }
  switch (plan.status) {
    case "running":
      return input.agentTask === null
        ? "When every step is done, the lead reviews the results and reports back."
        : "Messages here go to this agent only. To change the plan, ask the lead.";
    case "failed": {
      const stuck = plan.tasks.flatMap((task, index) =>
        task.status === "failed" || task.status === "cancelled" ? [index + 1] : [],
      );
      return stuck.length === 0
        ? null
        : `Steps that need ${teamStepList(stuck)} wait until ${stuck.length === 1 ? "it passes" : "they pass"}.`;
    }
    case "cancelled":
      return "The team was cancelled. Ask the lead for a new one.";
    default:
      return null;
  }
}

/** A step's place on the timeline, from the plan's state and the steps it waits for. */
function teamStepState(
  plan: TeamPlan,
  task: TeamTask,
  waitsFor: ReadonlyArray<number>,
): TeamStepState {
  if (plan.status === "proposed") return "proposed";
  if (waitsFor.length > 0) return "blocked";
  const { status } = teamTaskStatus(plan, task);
  return status === "pending" ? "waiting" : status;
}

/** When the team's work started and stopped, and the tokens it used. */
function teamRunTotals(plan: TeamPlan) {
  let startMs: number | null = null;
  let endMs: number | null = null;
  let tokens = 0;
  for (const task of plan.tasks) {
    const started = task.startedAt === null ? Number.NaN : Date.parse(task.startedAt);
    if (Number.isFinite(started)) startMs = startMs === null ? started : Math.min(startMs, started);
    const ended = task.completedAt === null ? Number.NaN : Date.parse(task.completedAt);
    if (Number.isFinite(ended)) endMs = endMs === null ? ended : Math.max(endMs, ended);
    if (task.usage !== undefined) tokens += task.usage.inputTokens + task.usage.outputTokens;
  }
  return { startMs, endMs: endMs ?? Date.parse(plan.updatedAt), tokens };
}

/** A duration that keeps counting while `endMs` is null, rewritten through the DOM each second. */
function TeamElapsed(props: { startMs: number; endMs: number | null }) {
  const { startMs, endMs } = props;
  return (
    <span
      className="tabular-nums"
      ref={tickTextContent(
        (nowMs) =>
          formatDuration(Math.max(1_000, Math.floor(((endMs ?? nowMs) - startMs) / 1_000) * 1_000)),
        endMs === null,
      )}
    />
  );
}

function TeamPlanHeader(props: { plan: TeamPlan; draft: TeamDraft | null }) {
  const { plan } = props;
  const summary = teamPlanSummary(plan);
  const { Icon, label, tone } = TEAM_PILL[plan.status];
  const progress = teamStatusText(summary).progress;
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex min-h-6 items-center gap-2">
        <span
          className={cn(
            "inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full ps-2 pe-2.5 font-medium text-xs",
            tone,
          )}
        >
          <Icon aria-hidden className="size-3.5 shrink-0" />
          {plan.status === "failed" && summary.failed === 0 ? "Stopped" : label}
        </span>
        <span className="ms-auto whitespace-nowrap text-muted-foreground text-xs tabular-nums">
          {progress ?? (
            <>
              Proposed <RelativeTime timestamp={plan.proposedAt} />
            </>
          )}
        </span>
      </div>
      {plan.status === "proposed" ? null : (
        <div aria-hidden className="flex h-1 gap-0.75">
          {plan.tasks.map((task) => (
            <span
              key={task.id}
              className={cn(
                "flex-1 rounded-full",
                STEP_SEGMENT[teamStepState(plan, task, teamTaskWaitsFor(plan, task))],
              )}
            />
          ))}
        </div>
      )}
      <p className="whitespace-pre-wrap break-words text-foreground/90">{plan.goal}</p>
      <TeamPlanMeta plan={plan} draft={props.draft} />
    </div>
  );
}

/** Under the goal: the team's shape while proposed, then how long it ran and what it used. */
function TeamPlanMeta(props: { plan: TeamPlan; draft: TeamDraft | null }) {
  const { plan, draft } = props;
  if (draft !== null) {
    const steps = draft.tasks.length;
    const agents = draft.agents.length;
    const parts = [
      `${steps} ${steps === 1 ? "step" : "steps"}`,
      `${agents} ${agents === 1 ? "agent" : "agents"}`,
    ];
    if (steps > 1) {
      parts.push(
        teamRunsInSequence(draft.tasks)
          ? "one step after another"
          : "some steps run at the same time",
      );
    }
    return <p className="text-muted-foreground text-xs">{parts.join(" · ")}</p>;
  }
  const totals = teamRunTotals(plan);
  if (totals.startMs === null) return null;
  const running = plan.status === "running";
  return (
    <p className="flex items-center gap-1.5 text-muted-foreground text-xs">
      <ClockIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="tabular-nums">
        {plan.status === "completed" ? "Took " : null}
        <TeamElapsed startMs={totals.startMs} endMs={running ? null : totals.endMs} />
        {totals.tokens > 0
          ? ` · ${formatTokens(totals.tokens)} tokens${running ? " so far" : ""}`
          : null}
      </span>
    </p>
  );
}

function TeamRunSteps(props: {
  plan: TeamPlan;
  catalog: TeamModelCatalog;
  agentTask: AgentTask | null;
  environmentId: ScopedThreadRef["environmentId"];
  pendingAction: TeamPlanPendingAction | null;
  disabled: boolean;
  onRetry: (task: TeamTask, agentId?: TeamAgentId) => void;
}) {
  const { plan, agentTask } = props;
  const flows = teamStepFlows(plan.tasks);
  return (
    <section aria-label="Steps" className="flex flex-col gap-3">
      <TeamSectionHeading detail={String(plan.tasks.length)}>Steps</TeamSectionHeading>
      <ol className="flex flex-col">
        {plan.tasks.map((task, index) => {
          const thisThread = agentTask?.task.id === task.id ? agentTask : null;
          return (
            <TeamRunStep
              key={task.id}
              number={index + 1}
              last={index === plan.tasks.length - 1}
              task={task}
              plan={plan}
              agent={plan.agents.find((agent) => agent.id === task.agentId) ?? null}
              flow={flows.get(task.id) ?? null}
              compact={agentTask !== null && thisThread === null}
              thisThread={thisThread}
              catalog={props.catalog}
              environmentId={props.environmentId}
              retrying={props.pendingAction === `retry:${task.id}`}
              disabled={props.disabled}
              onRetry={props.onRetry}
            />
          );
        })}
      </ol>
    </section>
  );
}

function TeamRunStep(props: {
  number: number;
  last: boolean;
  task: TeamTask;
  plan: TeamPlan;
  agent: TeamAgent | null;
  flow: string | null;
  /** On an agent's thread, the other steps show only where they stand. */
  compact: boolean;
  /** Set on the step whose thread is open. */
  thisThread: AgentTask | null;
  catalog: TeamModelCatalog;
  environmentId: ScopedThreadRef["environmentId"];
  retrying: boolean;
  disabled: boolean;
  onRetry: (task: TeamTask, agentId?: TeamAgentId) => void;
}) {
  const { task, plan, agent, thisThread, compact } = props;
  const waitsFor = teamTaskWaitsFor(plan, task);
  const state = teamStepState(plan, task, waitsFor);
  const openThreadId =
    task.threadId !== null && (thisThread === null || thisThread.superseded) ? task.threadId : null;
  const tokens = task.usage === undefined ? null : task.usage.inputTokens + task.usage.outputTokens;
  const quiet =
    state === "waiting" || state === "blocked" || state === "cancelled" || state === "not_started";
  return (
    <TeamStepRow
      number={props.number}
      state={state}
      last={props.last}
      framed={thisThread !== null ? "this" : state === "failed" && !compact ? "failed" : null}
    >
      <div className="flex items-start gap-2">
        <h4
          className={cn(
            "min-w-0 flex-1 break-words font-medium leading-5.5",
            quiet && "text-foreground/70",
          )}
        >
          {task.title}
        </h4>
        {thisThread === null ? null : (
          <span className="flex h-5.5 shrink-0 items-center">
            <Badge variant="info" size="sm">
              This thread
            </Badge>
          </span>
        )}
        <TeamStepStatus state={state} task={task} waitsFor={waitsFor} />
        {openThreadId === null ? null : (
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={
              thisThread !== null
                ? "Open the latest attempt"
                : `Open the thread for step ${props.number}`
            }
            render={
              <Link
                to="/$environmentId/$threadId"
                params={{ environmentId: props.environmentId, threadId: openThreadId }}
              />
            }
          >
            <ArrowUpRightIcon aria-hidden />
          </Button>
        )}
      </div>
      {props.flow === null || compact ? null : <TeamStepFlow text={props.flow} />}
      {thisThread === null ? null : (
        <div className="mt-2 flex flex-col gap-1">
          <span className="font-medium text-muted-foreground text-xs">Assignment</span>
          <p className="whitespace-pre-wrap break-words text-foreground/85">{task.brief}</p>
        </div>
      )}
      <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
        {agent === null ? null : (
          <>
            <span className="inline-flex min-w-0 items-center gap-1.5 text-foreground/85">
              <TeamAgentAvatar role={agent.role} size="xs" />
              <span className="truncate">{agent.label}</span>
            </span>
            <TeamModelLabel catalog={props.catalog} selection={agent.modelSelection} />
          </>
        )}
        {tokens === null ? null : (
          <span className="tabular-nums">{formatTokens(tokens)} tokens</span>
        )}
        {task.attempt > 1 ? <span>Attempt {task.attempt}</span> : null}
      </div>
      {task.result === null || compact ? null : (
        <div
          className={cn(
            "mt-2 rounded-lg border px-2.5 py-2",
            state === "failed" ? "border-error/30 bg-error/8" : "bg-card",
          )}
        >
          <TeamResultText text={task.result} failed={state === "failed"} />
        </div>
      )}
      {canRetryTeamTask(plan, task) && !compact ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <TeamTaskRetry
            task={task}
            agent={agent}
            agents={plan.agents}
            catalog={props.catalog}
            retrying={props.retrying}
            disabled={props.disabled}
            onRetry={props.onRetry}
          />
          <span className="text-muted-foreground text-xs">or ask the lead to change the plan</span>
        </div>
      ) : null}
      {thisThread?.superseded ? (
        <p className="mt-2 text-muted-foreground text-xs">
          This thread ran attempt {thisThread.attempt}. The step was retried in a new thread, which
          holds its latest result.
        </p>
      ) : null}
    </TeamStepRow>
  );
}

function TeamStepStatus(props: {
  state: TeamStepState;
  task: TeamTask;
  waitsFor: ReadonlyArray<number>;
}) {
  const { state, task } = props;
  const startMs = task.startedAt === null ? null : Date.parse(task.startedAt);
  const endMs = task.completedAt === null ? null : Date.parse(task.completedAt);
  const took =
    startMs !== null && endMs !== null ? <TeamElapsed startMs={startMs} endMs={endMs} /> : null;
  const content =
    state === "running" ? (
      <>
        Working
        {startMs === null ? null : (
          <>
            {" · "}
            <TeamElapsed startMs={startMs} endMs={null} />
          </>
        )}
      </>
    ) : state === "completed" ? (
      (took ?? "Done")
    ) : state === "failed" ? (
      took === null ? (
        "Failed"
      ) : (
        <>Failed after {took}</>
      )
    ) : state === "blocked" ? (
      `Waits for ${teamStepList(props.waitsFor)}`
    ) : state === "waiting" ? (
      "Waiting"
    ) : state === "cancelled" ? (
      "Cancelled"
    ) : state === "not_started" ? (
      "Not started"
    ) : null;
  if (content === null) return null;
  return (
    <span
      className={cn(
        "shrink-0 whitespace-nowrap text-xs leading-5.5 tabular-nums",
        state === "running"
          ? "text-foreground/85"
          : state === "failed"
            ? "text-error-foreground"
            : "text-muted-foreground",
      )}
    >
      {content}
    </span>
  );
}

/** Retry on the task's agent, or pick another agent from the plan, such as a stronger model. */
function TeamTaskRetry(props: {
  task: TeamTask;
  agent: TeamAgent | null;
  agents: ReadonlyArray<TeamAgent>;
  catalog: TeamModelCatalog;
  retrying: boolean;
  disabled: boolean;
  onRetry: (task: TeamTask, agentId?: TeamAgentId) => void;
}) {
  const { task } = props;
  const others = props.agents.filter((agent) => agent.id !== task.agentId);
  return (
    <Group aria-label={`Retry ${task.title}`}>
      <Button size="xs" disabled={props.disabled} onClick={() => props.onRetry(task)}>
        <RotateCcwIcon aria-hidden />
        {props.retrying ? "Retrying…" : `Retry ${props.agent?.label ?? "step"}`}
      </Button>
      {others.length > 0 ? (
        <>
          <GroupSeparator />
          <Menu>
            <MenuTrigger
              disabled={props.disabled}
              render={<Button size="icon-xs" aria-label="Retry on another agent" />}
            >
              <ChevronDownIcon aria-hidden="true" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuGroup>
                <MenuGroupLabel>Retry on</MenuGroupLabel>
                {others.map((agent) => (
                  <MenuItem key={agent.id} onClick={() => props.onRetry(task, agent.id)}>
                    <TeamAgentAvatar role={agent.role} size="md" />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{agent.label}</span>
                      <span className="text-muted-foreground text-xs">
                        <TeamModelLabel catalog={props.catalog} selection={agent.modelSelection} />
                      </span>
                    </span>
                  </MenuItem>
                ))}
              </MenuGroup>
            </MenuPopup>
          </Menu>
        </>
      ) : null}
    </Group>
  );
}
