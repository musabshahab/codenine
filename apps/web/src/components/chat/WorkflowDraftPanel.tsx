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
import { useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { WorkflowIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { commandErrorMessage } from "../../lib/commandError";
import { ensureLocalApi } from "../../localApi";
import { useThreadStatus } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { savedWorkflowsEnvironment } from "../../state/savedWorkflows";
import { environmentThreadDetails } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { newWorkflowHref, workflowHref } from "../../workflowLinks";
import { agentTitle, useAgents } from "../agents/useAgents";
import { ConnectorMark } from "../connectors/ConnectorMark";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { RunWorkflowButton } from "../workflows/RunWorkflowButton";
import { readWorkflowEdit, setWorkflowEdit, workflowEditKey } from "../workflows/workflowEditStore";
import { useWorkflowClock } from "../workflows/workflowHooks";
import {
  CARD_STATUS_LABELS,
  definitionOf,
  formatWhen,
  resolveWorkflowEdit,
  workflowCardStatus,
  workflowWithDraft,
} from "../workflows/workflows.logic";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { TaskPanelFooter, TaskPanelLayout, TaskPanelNote } from "./TaskPanel";
import { TeamSectionHeading, TeamStepFlow, TeamStepRow } from "./TeamParts";
import { draftStepsOver, workflowDraftStatus, workflowScheduleText } from "./workflowDraft.logic";

const NO_WORKFLOW_DRAFT_ATOM = Atom.make<WorkflowDraft | null>(null);
const NO_SAVED_WORKFLOW_ATOM = Atom.make<SavedWorkflowLink | null>(null);

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
  const list = useEnvironmentQuery(
    link === null
      ? null
      : savedWorkflowsEnvironment.list({ environmentId: threadRef.environmentId, input: {} }),
  );
  const workflows = list.data?.workflows ?? null;
  const linkKey = link === null ? null : `${link.id}:${link.proposedAt}`;
  const unlisted =
    link !== null && workflows !== null && !workflows.some((entry) => entry.id === link.id);
  // When this client asked again for a list that misses the linked workflow.
  const [asked, setAsked] = useState<{ readonly key: string; readonly at: number } | null>(null);
  const { refresh } = list;
  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- refetch the list once when the thread names a workflow this client has not listed
  useEffect(() => {
    if (!unlisted || linkKey === null || asked?.key === linkKey) return;
    // oxlint-disable-next-line react/set-state-in-effect -- records when the list was asked again, which only this refetch knows
    setAsked({ key: linkKey, at: Date.now() });
    refresh();
  }, [unlisted, linkKey, asked?.key, refresh]);
  // A refresh restarts a fetch in flight, so only an answer to this ask is newer than it.
  const listedAfterLink = asked !== null && asked.key === linkKey && list.dataUpdatedAt > asked.at;
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
        <PanelMessage>
          The workflow saved from this chat was deleted, and the chat has no draft any more.
        </PanelMessage>
      ) : (
        <UnsavedDraftView threadRef={threadRef} draft={draft} deleted={status.deleted} />
      );
    case "saved":
      return (
        <SavedWorkflowView environmentId={threadRef.environmentId} workflow={status.workflow} />
      );
    case "changed":
      return draft === null ? null : (
        <ChangedWorkflowView threadRef={threadRef} draft={draft} workflow={status.workflow} />
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

function UnsavedDraftView(props: {
  threadRef: ScopedThreadRef;
  draft: WorkflowDraft;
  deleted: boolean;
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
    </TaskPanelLayout>
  );
}

/** What the saved workflow does now and whether it runs, as the workflow list reports it. */
function SavedWorkflowView(props: { environmentId: EnvironmentId; workflow: WorkflowSummary }) {
  const { environmentId, workflow } = props;
  const router = useRouter();
  const clock = useWorkflowClock();
  const canSetEnabled = useAtomValue(
    savedWorkflowsEnvironment.setEnabled.permissionAtom(environmentId),
  );
  const setEnabled = useAtomCommand(savedWorkflowsEnvironment.setEnabled, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState(false);
  const schedule = workflow.trigger.schedule;
  const status = workflowCardStatus(workflow, null);
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
    toastManager.add({ type: "success", title: `Turned ${words} ${workflow.title}` });
  };

  const turnOnBlock = workflow.enabled ? null : (workflow.problems[0]?.message ?? null);
  const toggleButton = (
    <Button
      size="xs"
      variant={workflow.enabled ? "outline" : "default"}
      disabled={busy || !canSetEnabled || turnOnBlock !== null}
      onClick={() => void toggle()}
    >
      {workflow.enabled ? "Turn off" : "Turn on"}
    </Button>
  );
  const footer = (
    <TaskPanelFooter>
      <TaskPanelNote>{note}</TaskPanelNote>
      <div className="flex flex-wrap items-center gap-2">
        {schedule === null ? null : turnOnBlock === null ? (
          toggleButton
        ) : (
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex" />}>
              {toggleButton}
            </TooltipTrigger>
            <TooltipPopup>{turnOnBlock}</TooltipPopup>
          </Tooltip>
        )}
        <RunWorkflowButton
          environmentId={environmentId}
          workflow={workflow}
          inputs={null}
          disabledReason={workflow.problems[0]?.message ?? null}
          variant="outline"
          size="xs"
        />
        <Button
          size="xs"
          variant="ghost"
          onClick={() => void router.navigate({ href: workflowHref(environmentId, workflow.name) })}
        >
          Open workflow
        </Button>
      </div>
    </TaskPanelFooter>
  );
  return (
    <TaskPanelLayout label="Workflow" footer={footer}>
      <WorkflowHeading
        title={workflow.title}
        badge={
          <Badge variant={status === "on" ? "success" : "secondary"}>
            {CARD_STATUS_LABELS[status]}
          </Badge>
        }
        description={workflow.description}
        schedule={schedule}
        goal=""
      />
      <WorkflowSteps environmentId={environmentId} steps={workflow.steps} />
    </TaskPanelLayout>
  );
}

/** A newer draft from the lead over the workflow saved from this chat. */
function ChangedWorkflowView(props: {
  threadRef: ScopedThreadRef;
  draft: WorkflowDraft;
  workflow: WorkflowSummary;
}) {
  const { threadRef, draft, workflow } = props;
  const { environmentId } = threadRef;
  const router = useRouter();
  const { agents } = useAgents(environmentId);
  const canSave = useAtomValue(savedWorkflowsEnvironment.save.permissionAtom(environmentId));
  const read = useAtomQueryRunner(savedWorkflowsEnvironment.read, {
    refresh: true,
    reportFailure: false,
  });
  const [busy, setBusy] = useState(false);

  // Opens the saved workflow's editor with this draft applied, so saving updates that workflow.
  const review = async () => {
    setBusy(true);
    const result = await read({ environmentId, input: { name: workflow.name } });
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: `Could not open ${workflow.title}`,
          description: commandErrorMessage(result, "Try again."),
        });
      }
      return;
    }
    const detail = result.value;
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
        fromDraft: { threadId: threadRef.threadId, proposedAt: draft.proposedAt },
      });
    }
    void router.navigate({ href: workflowHref(environmentId, detail.name) });
  };

  const footer = (
    <TaskPanelFooter>
      <TaskPanelNote>{`These changes aren't saved to ${workflow.title} yet.`}</TaskPanelNote>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="xs" disabled={busy || !canSave} onClick={() => void review()}>
          Review changes
        </Button>
      </div>
    </TaskPanelFooter>
  );
  return (
    <TaskPanelLayout label="Workflow" footer={footer}>
      <WorkflowHeading
        title={workflow.title}
        badge={<Badge variant="info">Changes</Badge>}
        description={draft.description}
        schedule={draft.schedule}
        goal={draft.goal}
      />
      <WorkflowSteps environmentId={environmentId} steps={draftStepsOver(draft, workflow.steps)} />
    </TaskPanelLayout>
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
