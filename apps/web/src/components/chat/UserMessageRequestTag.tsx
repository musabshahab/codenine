import type { OrchestrationMessageContext } from "@codenine/contracts";
import { hasTeamRequest, hasWorkflowRequest } from "@codenine/shared/composerContextReferences";
import { UsersIcon, WorkflowIcon } from "lucide-react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const REQUESTS = {
  team: {
    Icon: UsersIcon,
    label: "Team requested",
    tooltip: "Sent with Team on: the lead agent plans a team before any work starts",
  },
  workflow: {
    Icon: WorkflowIcon,
    label: "Workflow requested",
    tooltip: "Sent with Workflow on: the lead agent drafts a workflow instead of doing the work",
  },
} as const;

/** Marks a message the user sent with Team or Workflow on. */
export function UserMessageRequestTag(props: {
  readonly context: OrchestrationMessageContext | undefined;
}) {
  const records = props.context?.records ?? [];
  const request = hasTeamRequest(records)
    ? REQUESTS.team
    : hasWorkflowRequest(records)
      ? REQUESTS.workflow
      : null;
  if (request === null) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            className="me-1 flex items-center justify-end gap-1 text-xs leading-none text-muted-foreground"
            data-user-message-request=""
          />
        }
      >
        <request.Icon aria-hidden="true" className="size-3" />
        {request.label}
      </TooltipTrigger>
      <TooltipPopup side="top">{request.tooltip}</TooltipPopup>
    </Tooltip>
  );
}
