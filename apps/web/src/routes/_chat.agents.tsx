import { createFileRoute } from "@tanstack/react-router";

import { AgentsPage } from "../components/pages/AgentsPage";
import { validateSkillsSearch } from "../components/skills/skillsSearch";

function AgentsRouteView() {
  const search = Route.useSearch();
  return <AgentsPage machine={search.machine ?? null} workspace={search.workspace ?? null} />;
}

export const Route = createFileRoute("/_chat/agents")({
  // The machine, and the workspace a chat started here opens in, as the Skills page reads them.
  validateSearch: validateSkillsSearch,
  component: AgentsRouteView,
});
