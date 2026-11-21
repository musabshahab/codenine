import type { EnvironmentId, WorkflowDetail } from "@codenine/contracts";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { savedWorkflowsEnvironment } from "../../state/savedWorkflows";
import { useAccessEnvironment } from "../settings/useAccessEnvironment";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { RunStatusBadge } from "../workflows/RunStatusBadge";
import { RunWorkflowButton } from "../workflows/RunWorkflowButton";
import { WorkflowBreadcrumb, WorkflowViewSwitch } from "../workflows/WorkflowHeader";
import { useWorkflowClock, useWorkflowRuns } from "../workflows/workflowHooks";
import {
  formatCost,
  formatDuration,
  formatWhen,
  runDurationMs,
  runStartLine,
  runsSummaryLine,
  workflowHistoryRows,
} from "../workflows/workflows.logic";
import { WorkspacePage } from "./WorkspacePage";

/** A workflow's runs, newest first, with the scheduled runs Codenine skipped. */
export function WorkflowRunsPage(props: {
  readonly name: string | null;
  readonly machine: EnvironmentId | null;
}) {
  const { environment } = useAccessEnvironment(props.machine);
  const environmentId = environment?.environmentId ?? null;
  const connected = environment?.connection.phase === "connected";
  if (props.name === null || environmentId === null || !connected) {
    return (
      <RunsMessage machine={environmentId}>
        <EmptyTitle>
          {props.name === null ? "This workflow is not here" : "Not connected"}
        </EmptyTitle>
        <EmptyDescription>
          {props.name === null
            ? "The address does not name a workflow."
            : "Connect the computer the workflow is on to see its runs."}
        </EmptyDescription>
      </RunsMessage>
    );
  }
  return <RunsOnMachine environmentId={environmentId} name={props.name} />;
}

function RunsMessage(props: {
  readonly machine: EnvironmentId | null;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <WorkspacePage
      area="workflow"
      title={
        <WorkflowBreadcrumb machine={props.machine} workflow={{ title: "Runs", name: null }} />
      }
    >
      <Empty className="h-full">
        <EmptyHeader>{props.children}</EmptyHeader>
        {props.action}
      </Empty>
    </WorkspacePage>
  );
}

function RunsOnMachine(props: { readonly environmentId: EnvironmentId; readonly name: string }) {
  const { environmentId, name } = props;
  const detail = useEnvironmentQuery(
    savedWorkflowsEnvironment.read({ environmentId, input: { name } }),
  );
  if (detail.data === null) {
    return (
      <RunsMessage
        machine={environmentId}
        action={
          detail.error === null ? null : (
            <Button size="sm" variant="outline" onClick={detail.refresh}>
              Try again
            </Button>
          )
        }
      >
        {detail.error === null ? (
          <EmptyDescription>Loading…</EmptyDescription>
        ) : (
          <>
            <EmptyTitle>This workflow could not open</EmptyTitle>
            <EmptyDescription>{detail.error}</EmptyDescription>
          </>
        )}
      </RunsMessage>
    );
  }
  return <RunsTable environmentId={environmentId} workflow={detail.data} />;
}

function RunsTable(props: {
  readonly environmentId: EnvironmentId;
  readonly workflow: WorkflowDetail;
}) {
  const { environmentId, workflow } = props;
  const navigate = useNavigate();
  const clock = useWorkflowClock();
  const runs = useWorkflowRuns(environmentId).filter((run) => run.workflowId === workflow.id);
  const rows = workflowHistoryRows(runs, workflow.skipped);
  const summary = runsSummaryLine(runs, clock);
  return (
    <WorkspacePage
      area="workflow"
      title={
        <WorkflowBreadcrumb
          machine={environmentId}
          workflow={{ title: workflow.title, name: null }}
        />
      }
      subtitle={<WorkflowViewSwitch machine={environmentId} name={workflow.name} view="runs" />}
      actions={
        <RunWorkflowButton
          environmentId={environmentId}
          workflow={workflow}
          inputs={workflow.inputs}
          variant="outline"
          disabledReason={workflow.problems[0]?.message ?? null}
        />
      }
    >
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-8 sm:px-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-base font-semibold text-foreground">Runs</h2>
          {summary === null ? null : (
            <span className="text-muted-foreground text-sm">{summary}</span>
          )}
        </div>
        {rows.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No runs yet</EmptyTitle>
              <EmptyDescription>
                {workflow.trigger.schedule === null || !workflow.enabled
                  ? "Its runs show here once you start one."
                  : "Its runs show here from its first scheduled time, or once you start one."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="rounded-xl border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">Run</TableHead>
                  <TableHead className="w-52">Started</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead className="w-20">Time</TableHead>
                  <TableHead className="w-16">Cost</TableHead>
                  <TableHead className="w-16">
                    <span className="sr-only">Open</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  if (row.kind === "skipped") {
                    return (
                      <TableRow key={`skipped:${row.scheduledFor}`}>
                        <TableCell />
                        <TableCell>
                          <span className="flex flex-col gap-0.5">
                            <span>{formatWhen(Date.parse(row.scheduledFor), clock)}</span>
                            <span className="text-muted-foreground">Codenine was off</span>
                          </span>
                        </TableCell>
                        <TableCell>
                          <span className="flex flex-wrap items-center gap-2 whitespace-normal">
                            <Badge variant="outline">Skipped</Badge>
                            <span className="text-muted-foreground">
                              Missed runs were set to Skip it then
                            </span>
                          </span>
                        </TableCell>
                        <TableCell />
                        <TableCell />
                        <TableCell />
                      </TableRow>
                    );
                  }
                  const { run } = row;
                  const duration = runDurationMs(run, clock.nowMs);
                  return (
                    <TableRow key={run.threadId}>
                      <TableCell>
                        <span className="text-muted-foreground tabular-nums">{run.run}</span>
                      </TableCell>
                      <TableCell>
                        <span className="flex flex-col gap-0.5">
                          <span>{formatWhen(Date.parse(run.startedAt), clock)}</span>
                          <span className="whitespace-normal text-muted-foreground">
                            {runStartLine(run, clock)}
                          </span>
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="flex flex-wrap items-center gap-2 whitespace-normal">
                          <RunStatusBadge status={run.status} />
                          {run.headline === null ? null : <span>{run.headline}</span>}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="text-muted-foreground tabular-nums">
                          {duration === null ? "" : formatDuration(duration)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="text-muted-foreground tabular-nums">
                          {run.costUsd === null ? "Unknown" : formatCost(run.costUsd)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Button
                          size="xs"
                          variant="ghost"
                          aria-label={`Open run ${run.run}`}
                          onClick={() =>
                            void navigate({
                              to: "/workflows/$name/runs/$run",
                              params: { name: workflow.name, run: String(run.run) },
                              search: { machine: environmentId },
                            })
                          }
                        >
                          Open
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
        <p className="text-muted-foreground text-xs">
          Runs show here while their chats are kept. A run's chats keep everything its agents and
          lead did.
        </p>
      </div>
    </WorkspacePage>
  );
}
