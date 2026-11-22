import type { OrchestrationV2TurnItem, ScopedThreadRef, ThreadId } from "@codenine/contracts";
import { WorkflowIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { RunStatusBadge } from "../workflows/RunStatusBadge";
import { workflowResultExcerpt } from "./WorkflowRunCard.logic";
import type { WorkflowRunStatus } from "../workflows/workflows.logic";

type WorkflowRunItem = Extract<OrchestrationV2TurnItem, { type: "workflow_run" }>;

function runStatusOf(status: WorkflowRunItem["status"]): WorkflowRunStatus {
  switch (status) {
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "stopped";
    default:
      return "running";
  }
}

const BORDER_CLASS_NAME: Partial<Record<WorkflowRunStatus, string>> = {
  done: "border-success/32",
  failed: "border-destructive/32",
};

/** A workflow run's result in its workflow's chat; the full result renders only once opened. */
export function WorkflowRunCard(props: {
  readonly item: WorkflowRunItem;
  readonly threadRef: ScopedThreadRef;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { item } = props;
  const [expanded, setExpanded] = useState(false);
  const status = runStatusOf(item.status);
  const excerpt = item.result === null ? null : workflowResultExcerpt(item.result);
  return (
    <article
      aria-label="Workflow result"
      data-v2-item-type={item.type}
      className={cn(
        "relative min-w-0 rounded-xl border px-4 py-3",
        BORDER_CLASS_NAME[status] ?? "border-border",
      )}
    >
      <div className="mb-2 flex min-w-0 items-center gap-2">
        <WorkflowIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <h3 className="min-w-0 truncate font-semibold">
          {item.title ?? "Workflow"} · run {item.run}
        </h3>
        <RunStatusBadge status={status} />
        <Button
          size="xs"
          variant="ghost"
          className="ms-auto"
          onClick={() => props.onOpenThread(item.leadThreadId)}
        >
          Open run
        </Button>
      </div>
      {item.headline === null ? null : (
        <p className="mb-1.5 break-words font-medium">{item.headline}</p>
      )}
      {item.result === null || excerpt === null ? null : expanded ? (
        <ChatMarkdown text={item.result} cwd={undefined} threadRef={props.threadRef} />
      ) : (
        <p className="line-clamp-4 whitespace-pre-line break-words text-muted-foreground">
          {excerpt.text}
        </p>
      )}
      {excerpt === null || !excerpt.more ? null : (
        <Button
          size="xs"
          variant="link"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : "Show more"}
        </Button>
      )}
    </article>
  );
}
