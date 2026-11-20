import { SkillName } from "@codenine/contracts";
import { createFileRoute } from "@tanstack/react-router";
import * as Schema from "effect/Schema";

import { SkillEditorPage, type SkillEditorTarget } from "../components/pages/SkillEditorPage";
import { validateSkillsSearch } from "../components/skills/skillsSearch";

const isSkillName = Schema.is(SkillName);

function EditSkillRouteView() {
  const { scope, name } = Route.useParams();
  const search = Route.useSearch();
  const target: SkillEditorTarget =
    (scope === "codenine" || scope === "workspace") && isSkillName(name)
      ? { kind: "edit", scope, name }
      : { kind: "invalid" };
  return (
    <SkillEditorPage
      // Keyed so an edit in progress never carries over to another skill.
      key={`${scope}:${name}`}
      target={target}
      machine={search.machine ?? null}
      workspace={search.workspace ?? null}
    />
  );
}

export const Route = createFileRoute("/_chat/skills_/$scope/$name")({
  validateSearch: validateSkillsSearch,
  component: EditSkillRouteView,
});
