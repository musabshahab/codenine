import { createFileRoute } from "@tanstack/react-router";

import { WorkflowEditorPage } from "../components/pages/WorkflowEditorPage";
import { validateNewWorkflowSearch } from "../components/workflows/workflowsSearch";

function NewWorkflowRouteView() {
  const search = Route.useSearch();
  const from =
    search.fromThread !== undefined
      ? ({ kind: "draft", threadId: search.fromThread } as const)
      : search.fromTeam !== undefined
        ? ({ kind: "team", threadId: search.fromTeam } as const)
        : ({ kind: "blank" } as const);
  return (
    <WorkflowEditorPage
      // Keyed so a draft in progress never carries over to another starting point.
      key={`${from.kind}:${from.kind === "blank" ? "" : from.threadId}`}
      target={{ kind: "new", from }}
      machine={search.machine ?? null}
    />
  );
}

export const Route = createFileRoute("/_chat/workflows_/new")({
  validateSearch: validateNewWorkflowSearch,
  component: NewWorkflowRouteView,
});
