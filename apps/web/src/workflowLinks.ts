import type { EnvironmentId, TeamPlanRun, ThreadId } from "@codenine/contracts";
import { defaultStringifySearch } from "@tanstack/react-router";

import type { NewWorkflowSearch, WorkflowsSearch } from "./components/workflows/workflowsSearch";
import type { FileRoutesByTo } from "./routeTree.gen";

// Checked against the route tree and the routes' search, so renaming either fails the typecheck
// instead of a link.
const RUN_ROUTE = "/workflows/$name/runs/$run" satisfies keyof FileRoutesByTo;
const NEW_ROUTE = "/workflows/new" satisfies keyof FileRoutesByTo;

/** A workflow run's page, on the computer that ran it. */
export function workflowRunHref(
  environmentId: EnvironmentId,
  run: Pick<TeamPlanRun, "workflowName" | "run">,
): string {
  const path = RUN_ROUTE.replace("$name", encodeURIComponent(run.workflowName)).replace(
    "$run",
    String(run.run),
  );
  const search: WorkflowsSearch = { machine: environmentId };
  return `${path}${defaultStringifySearch(search)}`;
}

/**
 * The workflow editor, starting from a chat's draft or from a finished team. A workflow is saved on
 * the computer its chat ran on.
 */
export function newWorkflowHref(
  environmentId: EnvironmentId,
  from: { readonly fromThread: ThreadId } | { readonly fromTeam: ThreadId },
): string {
  const search: NewWorkflowSearch = { machine: environmentId, ...from };
  return `${NEW_ROUTE}${defaultStringifySearch(search)}`;
}
