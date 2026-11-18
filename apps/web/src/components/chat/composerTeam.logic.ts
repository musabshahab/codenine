import type { OrchestrationV2AppThreadLineage } from "@codenine/contracts";

interface LeadPlace {
  readonly lineage: Pick<OrchestrationV2AppThreadLineage, "relationshipToParent" | "sideChat">;
  readonly inTeam: boolean;
}

/**
 * A lead plans from a draft or a top-level thread that neither leads a team nor works for one.
 * Subagents and side chats answer to another thread, so they have none.
 */
function canLead(input: LeadPlace): boolean {
  return (
    !input.inTeam &&
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

export interface DraftHeroExample {
  readonly prompt: string;
  readonly team: boolean;
}

const DRAFT_HERO_EXAMPLES: ReadonlyArray<DraftHeroExample> = [
  { prompt: "Add sign-in with tests, then have a stronger model review it", team: true },
  { prompt: "Explain how this workspace is structured", team: false },
  { prompt: "Fix the failing test and explain the cause", team: false },
];

/**
 * Examples talk about work in the project, so a chat without one shows none, nor does one drafting
 * a workflow, and typing hides them.
 */
export function draftHeroExamples(input: {
  readonly hasProject: boolean;
  readonly composerEmpty: boolean;
  readonly teamAvailable: boolean;
  readonly workflowRequested: boolean;
}): ReadonlyArray<DraftHeroExample> {
  if (!input.hasProject || !input.composerEmpty || input.workflowRequested) return [];
  return input.teamAvailable
    ? DRAFT_HERO_EXAMPLES
    : DRAFT_HERO_EXAMPLES.filter((example) => !example.team);
}
