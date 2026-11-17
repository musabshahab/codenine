import { TeamAgentId, ThreadId } from "@codenine/contracts";
import { createFileRoute } from "@tanstack/react-router";
import * as Schema from "effect/Schema";

import { AgentEditorPage } from "../components/pages/AgentEditorPage";
import { type SkillsSearch, validateSkillsSearch } from "../components/skills/skillsSearch";

const isThreadId = Schema.is(ThreadId);
const isTeamAgentId = Schema.is(TeamAgentId);

/** Also, for an agent a lead suggested: the lead's chat and the team member that waits for it. */
interface NewAgentSearch extends SkillsSearch {
  readonly lead?: ThreadId | undefined;
  readonly member?: TeamAgentId | undefined;
}

function validateNewAgentSearch(raw: Record<string, unknown>): NewAgentSearch {
  return {
    ...validateSkillsSearch(raw),
    ...(isThreadId(raw.lead) && isTeamAgentId(raw.member)
      ? { lead: raw.lead, member: raw.member }
      : {}),
  };
}

function NewAgentRouteView() {
  const search = Route.useSearch();
  return (
    <AgentEditorPage
      target={
        search.lead === undefined || search.member === undefined
          ? { kind: "new" }
          : { kind: "suggested", lead: search.lead, member: search.member }
      }
      machine={search.machine ?? null}
      workspace={search.workspace ?? null}
    />
  );
}

export const Route = createFileRoute("/_chat/agents_/new")({
  validateSearch: validateNewAgentSearch,
  component: NewAgentRouteView,
});
