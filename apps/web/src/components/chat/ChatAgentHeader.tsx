import type { ConnectionSnapshot, EnvironmentId, ScopedThreadRef } from "@codenine/contracts";
import { Link } from "@tanstack/react-router";

import { agentUsesLine } from "../agents/agents.logic";
import { agentTitle, useAgents } from "../agents/useAgents";
import { ConnectorMark } from "../connectors/ConnectorMark";
import { Badge } from "../ui/badge";
import { useChatChoices } from "./useChatChoices";

interface ChatAgentTarget {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  /** False for a new chat, whose agent waits with its draft. */
  readonly onServer: boolean;
}

function useChatAgent(target: ChatAgentTarget) {
  const choices = useChatChoices({ ...target, projectId: null, canChange: false });
  const { agents } = useAgents(target.environmentId);
  const name = choices.agent;
  const agent =
    name === null ? null : (agents.find((candidate) => candidate.name === name) ?? null);
  return { name, agent, connections: choices.connections };
}

/** "Gmail agent" beside a chat's title, opening the agent's page. */
export function ChatAgentChip(props: ChatAgentTarget) {
  const { name, agent } = useChatAgent(props);
  if (name === null) return null;
  const title = agentTitle(name, agent);
  return (
    <Badge
      variant="info"
      size="lg"
      render={
        <Link to="/agents/$name/edit" params={{ name }} search={{ machine: props.environmentId }} />
      }
    >
      <ConnectorMark name={title} size="sm" tone="agent" />
      <span className="max-w-40 truncate">{title} agent</span>
    </Badge>
  );
}

function connectorNames(
  ids: ReadonlyArray<string>,
  connections: ReadonlyArray<Pick<ConnectionSnapshot, "id" | "name">>,
) {
  return ids.map((id) => connections.find((connection) => connection.id === id)?.name ?? id);
}

/** Under a chat's title: what its agent uses, such as "Uses Gmail · Write clear emails". */
export function ChatAgentLine(props: ChatAgentTarget) {
  const { agent, connections } = useChatAgent(props);
  if (agent === null) return null;
  return (
    <p className="min-w-0 truncate text-xs leading-4 text-muted-foreground">
      {agentUsesLine(
        connectorNames(
          agent.connectors.map((connector) => connector.id),
          connections,
        ),
        agent.skills,
      )}
    </p>
  );
}
