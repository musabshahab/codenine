import { EnvironmentId, ThreadId } from "@codenine/contracts";
import * as Schema from "effect/Schema";

const isThreadId = Schema.is(ThreadId);

/** The machine a Workflows page shows, carried in its address as on the Agents pages. */
export interface WorkflowsSearch {
  readonly machine?: EnvironmentId | undefined;
}

export function validateWorkflowsSearch(raw: Record<string, unknown>): WorkflowsSearch {
  return typeof raw.machine === "string" && raw.machine.trim()
    ? { machine: EnvironmentId.make(raw.machine) }
    : {};
}

/** Also, for a new workflow: the chat whose draft it starts from, or the finished team's lead. */
export interface NewWorkflowSearch extends WorkflowsSearch {
  readonly fromThread?: ThreadId | undefined;
  readonly fromTeam?: ThreadId | undefined;
}

export function validateNewWorkflowSearch(raw: Record<string, unknown>): NewWorkflowSearch {
  return {
    ...validateWorkflowsSearch(raw),
    ...(isThreadId(raw.fromThread) ? { fromThread: raw.fromThread } : {}),
    ...(isThreadId(raw.fromTeam) ? { fromTeam: raw.fromTeam } : {}),
  };
}
