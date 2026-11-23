import type { OrchestrationV2AppThreadLineage } from "@codenine/contracts";
import type { WorkspaceExample } from "@codenine/shared/workspacePreset";

interface LeadPlace {
  readonly lineage: Pick<OrchestrationV2AppThreadLineage, "relationshipToParent" | "sideChat">;
  readonly inTeam: boolean;
  /** An agent's chat cannot start or steer other chats, so it cannot lead. */
  readonly hasAgent: boolean;
}

/**
 * A lead plans from a draft or a top-level thread that neither leads a team nor works for one.
 * Subagents and side chats answer to another thread, so they have none.
 */
function canLead(input: LeadPlace): boolean {
  return (
    !input.inTeam &&
    !input.hasAgent &&
    input.lineage.relationshipToParent !== "subagent" &&
    input.lineage.sideChat !== true
  );
}

export function teamToggleAvailable(
  input: LeadPlace & {
    /** A team works in a project's folder; a chat in Chats has none. */
    readonly inProject: boolean;
  },
): boolean {
  return input.inProject && canLead(input);
}

/** Workflow is offered in Chats too: the workspace its steps work in is chosen when it is saved. */
export function workflowToggleAvailable(input: LeadPlace): boolean {
  return canLead(input);
}

/** A slash command goes to the provider as typed, so neither Team nor Workflow rides on it. */
export function sendsComposerRequest(input: {
  readonly requested: boolean;
  readonly prompt: string;
}): boolean {
  return input.requested && !input.prompt.trimStart().startsWith("/");
}

/**
 * Examples talk about work in the project, so a chat without one shows none, nor does one drafting
 * a workflow, and typing hides them.
 */
export function draftHeroExamples(input: {
  readonly examples: ReadonlyArray<WorkspaceExample>;
  readonly hasProject: boolean;
  readonly composerEmpty: boolean;
  readonly teamAvailable: boolean;
  readonly workflowRequested: boolean;
}): ReadonlyArray<WorkspaceExample> {
  if (!input.hasProject || !input.composerEmpty || input.workflowRequested) return [];
  return input.teamAvailable ? input.examples : input.examples.filter((example) => !example.team);
}
