const oneLine = (text: string) => text.replaceAll(/\s+/g, " ").trim();

/** What a session's instructions say about the agent a chat talks to: who it is, then how it works. */
export function buildAgentInstructions(agent: {
  readonly title: string;
  readonly description: string;
  readonly instructions: string;
}): string {
  const identity = `You are the ${oneLine(agent.title)} agent. ${oneLine(agent.description)}`;
  const body = agent.instructions.trim();
  return body === "" ? identity : `${identity}\n\n${body}`;
}
