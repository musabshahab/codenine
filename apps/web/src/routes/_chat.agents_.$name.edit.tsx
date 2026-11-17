import { AgentName } from "@codenine/contracts";
import { createFileRoute } from "@tanstack/react-router";
import * as Schema from "effect/Schema";

import { AgentEditorPage, type AgentEditorTarget } from "../components/pages/AgentEditorPage";
import { validateSkillsSearch } from "../components/skills/skillsSearch";

const isAgentName = Schema.is(AgentName);

function EditAgentRouteView() {
  const { name } = Route.useParams();
  const search = Route.useSearch();
  const target: AgentEditorTarget = isAgentName(name)
    ? { kind: "edit", name }
    : { kind: "invalid" };
  return (
    <AgentEditorPage
      // Keyed so an edit in progress never carries over to another agent.
      key={name}
      target={target}
      machine={search.machine ?? null}
      workspace={search.workspace ?? null}
    />
  );
}

// A level below `new`, so an agent named "new" still has its own page.
export const Route = createFileRoute("/_chat/agents_/$name/edit")({
  validateSearch: validateSkillsSearch,
  component: EditAgentRouteView,
});
