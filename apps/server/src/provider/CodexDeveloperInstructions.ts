import type { V2TurnStartParams__AdditionalContextEntry } from "effect-codex-app-server/schema";
import { buildRuntimeInstructions } from "@codenine/provider-core/server/runtimeInstructions";
import {
  buildSkillsInstructions,
  type SkillListing,
} from "@codenine/provider-core/server/skillInstructions";

import { CODENINE_ORCHESTRATION_SECTIONS } from "@codenine/provider-core/server/orchestrationInstructions";

/** Codex silently truncates additionalContext values over 1,000 tokens, counted as UTF-8 bytes / 4. */
export const CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES = 4_000;

type CodexAdditionalContext = Record<string, V2TurnStartParams__AdditionalContextEntry>;

const AGENT_KEY_PREFIX = "codenine_agent_";
const agentKey = (index: number) => `${AGENT_KEY_PREFIX}${String(index + 1).padStart(3, "0")}`;
const NO_AGENT_NOTE =
  "This chat no longer talks to an agent. Set aside the agent instructions given earlier in it and work as you normally would.";

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

/** Splits text into pieces of at most `maxBytes` UTF-8 bytes, at line ends where it can. */
function splitUtf8(text: string, maxBytes: number): ReadonlyArray<string> {
  const pieces: Array<string> = [];
  let current = "";
  let currentBytes = 0;
  for (const line of text.split(/(?<=\n)/u)) {
    const lineBytes = utf8Bytes(line);
    if (currentBytes + lineBytes <= maxBytes) {
      current += line;
      currentBytes += lineBytes;
      continue;
    }
    if (current !== "") pieces.push(current);
    current = "";
    currentBytes = 0;
    for (const character of line) {
      const characterBytes = utf8Bytes(character);
      if (currentBytes + characterBytes > maxBytes) {
        pieces.push(current);
        current = "";
        currentBytes = 0;
      }
      current += character;
      currentBytes += characterBytes;
    }
  }
  if (current !== "") pieces.push(current);
  return pieces;
}

/** The instructions of the agent a chat talks to, in order, each entry within Codex's cap. */
export function buildCodexAgentContext(instructions: string): CodexAdditionalContext {
  return Object.fromEntries(
    splitUtf8(instructions, CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES).map((value, index) => [
      agentKey(index),
      { kind: "application" as const, value },
    ]),
  );
}

/**
 * Codex keeps what it sent in the conversation and resends an entry only when its value changes,
 * so an agent entry that went away is overwritten instead of left out: emptied, or with a note
 * when the chat no longer talks to any agent.
 */
export function replaceDroppedAgentContext(
  next: CodexAdditionalContext,
  previous: CodexAdditionalContext | undefined,
): CodexAdditionalContext {
  const dropped = Object.keys(previous ?? {}).filter(
    (key) => key.startsWith(AGENT_KEY_PREFIX) && !(key in next),
  );
  if (dropped.length === 0) return next;
  const hasAgent = Object.keys(next).some((key) => key.startsWith(AGENT_KEY_PREFIX));
  return {
    ...next,
    ...Object.fromEntries(
      dropped.map((key) => [
        key,
        {
          kind: "application" as const,
          value: !hasAgent && key === agentKey(0) ? NO_AGENT_NOTE : "",
        },
      ]),
    ),
  };
}

export interface CodexRuntimeInfo {
  readonly model: string;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}

/** Keep this outside collaboration mode; model-catalog mode text overrides client developer_instructions. */
export function buildCodexAdditionalContext(
  runtime: CodexRuntimeInfo,
  skills: ReadonlyArray<SkillListing> = [],
): Record<string, V2TurnStartParams__AdditionalContextEntry> {
  const skillsInstructions = buildSkillsInstructions(skills);
  // Split values to fit per-entry caps; number keys because Codex emits them in key order.
  return {
    ...Object.fromEntries(
      CODENINE_ORCHESTRATION_SECTIONS.map((section, index) => [
        `codenine_orchestration_${String(index + 1).padStart(2, "0")}`,
        { kind: "application" as const, value: section },
      ]),
    ),
    codenine_runtime: {
      kind: "application",
      value: buildRuntimeInstructions({ harness: "Codex", ...runtime }),
    },
    // Codex re-sends an entry only when it changes, so a new skill reaches the next turn.
    ...(skillsInstructions === ""
      ? {}
      : { codenine_skills: { kind: "application" as const, value: skillsInstructions } }),
  };
}
