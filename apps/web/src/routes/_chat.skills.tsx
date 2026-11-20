import { createFileRoute } from "@tanstack/react-router";

import { SkillsPage } from "../components/pages/SkillsPage";
import { validateSkillsSearch } from "../components/skills/skillsSearch";

function SkillsRouteView() {
  const search = Route.useSearch();
  return <SkillsPage machine={search.machine ?? null} workspace={search.workspace ?? null} />;
}

export const Route = createFileRoute("/_chat/skills")({
  validateSearch: validateSkillsSearch,
  component: SkillsRouteView,
});
