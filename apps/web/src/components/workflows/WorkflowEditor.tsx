import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted, settlePromise } from "@codenine/client-runtime/state/runtime";
import type {
  AgentModel,
  EnvironmentId,
  WorkflowDefinition,
  WorkflowDetail,
  WorkflowStepId,
} from "@codenine/contracts";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";

import { commandErrorMessage } from "../../lib/commandError";
import { ensureLocalApi } from "../../localApi";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { savedWorkflowsEnvironment } from "../../state/savedWorkflows";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  agentTitle,
  describeAgentModel,
  useAgentModelCatalog,
  useAgents,
} from "../agents/useAgents";
import { workflowScheduleText } from "../chat/workflowDraft.logic";
import { WorkspacePage } from "../pages/WorkspacePage";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { RunWorkflowButton } from "./RunWorkflowButton";
import { type CanvasStep, WorkflowCanvas } from "./WorkflowCanvas";
import {
  readWorkflowEdit,
  setWorkflowEdit,
  setWorkflowSelection,
  useWorkflowEdit,
  useWorkflowSelection,
  type WorkflowSelection,
} from "./workflowEditStore";
import { WorkflowBreadcrumb, WorkflowViewSwitch } from "./WorkflowHeader";
import { useWorkflowClock } from "./workflowHooks";
import { LeadPanel, StepPanel, TriggerPanel, WorkflowPanel } from "./WorkflowPanels";
import {
  addStep,
  changeWorkflowEdit,
  checkWorkflow,
  connectSteps,
  definitionOf,
  disconnectSteps,
  draftProblems,
  formatRecent,
  formatWhen,
  resolveWorkflowEdit,
  updateStep,
  upcomingRuns,
  WORKFLOW_NOTES_MAX,
  workflowSaveName,
  wouldCreateCycle,
} from "./workflows.logic";

/** The newer of the workflow as read and as the last save returned it. */
function newestSaved(read: WorkflowDetail | null, lastSave: WorkflowDetail | null) {
  if (read === null || lastSave === null || lastSave.name !== read.name) return read;
  return Date.parse(lastSave.updatedAt) > Date.parse(read.updatedAt) ? lastSave : read;
}

/**
 * Draws and changes a workflow: the canvas, the panel for what is selected, and the bar that turns
 * it on, runs it and saves it. Unsaved edits live in a store keyed by machine and workflow, so
 * leaving to make an agent and coming back keeps them.
 */
export function WorkflowEditor(props: {
  readonly environmentId: EnvironmentId;
  readonly editKey: string;
  /** The saved workflow; null for a new one. */
  readonly saved: WorkflowDetail | null;
  /** Where a new workflow starts. */
  readonly start: WorkflowDefinition;
  /** Shown over the canvas, such as that the chat's draft could not be read. */
  readonly notice: string | null;
}) {
  const { environmentId, editKey, start } = props;
  const navigate = useNavigate();
  const clock = useWorkflowClock();
  const edit = useWorkflowEdit(environmentId, editKey);
  const selection = useWorkflowSelection(environmentId, editKey);
  const list = useEnvironmentQuery(savedWorkflowsEnvironment.list({ environmentId, input: {} }));
  const { agents } = useAgents(environmentId);
  const catalog = useAgentModelCatalog(environmentId);
  const allProjects = useProjects();
  const canSave = useAtomValue(savedWorkflowsEnvironment.save.permissionAtom(environmentId));
  const saveCommand = useAtomCommand(savedWorkflowsEnvironment.save, { reportFailure: false });
  const deleteCommand = useAtomCommand(savedWorkflowsEnvironment.delete, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [lastSave, setLastSave] = useState<WorkflowDetail | null>(null);

  const saved = newestSaved(props.saved, lastSave);
  const savedState =
    saved === null
      ? null
      : { definition: definitionOf(saved), notes: saved.notes, updatedAt: saved.updatedAt };
  const shown = resolveWorkflowEdit(savedState, start, edit);
  const { definition } = shown;
  const problems = saved === null || shown.dirty ? draftProblems(definition) : saved.problems;
  const disabled = busy || !canSave;
  const projects = allProjects.filter(
    (project) => project.environmentId === environmentId && (project.archivedAt ?? null) === null,
  );
  const takenNames = list.data?.workflows.map((workflow) => workflow.name) ?? [];
  const search = { machine: environmentId };
  const issues = checking ? (checkWorkflow(definition, takenNames).issues ?? []) : [];

  const update = (change: {
    readonly definition?: (current: WorkflowDefinition) => WorkflowDefinition;
    readonly notes?: string;
  }) => {
    // Reads the store, not this render, so several changes from one handler all apply.
    const current = readWorkflowEdit(environmentId, editKey);
    const now = resolveWorkflowEdit(savedState, start, current);
    setWorkflowEdit(
      environmentId,
      editKey,
      changeWorkflowEdit(now, savedState, current, {
        ...(change.definition === undefined
          ? {}
          : { definition: change.definition(now.definition) }),
        ...(change.notes === undefined ? {} : { notes: change.notes }),
      }),
    );
  };
  const changeDefinition = (change: (current: WorkflowDefinition) => WorkflowDefinition) =>
    update({ definition: change });
  const select = (next: WorkflowSelection | null) =>
    setWorkflowSelection(environmentId, editKey, next);
  const discard = () => {
    setWorkflowEdit(environmentId, editKey, null);
    setChecking(false);
    setFailure(null);
  };

  const save = async () => {
    if (busy) return;
    const edited = readWorkflowEdit(environmentId, editKey);
    const current = resolveWorkflowEdit(savedState, start, edited);
    const checked = checkWorkflow(current.definition, takenNames);
    if (checked.issues !== undefined) {
      setChecking(true);
      const stepIssue = checked.issues.find((issue) => issue.step !== null);
      if (stepIssue?.step != null) select({ kind: "step", id: stepIssue.step });
      return;
    }
    setChecking(false);
    setFailure(null);
    setBusy(true);
    const result = await saveCommand({
      environmentId,
      input: {
        workflow: checked.workflow,
        ...(saved === null ? {} : { previousName: saved.name }),
        // Only notes the user changed: a run may have added its own since these edits began.
        ...(edited === null || edited.notes === edited.base.notes
          ? {}
          : { notes: current.notes.slice(-WORKFLOW_NOTES_MAX) }),
      },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setFailure(commandErrorMessage(result, "The workflow was not saved."));
      }
      return;
    }
    const savedNow = result.value;
    setWorkflowEdit(environmentId, editKey, null);
    toastManager.add({ type: "success", title: `Saved ${savedNow.title}` });
    if (saved === null || savedNow.name !== saved.name) {
      setWorkflowSelection(environmentId, editKey, null);
      void navigate({
        to: "/workflows/$name",
        params: { name: savedNow.name },
        search,
        replace: true,
      });
      return;
    }
    setLastSave(savedNow);
  };

  const deleteWorkflow = async () => {
    if (saved === null || busy) return;
    const confirmed = await settlePromise(() =>
      ensureLocalApi().dialogs.confirm(
        `Delete ${saved.title}?\nIts folder is removed from your Codenine folder, and a run in progress is stopped. Chats from its runs stay.`,
        { variant: "destructive" },
      ),
    );
    if (confirmed._tag !== "Success" || !confirmed.value) return;
    setBusy(true);
    const result = await deleteCommand({ environmentId, input: { name: saved.name } });
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setFailure(commandErrorMessage(result, "The workflow was not deleted."));
      }
      return;
    }
    setWorkflowEdit(environmentId, editKey, null);
    setWorkflowSelection(environmentId, editKey, null);
    toastManager.add({ type: "success", title: `Deleted ${saved.title}` });
    void navigate({ to: "/workflows", search, replace: true });
  };

  const createAgent = (stepId: WorkflowStepId) => {
    // Keeps the edit in the store even when nothing changed yet, so the agent page can read the
    // step and hand the new agent back to it.
    update({});
    select({ kind: "step", id: stepId });
    void navigate({
      to: "/agents/new",
      search: { machine: environmentId, workflowEdit: editKey, step: stepId },
    });
  };

  const agentOf = (name: string | null) =>
    name === null ? undefined : agents.find((agent) => agent.name === name);
  const modelName = (model: AgentModel) => describeAgentModel(catalog, model).name;
  const canvasSteps = definition.steps.map((step): CanvasStep => {
    const agent = agentOf(step.agent);
    const model = step.model ?? agent?.model ?? null;
    return {
      id: step.id,
      title: step.title.trim() || "Untitled step",
      agent:
        step.agent !== null
          ? agentTitle(step.agent, agent)
          : step.suggestion !== undefined
            ? `${step.suggestion.title}, not made yet`
            : "No agent yet",
      agentTone:
        step.agent !== null ? "agent" : step.suggestion !== undefined ? "suggested" : "none",
      detail:
        model !== null
          ? modelName(model)
          : step.agent === null
            ? "Its agent's model"
            : "No model yet",
      tone: "default",
      problem: problems.find((problem) => problem.step === step.id)?.message ?? null,
      position: step.position,
      dependsOn: step.dependsOn,
    };
  });
  const schedule = definition.trigger.schedule;
  const nextRun =
    schedule !== null && definition.enabled && problems.length === 0
      ? (upcomingRuns(schedule, clock.nowMs, 1)[0] ?? null)
      : null;
  const turnOnBlock =
    !definition.enabled && problems.length > 0 ? `Fix this first: ${problems[0]?.message}` : null;

  const selectedStep =
    selection?.kind === "step"
      ? (definition.steps.find((step) => step.id === selection.id) ?? null)
      : null;
  const panelSelection = selection?.kind === "step" && selectedStep === null ? null : selection;

  const notices: ReactNode[] = [];
  if (props.notice !== null) {
    notices.push(
      <Alert key="notice" variant="info">
        <AlertDescription>{props.notice}</AlertDescription>
      </Alert>,
    );
  }
  if (shown.overtaken) {
    notices.push(
      <Alert key="overtaken" variant="warning">
        <AlertDescription>
          This workflow was saved somewhere else after you started changing it. Saving replaces that
          version.
        </AlertDescription>
        <AlertAction>
          <Button size="xs" variant="outline" onClick={discard}>
            Discard my changes
          </Button>
        </AlertAction>
      </Alert>,
    );
  }
  if (failure !== null) {
    notices.push(
      <Alert key="failure" variant="error">
        <AlertDescription>{failure}</AlertDescription>
      </Alert>,
    );
  }
  if (issues.length > 0) {
    notices.push(
      <Alert key="issues" variant="warning">
        <AlertTitle>Not saved yet</AlertTitle>
        <AlertDescription>
          <ul className="flex flex-col gap-1">
            {issues.map((issue) => (
              <li key={`${issue.step ?? ""}:${issue.message}`}>{issue.message}</li>
            ))}
          </ul>
        </AlertDescription>
      </Alert>,
    );
  }

  const title = definition.title.trim() || (saved === null ? "New workflow" : saved.title);
  const actions = (
    <>
      {shown.dirty ? (
        <Button size="sm" variant="ghost-muted" disabled={busy} onClick={discard}>
          Discard changes
        </Button>
      ) : null}
      {schedule === null ? null : (
        <Tooltip>
          <TooltipTrigger
            render={<label className="flex items-center gap-2 text-foreground text-sm" />}
          >
            <Switch
              size="sm"
              checked={definition.enabled}
              disabled={disabled || turnOnBlock !== null}
              onCheckedChange={(enabled) =>
                changeDefinition((current) => ({ ...current, enabled }))
              }
            />
            {definition.enabled ? "On" : "Off"}
          </TooltipTrigger>
          <TooltipPopup>
            {turnOnBlock ??
              (definition.enabled
                ? "Scheduled runs happen while it is on. Save to apply."
                : "Turn it on to run it on its schedule. Save to apply.")}
          </TooltipPopup>
        </Tooltip>
      )}
      {nextRun === null || schedule === null ? null : (
        <span className="hidden text-muted-foreground text-xs lg:inline">
          Next run {formatWhen(nextRun, { ...clock, timeZone: schedule.timeZone })}
        </span>
      )}
      {saved === null ? null : (
        <RunWorkflowButton
          environmentId={environmentId}
          workflow={saved}
          inputs={saved.inputs}
          variant="outline"
          disabledReason={
            shown.dirty
              ? "Save your changes first. Run now runs the saved workflow."
              : (saved.problems[0]?.message ?? null)
          }
        />
      )}
      <Button
        size="sm"
        disabled={disabled || (saved !== null && !shown.dirty)}
        onClick={() => void save()}
      >
        {busy ? "Saving…" : "Save"}
      </Button>
    </>
  );

  return (
    <WorkspacePage
      area="workflow"
      title={<WorkflowBreadcrumb machine={environmentId} workflow={{ title, name: null }} />}
      subtitle={
        saved === null ? undefined : (
          <WorkflowViewSwitch machine={environmentId} name={saved.name} view="canvas" />
        )
      }
      actions={actions}
    >
      <div className="flex min-h-full flex-col md:h-full md:flex-row">
        <section
          aria-label="Canvas"
          className="relative h-112 min-w-0 shrink-0 md:h-auto md:flex-1 md:shrink"
        >
          <WorkflowCanvas
            mode="edit"
            trigger={{
              kicker: "When",
              title: workflowScheduleText(schedule),
              detail:
                schedule === null
                  ? "Run now starts it"
                  : !definition.enabled
                    ? "Off"
                    : nextRun === null
                      ? "Can't run yet"
                      : `Next ${formatRecent(nextRun, { ...clock, timeZone: schedule.timeZone })}`,
              position: definition.trigger.position,
            }}
            lead={{
              model:
                definition.lead.model === null ? "no model yet" : modelName(definition.lead.model),
              activity: "checks each result and sends work back",
              goal: definition.lead.goal,
            }}
            steps={canvasSteps}
            selection={panelSelection}
            onSelect={select}
            onMoveStep={(id, position) =>
              changeDefinition((current) =>
                updateStep(current, id, (step) => ({ ...step, position })),
              )
            }
            onMoveTrigger={(position) =>
              changeDefinition((current) => ({
                ...current,
                trigger: { ...current.trigger, position },
              }))
            }
            canConnect={(from, to) =>
              !definition.steps.some((step) => step.id === to && step.dependsOn.includes(from)) &&
              !wouldCreateCycle(definition.steps, from, to)
            }
            onConnect={(from, to) => changeDefinition((current) => connectSteps(current, from, to))}
            onDisconnect={(from, to) =>
              changeDefinition((current) => disconnectSteps(current, from, to))
            }
            onAddStep={(position) => {
              const current = readWorkflowEdit(environmentId, editKey);
              const next = addStep(
                resolveWorkflowEdit(savedState, start, current).definition,
                position,
              );
              changeDefinition(() => next.definition);
              select({ kind: "step", id: next.id });
            }}
          />
          {notices.length === 0 ? null : (
            <div className="pointer-events-none absolute inset-x-0 top-14 z-10 flex justify-center px-4">
              <div className="pointer-events-auto flex w-full max-w-lg flex-col gap-2">
                {notices}
              </div>
            </div>
          )}
        </section>
        <aside
          aria-label="Selected part"
          className="flex flex-col gap-4 border-border border-t p-5 md:w-96 md:shrink-0 md:overflow-y-auto md:border-t-0 md:border-l"
        >
          {panelSelection === null ? (
            <WorkflowPanel
              definition={definition}
              savedAs={workflowSaveName(definition, takenNames)}
              problems={problems}
              disabled={disabled}
              onChange={changeDefinition}
              onSelect={select}
              onDelete={saved === null ? null : () => void deleteWorkflow()}
            />
          ) : panelSelection.kind === "trigger" ? (
            <TriggerPanel
              definition={definition}
              nowMs={clock.nowMs}
              hour12={clock.hour12}
              disabled={disabled}
              onChange={changeDefinition}
              onClose={() => select(null)}
            />
          ) : panelSelection.kind === "lead" ? (
            <LeadPanel
              environmentId={environmentId}
              definition={definition}
              notes={shown.notes}
              projects={projects}
              disabled={disabled}
              onChange={changeDefinition}
              onNotesChange={(notes) => update({ notes })}
              onClose={() => select(null)}
            />
          ) : selectedStep === null ? null : (
            <StepPanel
              // Keyed so a step's fields never carry over to the next one selected.
              key={selectedStep.id}
              environmentId={environmentId}
              definition={definition}
              step={selectedStep}
              agents={agents}
              problem={
                problems.find((problem) => problem.step === selectedStep.id)?.message ?? null
              }
              disabled={disabled}
              onChange={changeDefinition}
              onSelect={select}
              onCreateAgent={() => createAgent(selectedStep.id)}
              onEditAgent={(name) =>
                void navigate({ to: "/agents/$name/edit", params: { name }, search })
              }
            />
          )}
        </aside>
      </div>
    </WorkspacePage>
  );
}
