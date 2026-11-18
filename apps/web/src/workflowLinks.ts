import type { EnvironmentId, TeamPlanRun, ThreadId } from "@codenine/contracts";
import { defaultStringifySearch } from "@tanstack/react-router";

/** A workflow run's page, on the computer that ran it. */
export function workflowRunHref(
  environmentId: EnvironmentId,
  run: Pick<TeamPlanRun, "workflowName" | "run">,
): string {
  const path = `/workflows/${encodeURIComponent(run.workflowName)}/runs/${run.run}`;
  return `${path}${defaultStringifySearch({ machine: environmentId })}`;
}

/**
 * The workflow editor, starting from a chat's draft or from a finished team. A workflow is saved on
 * the computer its chat ran on.
 */
export function newWorkflowHref(
  environmentId: EnvironmentId,
  from: { readonly fromThread: ThreadId } | { readonly fromTeam: ThreadId },
): string {
  return `/workflows/new${defaultStringifySearch({ machine: environmentId, ...from })}`;
}
