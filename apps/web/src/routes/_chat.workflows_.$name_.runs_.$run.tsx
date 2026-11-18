import { WorkflowName } from "@codenine/contracts";
import { createFileRoute } from "@tanstack/react-router";
import * as Schema from "effect/Schema";

import { WorkflowRunPage } from "../components/pages/WorkflowRunPage";
import { validateWorkflowsSearch } from "../components/workflows/workflowsSearch";

const isWorkflowName = Schema.is(WorkflowName);

function WorkflowRunRouteView() {
  const { name, run } = Route.useParams();
  const search = Route.useSearch();
  const number = /^[1-9]\d{0,8}$/u.test(run) ? Number(run) : null;
  return (
    <WorkflowRunPage
      key={`${name}:${run}`}
      name={isWorkflowName(name) ? name : null}
      run={number}
      machine={search.machine ?? null}
    />
  );
}

export const Route = createFileRoute("/_chat/workflows_/$name_/runs_/$run")({
  validateSearch: validateWorkflowsSearch,
  component: WorkflowRunRouteView,
});
