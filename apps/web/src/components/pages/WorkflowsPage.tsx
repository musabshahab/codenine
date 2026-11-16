import { WorkflowIcon } from "lucide-react";

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { WorkspacePage } from "./WorkspacePage";

/** Workflows: agents and steps chained into a process that runs again. */
export function WorkflowsPage() {
  return (
    <WorkspacePage area="workflows" title="Workflows">
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <WorkflowIcon />
          </EmptyMedia>
          <EmptyTitle>No workflows yet</EmptyTitle>
          <EmptyDescription>
            A workflow chains agents and steps into a process you can run again, or on a schedule.
            Building workflows comes next; until then, choose New task with a team and several
            agents split one task.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </WorkspacePage>
  );
}
