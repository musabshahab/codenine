import { WorkflowName } from "@codenine/contracts";
import { createFileRoute } from "@tanstack/react-router";
import * as Schema from "effect/Schema";

import { WorkflowEditorPage } from "../components/pages/WorkflowEditorPage";
import { validateWorkflowsSearch } from "../components/workflows/workflowsSearch";

const isWorkflowName = Schema.is(WorkflowName);

function WorkflowRouteView() {
  const { name } = Route.useParams();
  const search = Route.useSearch();
  return (
    <WorkflowEditorPage
      // Keyed so an edit in progress never carries over to another workflow.
      key={name}
      target={isWorkflowName(name) ? { kind: "saved", name } : { kind: "invalid" }}
      machine={search.machine ?? null}
    />
  );
}

export const Route = createFileRoute("/_chat/workflows_/$name")({
  validateSearch: validateWorkflowsSearch,
  component: WorkflowRouteView,
});
