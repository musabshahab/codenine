import type { ComposerCommandItem } from "./ComposerCommandMenu";
import type { ModelPickerAgents } from "./ModelPickerAgentRow";

type ComposerAgentItem = Extract<ComposerCommandItem, { type: "agent" }>;

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * The agents an `@` mention can hand the chat to, best first in the menu: every word typed starts
 * a word of the agent's title or name. Agents that cannot run here stay in the picker, which says
 * why. No agent appears once the chat has an agent.
 */
export function matchComposerAgentItems(
  agents: ModelPickerAgents | undefined,
  query: string,
): ComposerAgentItem[] {
  if (agents === undefined) return [];
  const typed = words(query);
  const matches = (text: string) => {
    const candidates = words(text);
    return typed.every((word) => candidates.some((candidate) => candidate.startsWith(word)));
  };
  const items: ComposerAgentItem[] = [];
  if (agents.selected !== null && matches("No agent")) {
    items.push({
      id: "agent:none",
      type: "agent",
      name: null,
      label: "No agent",
      description: "Hand the chat back to just the model",
    });
  }
  for (const agent of agents.items) {
    if (agent.disabledReason !== null || !matches(`${agent.title} ${agent.name}`)) continue;
    items.push({
      id: `agent:${agent.name}`,
      type: "agent",
      name: agent.name,
      label: agent.title,
      description: agent.detail,
    });
  }
  return items;
}
