import { teamStepFlows } from "@codenine/client-runtime/team";
import {
  type AgentSummary,
  type ScopedThreadRef,
  TeamTaskId,
  type WorkflowDraft,
  type WorkflowDraftStep,
} from "@codenine/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { WorkflowIcon } from "lucide-react";

import { useThreadStatus } from "../../state/entities";
import { environmentThreadDetails } from "../../state/threads";
import { newWorkflowHref } from "../../workflowLinks";
import { agentTitle, useAgents } from "../agents/useAgents";
import { ConnectorMark } from "../connectors/ConnectorMark";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { TaskPanelFooter, TaskPanelLayout, TaskPanelNote } from "./TaskPanel";
import { TeamSectionHeading, TeamStepFlow, TeamStepRow } from "./TeamParts";
import { workflowScheduleText } from "./workflowDraft.logic";

const NO_WORKFLOW_DRAFT_ATOM = Atom.make<WorkflowDraft | null>(null);

/** The workflow a lead drafted in a chat, read from its thread detail; null without one. */
export function useWorkflowDraft(threadRef: ScopedThreadRef | null): WorkflowDraft | null {
  return useAtomValue(
    threadRef === null
      ? NO_WORKFLOW_DRAFT_ATOM
      : environmentThreadDetails.workflowDraftAtom(threadRef),
  );
}

/**
 * The Workflow tab: the workflow a lead drafted in this chat. The user reviews and saves it in the
 * editor; nothing here changes it.
 */
export function WorkflowDraftPanel(props: { threadRef: ScopedThreadRef }) {
  const draft = useWorkflowDraft(props.threadRef);
  const loading = useThreadStatus(props.threadRef) !== "live";
  if (draft === null) {
    return (
      <TaskPanelLayout label="Workflow" footer={null}>
        <p className="text-muted-foreground">
          {loading
            ? "Loading the draft…"
            : "No workflow is drafted in this chat. Turn on Workflow in the composer and describe what should happen."}
        </p>
      </TaskPanelLayout>
    );
  }
  return <WorkflowDraftView threadRef={props.threadRef} draft={draft} />;
}

function WorkflowDraftView(props: { threadRef: ScopedThreadRef; draft: WorkflowDraft }) {
  const { threadRef, draft } = props;
  const router = useRouter();
  const { agents } = useAgents(threadRef.environmentId);
  const flows = teamStepFlows(
    draft.steps.map((step) => ({
      id: TeamTaskId.make(step.id),
      dependsOn: step.dependsOn.map((id) => TeamTaskId.make(id)),
    })),
  );
  const waitsForAgent = draft.steps.some((step) => step.agent === null);
  const footer = (
    <TaskPanelFooter>
      <TaskPanelNote>
        {waitsForAgent
          ? "Nothing is saved until you save it. It can't run until every step has an agent."
          : "Nothing is saved until you save it."}
      </TaskPanelNote>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="xs"
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
      <div className="flex flex-col gap-2.5">
        <div className="flex min-h-6 items-center gap-2">
          <h2 className="min-w-0 flex-1 break-words font-semibold">{draft.title}</h2>
          <Badge variant="secondary">Draft</Badge>
        </div>
        {draft.description.trim() === "" ? null : (
          <p className="whitespace-pre-wrap break-words text-muted-foreground">
            {draft.description}
          </p>
        )}
        <dl className="grid grid-cols-[3rem_minmax(0,1fr)] gap-x-3 gap-y-1.5">
          <dt className="text-muted-foreground">When</dt>
          <dd>{workflowScheduleText(draft.schedule)}</dd>
          {draft.goal.trim() === "" ? null : (
            <>
              <dt className="text-muted-foreground">Goal</dt>
              <dd className="whitespace-pre-wrap break-words text-foreground/90">{draft.goal}</dd>
            </>
          )}
        </dl>
      </div>
      <section aria-label="Steps" className="flex flex-col gap-3">
        <TeamSectionHeading detail={String(draft.steps.length)}>Steps</TeamSectionHeading>
        <ol className="flex flex-col">
          {draft.steps.map((step, index) => (
            <WorkflowDraftStepRow
              key={step.id}
              number={index + 1}
              last={index === draft.steps.length - 1}
              step={step}
              agents={agents}
              flow={flows.get(TeamTaskId.make(step.id)) ?? null}
            />
          ))}
        </ol>
      </section>
    </TaskPanelLayout>
  );
}

/** A step as the lead drafted it: who does it, what it does each run, and when it is done. */
function WorkflowDraftStepRow(props: {
  number: number;
  last: boolean;
  step: WorkflowDraftStep;
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
      {step.instructions.trim() === "" ? null : (
        <p className="mt-1.5 line-clamp-4 whitespace-pre-wrap break-words text-foreground/85">
          {step.instructions}
        </p>
      )}
      {step.doneWhen.trim() === "" ? null : (
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
