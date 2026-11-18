import { createFileRoute } from "@tanstack/react-router";

import { WorkflowsPage } from "../components/pages/WorkflowsPage";
import { validateWorkflowsSearch } from "../components/workflows/workflowsSearch";

function WorkflowsRouteView() {
  const search = Route.useSearch();
  return <WorkflowsPage machine={search.machine ?? null} />;
}

export const Route = createFileRoute("/_chat/workflows")({
  validateSearch: validateWorkflowsSearch,
  component: WorkflowsRouteView,
});
