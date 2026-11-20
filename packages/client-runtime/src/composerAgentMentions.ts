/** Prompt text handing the chat to an agent. No `@`, which the editor would turn into a file chip. */
export function formatComposerAgentMention(name: string): string {
  return `agent:${name}`;
}

export interface ComposerAgentMentionOccurrence {
  readonly name: string;
  readonly source: string;
  readonly start: number;
  readonly end: number;
}

// Names match AgentName: lower case letters, digits and single hyphens.
const AGENT_MENTION_PATTERN = /(?<![^\s,(["'])agent:([a-z0-9]+(?:-[a-z0-9]+)*)(?![\w-])/gu;

/** Finds the `agent:<name>` references that `formatComposerAgentMention` writes. */
export function collectComposerAgentMentions(
  text: string,
): ReadonlyArray<ComposerAgentMentionOccurrence> {
  if (!text.includes("agent:")) return [];
  return Array.from(text.matchAll(AGENT_MENTION_PATTERN), (match) => ({
    name: match[1]!,
    source: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
}
