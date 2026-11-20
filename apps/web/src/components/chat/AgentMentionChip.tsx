import type { EnvironmentId } from "@codenine/contracts";
import { BotIcon } from "lucide-react";

import { agentTitle, useAgents } from "../agents/useAgents";
import { ContextChipPopover } from "../contextChipParts";

/** `agent:<name>` from the `@` menu: the agent the message handed the chat to. */
export function AgentMentionChip(props: {
  environmentId: EnvironmentId | null;
  name: string;
  source: string;
}) {
  const { agents } = useAgents(props.environmentId);
  const agent = agents.find((candidate) => candidate.name === props.name);
  const title = agentTitle(props.name, agent);
  return (
    <ContextChipPopover
      kind="mention"
      icon={<BotIcon />}
      label={title}
      accessibleLabel={`Agent ${title}`}
      copyMarkdown={props.source}
    >
      <div className="space-y-1 p-2 text-sm">
        <p className="font-medium">{title} agent</p>
        {agent === undefined ? null : <p className="text-muted-foreground">{agent.description}</p>}
      </div>
    </ContextChipPopover>
  );
}
