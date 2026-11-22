import { Badge } from "../ui/badge";
import { RUN_STATUS_LABELS, type WorkflowRunStatus } from "./workflows.logic";

const STATUS_BADGE = {
  running: "info",
  waiting: "warning",
  done: "success",
  failed: "error",
  stopped: "outline",
} as const satisfies Record<WorkflowRunStatus, string>;

export function RunStatusBadge(props: {
  readonly status: WorkflowRunStatus;
  readonly size?: "lg" | undefined;
}) {
  return (
    <Badge variant={STATUS_BADGE[props.status]} size={props.size}>
      {RUN_STATUS_LABELS[props.status]}
    </Badge>
  );
}
