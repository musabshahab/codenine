import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@codenine/client-runtime/environment";
import { resolveTeamDraft } from "@codenine/client-runtime/team";
import {
  type AgentModel,
  type AgentSummary,
  type AgentName,
  type ConnectionSnapshot,
  type EnvironmentId,
  type ProjectId,
  type ScopedThreadRef,
  skillTitle,
  type TeamAgent,
  type TeamAgentId,
  type ThreadId,
  type WorkflowStep,
  type WorkflowStepId,
} from "@codenine/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { useRightPanelStore } from "../../rightPanelStore";
import { agentsEnvironment } from "../../state/agents";
import { connectorsEnvironment } from "../../state/connectors";
import { useThreadStatus } from "../../state/entities";
import { useReadSinceOpened } from "../../hooks/useEditorDraft";
import { useEnvironmentQuery } from "../../state/query";
import { environmentThreadDetails } from "../../state/threads";
import { AgentForm, type AgentFormStart } from "../agents/AgentForm";
import { suggestedAbilities, teamRoleAbilities, teamRoleDescription } from "../agents/agents.logic";
import {
  type AgentModelCatalog,
  agentChatModelSelection,
  agentModelOfSelection,
  useAgentModelCatalog,
} from "../agents/useAgents";
import { changeTeamPlanDraft, useTeamDraftEdit } from "../chat/useTeamPlanActions";
import { useAccessEnvironment, useOpenedEnvironment } from "../settings/useAccessEnvironment";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { toastManager } from "../ui/toast";
import {
  parseWorkflowEditKey,
  readWorkflowEdit,
  setWorkflowEdit,
  setWorkflowSelection,
  useWorkflowEdit,
} from "../workflows/workflowEditStore";
import { assignStepAgent } from "../workflows/workflows.logic";
import { WorkspacePage } from "./WorkspacePage";

export type AgentEditorTarget =
  | { readonly kind: "new" }
  /** A new agent for a team member that has none yet, on the lead's computer. */
  | { readonly kind: "suggested"; readonly lead: ThreadId; readonly member: TeamAgentId }
  /** A new agent for a step of a workflow being edited, named by its edit key on the machine. */
  | { readonly kind: "workflow-step"; readonly edit: string; readonly step: WorkflowStepId }
  | { readonly kind: "edit"; readonly name: AgentName }
  | { readonly kind: "invalid" };

/** Makes an agent or changes one: what it does, its model and effort, and what it may use. */
export function AgentEditorPage(props: {
  readonly target: AgentEditorTarget;
  readonly machine: EnvironmentId | null;
  readonly workspace: ProjectId | null;
}) {
  const { environment } = useAccessEnvironment(props.machine);
  const environmentId = environment?.environmentId ?? null;
  const connected = environment?.connection.phase === "connected";
  const opened = useOpenedEnvironment(environmentId, connected);
  const editing = props.target.kind === "edit" ? props.target : null;
  const suggested = props.target.kind === "suggested" ? props.target : null;
  const forStep = props.target.kind === "workflow-step" ? props.target : null;
  const read =
    editing !== null && environmentId !== null && opened
      ? agentsEnvironment.read({ environmentId, input: { name: editing.name } })
      : null;
  const detail = useEnvironmentQuery(read);
  const answered = useReadSinceOpened(read, detail);
  const title = detail.data?.title ?? (editing === null ? "New agent" : skillTitle(editing.name));
  const navigate = useNavigate();
  const breadcrumb = (
    <span className="flex min-w-0 items-center gap-1">
      <Link
        to="/agents"
        search={{ machine: environmentId ?? undefined, workspace: props.workspace ?? undefined }}
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        Agents
      </Link>
      <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{title}</span>
    </span>
  );
  return (
    <WorkspacePage area="agent" title={breadcrumb}>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6">
        {props.target.kind === "invalid" ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>This agent is not here</EmptyTitle>
              <EmptyDescription>The address does not name an agent.</EmptyDescription>
            </EmptyHeader>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void navigate({
                  to: "/agents",
                  search: {
                    machine: environmentId ?? undefined,
                    workspace: props.workspace ?? undefined,
                  },
                })
              }
            >
              Back to agents
            </Button>
          </Empty>
        ) : environmentId === null || !opened ? (
          <p className="text-sm text-muted-foreground">
            Connect the computer the agent is on to change it.
          </p>
        ) : suggested !== null ? (
          <SuggestedAgentForm
            environmentId={environmentId}
            connected={connected}
            workspace={props.workspace}
            leadRef={scopeThreadRef(environmentId, suggested.lead)}
            memberId={suggested.member}
          />
        ) : forStep !== null ? (
          <WorkflowStepAgentForm
            environmentId={environmentId}
            connected={connected}
            workspace={props.workspace}
            editKey={forStep.edit}
            stepId={forStep.step}
          />
        ) : editing === null ? (
          <AgentForm
            environmentId={environmentId}
            workspace={props.workspace}
            agent={null}
            connected={connected}
          />
        ) : detail.data === null || !answered ? (
          detail.error === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>This agent could not open</EmptyTitle>
                <EmptyDescription>{detail.error}</EmptyDescription>
              </EmptyHeader>
              <Button size="sm" variant="outline" onClick={detail.refresh}>
                Try again
              </Button>
            </Empty>
          )
        ) : (
          // Keyed by name: a newer read of the same agent reaches the form, which keeps its edits.
          <AgentForm
            key={detail.data.name}
            environmentId={environmentId}
            workspace={props.workspace}
            agent={detail.data}
            connected={connected}
          />
        )}
      </div>
    </WorkspacePage>
  );
}

const NO_CONNECTIONS: ReadonlyArray<ConnectionSnapshot> = [];

/** The member's agent, with only the connectors the user has, on the member's model. */
function suggestionStart(
  member: TeamAgent,
  connections: ReadonlyArray<ConnectionSnapshot>,
  catalog: AgentModelCatalog,
): AgentFormStart {
  const suggestion = member.suggestion;
  return {
    title: suggestion?.title ?? member.label,
    description: suggestion?.description ?? teamRoleDescription(member.role),
    instructions: member.instructions ?? suggestion?.instructions ?? "",
    model: agentModelOfSelection(catalog.entries, member.modelSelection),
    connectors: (suggestion?.connectors ?? []).flatMap((id) =>
      connections.some((connection) => connection.id === id) ? [{ id, approvals: {} }] : [],
    ),
    abilities: teamRoleAbilities(member.role),
  };
}

/**
 * Makes the agent a lead suggested for a team member. Nothing is saved until Save, which gives
 * the member the agent in the team's unsaved edits and returns to the lead's Task tab.
 */
function SuggestedAgentForm(props: {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  readonly workspace: ProjectId | null;
  readonly leadRef: ScopedThreadRef;
  readonly memberId: TeamAgentId;
}) {
  const { environmentId, leadRef } = props;
  const navigate = useNavigate();
  const plan = useAtomValue(environmentThreadDetails.teamAtom(leadRef));
  const loading = useThreadStatus(leadRef) !== "live";
  const edit = useTeamDraftEdit(leadRef);
  const catalog = useAgentModelCatalog(environmentId);
  const connectors = useEnvironmentQuery(connectorsEnvironment.state({ environmentId, input: {} }));
  // A member the lead suggested an agent for, or defined for this team, until it runs as one.
  const member =
    plan?.status === "proposed"
      ? (resolveTeamDraft(plan, edit).draft.agents.find(
          (candidate) => candidate.id === props.memberId && candidate.agent === undefined,
        ) ?? null)
      : null;
  // The form starts from the member once, and stays open if the team changes meanwhile.
  const [start, setStart] = useState<{
    readonly form: AgentFormStart;
    readonly suggested: boolean;
  } | null>(null);
  if (
    start === null &&
    member !== null &&
    (connectors.data !== null || connectors.error !== null)
  ) {
    setStart({
      form: suggestionStart(member, connectors.data?.connections ?? NO_CONNECTIONS, catalog),
      suggested: member.suggestion !== undefined,
    });
  }
  const backToLead = () => {
    useRightPanelStore.getState().open(leadRef, "task");
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: leadRef.environmentId, threadId: leadRef.threadId },
      replace: true,
    });
  };
  const onSaved = (agent: AgentSummary) => {
    if (plan !== null && member !== null) {
      changeTeamPlanDraft(leadRef, plan, {
        type: "agent.assign",
        agentId: member.id,
        agent: agent.name,
        label: agent.title,
        modelSelection:
          agent.model === null
            ? member.modelSelection
            : agentChatModelSelection(catalog.entries, agent.model),
      });
    } else {
      toastManager.add({
        type: "info",
        title: "The team changed",
        description: `Choose ${agent.title} for the team in its Task tab.`,
      });
    }
    backToLead();
  };
  if (start !== null) {
    return (
      <AgentForm
        environmentId={environmentId}
        workspace={props.workspace}
        agent={null}
        connected={props.connected}
        forTeam={{
          start: start.form,
          onSaved,
          onCancel: backToLead,
          ...(start.suggested
            ? {}
            : {
                intro:
                  "Save this team member as one of your agents. The team then uses the saved agent.",
              }),
        }}
      />
    );
  }
  if (member !== null || (plan === null && loading)) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>This member is settled</EmptyTitle>
        <EmptyDescription>
          The team uses an agent for it now, or the lead proposed another team.
        </EmptyDescription>
      </EmptyHeader>
      <Button size="sm" variant="outline" onClick={backToLead}>
        Back to the team
      </Button>
    </Empty>
  );
}

/** The lead's suggestion for a workflow step, with only the connectors the user has. */
function workflowStepStart(
  step: WorkflowStep | null,
  leadModel: AgentModel | null,
  connections: ReadonlyArray<ConnectionSnapshot>,
): AgentFormStart {
  const suggestion = step?.suggestion;
  return {
    title: suggestion?.title ?? "",
    description: suggestion?.description ?? "",
    instructions: suggestion?.instructions ?? "",
    // As a team's suggested agent starts on its member's model, this one starts on the lead's.
    model: step?.model ?? leadModel,
    connectors: (suggestion?.connectors ?? []).flatMap((id) =>
      connections.some((connection) => connection.id === id) ? [{ id, approvals: {} }] : [],
    ),
    abilities: suggestedAbilities(
      `${suggestion?.description ?? ""}\n${suggestion?.instructions ?? ""}\n${step?.instructions ?? ""}`,
    ),
  };
}

/**
 * Makes the agent a workflow step waits for. Save gives the step the agent in the workflow's
 * unsaved edits and returns to its canvas; the workflow itself saves with its own Save.
 */
function WorkflowStepAgentForm(props: {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  readonly workspace: ProjectId | null;
  readonly editKey: string;
  readonly stepId: WorkflowStepId;
}) {
  const { environmentId, editKey, stepId } = props;
  const navigate = useNavigate();
  const edit = useWorkflowEdit(environmentId, editKey);
  const connectors = useEnvironmentQuery(connectorsEnvironment.state({ environmentId, input: {} }));
  const step = edit?.definition.steps.find((candidate) => candidate.id === stepId) ?? null;
  // The form starts from the suggestion once, and stays open if the workflow changes meanwhile.
  const [start, setStart] = useState<AgentFormStart | null>(null);
  if (start === null && (connectors.data !== null || connectors.error !== null)) {
    setStart(
      workflowStepStart(
        step,
        edit?.definition.lead.model ?? null,
        connectors.data?.connections ?? NO_CONNECTIONS,
      ),
    );
  }
  const backToWorkflow = () => {
    const target = parseWorkflowEditKey(editKey);
    const machine = environmentId;
    if (target === null) {
      void navigate({ to: "/workflows", search: { machine }, replace: true });
    } else if (target.kind === "saved") {
      void navigate({
        to: "/workflows/$name",
        params: { name: target.name },
        search: { machine },
        replace: true,
      });
    } else {
      const from = target.from;
      void navigate({
        to: "/workflows/new",
        search: {
          machine,
          ...(from.kind === "draft" ? { fromThread: from.threadId } : {}),
          ...(from.kind === "team" ? { fromTeam: from.threadId } : {}),
        },
        replace: true,
      });
    }
  };
  const onSaved = (agent: AgentSummary) => {
    const current = readWorkflowEdit(environmentId, editKey);
    if (current !== null && current.definition.steps.some((candidate) => candidate.id === stepId)) {
      setWorkflowEdit(environmentId, editKey, {
        ...current,
        definition: assignStepAgent(current.definition, stepId, agent),
      });
      setWorkflowSelection(environmentId, editKey, { kind: "step", id: stepId });
    } else {
      toastManager.add({
        type: "info",
        title: "The workflow changed",
        description: `Choose ${agent.title} for the step on the workflow's canvas.`,
      });
    }
    backToWorkflow();
  };
  if (start === null) return <p className="text-sm text-muted-foreground">Loading…</p>;
  return (
    <AgentForm
      environmentId={environmentId}
      workspace={props.workspace}
      agent={null}
      connected={props.connected}
      forTeam={{
        start,
        onSaved,
        onCancel: backToWorkflow,
        intro:
          "The lead suggested this agent for a step of your workflow. Save it to give the step its agent.",
      }}
    />
  );
}
