import { BotIcon } from "lucide-react";

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { WorkspacePage } from "./WorkspacePage";

/** Agents: assistants set up once for a kind of task. */
export function AgentsPage() {
  return (
    <WorkspacePage area="agents" title="Agents">
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BotIcon />
          </EmptyMedia>
          <EmptyTitle>No agents yet</EmptyTitle>
          <EmptyDescription>
            An agent is an assistant set up once for a kind of task: its instructions, the model it
            runs on, and the skills and connectors it can use. Building agents comes next; until
            then, start a chat and pick its model in the composer.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </WorkspacePage>
  );
}
