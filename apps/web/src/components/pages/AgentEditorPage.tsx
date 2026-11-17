import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@codenine/client-runtime/environment";
import { resolveTeamDraft } from "@codenine/client-runtime/team";
import {
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
} from "@codenine/contracts";
import { teamMembersWithoutAgent } from "@codenine/shared/team";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { useRightPanelStore } from "../../rightPanelStore";
import { agentsEnvironment } from "../../state/agents";
import { connectorsEnvironment } from "../../state/connectors";
import { useThreadStatus } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { environmentThreadDetails } from "../../state/threads";
import { AgentForm, type AgentFormStart } from "../agents/AgentForm";
import {
  type AgentModelCatalog,
  agentChatModelSelection,
  agentModelOfSelection,
  useAgentModelCatalog,
} from "../agents/useAgents";
import { changeTeamPlanDraft, useTeamDraftEdit } from "../chat/useTeamPlanActions";
import { useAccessEnvironment } from "../settings/useAccessEnvironment";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { toastManager } from "../ui/toast";
import { WorkspacePage } from "./WorkspacePage";

export type AgentEditorTarget =
  | { readonly kind: "new" }
  /** A new agent for a team member the lead suggested one for, on the lead's computer. */
  | { readonly kind: "suggested"; readonly lead: ThreadId; readonly member: TeamAgentId }
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
  const editing = props.target.kind === "edit" ? props.target : null;
  const suggested = props.target.kind === "suggested" ? props.target : null;
  const detail = useEnvironmentQuery(
    editing !== null && environmentId !== null && connected
      ? agentsEnvironment.read({ environmentId, input: { name: editing.name } })
      : null,
  );
  const title = detail.data?.title ?? (editing === null ? "New agent" : skillTitle(editing.name));
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
          </Empty>
        ) : environmentId === null || !connected ? (
          <p className="text-sm text-muted-foreground">
            Connect the computer the agent is on to change it.
          </p>
        ) : suggested !== null ? (
          <SuggestedAgentForm
            environmentId={environmentId}
            workspace={props.workspace}
            leadRef={scopeThreadRef(environmentId, suggested.lead)}
            memberId={suggested.member}
          />
        ) : editing === null ? (
          <AgentForm environmentId={environmentId} workspace={props.workspace} agent={null} />
        ) : detail.data === null ? (
          detail.error === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>This agent could not open</EmptyTitle>
                <EmptyDescription>{detail.error}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )
        ) : (
          // Keyed so the form starts from the agent it opened, even if the agent changes later.
          <AgentForm
            key={detail.data.name}
            environmentId={environmentId}
            workspace={props.workspace}
            agent={detail.data}
          />
        )}
      </div>
    </WorkspacePage>
  );
}

const NO_CONNECTIONS: ReadonlyArray<ConnectionSnapshot> = [];

/** The suggestion's agent, with only the connectors the user has, on the member's model. */
function suggestionStart(
  member: TeamAgent,
  connections: ReadonlyArray<ConnectionSnapshot>,
  catalog: AgentModelCatalog,
): AgentFormStart {
  const suggestion = member.suggestion;
  return {
    title: suggestion?.title ?? member.label,
    description: suggestion?.description ?? "",
    instructions: suggestion?.instructions ?? "",
    model: agentModelOfSelection(catalog.entries, member.modelSelection),
    connectors: (suggestion?.connectors ?? []).flatMap((id) =>
      connections.some((connection) => connection.id === id) ? [{ id, approvals: {} }] : [],
    ),
  };
}

/**
 * Makes the agent a lead suggested for a team member. Nothing is saved until Save, which gives
 * the member the agent in the team's unsaved edits and returns to the lead's Task tab.
 */
function SuggestedAgentForm(props: {
  readonly environmentId: EnvironmentId;
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
  const member =
    plan?.status === "proposed"
      ? (teamMembersWithoutAgent(resolveTeamDraft(plan, edit).draft).find(
          (candidate) => candidate.id === props.memberId,
        ) ?? null)
      : null;
  // The form starts from the suggestion once, and stays open if the team changes meanwhile.
  const [start, setStart] = useState<AgentFormStart | null>(null);
  if (
    start === null &&
    member !== null &&
    (connectors.data !== null || connectors.error !== null)
  ) {
    setStart(suggestionStart(member, connectors.data?.connections ?? NO_CONNECTIONS, catalog));
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
        forTeam={{ start, onSaved, onCancel: backToLead }}
      />
    );
  }
  if (member !== null || (plan === null && loading)) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>This suggestion is settled</EmptyTitle>
        <EmptyDescription>
          The team has an agent for it now, or the lead proposed another team.
        </EmptyDescription>
      </EmptyHeader>
      <Button size="sm" variant="outline" onClick={backToLead}>
        Back to the team
      </Button>
    </Empty>
  );
}
