import type { OrchestrationV2TurnItem } from "@codenine/contracts";

type WorkflowRunItem = Extract<OrchestrationV2TurnItem, { readonly type: "workflow_run" }>;

/** The workflow results a chat's agent has not been given yet, as the text its next prompt carries. */
export function workflowResultsContext(items: ReadonlyArray<WorkflowRunItem>): string {
  if (items.length === 0) return "";
  return [
    "Workflow results posted in this chat since your last turn:",
    ...items.map((item) =>
      [
        `Workflow "${item.title}", run ${item.run}, ${item.status === "cancelled" ? "stopped" : item.status}${item.headline ? `: ${item.headline}` : ""}`,
        item.result ?? "(No result was recorded.)",
        `Run ${item.run}'s own chat is thread ${item.leadThreadId}; read it with codenine_thread_read for more.`,
      ].join("\n"),
    ),
  ].join("\n\n");
}
