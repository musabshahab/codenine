import { createFileRoute } from "@tanstack/react-router";

import { SkillEditorPage } from "../components/pages/SkillEditorPage";
import { validateSkillsSearch } from "../components/skills/skillsSearch";

function NewSkillRouteView() {
  const search = Route.useSearch();
  return (
    <SkillEditorPage
      target={{ kind: "new" }}
      machine={search.machine ?? null}
      workspace={search.workspace ?? null}
    />
  );
}

export const Route = createFileRoute("/_chat/skills_/new")({
  validateSearch: validateSkillsSearch,
  component: NewSkillRouteView,
});
