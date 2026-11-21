import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@codenine/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@codenine/client-runtime/state/runtime";
import {
  canReviewTeamTask,
  teamCancelCommand,
  teamCommandFailure,
  teamResumeCommand,
  teamTaskReviewCommand,
} from "@codenine/client-runtime/team";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  type EnvironmentId,
  type OrchestrationV2Command,
  type ScopedThreadRef,
  type TeamPlan,
  type TeamTask,
  ThreadId,
  type WorkflowDetail,
  type WorkflowStepId,
} from "@codenine/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import { type ReactNode, useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { randomUUID } from "../../lib/utils";
import {
  useAssistantMessageText,
  useQuietThreadShell,
  useQuietThreadShells,
  useQuietThreadVisibleTurnItems,
  useThreadStatus,
} from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { savedWorkflowsEnvironment } from "../../state/savedWorkflows";
import { useEnvironmentScope } from "../../state/session";
import { environmentThreadDetails } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import {
  agentModelOfSelection,
  describeAgentModel,
  useAgentModelCatalog,
} from "../agents/useAgents";
import { useAccessEnvironment } from "../settings/useAccessEnvironment";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { RunStatusBadge } from "../workflows/RunStatusBadge";
import { type CanvasStep, type CanvasStepTone, WorkflowCanvas } from "../workflows/WorkflowCanvas";
import { WorkflowBreadcrumb } from "../workflows/WorkflowHeader";
import { useWorkflowClock, useWorkflowRuns } from "../workflows/workflowHooks";
import {
  costLine,
  type FormatOptions,
  formatDay,
  formatDuration,
  formatTime,
  formatWhen,
  leadActivity,
  raisedLimitLine,
  raisedLimits,
  runStepPositions,
  type StepRunKind,
  stepRunState,
  threadWaitsForUser,
  workflowRunStatus,
} from "../workflows/workflows.logic";
import { WorkspacePage } from "./WorkspacePage";

const STEP_TONE: Record<StepRunKind, CanvasStepTone> = {
  waiting: "muted",
  "not-started": "muted",
  working: "working",
  checking: "working",
  "needs-you": "attention",
  done: "done",
  failed: "failed",
  stopped: "muted",
};

const TRIGGER_WORDS = {
  manual: "you started it",
  schedule: "on schedule",
  missed: "ran late",
} as const;

/** One run of a workflow: its steps as they stand, the lead's notes, and what waits for the user. */
export function WorkflowRunPage(props: {
  readonly name: string | null;
  readonly run: number | null;
  readonly machine: EnvironmentId | null;
}) {
  const { environment } = useAccessEnvironment(props.machine);
  const environmentId = environment?.environmentId ?? null;
  const connected = environment?.connection.phase === "connected";
  if (props.name === null || props.run === null) {
    return (
      <RunMessage machine={environmentId} title="Workflow" run={undefined}>
        <EmptyTitle>This run is not here</EmptyTitle>
        <EmptyDescription>The address does not name a workflow run.</EmptyDescription>
      </RunMessage>
    );
  }
  if (environmentId === null || !connected) {
    return (
      <RunMessage machine={environmentId} title="Workflow" run={props.run}>
        <EmptyTitle>Not connected</EmptyTitle>
        <EmptyDescription>
          Connect the computer the workflow ran on to see this run.
        </EmptyDescription>
      </RunMessage>
    );
  }
  return <RunOnMachine environmentId={environmentId} name={props.name} run={props.run} />;
}

function RunMessage(props: {
  readonly machine: EnvironmentId | null;
  readonly title: string;
  readonly name?: string | undefined;
  readonly run: number | undefined;
  readonly children: ReactNode;
}) {
  return (
    <WorkspacePage
      area="workflow"
      title={
        <WorkflowBreadcrumb
          machine={props.machine}
          workflow={{ title: props.title, name: props.name ?? null }}
          run={props.run}
        />
      }
    >
      <Empty className="h-full">
        <EmptyHeader>{props.children}</EmptyHeader>
      </Empty>
    </WorkspacePage>
  );
}

function RunOnMachine(props: {
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly run: number;
}) {
  const { environmentId, name, run } = props;
  const detail = useEnvironmentQuery(
    savedWorkflowsEnvironment.read({ environmentId, input: { name } }),
  );
  // A workflow deleted since still names its runs, so its id can come from their chats.
  const known = useWorkflowRuns(environmentId).find(
    (candidate) => candidate.workflowName === name && candidate.run === run,
  );
  const workflowId = detail.data?.id ?? known?.workflowId ?? null;
  if (workflowId === null) {
    return (
      <RunMessage machine={environmentId} title="Workflow" name={name} run={run}>
        {detail.error === null ? (
          <EmptyDescription>Loading…</EmptyDescription>
        ) : (
          <>
            <EmptyTitle>This run could not open</EmptyTitle>
            <EmptyDescription>{detail.error}</EmptyDescription>
          </>
        )}
      </RunMessage>
    );
  }
  return (
    <WorkflowRunView
      environmentId={environmentId}
      name={name}
      run={run}
      workflow={detail.data}
      leadRef={scopeThreadRef(environmentId, ThreadId.make(`thread:workflow:${workflowId}:${run}`))}
      title={detail.data?.title ?? known?.title ?? name}
    />
  );
}

function WorkflowRunView(props: {
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly run: number;
  readonly workflow: WorkflowDetail | null;
  readonly leadRef: ScopedThreadRef;
  readonly title: string;
}) {
  const { environmentId, leadRef } = props;
  const navigate = useNavigate();
  const clock = useWorkflowClock();
  const plan = useAtomValue(environmentThreadDetails.teamAtom(leadRef));
  const status = useThreadStatus(leadRef);
  const leadShell = useQuietThreadShell(leadRef);
  const shells = useQuietThreadShells();
  const catalog = useAgentModelCatalog(environmentId);
  const openThread = (threadId: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
    });

  const breadcrumb = (
    <WorkflowBreadcrumb
      machine={environmentId}
      workflow={{ title: props.title, name: props.workflow === null ? null : props.name }}
      run={props.run}
    />
  );
  if (plan === null || plan.run === undefined) {
    return (
      <WorkspacePage area="workflow" title={breadcrumb}>
        <Empty className="h-full">
          <EmptyHeader>
            {status === "live" || status === "deleted" ? (
              <>
                <EmptyTitle>This run is not here</EmptyTitle>
                <EmptyDescription>
                  Its chat is gone, or it was never started on this computer.
                </EmptyDescription>
              </>
            ) : (
              <EmptyDescription>Loading the run…</EmptyDescription>
            )}
          </EmptyHeader>
        </Empty>
      </WorkspacePage>
    );
  }

  const run = plan.run;
  const chatThreadId = run.chatThreadId;
  const stepShells = new Map(
    shells.flatMap((shell) =>
      shell.environmentId === environmentId &&
      shell.source.teamTask?.rootThreadId === leadRef.threadId
        ? [[shell.id, shell] as const]
        : [],
    ),
  );
  const waitsForUser = (task: TeamTask) => {
    const shell = task.threadId === null ? undefined : stepShells.get(task.threadId);
    return shell !== undefined && threadWaitsForUser(shell);
  };
  const asking = plan.tasks.filter((task) => task.status === "running" && waitsForUser(task));
  const runStatus = workflowRunStatus(plan, asking.length > 0);
  const finished = runStatus === "done" || runStatus === "failed" || runStatus === "stopped";
  const startedAt = Date.parse(run.startedAt);
  const endedAt = finished
    ? Date.parse(leadShell?.latestRun?.completedAt ?? plan.updatedAt)
    : clock.nowMs;
  const positions = runStepPositions(plan.tasks, props.workflow?.steps ?? []);
  const agentLabel = (task: TeamTask) =>
    plan.agents.find((agent) => agent.id === task.agentId)?.label ?? "Its agent";
  const steps = plan.tasks.map((task): CanvasStep => {
    const state = stepRunState(plan.status, task, waitsForUser(task));
    return {
      id: task.id as string as WorkflowStepId,
      title: task.title,
      agent: agentLabel(task),
      agentTone: "agent",
      detail: state.label,
      tone: STEP_TONE[state.kind],
      problem: null,
      position: positions.get(task.id) ?? { x: 0, y: 0 },
      dependsOn: task.dependsOn.map((dependency) => dependency as string as WorkflowStepId),
    };
  });
  const leadModel =
    leadShell === null
      ? "its model"
      : describeAgentModel(
          catalog,
          agentModelOfSelection(catalog.entries, leadShell.modelSelection),
        ).name;
  const header = [
    `Started ${formatWhen(startedAt, clock)}`,
    Number.isNaN(endedAt) ? null : formatDuration(Math.max(0, endedAt - startedAt)),
    costLine(run.costUsd, run.limits.spendUsd),
  ]
    .filter((part) => part !== null)
    .join(" · ");

  return (
    <WorkspacePage
      area="workflow"
      title={breadcrumb}
      subtitle={<RunStatusBadge status={runStatus} size="lg" />}
      actions={
        <>
          <span className="hidden text-muted-foreground text-xs md:inline">{header}</span>
          {finished ? null : <StopRunButton environmentId={environmentId} leadRef={leadRef} />}
        </>
      }
    >
      <div className="flex min-h-full flex-col lg:flex-row">
        <div className="flex min-w-0 flex-1 flex-col">
          <section aria-label="Steps" className="relative h-96 shrink-0 border-border border-b">
            <WorkflowCanvas
              mode="run"
              trigger={{
                kicker: "Started",
                title: formatDay(startedAt, clock),
                detail: `${formatTime(startedAt, clock)} · ${TRIGGER_WORDS[run.trigger]}`,
                position: props.workflow?.trigger.position ?? triggerFallback(steps),
              }}
              lead={{
                model: leadModel,
                activity: leadActivity(plan, (task) => task.title),
                goal: plan.goal,
              }}
              steps={steps}
              selection={null}
              onSelect={(selection) => {
                if (selection?.kind === "lead") openThread(leadRef.threadId);
                if (selection?.kind !== "step") return;
                // A run's task carries its step's id.
                const task = plan.tasks.find(
                  (candidate) => (candidate.id as string) === selection.id,
                );
                if (task?.threadId != null) openThread(task.threadId);
              }}
            />
          </section>
          <LeadNotes
            leadRef={leadRef}
            clock={clock}
            onOpen={() => openThread(leadRef.threadId)}
            onOpenChat={chatThreadId === undefined ? null : () => openThread(chatThreadId)}
          />
        </div>
        <aside
          aria-label="Waiting for you"
          className="flex flex-col gap-4 border-border border-t p-5 lg:w-104 lg:shrink-0 lg:border-t-0 lg:border-l"
        >
          <span className="text-muted-foreground text-xs md:hidden">{header}</span>
          <RunActions
            environmentId={environmentId}
            leadRef={leadRef}
            plan={plan}
            workflow={props.workflow}
            asking={asking}
            onOpenThread={openThread}
          />
        </aside>
      </div>
    </WorkspacePage>
  );
}

function triggerFallback(steps: ReadonlyArray<CanvasStep>) {
  const xs = steps.map((step) => step.position.x);
  return { x: (xs.length === 0 ? 0 : Math.min(...xs)) - 280, y: 0 };
}

const newCommandId = () => CommandId.make(randomUUID());

/** Sends one team command for the run and reports a rejection. */
function useRunCommand(environmentId: EnvironmentId) {
  const permitted = useAtomValue(
    orchestrationEnvironment.v2.dispatchCommand.permissionAtom(environmentId),
  );
  const hasScope = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const dispatch = useAtomCommand(orchestrationEnvironment.v2.dispatchCommand, {
    reportFailure: false,
  });
  const [pending, setPending] = useState<string | null>(null);
  const send = async (key: string, command: OrchestrationV2Command): Promise<boolean> => {
    if (!permitted || !hasScope || pending !== null) return false;
    setPending(key);
    const result = await dispatch({ environmentId, input: command });
    setPending(null);
    if (result._tag === "Success") return true;
    if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: "That did not reach the run",
        description: teamCommandFailure(squashAtomCommandFailure(result)).message,
      });
    }
    return false;
  };
  return { canOperate: permitted && hasScope, pending, send };
}

function StopRunButton(props: {
  readonly environmentId: EnvironmentId;
  readonly leadRef: ScopedThreadRef;
}) {
  const { canOperate, pending, send } = useRunCommand(props.environmentId);
  const stop = async () => {
    const confirmed = await settlePromise(() =>
      ensureLocalApi().dialogs.confirm(
        "Stop this run?\nRunning steps stop, and steps that have not started will not start.",
        { variant: "destructive" },
      ),
    );
    if (confirmed._tag !== "Success" || !confirmed.value) return;
    await send(
      "stop",
      teamCancelCommand({ threadId: props.leadRef.threadId, commandId: newCommandId() }),
    );
  };
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={!canOperate || pending !== null}
      onClick={() => void stop()}
    >
      {pending === "stop" ? "Stopping…" : "Stop run"}
    </Button>
  );
}

const LIMIT_TITLES = {
  spend: "It reached its spending limit",
  unpriced: "Its cost can't be estimated",
  time: "It reached its time limit",
} as const;

/** What waits for the user: a limit or an undecided step, results to judge, and steps that ask. */
function RunActions(props: {
  readonly environmentId: EnvironmentId;
  readonly leadRef: ScopedThreadRef;
  readonly plan: TeamPlan;
  readonly workflow: WorkflowDetail | null;
  readonly asking: ReadonlyArray<TeamTask>;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { plan, leadRef } = props;
  const run = plan.run;
  const { canOperate, pending, send } = useRunCommand(props.environmentId);
  const [sendingBack, setSendingBack] = useState<TeamTask | null>(null);
  const clock = useWorkflowClock();
  if (run === undefined) return null;
  const threadId = leadRef.threadId;
  const reviewing = plan.tasks.filter((task) => canReviewTeamTask(plan, task));
  const hold = plan.hold;
  const limitReason = hold === undefined || hold.reason === "review" ? null : hold.reason;
  const raised =
    limitReason === null
      ? null
      : raisedLimits(run.limits, props.workflow?.lead.limits ?? null, limitReason, {
          costUsd: run.costUsd,
          minutes: (clock.nowMs - Date.parse(run.startedAt)) / 60_000,
        });
  const review = (task: TeamTask, verdict: "accept" | "revise", notes?: string) =>
    send(
      `review:${task.id}`,
      teamTaskReviewCommand({
        threadId,
        planId: plan.id,
        task,
        verdict,
        notes,
        commandId: newCommandId(),
      }),
    );
  const nothing = hold === undefined && reviewing.length === 0 && props.asking.length === 0;
  return (
    <>
      {limitReason === null || raised === null ? null : (
        <Alert variant="warning">
          <AlertTitle>{LIMIT_TITLES[limitReason]}</AlertTitle>
          <AlertDescription>
            <p>
              {limitReason === "unpriced"
                ? "Codenine has no price for a model this run uses, so its spending limit can't stop it. Steps already running finish; nothing new starts until you decide."
                : "The lead stopped to ask whether to go on. Steps already running finish; nothing new starts until you decide."}
            </p>
            <span className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={!canOperate || pending !== null}
                onClick={() =>
                  void send(
                    "resume",
                    teamResumeCommand({
                      threadId,
                      planId: plan.id,
                      limits: raised,
                      commandId: newCommandId(),
                    }),
                  )
                }
              >
                {limitReason === "unpriced" ? "Go on" : "Go on,"}{" "}
                {raisedLimitLine(run.limits, raised, limitReason)}
              </Button>
              <StopRunButton environmentId={props.environmentId} leadRef={leadRef} />
            </span>
          </AlertDescription>
        </Alert>
      )}
      {hold?.reason === "review" ? (
        <Alert variant="warning">
          <AlertTitle>The lead left a step for you</AlertTitle>
          <AlertDescription>
            It ended its turn without deciding. Accept the result below, or send it back with what
            should change.
          </AlertDescription>
        </Alert>
      ) : null}
      {reviewing.map((task) => (
        <section
          key={task.id}
          aria-label={`${task.title} waits for review`}
          className="flex flex-col gap-2.5 rounded-xl border border-border bg-card p-4"
        >
          <span className="font-medium text-foreground text-sm">
            {task.title} is ready for review
          </span>
          {task.result === null ? null : (
            <p className="line-clamp-5 whitespace-pre-wrap text-muted-foreground text-xs">
              {task.result}
            </p>
          )}
          <span className="text-muted-foreground text-xs">
            {hold?.reason === "review"
              ? "The lead is waiting for you to decide."
              : "The lead is checking it. You can decide instead."}
          </span>
          <span className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={!canOperate || pending !== null}
              onClick={() => void review(task, "accept")}
            >
              Accept
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!canOperate || pending !== null}
              onClick={() => setSendingBack(task)}
            >
              Send back…
            </Button>
            {task.threadId === null ? null : (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  if (task.threadId !== null) props.onOpenThread(task.threadId);
                }}
              >
                Open chat
              </Button>
            )}
          </span>
        </section>
      ))}
      {props.asking.map((task) => (
        <section
          key={task.id}
          aria-label={`${task.title} waits for your answer`}
          className="flex flex-col gap-2.5 rounded-xl border border-warning/40 bg-warning/4 p-4"
        >
          <span className="font-medium text-foreground text-sm">
            {task.title} is waiting for your answer
          </span>
          <span className="text-muted-foreground text-xs">
            Its agent asked before going on. This also waits in your Inbox.
          </span>
          <Button
            size="sm"
            className="self-start"
            onClick={() => {
              if (task.threadId !== null) props.onOpenThread(task.threadId);
            }}
          >
            Open to answer
          </Button>
        </section>
      ))}
      {nothing ? (
        <p className="text-muted-foreground text-sm">
          {plan.status === "running"
            ? "Nothing waits for you. The lead checks each step as it finishes."
            : (run.headline ?? "This run is over.")}
        </p>
      ) : null}
      {sendingBack === null ? null : (
        <SendBackDialog
          task={sendingBack}
          busy={pending !== null}
          onSend={async (notes) => {
            if (await review(sendingBack, "revise", notes)) setSendingBack(null);
          }}
          onClose={() => setSendingBack(null)}
        />
      )}
    </>
  );
}

function SendBackDialog(props: {
  readonly task: TeamTask;
  readonly busy: boolean;
  readonly onSend: (notes: string) => Promise<void>;
  readonly onClose: () => void;
}) {
  const [notes, setNotes] = useState("");
  const ready = notes.trim() !== "";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <form
          noValidate
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) void props.onSend(notes);
          }}
        >
          <DialogHeader>
            <DialogTitle>Send {props.task.title} back</DialogTitle>
            <DialogDescription>
              Its agent continues in the same chat with your notes, and the lead checks the result
              again.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Textarea
              aria-label="What should change"
              rows={5}
              placeholder="What should change"
              value={notes}
              disabled={props.busy}
              onChange={(event) => setNotes(event.currentTarget.value)}
            />
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" size="sm" disabled={props.busy} onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={props.busy || !ready}>
              Send back
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

/** The lead's messages in the run, with their times, newest last. */
function LeadNotes(props: {
  readonly leadRef: ScopedThreadRef;
  readonly clock: FormatOptions;
  readonly onOpen: () => void;
  /** Opens the workflow's chat, which this run reports to. */
  readonly onOpenChat: (() => void) | null;
}) {
  const items = useQuietThreadVisibleTurnItems(props.leadRef);
  const notes = items.flatMap((row) => {
    if (row.item.type !== "assistant_message") return [];
    const at = row.item.completedAt ?? row.item.startedAt;
    return [{ id: row.item.id, at: at === null ? null : DateTime.toEpochMillis(at) }];
  });
  return (
    <section aria-labelledby="lead-notes-title" className="flex flex-col gap-3 px-6 py-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="lead-notes-title" className="font-semibold text-foreground text-sm">
          Lead's notes
        </h2>
        <span className="flex gap-1">
          <Button size="xs" variant="link" onClick={props.onOpen}>
            Open the lead's chat
          </Button>
          {props.onOpenChat === null ? null : (
            <Button size="xs" variant="link" onClick={props.onOpenChat}>
              Open chat
            </Button>
          )}
        </span>
      </div>
      {notes.length === 0 ? (
        <p className="text-muted-foreground text-sm">The lead hasn't written anything yet.</p>
      ) : (
        <ol className="flex max-w-3xl flex-col gap-2.5">
          {notes.map((note) => (
            <LeadNote
              key={note.id}
              leadRef={props.leadRef}
              itemId={note.id}
              time={note.at === null ? "" : formatTime(note.at, props.clock)}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function LeadNote(props: {
  readonly leadRef: ScopedThreadRef;
  readonly itemId: string;
  readonly time: string;
}) {
  // Each note reads its own text, so a streaming reply re-renders only its row.
  const text = useAssistantMessageText(props.leadRef, props.itemId);
  return (
    <li className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-3 text-sm">
      <span className="text-muted-foreground text-xs tabular-nums">{props.time}</span>
      <span className="line-clamp-4 whitespace-pre-wrap text-foreground">{text ?? ""}</span>
    </li>
  );
}
