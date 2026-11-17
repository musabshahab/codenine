import { createFileRoute } from "@tanstack/react-router";

import { AgentEditorPage } from "../components/pages/AgentEditorPage";
import { validateSkillsSearch } from "../components/skills/skillsSearch";

function NewAgentRouteView() {
  const search = Route.useSearch();
  return (
    <AgentEditorPage
      target={{ kind: "new" }}
      machine={search.machine ?? null}
      workspace={search.workspace ?? null}
    />
  );
}

export const Route = createFileRoute("/_chat/agents_/new")({
  validateSearch: validateSkillsSearch,
  component: NewAgentRouteView,
});
