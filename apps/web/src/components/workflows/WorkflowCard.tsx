import { isAtomCommandInterrupted, settlePromise } from "@codenine/client-runtime/state/runtime";
import type { AgentSummary, EnvironmentId, WorkflowSummary } from "@codenine/contracts";
import { useNavigate } from "@tanstack/react-router";
import { EllipsisIcon } from "lucide-react";
import { useState } from "react";

import { commandErrorMessage } from "../../lib/commandError";
import { ensureLocalApi } from "../../localApi";
import { savedWorkflowsEnvironment } from "../../state/savedWorkflows";
import { useAtomCommand } from "../../state/use-atom-command";
import { type AgentModelCatalog, agentTitle, describeAgentModel } from "../agents/useAgents";
import { workflowScheduleText } from "../chat/workflowDraft.logic";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { RunWorkflowButton } from "./RunWorkflowButton";
import { setWorkflowEdit } from "./workflowEditStore";
import {
  CARD_STATUS_LABELS,
  type FormatOptions,
  formatCost,
  formatRecent,
  RUN_STATUS_LABELS,
  type WorkflowCardStatus,
  workflowCardStatus,
  type WorkflowRun,
} from "./workflows.logic";

const STATUS_BADGE = {
  on: "success",
  off: "outline",
  manual: "secondary",
  running: "info",
  waiting: "warning",
  failed: "error",
} as const satisfies Record<WorkflowCardStatus, string>;

function waitingLine(run: WorkflowRun): string {
  switch (run.hold?.reason) {
    case "spend":
      return `Run ${run.run} reached its spending limit. It waits until you say whether to go on.`;
    case "unpriced":
      return `Run ${run.run} has a spending limit, but its cost can't be estimated. It waits until you say whether to go on.`;
    case "time":
      return `Run ${run.run} reached its time limit. It waits until you say whether to go on.`;
    case "review":
      return `Run ${run.run} waits for you to accept a step or send it back.`;
    case undefined:
      return `A step in run ${run.run} waits for your answer.`;
  }
}

/** A saved workflow: what it does, when it runs, its steps and lead, and how its last run went. */
export function WorkflowCard(props: {
  readonly environmentId: EnvironmentId;
  readonly workflow: WorkflowSummary;
  /** Its runs this client knows, newest first. */
  readonly runs: ReadonlyArray<WorkflowRun>;
  readonly agents: ReadonlyArray<AgentSummary>;
  readonly catalog: AgentModelCatalog;
  readonly clock: FormatOptions;
  readonly canSave: boolean;
}) {
  const { environmentId, workflow, clock } = props;
  const navigate = useNavigate();
  const remove = useAtomCommand(savedWorkflowsEnvironment.delete, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const latest = props.runs[0] ?? null;
  const active = latest !== null && (latest.status === "running" || latest.status === "waiting");
  const status = workflowCardStatus(workflow, latest?.status ?? null);
  const schedule = workflow.trigger.schedule;
  const titleId = `workflow-${workflow.name}`;
  const search = { machine: environmentId };

  const steps =
    workflow.steps.length === 0
      ? "None yet"
      : workflow.steps
          .map((step) =>
            step.agent === null
              ? `${step.title} (no agent yet)`
              : agentTitle(
                  step.agent,
                  props.agents.find((agent) => agent.name === step.agent),
                ),
          )
          .join(", ");
  const lead =
    workflow.leadModel === null
      ? "No model yet"
      : describeAgentModel(props.catalog, workflow.leadModel).name;
  const lastRun =
    latest === null
      ? "None yet"
      : [
          latest.headline ?? RUN_STATUS_LABELS[latest.status],
          formatRecent(Date.parse(latest.startedAt), clock),
          latest.costUsd === null ? null : formatCost(latest.costUsd),
        ]
          .filter((part) => part !== null)
          .join(" · ");

  const deleteWorkflow = async () => {
    const confirmed = await settlePromise(() =>
      ensureLocalApi().dialogs.confirm(
        `Delete ${workflow.title}?\nIts folder is removed from your Codenine folder, and a run in progress is stopped. Chats from its runs stay.`,
        { variant: "destructive" },
      ),
    );
    if (confirmed._tag !== "Success" || !confirmed.value) return;
    setBusy(true);
    const result = await remove({ environmentId, input: { name: workflow.name } });
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: `Could not delete ${workflow.title}`,
          description: commandErrorMessage(result, "Try again."),
        });
      }
      return;
    }
    setWorkflowEdit(environmentId, workflow.name, null);
    toastManager.add({ type: "success", title: `Deleted ${workflow.title}` });
  };

  return (
    <article
      aria-labelledby={titleId}
      className="flex flex-col gap-3.5 rounded-xl border border-border bg-card p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <span className="flex min-w-0 flex-col gap-1">
          <h2 id={titleId} className="font-semibold text-base text-foreground">
            {workflow.title}
          </h2>
          {workflow.description === "" ? null : (
            <span className="text-muted-foreground text-sm">{workflow.description}</span>
          )}
        </span>
        <Badge variant={STATUS_BADGE[status]} size="lg">
          {CARD_STATUS_LABELS[status]}
        </Badge>
      </div>
      <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
        {schedule === null ? null : (
          <>
            <dt className="text-muted-foreground">When</dt>
            <dd className="text-foreground">
              {workflow.nextRunAt === null
                ? workflowScheduleText(schedule)
                : `${workflowScheduleText(schedule)} · next ${formatRecent(Date.parse(workflow.nextRunAt), clock)}`}
            </dd>
          </>
        )}
        <dt className="text-muted-foreground">Steps</dt>
        <dd className="text-foreground">{steps}</dd>
        <dt className="text-muted-foreground">Lead</dt>
        <dd className="text-foreground">{lead}</dd>
        <dt className="text-muted-foreground">Last run</dt>
        <dd className="text-foreground">{lastRun}</dd>
      </dl>
      {workflow.problems.length === 0 ? null : (
        <Alert variant="warning">
          <AlertTitle>It can't run yet</AlertTitle>
          <AlertDescription>
            <ul className="flex flex-col gap-1">
              {workflow.problems.map((problem) => (
                <li key={`${problem.step ?? ""}:${problem.message}`}>{problem.message}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      {latest?.status === "waiting" ? (
        <Alert variant="warning">
          <AlertDescription>{waitingLine(latest)}</AlertDescription>
        </Alert>
      ) : null}
      <div className="mt-auto flex flex-wrap items-center gap-2">
        {active ? (
          <Button
            size="sm"
            onClick={() =>
              void navigate({
                to: "/workflows/$name/runs/$run",
                params: { name: workflow.name, run: String(latest.run) },
                search,
              })
            }
          >
            Open the run
          </Button>
        ) : (
          <RunWorkflowButton
            environmentId={environmentId}
            workflow={workflow}
            inputs={null}
            disabledReason={workflow.problems[0]?.message ?? null}
          />
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            void navigate({ to: "/workflows/$name", params: { name: workflow.name }, search })
          }
        >
          Open
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void navigate({
              to: "/workflows/$name/runs",
              params: { name: workflow.name },
              search,
            })
          }
        >
          Runs
        </Button>
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost-muted"
                className="ms-auto"
                aria-label={`More for ${workflow.title}`}
              />
            }
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem
              variant="destructive"
              disabled={!props.canSave || busy}
              onClick={() => void deleteWorkflow()}
            >
              Delete
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </article>
  );
}
