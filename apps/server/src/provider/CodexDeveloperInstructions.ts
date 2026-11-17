import type { V2TurnStartParams__AdditionalContextEntry } from "effect-codex-app-server/schema";
import { buildRuntimeInstructions } from "@codenine/provider-core/server/runtimeInstructions";
import {
  buildSkillsInstructions,
  type SkillListing,
} from "@codenine/provider-core/server/skillInstructions";

import { CODENINE_ORCHESTRATION_SECTIONS } from "@codenine/provider-core/server/orchestrationInstructions";

/** Codex silently truncates additionalContext values over 1,000 tokens, counted as UTF-8 bytes / 4. */
export const CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES = 4_000;

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
