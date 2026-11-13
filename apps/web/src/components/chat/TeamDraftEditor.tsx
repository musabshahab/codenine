import { teamStepFlows, teamStepList, type TeamDraftChange } from "@codenine/client-runtime/team";
import {
  TEAM_MAX_AGENTS,
  type ModelSelection,
  type TeamAgent,
  type TeamAgentRole,
  type TeamDraft,
  type TeamTaskDraft,
  type TeamTaskId,
  type TeamWorkspace,
} from "@codenine/contracts";
import {
  ChevronDownIcon,
  EllipsisIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  UserPlusIcon,
} from "lucide-react";
import { useId, useState } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  TeamModelPicker,
  teamModelLine,
  teamModelText,
  type TeamModelCatalog,
} from "./TeamAgentModel";
import {
  TEAM_ROLE_LABELS,
  TEAM_WORKSPACE_LABELS,
  TeamAgentAvatar,
  TeamSectionHeading,
  TeamStepFlow,
  TeamStepRow,
} from "./TeamParts";

const ROLES = Object.keys(TEAM_ROLE_LABELS) as ReadonlyArray<TeamAgentRole>;

const WORKSPACE_HELP: Record<TeamWorkspace, string> = {
  shared: "Works in the lead's checkout and sees the changes earlier steps made.",
  worktree: "Works on its own copy, so steps that run at the same time cannot collide.",
};

type OnTeamDraftChange = (change: TeamDraftChange) => void;

/** The places of the steps an agent runs, counted from 1. */
function stepsOf(draft: TeamDraft, agentId: TeamAgent["id"]): ReadonlyArray<number> {
  return draft.tasks.flatMap((task, index) => (task.agentId === agentId ? [index + 1] : []));
}

// A brief opens to be added to, so the caret starts after its text. Module-level, so the ref
// stays the same function and runs once, not on every keystroke.
function focusAtEnd(node: HTMLTextAreaElement | null) {
  node?.focus();
  node?.setSelectionRange(node.value.length, node.value.length);
}

function sameModelSelection(a: ModelSelection, b: ModelSelection): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** "3 agents · all on 6 Astra · Extra high", or how many models the team mixes. */
function teamModelSummary(agents: ReadonlyArray<TeamAgent>, catalog: TeamModelCatalog): string {
  const count = `${agents.length} ${agents.length === 1 ? "agent" : "agents"}`;
  const first = agents[0];
  if (first === undefined) return count;
  const line = teamModelLine(catalog, first.modelSelection);
  if (agents.length === 1) return `${count} · ${line}`;
  if (agents.every((agent) => sameModelSelection(agent.modelSelection, first.modelSelection))) {
    return `${count} · all on ${line}`;
  }
  const models = new Set(
    agents.map((agent) => `${agent.modelSelection.instanceId}\n${agent.modelSelection.model}`),
  );
  return models.size === 1
    ? `${count} · all on ${teamModelText(catalog, first.modelSelection).name}`
    : `${count} · ${models.size} models`;
}

/** The body of a proposed team: the team on one line, then each step, all editable until approval. */
export function TeamDraftEditor(props: {
  draft: TeamDraft;
  catalog: TeamModelCatalog;
  /** The model a new agent starts on when the team has no agent to copy it from. */
  defaultModelSelection: ModelSelection | null;
  disabled: boolean;
  onChange: OnTeamDraftChange;
}) {
  const { draft, catalog, disabled, onChange } = props;
  const [rosterOpen, setRosterOpen] = useState(false);
  // `assign` is the step that asked for the new agent, which then takes it.
  const [adding, setAdding] = useState<{ readonly assign: TeamTaskId | null } | null>(null);
  const [editingBrief, setEditingBrief] = useState<TeamTaskId | null>(null);
  const newAgentModel = draft.agents[0]?.modelSelection ?? props.defaultModelSelection;
  const canAddAgent = newAgentModel !== null && draft.agents.length < TEAM_MAX_AGENTS;
  const flows = teamStepFlows(draft.tasks);
  return (
    <>
      <section aria-label="Team" className="flex flex-col gap-2">
        <div className="flex min-h-7 items-center gap-2.5">
          <TeamSectionHeading>Team</TeamSectionHeading>
          <span aria-hidden className="flex items-center ps-1">
            {draft.agents.map((agent) => (
              <TeamAgentAvatar
                key={agent.id}
                role={agent.role}
                size="sm"
                className="-ms-1 ring-2 ring-background"
              />
            ))}
          </span>
          <span className="min-w-0 flex-1 truncate text-foreground/85">
            {teamModelSummary(draft.agents, catalog)}
          </span>
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={rosterOpen}
            onClick={() => {
              setRosterOpen(!rosterOpen);
              setAdding(null);
            }}
          >
            {rosterOpen ? "Done" : "Edit team"}
            <ChevronDownIcon aria-hidden className={cn(rosterOpen && "rotate-180")} />
          </Button>
        </div>
        {rosterOpen ? (
          <ul aria-label="Agents" className="flex flex-col gap-0.5 rounded-lg border bg-card p-1">
            {draft.agents.map((agent) => (
              <TeamRosterRow
                key={agent.id}
                agent={agent}
                draft={draft}
                catalog={catalog}
                disabled={disabled}
                onChange={onChange}
              />
            ))}
            <li>
              {adding !== null && newAgentModel !== null ? (
                <TeamAgentForm
                  catalog={catalog}
                  defaultModelSelection={newAgentModel}
                  disabled={disabled}
                  onAdd={(agent) => {
                    onChange({
                      type: "agent.add",
                      ...agent,
                      ...(adding.assign === null ? {} : { assign: adding.assign }),
                    });
                    setAdding(null);
                  }}
                  onClose={() => setAdding(null)}
                />
              ) : (
                <button
                  type="button"
                  disabled={disabled || !canAddAgent}
                  onClick={() => setAdding({ assign: null })}
                  className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2 text-start text-foreground/85 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-64"
                >
                  <span
                    aria-hidden
                    className="flex size-6.5 items-center justify-center rounded-md border border-input border-dashed text-muted-foreground"
                  >
                    <PlusIcon className="size-3.5" />
                  </span>
                  {draft.agents.length >= TEAM_MAX_AGENTS
                    ? `A team has at most ${TEAM_MAX_AGENTS} agents`
                    : "Add agent"}
                </button>
              )}
            </li>
          </ul>
        ) : null}
      </section>
      <section aria-label="Steps" className="flex flex-col gap-3">
        <TeamSectionHeading detail={String(draft.tasks.length)}>Steps</TeamSectionHeading>
        <ol className="flex flex-col">
          {draft.tasks.map((task, index) => (
            <TeamDraftStep
              key={task.id}
              number={index + 1}
              last={index === draft.tasks.length - 1}
              task={task}
              draft={draft}
              flow={flows.get(task.id) ?? null}
              catalog={catalog}
              disabled={disabled}
              editingBrief={editingBrief === task.id}
              onEditBrief={(open) => setEditingBrief(open ? task.id : null)}
              canAddAgent={canAddAgent}
              onNewAgent={() => {
                setRosterOpen(true);
                setAdding({ assign: task.id });
              }}
              onChange={onChange}
            />
          ))}
        </ol>
      </section>
    </>
  );
}

function TeamRosterRow(props: {
  agent: TeamAgent;
  draft: TeamDraft;
  catalog: TeamModelCatalog;
  disabled: boolean;
  onChange: OnTeamDraftChange;
}) {
  const { agent, draft } = props;
  const steps = stepsOf(draft, agent.id);
  const stepText = steps.length === 0 ? "No steps" : teamStepList(steps);
  const details = [
    agent.role === "custom" ? null : TEAM_ROLE_LABELS[agent.role],
    TEAM_WORKSPACE_LABELS[agent.workspace],
    stepText.charAt(0).toUpperCase() + stepText.slice(1),
  ]
    .filter((part) => part !== null)
    .join(" · ");
  const remove = (
    <Button
      size="icon-xs"
      variant="ghost-destructive"
      aria-label={`Remove ${agent.label}`}
      disabled={props.disabled || steps.length > 0}
      onClick={() => props.onChange({ type: "agent.remove", agentId: agent.id })}
    >
      <Trash2Icon aria-hidden />
    </Button>
  );
  return (
    <li className="flex min-h-11.5 items-center gap-2.5 rounded-md py-1 ps-2 pe-1">
      <TeamAgentAvatar role={agent.role} size="lg" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{agent.label}</span>
        <span className="truncate text-muted-foreground text-xs">{details}</span>
      </div>
      <TeamAgentModelPicker
        agent={agent}
        draft={draft}
        catalog={props.catalog}
        disabled={props.disabled}
        onChange={props.onChange}
      />
      {steps.length > 0 ? (
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
            {remove}
          </TooltipTrigger>
          <TooltipPopup side="top">Give its steps to another agent to remove it</TooltipPopup>
        </Tooltip>
      ) : (
        remove
      )}
    </li>
  );
}

/**
 * An agent's model, set from its row or from any step it runs. The footer says which steps the
 * change reaches, and can keep every agent on the same model.
 */
function TeamAgentModelPicker(props: {
  agent: TeamAgent;
  draft: TeamDraft;
  catalog: TeamModelCatalog;
  disabled: boolean;
  onChange: OnTeamDraftChange;
}) {
  const { agent, draft, catalog } = props;
  const [applyAll, setApplyAll] = useState(false);
  const others = draft.agents.filter((candidate) => candidate.id !== agent.id);
  const setModel = (modelSelection: ModelSelection, everyAgent: boolean) => {
    for (const target of everyAgent ? draft.agents : [agent]) {
      props.onChange({ type: "agent.model", agentId: target.id, modelSelection });
    }
  };
  const steps = stepsOf(draft, agent.id);
  const note =
    steps.length === 0
      ? `${agent.label} has no steps yet.`
      : steps.length === 1
        ? `${agent.label} runs ${teamStepList(steps)}.`
        : `${agent.label} runs ${teamStepList(steps)}, so this changes ${steps.length === 2 ? "both" : "all of them"}.`;
  return (
    <TeamModelPicker
      catalog={catalog}
      selection={agent.modelSelection}
      label={`Model for ${agent.label}`}
      disabled={props.disabled}
      onOpenChange={(open) => {
        // A team already on one model stays on it; uncheck to change this agent alone.
        if (open) {
          setApplyAll(
            others.length > 0 &&
              others.every((other) =>
                sameModelSelection(other.modelSelection, agent.modelSelection),
              ),
          );
        }
      }}
      onChange={(modelSelection) => setModel(modelSelection, applyAll)}
      footer={
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-border/70 border-t bg-muted/40 px-3 py-2 text-xs">
          <p className="min-w-0 flex-1 text-muted-foreground">{note}</p>
          {others.length > 0 ? (
            <label className="flex cursor-pointer items-center gap-2">
              <Checkbox
                checked={applyAll}
                onCheckedChange={(checked) => {
                  setApplyAll(checked);
                  if (checked) setModel(agent.modelSelection, true);
                }}
              />
              Use for all {draft.agents.length} agents
            </label>
          ) : null}
        </div>
      }
    />
  );
}

function TeamDraftStep(props: {
  number: number;
  last: boolean;
  task: TeamTaskDraft;
  draft: TeamDraft;
  flow: string | null;
  catalog: TeamModelCatalog;
  disabled: boolean;
  editingBrief: boolean;
  onEditBrief: (open: boolean) => void;
  canAddAgent: boolean;
  onNewAgent: () => void;
  onChange: OnTeamDraftChange;
}) {
  const { task, draft } = props;
  const agent = draft.agents.find((candidate) => candidate.id === task.agentId) ?? null;
  return (
    <TeamStepRow number={props.number} state="proposed" last={props.last} framed={null}>
      <div className="flex items-start gap-2">
        <h4 className="min-w-0 flex-1 break-words font-medium leading-5.5">{task.title}</h4>
        <Menu>
          <MenuTrigger
            disabled={props.disabled}
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`More for step ${props.number}`}
              />
            }
          >
            <EllipsisIcon aria-hidden />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => props.onEditBrief(true)}>
              <PencilIcon aria-hidden />
              Edit brief
            </MenuItem>
            <MenuItem
              variant="destructive"
              onClick={() => props.onChange({ type: "task.remove", taskId: task.id })}
            >
              <Trash2Icon aria-hidden />
              Remove step
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      {props.flow === null ? null : <TeamStepFlow text={props.flow} />}
      {props.editingBrief ? (
        <div className="mt-2 flex flex-col gap-1.5">
          <Textarea
            size="sm"
            rows={5}
            ref={focusAtEnd}
            aria-label={`Brief for ${task.title}`}
            value={task.brief}
            readOnly={props.disabled}
            onChange={(event) =>
              props.onChange({ type: "task.brief", taskId: task.id, brief: event.target.value })
            }
          />
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 text-muted-foreground text-xs">
              The agent gets this with the results it starts from.
            </p>
            <Button size="xs" variant="ghost" onClick={() => props.onEditBrief(false)}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          disabled={props.disabled}
          onClick={() => props.onEditBrief(true)}
          className="mt-1 block w-full cursor-text rounded-sm text-start text-muted-foreground outline-none hover:text-foreground/85 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default disabled:hover:text-muted-foreground"
        >
          <span className="sr-only">Edit brief: </span>
          <span className="line-clamp-2 break-words">{task.brief}</span>
        </button>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <TeamStepAgentMenu
          number={props.number}
          task={task}
          draft={draft}
          catalog={props.catalog}
          disabled={props.disabled}
          canAddAgent={props.canAddAgent}
          onNewAgent={props.onNewAgent}
          onChange={props.onChange}
        />
        {agent === null ? null : (
          <TeamAgentModelPicker
            agent={agent}
            draft={draft}
            catalog={props.catalog}
            disabled={props.disabled}
            onChange={props.onChange}
          />
        )}
      </div>
    </TeamStepRow>
  );
}

function TeamStepAgentMenu(props: {
  number: number;
  task: TeamTaskDraft;
  draft: TeamDraft;
  catalog: TeamModelCatalog;
  disabled: boolean;
  canAddAgent: boolean;
  onNewAgent: () => void;
  onChange: OnTeamDraftChange;
}) {
  const { task, draft } = props;
  const agent = draft.agents.find((candidate) => candidate.id === task.agentId) ?? null;
  const label = agent?.label ?? task.agentId;
  return (
    <Menu>
      <MenuTrigger
        disabled={props.disabled}
        render={
          <Button
            size="xs"
            variant="outline"
            aria-label={`Agent for step ${props.number}: ${label}`}
          />
        }
      >
        {agent === null ? null : <TeamAgentAvatar role={agent.role} size="xs" />}
        <span className="truncate">{label}</span>
        {agent === null || agent.role === "custom" ? null : (
          <span className="font-normal text-muted-foreground">{TEAM_ROLE_LABELS[agent.role]}</span>
        )}
        <ChevronDownIcon aria-hidden />
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuGroup>
          <MenuGroupLabel>Give this step to</MenuGroupLabel>
          <MenuRadioGroup
            value={task.agentId}
            onValueChange={(value) => {
              const next = draft.agents.find((candidate) => candidate.id === value);
              if (next !== undefined) {
                props.onChange({ type: "task.assign", taskId: task.id, agentId: next.id });
              }
            }}
          >
            {draft.agents.map((candidate) => {
              const steps = stepsOf(draft, candidate.id);
              return (
                <MenuRadioItem key={candidate.id} value={candidate.id} closeOnClick>
                  <span className="flex items-center gap-2.5">
                    <TeamAgentAvatar role={candidate.role} size="md" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{candidate.label}</span>
                      <span className="truncate text-muted-foreground text-xs">
                        {teamModelLine(props.catalog, candidate.modelSelection)} ·{" "}
                        {steps.length === 0 ? "no steps yet" : `runs ${teamStepList(steps)}`}
                      </span>
                    </span>
                    <MenuRadioItemIndicator />
                  </span>
                </MenuRadioItem>
              );
            })}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuItem disabled={!props.canAddAgent} onClick={props.onNewAgent}>
          <UserPlusIcon aria-hidden />
          New agent…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function TeamAgentForm(props: {
  catalog: TeamModelCatalog;
  defaultModelSelection: ModelSelection;
  disabled: boolean;
  onAdd: (agent: {
    label: string;
    role: TeamAgentRole;
    modelSelection: ModelSelection;
    workspace: TeamWorkspace;
  }) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [label, setLabel] = useState("");
  const [role, setRole] = useState<TeamAgentRole>("implement");
  const [workspace, setWorkspace] = useState<TeamWorkspace>("shared");
  const [modelSelection, setModelSelection] = useState(props.defaultModelSelection);
  const canAdd = !props.disabled && label.trim() !== "";
  return (
    <form
      aria-label="New agent"
      className="m-1 flex flex-col gap-3 rounded-md border bg-background p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (canAdd) props.onAdd({ label, role, modelSelection, workspace });
      }}
    >
      <div className="flex flex-wrap gap-2">
        <div className="flex min-w-36 flex-1 flex-col gap-1">
          <label htmlFor={`${id}-name`} className="text-muted-foreground text-xs">
            Name
          </label>
          <Input
            id={`${id}-name`}
            size="sm"
            autoFocus
            placeholder="Fact checker"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
        </div>
        <div className="flex w-36 flex-col gap-1">
          <span id={`${id}-role`} className="text-muted-foreground text-xs">
            Role
          </span>
          <Select
            value={role}
            onValueChange={(value) => {
              if (value !== null) setRole(value);
            }}
          >
            <SelectTrigger size="sm" aria-labelledby={`${id}-role`}>
              <SelectValue>{(value: TeamAgentRole) => TEAM_ROLE_LABELS[value]}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {ROLES.map((candidate) => (
                <SelectItem key={candidate} value={candidate}>
                  {TEAM_ROLE_LABELS[candidate]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <span id={`${id}-workspace`} className="text-muted-foreground text-xs">
          Works in
        </span>
        <ToggleGroup
          aria-labelledby={`${id}-workspace`}
          className="w-full *:flex-1"
          value={[workspace]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "shared" || value === "worktree") setWorkspace(value);
          }}
        >
          <Toggle value="shared">{TEAM_WORKSPACE_LABELS.shared}</Toggle>
          <Toggle value="worktree">{TEAM_WORKSPACE_LABELS.worktree}</Toggle>
        </ToggleGroup>
        <p className="text-muted-foreground text-xs">{WORKSPACE_HELP[workspace]}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <TeamModelPicker
          catalog={props.catalog}
          selection={modelSelection}
          label="Model for the new agent"
          disabled={props.disabled}
          onChange={setModelSelection}
        />
        <div className="ms-auto flex items-center gap-1">
          <Button size="xs" variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button size="xs" variant="outline" type="submit" disabled={!canAdd}>
            Add agent
          </Button>
        </div>
      </div>
    </form>
  );
}
