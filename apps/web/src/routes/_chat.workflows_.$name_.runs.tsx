import { WorkflowName } from "@codenine/contracts";
import { createFileRoute } from "@tanstack/react-router";
import * as Schema from "effect/Schema";

import { WorkflowRunsPage } from "../components/pages/WorkflowRunsPage";
import { validateWorkflowsSearch } from "../components/workflows/workflowsSearch";

const isWorkflowName = Schema.is(WorkflowName);

function WorkflowRunsRouteView() {
  const { name } = Route.useParams();
  const search = Route.useSearch();
  return (
    <WorkflowRunsPage
      key={name}
      name={isWorkflowName(name) ? name : null}
      machine={search.machine ?? null}
    />
  );
}

export const Route = createFileRoute("/_chat/workflows_/$name_/runs")({
  validateSearch: validateWorkflowsSearch,
  component: WorkflowRunsRouteView,
});
