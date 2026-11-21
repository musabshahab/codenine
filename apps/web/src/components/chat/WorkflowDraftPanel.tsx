import { teamStepFlows } from "@codenine/client-runtime/team";
import { isAtomCommandInterrupted, settlePromise } from "@codenine/client-runtime/state/runtime";
import {
  type AgentSummary,
  type EnvironmentId,
  type SavedWorkflowLink,
  type ScopedThreadRef,
  TeamTaskId,
  type WorkflowDraft,
  type WorkflowDraftStep,
  type WorkflowSchedule,
  type WorkflowSummary,
} from "@codenine/contracts";
import { scopeThreadRef } from "@codenine/client-runtime/environment";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { AsyncResult, Atom } from "effect/reactivity";
import { WorkflowIcon } from "lucide-react";
import { type ReactNode, useContext, useEffect, useState } from "react";

import { commandErrorMessage } from "../../lib/commandError";
import { ensureLocalApi } from "../../localApi";
import { useThreadStatus } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { savedWorkflowsEnvironment } from "../../state/savedWorkflows";
import { environmentThreadDetails } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { buildThreadRouteParams } from "../../threadRoutes";
import { newWorkflowHref, workflowHref } from "../../workflowLinks";
import { agentTitle, useAgents } from "../agents/useAgents";
import { ConnectorMark } from "../connectors/ConnectorMark";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { RunStatusBadge } from "../workflows/RunStatusBadge";
import { RunWorkflowButton } from "../workflows/RunWorkflowButton";
import { readWorkflowEdit, setWorkflowEdit, workflowEditKey } from "../workflows/workflowEditStore";
import { useWorkflowClock, useWorkflowRuns } from "../workflows/workflowHooks";
import {
  CARD_STATUS_LABELS,
  definitionOf,
  formatCost,
  formatDuration,
  formatWhen,
  resolveWorkflowEdit,
  runDurationMs,
  type WorkflowRun,
  type WorkflowRunStatus,
  workflowCardStatus,
  workflowWithDraft,
} from "../workflows/workflows.logic";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { TaskPanelFooter, TaskPanelLayout, TaskPanelNote } from "./TaskPanel";
import { TeamSectionHeading, TeamStepFlow, TeamStepRow } from "./TeamParts";
import {
  chatWorkflowRuns,
  draftStepsOver,
  listAnsweredSince,
  type SwitchedWorkflow,
  switchedWorkflow,
  workflowDraftStatus,
  workflowScheduleText,
} from "./workflowDraft.logic";

const NO_WORKFLOW_DRAFT_ATOM = Atom.make<WorkflowDraft | null>(null);
const NO_SAVED_WORKFLOW_ATOM = Atom.make<SavedWorkflowLink | null>(null);
const NO_LIST_ATOM = Atom.make<AsyncResult.AsyncResult<unknown, unknown>>(AsyncResult.initial());

/** The workflow a lead drafted in a chat, read from its thread detail; null without one. */
export function useWorkflowDraft(threadRef: ScopedThreadRef | null): WorkflowDraft | null {
  return useAtomValue(
    threadRef === null
      ? NO_WORKFLOW_DRAFT_ATOM
      : environmentThreadDetails.workflowDraftAtom(threadRef),
  );
}

/** The workflow a chat's draft was saved as; null until the user saves one. */
export function useSavedWorkflowLink(threadRef: ScopedThreadRef | null): SavedWorkflowLink | null {
  return useAtomValue(
    threadRef === null
      ? NO_SAVED_WORKFLOW_ATOM
      : environmentThreadDetails.savedWorkflowAtom(threadRef),
  );
}

/**
 * The Workflow tab: the workflow a lead drafted in this chat, or the workflow it was saved as. The
 * user reviews and saves a draft in the editor.
 */
export function WorkflowDraftPanel(props: { threadRef: ScopedThreadRef }) {
  const draft = useWorkflowDraft(props.threadRef);
  const link = useSavedWorkflowLink(props.threadRef);
  const loading = useThreadStatus(props.threadRef) !== "live";
  if (draft === null && link === null) {
    return (
      <PanelMessage>
        {loading
          ? "Loading the draft…"
          : "No workflow is drafted in this chat. Turn on Workflow in the composer and describe what should happen."}
      </PanelMessage>
    );
  }
  return <WorkflowDraftStatusView threadRef={props.threadRef} draft={draft} link={link} />;
}

function PanelMessage(props: { children: ReactNode; action?: ReactNode }) {
  return (
    <TaskPanelLayout label="Workflow" footer={null}>
      <p className="text-muted-foreground">{props.children}</p>
      {props.action}
    </TaskPanelLayout>
  );
}

function WorkflowDraftStatusView(props: {
  threadRef: ScopedThreadRef;
  draft: WorkflowDraft | null;
  link: SavedWorkflowLink | null;
}) {
  const { threadRef, draft, link } = props;
  const registry = useContext(RegistryContext);
  const listAtom =
    link === null
      ? null
      : savedWorkflowsEnvironment.list({ environmentId: threadRef.environmentId, input: {} });
  const list = useEnvironmentQuery(listAtom);
  const listResult = useAtomValue<AsyncResult.AsyncResult<unknown, unknown>>(
    listAtom ?? NO_LIST_ATOM,
  );
  const workflows = list.data?.workflows ?? null;
  const linkKey = link === null ? null : `${link.id}:${link.proposedAt}`;
  const unlisted =
    link !== null && workflows !== null && !workflows.some((entry) => entry.id === link.id);
  // The list as it was when this client asked again for a list that misses the linked workflow.
  const [asked, setAsked] = useState<{
    readonly key: string;
    readonly before: AsyncResult.AsyncResult<unknown, unknown>;
  } | null>(null);
  const { refresh } = list;
  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- refetch the list once when the thread names a workflow this client has not listed
  useEffect(() => {
    if (!unlisted || linkKey === null || listAtom === null || asked?.key === linkKey) return;
    // oxlint-disable-next-line react/set-state-in-effect -- records the list this refetch replaces, which only this refetch knows
    setAsked({ key: linkKey, before: registry.get(listAtom) });
    refresh();
  }, [unlisted, linkKey, listAtom, asked?.key, registry, refresh]);
  // A refresh restarts a fetch in flight, so only an answer to this ask settles after it.
  const listedAfterLink =
    asked !== null && asked.key === linkKey && listAnsweredSince(listResult, asked.before);
  const status = workflowDraftStatus({ draft, link, workflows, listedAfterLink });

  switch (status.kind) {
    case "checking":
      return list.error === null ? (
        <PanelMessage>Checking the saved workflow…</PanelMessage>
      ) : (
        <PanelMessage
          action={
            <div>
              <Button size="xs" variant="outline" onClick={refresh}>
                Try again
              </Button>
            </div>
          }
        >
          {list.error}
        </PanelMessage>
      );
    case "unsaved":
      return draft === null ? (
        <TaskPanelLayout label="Workflow" footer={null}>
          <p className="text-muted-foreground">This chat's workflow was deleted.</p>
          <ChatWorkflowRuns threadRef={threadRef} link={link} workflowName={null} />
        </TaskPanelLayout>
      ) : (
        <UnsavedDraftView
          threadRef={threadRef}
          draft={draft}
          deleted={status.deleted}
          link={link}
        />
      );
    case "saved":
      return <SavedWorkflowView threadRef={threadRef} link={link} workflow={status.workflow} />;
    case "changed":
      return draft === null ? null : (
        <ChangedWorkflowView
          threadRef={threadRef}
          link={link}
          draft={draft}
          workflow={status.workflow}
          onReadFailed={refresh}
        />
      );
  }
}

function stepFlows(steps: ReadonlyArray<Pick<WorkflowDraftStep, "id" | "dependsOn">>) {
  return teamStepFlows(
    steps.map((step) => ({
      id: TeamTaskId.make(step.id),
      dependsOn: step.dependsOn.map((id) => TeamTaskId.make(id)),
    })),
  );
}

const CANNOT_CHANGE = "This connection can see workflows but cannot change them.";

/** A control, with why it is disabled on hover when something stops it. */
function WithReason(props: { reason: string | null; children: ReactNode }) {
  if (props.reason === null) return props.children;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>{props.children}</TooltipTrigger>
      <TooltipPopup>{props.reason}</TooltipPopup>
    </Tooltip>
  );
}

function UnsavedDraftView(props: {
  threadRef: ScopedThreadRef;
  draft: WorkflowDraft;
  deleted: boolean;
  link: SavedWorkflowLink | null;
}) {
  const { threadRef, draft } = props;
  const router = useRouter();
  const canSave = useAtomValue(
    savedWorkflowsEnvironment.save.permissionAtom(threadRef.environmentId),
  );
  const waitsForAgent = draft.steps.some((step) => step.agent === null);
  const note =
    (props.deleted
      ? "The workflow saved from this draft was deleted."
      : "Nothing is saved until you save it in the editor.") +
    (draft.schedule !== null ? " A saved workflow starts off." : "") +
    (waitsForAgent ? " It can't run until every step has an agent." : "");
  const footer = (
    <TaskPanelFooter>
      <TaskPanelNote>{note}</TaskPanelNote>
      <div className="flex flex-wrap items-center gap-2">
        <WithReason reason={canSave ? null : CANNOT_CHANGE}>
          <Button
            size="xs"
            disabled={!canSave}
            onClick={() =>
              void router.navigate({
                href: newWorkflowHref(threadRef.environmentId, { fromThread: threadRef.threadId }),
              })
            }
          >
            Review and save
          </Button>
        </WithReason>
      </div>
    </TaskPanelFooter>
  );
  return (
    <TaskPanelLayout label="Workflow" footer={footer}>
      <WorkflowHeading
        title={draft.title}
        badge={<Badge variant="secondary">Draft</Badge>}
        description={draft.description}
        schedule={draft.schedule}
        goal={draft.goal}
      />
      <WorkflowSteps environmentId={threadRef.environmentId} steps={draft.steps} />
      {props.deleted ? (
        <ChatWorkflowRuns threadRef={threadRef} link={props.link} workflowName={null} />
      ) : null}
    </TaskPanelLayout>
  );
}

/**
 * Turns the saved workflow on or off. It shows the answer at once and stays busy until the list
 * catches up, so a second press cannot send the old state again.
 */
function useWorkflowSwitch(environmentId: EnvironmentId, listed: WorkflowSummary) {
  const setEnabled = useAtomCommand(savedWorkflowsEnvironment.setEnabled, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState(false);
  const [switched, setSwitched] = useState<SwitchedWorkflow | null>(null);
  const shown = switchedWorkflow(listed, switched);
  const { workflow } = shown;

  const toggle = async () => {
    const enabled = !workflow.enabled;
    const words = enabled ? "on" : "off";
    setBusy(true);
    const result = await setEnabled({ environmentId, input: { name: workflow.name, enabled } });
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: `Could not turn ${words} ${workflow.title}`,
          description: commandErrorMessage(result, "Try again."),
        });
      }
      return;
    }
    setSwitched(result.value);
    toastManager.add({ type: "success", title: `Turned ${words} ${workflow.title}` });
  };

  return { workflow, busy: busy || shown.settling, toggle };
}

function WorkflowStatusBadge(props: {
  workflow: WorkflowSummary;
  latestRun: WorkflowRunStatus | null;
}) {
  const status = workflowCardStatus(props.workflow, props.latestRun);
  return (
    <Badge variant={status === "on" ? "success" : "secondary"}>{CARD_STATUS_LABELS[status]}</Badge>
  );
}

/** Turn on or off, Run now and Open workflow for the workflow saved from this chat. */
function SavedWorkflowControls(props: {
  environmentId: EnvironmentId;
  workflow: WorkflowSummary;
  switching: boolean;
  onToggle: () => void;
  /** Turn on leads the footer when nothing else does. */
  lead: boolean;
}) {
  const { environmentId, workflow } = props;
  const router = useRouter();
  const canSetEnabled = useAtomValue(
    savedWorkflowsEnvironment.setEnabled.permissionAtom(environmentId),
  );
  const toggleReason = !canSetEnabled
    ? CANNOT_CHANGE
    : workflow.enabled
      ? null
      : (workflow.problems[0]?.message ?? null);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {workflow.trigger.schedule === null ? null : (
        <WithReason reason={toggleReason}>
          <Button
            size="xs"
            variant={props.lead && !workflow.enabled ? "default" : "outline"}
            disabled={props.switching || toggleReason !== null}
            onClick={props.onToggle}
          >
            {workflow.enabled ? "Turn off" : "Turn on"}
          </Button>
        </WithReason>
      )}
      <RunWorkflowButton
        environmentId={environmentId}
        workflow={workflow}
        inputs={null}
        disabledReason={workflow.problems[0]?.message ?? null}
        variant="outline"
        size="xs"
        navigateOnStart={false}
      />
      <Button
        size="xs"
        variant="ghost"
        onClick={() => void router.navigate({ href: workflowHref(environmentId, workflow.name) })}
      >
        Open workflow
      </Button>
    </div>
  );
}

/** What the saved workflow does now and whether it runs, as the workflow list reports it. */
function SavedWorkflowView(props: {
  threadRef: ScopedThreadRef;
  link: SavedWorkflowLink | null;
  workflow: WorkflowSummary;
}) {
  const { threadRef } = props;
  const { environmentId } = threadRef;
  const clock = useWorkflowClock();
  const runs = useChatWorkflowRuns(threadRef, props.link);
  const { workflow, busy, toggle } = useWorkflowSwitch(environmentId, props.workflow);
  const schedule = workflow.trigger.schedule;
  const note =
    workflow.problems.length > 0
      ? `It can't run yet. ${workflow.problems.map((problem) => problem.message).join(" ")}`
      : schedule === null
        ? "It runs when you start it."
        : !workflow.enabled
          ? "It's off, so it won't run on its schedule until you turn it on."
          : workflow.nextRunAt === null
            ? "It's on, so it runs on its schedule."
            : `Next run ${formatWhen(Date.parse(workflow.nextRunAt), { ...clock, timeZone: schedule.timeZone })}.`;
  const footer = (
    <TaskPanelFooter>
      <TaskPanelNote>{note}</TaskPanelNote>
      <SavedWorkflowControls
        environmentId={environmentId}
        workflow={workflow}
        switching={busy}
        onToggle={() => void toggle()}
        lead
      />
    </TaskPanelFooter>
  );
  return (
    <TaskPanelLayout label="Workflow" footer={footer}>
      <WorkflowHeading
        title={workflow.title}
        badge={<WorkflowStatusBadge workflow={workflow} latestRun={runs[0]?.status ?? null} />}
        description={workflow.description}
        schedule={schedule}
        goal=""
      />
      <WorkflowSteps environmentId={environmentId} steps={workflow.steps} />
      <ChatWorkflowRuns threadRef={threadRef} link={props.link} workflowName={workflow.name} />
    </TaskPanelLayout>
  );
}

/** A newer draft from the lead over the workflow saved from this chat. */
function ChangedWorkflowView(props: {
  threadRef: ScopedThreadRef;
  link: SavedWorkflowLink | null;
  draft: WorkflowDraft;
  workflow: WorkflowSummary;
  /** Reads the list again, so a workflow deleted elsewhere shows as deleted. */
  onReadFailed: () => void;
}) {
  const { threadRef, draft, onReadFailed } = props;
  const { environmentId } = threadRef;
  const router = useRouter();
  const { agents } = useAgents(environmentId);
  const canSave = useAtomValue(savedWorkflowsEnvironment.save.permissionAtom(environmentId));
  const read = useAtomQueryRunner(savedWorkflowsEnvironment.read, {
    refresh: true,
    reportFailure: false,
  });
  const save = useAtomCommand(savedWorkflowsEnvironment.save, { reportFailure: false });
  const switcher = useWorkflowSwitch(environmentId, props.workflow);
  const { workflow } = switcher;
  const runs = useChatWorkflowRuns(threadRef, props.link);
  const [busy, setBusy] = useState(false);
  const fromDraft = { threadId: threadRef.threadId, proposedAt: draft.proposedAt };

  const readSaved = async (failedTitle: string) => {
    const result = await read({ environmentId, input: { name: workflow.name } });
    if (result._tag === "Success") return result.value;
    onReadFailed();
    if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: failedTitle,
        description: commandErrorMessage(result, "Try again."),
      });
    }
    return null;
  };

  // Opens the saved workflow's editor with this draft applied, so saving updates that workflow.
  const review = async () => {
    setBusy(true);
    const detail = await readSaved(`Could not open ${workflow.title}`);
    setBusy(false);
    if (detail === null) return;
    const key = workflowEditKey({ kind: "saved", name: detail.name });
    const base = {
      definition: definitionOf(detail),
      notes: detail.notes,
      updatedAt: detail.updatedAt,
    };
    const current = readWorkflowEdit(environmentId, key);
    const dirty = resolveWorkflowEdit(base, base.definition, current).dirty;
    // Unsaved edits that already apply this draft are the user's changes on top of it; they stay.
    const appliesDraft =
      dirty &&
      current?.fromDraft?.threadId === threadRef.threadId &&
      current.fromDraft.proposedAt === draft.proposedAt;
    if (!appliesDraft) {
      if (dirty) {
        const confirmed = await settlePromise(() =>
          ensureLocalApi().dialogs.confirm(
            `Replace your unsaved changes to ${detail.title} with the chat's newer draft?`,
          ),
        );
        if (confirmed._tag !== "Success" || !confirmed.value) return;
      }
      setWorkflowEdit(environmentId, key, {
        definition: workflowWithDraft(base.definition, draft, agents),
        notes: detail.notes,
        base,
        fromDraft,
      });
    }
    void router.navigate({ href: workflowHref(environmentId, detail.name) });
  };

  // Saves the workflow as it is, naming this draft, so the chat records it as handled.
  const discard = async () => {
    const failedTitle = `Could not discard the changes to ${workflow.title}`;
    setBusy(true);
    const detail = await readSaved(failedTitle);
    if (detail === null) {
      setBusy(false);
      return;
    }
    const result = await save({
      environmentId,
      input: { workflow: definitionOf(detail), previousName: detail.name, fromDraft },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: failedTitle,
          description: commandErrorMessage(result, "Try again."),
        });
      }
      return;
    }
    toastManager.add({ type: "success", title: `Kept ${result.value.title} as it was` });
  };

  const saveReason = canSave ? null : CANNOT_CHANGE;
  const footer = (
    <TaskPanelFooter>
      <TaskPanelNote>{`These changes aren't saved to ${workflow.title} yet.`}</TaskPanelNote>
      <div className="flex flex-wrap items-center gap-2">
        <WithReason reason={saveReason}>
          <Button size="xs" disabled={busy || !canSave} onClick={() => void review()}>
            Review changes
          </Button>
        </WithReason>
        <WithReason reason={saveReason}>
          <Button
            size="xs"
            variant="ghost"
            disabled={busy || !canSave}
            onClick={() => void discard()}
          >
            Discard changes
          </Button>
        </WithReason>
      </div>
      <SavedWorkflowControls
        environmentId={environmentId}
        workflow={workflow}
        switching={switcher.busy}
        onToggle={() => void switcher.toggle()}
        lead={false}
      />
    </TaskPanelFooter>
  );
  return (
    <TaskPanelLayout label="Workflow" footer={footer}>
      <WorkflowHeading
        title={workflow.title}
        badge={
          <>
            <Badge variant="info">Changes</Badge>
            <WorkflowStatusBadge workflow={workflow} latestRun={runs[0]?.status ?? null} />
          </>
        }
        description={draft.description}
        schedule={draft.schedule}
        goal={draft.goal}
      />
      <WorkflowSteps environmentId={environmentId} steps={draftStepsOver(draft, workflow.steps)} />
      <ChatWorkflowRuns threadRef={threadRef} link={props.link} workflowName={workflow.name} />
    </TaskPanelLayout>
  );
}

/** The runs of the chat's workflow, newest first. */
function useChatWorkflowRuns(
  threadRef: ScopedThreadRef,
  link: SavedWorkflowLink | null,
): ReadonlyArray<WorkflowRun> {
  return chatWorkflowRuns(useWorkflowRuns(threadRef.environmentId), threadRef.threadId, link);
}

const CHAT_RUNS_SHOWN = 10;

/** The workflow's latest runs; each opens its lead's chat. */
function ChatWorkflowRuns(props: {
  threadRef: ScopedThreadRef;
  link: SavedWorkflowLink | null;
  /** The workflow's name while it exists, for its runs page. */
  workflowName: string | null;
}) {
  const { threadRef, workflowName } = props;
  const { environmentId } = threadRef;
  const navigate = useNavigate();
  const clock = useWorkflowClock();
  const runs = useChatWorkflowRuns(threadRef, props.link).slice(0, CHAT_RUNS_SHOWN);
  return (
    <section aria-label="Runs" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <TeamSectionHeading>Runs</TeamSectionHeading>
        {workflowName === null ? null : (
          <Button
            size="xs"
            variant="link"
            onClick={() =>
              void navigate({
                to: "/workflows/$name/runs",
                params: { name: workflowName },
                search: { machine: environmentId },
              })
            }
          >
            All runs
          </Button>
        )}
      </div>
      {runs.length === 0 ? (
        <p className="text-muted-foreground text-xs">No runs yet.</p>
      ) : (
        <ul className="flex flex-col gap-px">
          {runs.map((run) => {
            const duration = runDurationMs(run, clock.nowMs);
            const detail = [
              formatWhen(Date.parse(run.startedAt), clock),
              duration === null ? null : formatDuration(duration),
              run.costUsd === null ? null : formatCost(run.costUsd),
            ]
              .filter((part) => part !== null)
              .join(" · ");
            return (
              <li key={run.threadId}>
                <button
                  type="button"
                  className="flex w-full min-w-0 flex-col gap-0.5 rounded-md px-2 py-1.5 text-start outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  onClick={() =>
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: buildThreadRouteParams(scopeThreadRef(environmentId, run.threadId)),
                    })
                  }
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="font-medium">Run {run.run}</span>
                    <RunStatusBadge status={run.status} />
                    <span className="min-w-0 truncate text-muted-foreground text-xs">{detail}</span>
                  </span>
                  {run.headline === null ? null : (
                    <span className="line-clamp-2 break-words text-muted-foreground text-xs">
                      {run.headline}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function WorkflowHeading(props: {
  title: string;
  badge: ReactNode;
  description: string;
  schedule: WorkflowSchedule | null;
  goal: string;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex min-h-6 items-center gap-2">
        <h2 className="min-w-0 flex-1 break-words font-semibold">{props.title}</h2>
        {props.badge}
      </div>
      {props.description.trim() === "" ? null : (
        <p className="whitespace-pre-wrap break-words text-muted-foreground">{props.description}</p>
      )}
      <dl className="grid grid-cols-[3rem_minmax(0,1fr)] gap-x-3 gap-y-1.5">
        <dt className="text-muted-foreground">When</dt>
        <dd>{workflowScheduleText(props.schedule)}</dd>
        {props.goal.trim() === "" ? null : (
          <>
            <dt className="text-muted-foreground">Goal</dt>
            <dd className="whitespace-pre-wrap break-words text-foreground/90">{props.goal}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

/** A step as the tab shows it; a saved workflow's list entry has no instructions or suggestion. */
type ShownStep = Pick<WorkflowDraftStep, "id" | "title" | "agent" | "dependsOn"> &
  Partial<Pick<WorkflowDraftStep, "suggestion" | "instructions" | "doneWhen">>;

function WorkflowSteps(props: { environmentId: EnvironmentId; steps: ReadonlyArray<ShownStep> }) {
  const { steps } = props;
  const { agents } = useAgents(props.environmentId);
  const flows = stepFlows(steps);
  return (
    <section aria-label="Steps" className="flex flex-col gap-3">
      <TeamSectionHeading detail={String(steps.length)}>Steps</TeamSectionHeading>
      <ol className="flex flex-col">
        {steps.map((step, index) => (
          <WorkflowStepRow
            key={step.id}
            number={index + 1}
            last={index === steps.length - 1}
            step={step}
            agents={agents}
            flow={flows.get(TeamTaskId.make(step.id)) ?? null}
          />
        ))}
      </ol>
    </section>
  );
}

/** A step: who does it, and, as the lead drafted it, what it does each run and when it is done. */
function WorkflowStepRow(props: {
  number: number;
  last: boolean;
  step: ShownStep;
  agents: ReadonlyArray<AgentSummary>;
  flow: string | null;
}) {
  const { step } = props;
  const name =
    step.agent === null
      ? null
      : agentTitle(
          step.agent,
          props.agents.find((agent) => agent.name === step.agent),
        );
  const suggestion = step.agent === null ? (step.suggestion ?? null) : null;
  const instructions = step.instructions?.trim() ?? "";
  const doneWhen = step.doneWhen?.trim() ?? "";
  return (
    <TeamStepRow number={props.number} state="proposed" last={props.last} framed={null}>
      <h4 className="break-words font-medium leading-5.5">{step.title}</h4>
      {props.flow === null ? null : <TeamStepFlow text={props.flow} />}
      <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        {name === null ? (
          <>
            {suggestion === null ? null : (
              <span className="inline-flex min-w-0 items-center gap-1.5 text-foreground/85">
                <ConnectorMark name={suggestion.title} size="sm" tone="suggested" />
                <span className="truncate">{suggestion.title}</span>
              </span>
            )}
            <Badge variant="warning" size="sm">
              Needs an agent
            </Badge>
          </>
        ) : (
          <span className="inline-flex min-w-0 items-center gap-1.5 text-foreground/85">
            <ConnectorMark name={name} size="sm" tone="agent" />
            <span className="truncate">{name}</span>
          </span>
        )}
      </div>
      {suggestion === null ? null : (
        <p className="mt-1 break-words text-muted-foreground text-xs">
          Suggested agent: {suggestion.description}
        </p>
      )}
      {instructions === "" ? null : (
        <p className="mt-1.5 line-clamp-4 whitespace-pre-wrap break-words text-foreground/85">
          {step.instructions}
        </p>
      )}
      {doneWhen === "" ? null : (
        <p className="mt-1 break-words text-muted-foreground text-xs">Done when: {step.doneWhen}</p>
      )}
    </TeamStepRow>
  );
}

/** The line above the composer that leads back to the draft while its tab is out of sight. */
export function workflowDraftBannerItem(
  draft: Pick<WorkflowDraft, "title">,
  onOpen: () => void,
): ComposerBannerStackItem {
  return {
    id: "workflow-draft",
    variant: "default",
    icon: <WorkflowIcon />,
    title: "Workflow draft",
    description: draft.title,
    actions: (
      <Button size="xs" variant="ghost" onClick={onOpen}>
        Open
      </Button>
    ),
  };
}
