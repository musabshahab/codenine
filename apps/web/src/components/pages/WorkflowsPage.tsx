import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@codenine/contracts";
import { WorkflowIcon } from "lucide-react";
import { useState } from "react";

import { savedWorkflowsEnvironment } from "../../state/savedWorkflows";
import { useEnvironmentQuery } from "../../state/query";
import { useAgentModelCatalog, useAgents } from "../agents/useAgents";
import { EnvironmentPagePicker } from "../settings/EnvironmentPagePicker";
import { useAccessEnvironment } from "../settings/useAccessEnvironment";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { NewWorkflowMenu } from "../workflows/NewWorkflowMenu";
import { WorkflowCard } from "../workflows/WorkflowCard";
import { useWorkflowClock, useWorkflowRuns } from "../workflows/workflowHooks";
import { WorkspacePage } from "./WorkspacePage";

/** Workflows: saved teams that run on a schedule or when the user starts them. */
export function WorkflowsPage(props: { readonly machine: EnvironmentId | null }) {
  const [selectedMachine, setSelectedMachine] = useState(props.machine);
  const { candidates, environment, label } = useAccessEnvironment(selectedMachine);
  const environmentId = environment?.environmentId ?? null;
  const connected = environment?.connection.phase === "connected";
  const canSave = useAtomValue(savedWorkflowsEnvironment.save.permissionAtom(environmentId));
  return (
    <WorkspacePage
      area="workflows"
      title="Workflows"
      actions={
        environmentId !== null && connected ? (
          <NewWorkflowMenu environmentId={environmentId} disabled={!canSave} />
        ) : null
      }
    >
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-8 sm:px-6">
        <p className="max-w-2xl text-muted-foreground text-sm">
          Your agents working through a process for you, on a schedule or when you start it. In each
          run a lead hands out the steps, checks every result against your goal, and sends work back
          until it is right.
        </p>
        {candidates.length > 1 && environment !== null ? (
          <div className="-mx-3 sm:-mx-4">
            <EnvironmentPagePicker
              label="Workflows on"
              candidates={candidates}
              value={environment.environmentId}
              onChange={setSelectedMachine}
            />
          </div>
        ) : null}
        {environment === null ? (
          <p className="text-muted-foreground text-sm">Connect a computer to see its workflows.</p>
        ) : !connected ? (
          <p className="text-muted-foreground text-sm">
            Reconnect {label ?? environment.label} to see its workflows.
          </p>
        ) : (
          <WorkflowsOnMachine
            key={environment.environmentId}
            environmentId={environment.environmentId}
            canSave={canSave}
          />
        )}
        <p className="text-muted-foreground text-xs">
          Workflows live in your Codenine folder, so backups include them. A scheduled run needs
          Codenine running on this computer at its time; each workflow says what happens to runs it
          misses.
        </p>
      </div>
    </WorkspacePage>
  );
}

function WorkflowsOnMachine(props: {
  readonly environmentId: EnvironmentId;
  readonly canSave: boolean;
}) {
  const { environmentId } = props;
  const list = useEnvironmentQuery(savedWorkflowsEnvironment.list({ environmentId, input: {} }));
  const { agents } = useAgents(environmentId);
  const catalog = useAgentModelCatalog(environmentId);
  const runs = useWorkflowRuns(environmentId);
  const clock = useWorkflowClock();
  if (list.data === null) {
    return list.error === null ? (
      <p className="text-muted-foreground text-sm">Loading workflows…</p>
    ) : (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <WorkflowIcon />
          </EmptyMedia>
          <EmptyTitle>Workflows could not load</EmptyTitle>
          <EmptyDescription>{list.error}</EmptyDescription>
        </EmptyHeader>
        <Button size="sm" variant="outline" onClick={list.refresh}>
          Try again
        </Button>
      </Empty>
    );
  }
  if (list.data.workflows.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <WorkflowIcon />
          </EmptyMedia>
          <EmptyTitle>No workflows yet</EmptyTitle>
          <EmptyDescription>
            A workflow is a team of your agents that runs again: each step done by one of them, and
            a lead that checks every result against the outcome you want. Run it on a schedule or
            whenever you start it.
          </EmptyDescription>
        </EmptyHeader>
        <NewWorkflowMenu environmentId={environmentId} disabled={!props.canSave} />
      </Empty>
    );
  }
  const workflows = list.data.workflows.toSorted((left, right) =>
    left.title.localeCompare(right.title),
  );
  return (
    <div className="grid gap-3.5 lg:grid-cols-2">
      {workflows.map((workflow) => (
        <WorkflowCard
          key={workflow.name}
          environmentId={environmentId}
          workflow={workflow}
          runs={runs.filter((run) => run.workflowId === workflow.id)}
          agents={agents}
          catalog={catalog}
          clock={clock}
          canSave={props.canSave}
        />
      ))}
    </div>
  );
}
