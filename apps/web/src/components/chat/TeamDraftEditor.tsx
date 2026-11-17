import { teamStepFlows, teamStepList, type TeamDraftChange } from "@codenine/client-runtime/team";
import {
  TEAM_MAX_AGENTS,
  type AgentName,
  type AgentSummary,
  type ModelSelection,
  type ScopedThreadRef,
  type TeamAgent,
  type TeamAgentRole,
  type TeamDraft,
  type TeamTaskDraft,
  type TeamTaskId,
  type TeamWorkspace,
} from "@codenine/contracts";
import { teamMembersWithoutAgent } from "@codenine/shared/team";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  EllipsisIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  UserPlusIcon,
} from "lucide-react";
import { type ReactElement, type ReactNode, useId, useState } from "react";

import { cn } from "../../lib/utils";
import { agentChatModelSelection, useAgents } from "../agents/useAgents";
import { ConnectorMark } from "../connectors/ConnectorMark";
import { Button, InlineButton } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
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
  TeamMemberMark,
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

/** The user's agents a team is built from, as the editor reads them. */
interface YourAgents {
  readonly agents: ReadonlyArray<AgentSummary>;
  readonly loading: boolean;
  readonly error: string | null;
}

/** The places of the steps an agent runs, counted from 1. */
function stepsOf(draft: TeamDraft, agentId: TeamAgent["id"]): ReadonlyArray<number> {
  return draft.tasks.flatMap((task, index) => (task.agentId === agentId ? [index + 1] : []));
}

/** What the tab calls a member: the lead's suggestion until it has an agent, else its label. */
function memberName(member: TeamAgent): string {
  return member.agent === undefined ? (member.suggestion?.title ?? member.label) : member.label;
}

/** The title of the user's agent a member runs as; undefined for none, or while agents load. */
function agentTitleOf(member: TeamAgent, agents: ReadonlyArray<AgentSummary>): string | undefined {
  return member.agent === undefined
    ? undefined
    : agents.find((agent) => agent.name === member.agent)?.title;
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
  leadRef: ScopedThreadRef;
  draft: TeamDraft;
  catalog: TeamModelCatalog;
  /** The model an added agent without one starts on, when the team has no member to copy. */
  defaultModelSelection: ModelSelection | null;
  disabled: boolean;
  onChange: OnTeamDraftChange;
}) {
  const { leadRef, draft, catalog, disabled, onChange } = props;
  const list = useAgents(leadRef.environmentId);
  const yours: YourAgents = {
    agents: list.agents,
    loading: list.data === null && list.error === null,
    error: list.error,
  };
  // A member waiting for an agent opens the team, where it gets one, and the team stays open
  // after until the user closes it. Null until either happens.
  const [rosterChoice, setRosterChoice] = useState<boolean | null>(null);
  if (rosterChoice === null && teamMembersWithoutAgent(draft).length > 0) setRosterChoice(true);
  const rosterOpen = rosterChoice === true;
  // `assign` is the step that asked for the new agent, which then takes it.
  const [adding, setAdding] = useState<{ readonly assign: TeamTaskId | null } | null>(null);
  const [editingBrief, setEditingBrief] = useState<TeamTaskId | null>(null);
  const fallbackModel = draft.agents[0]?.modelSelection ?? props.defaultModelSelection;
  const canAddAgent = draft.agents.length < TEAM_MAX_AGENTS;
  const flows = teamStepFlows(draft.tasks);
  return (
    <>
      <section aria-label="Team" className="flex flex-col gap-2">
        <div className="flex min-h-7 items-center gap-2.5">
          <TeamSectionHeading>Team</TeamSectionHeading>
          <span aria-hidden className="flex items-center ps-1">
            {draft.agents.map((member) => (
              <TeamMemberMark
                key={member.id}
                member={member}
                name={agentTitleOf(member, yours.agents)}
                size="sm"
                className="-ms-1 rounded-sm ring-2 ring-background"
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
              setRosterChoice(!rosterOpen);
              setAdding(null);
            }}
          >
            {rosterOpen ? "Done" : "Edit team"}
            <ChevronDownIcon aria-hidden className={cn(rosterOpen && "rotate-180")} />
          </Button>
        </div>
        {rosterOpen ? (
          <ul aria-label="Agents" className="flex flex-col gap-0.5 rounded-lg border bg-card p-1">
            {draft.agents.map((member) => (
              <TeamRosterRow
                key={member.id}
                leadRef={leadRef}
                member={member}
                draft={draft}
                catalog={catalog}
                yours={yours}
                disabled={disabled}
                onChange={onChange}
              />
            ))}
            <li>
              {adding !== null ? (
                <TeamAgentForm
                  environmentId={leadRef.environmentId}
                  yours={yours}
                  catalog={catalog}
                  fallbackModelSelection={fallbackModel}
                  disabled={disabled}
                  onAdd={(member) => {
                    onChange({
                      type: "agent.add",
                      ...member,
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
                  {canAddAgent ? "Add agent" : `A team has at most ${TEAM_MAX_AGENTS} agents`}
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
              agents={yours.agents}
              disabled={disabled}
              editingBrief={editingBrief === task.id}
              onEditBrief={(open) => setEditingBrief(open ? task.id : null)}
              canAddAgent={canAddAgent}
              onNewAgent={() => {
                setRosterChoice(true);
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

/**
 * A member as the agent it runs as, or, while the lead's suggestion waits for an agent, what it
 * would do with the ways to give it one. Members of plans from before agents show their role.
 */
function TeamRosterRow(props: {
  leadRef: ScopedThreadRef;
  member: TeamAgent;
  draft: TeamDraft;
  catalog: TeamModelCatalog;
  yours: YourAgents;
  disabled: boolean;
  onChange: OnTeamDraftChange;
}) {
  const { member, draft } = props;
  const navigate = useNavigate();
  const steps = stepsOf(draft, member.id);
  const stepText = steps.length === 0 ? "No steps" : teamStepList(steps);
  const suggestion = member.agent === undefined ? (member.suggestion ?? null) : null;
  const agentTitle = agentTitleOf(member, props.yours.agents);
  const details = [
    suggestion === null ? null : "Suggested",
    // The lead may name a member apart from its agent; the row still says which agent runs it.
    agentTitle === undefined || agentTitle === member.label ? null : `${agentTitle} agent`,
    member.role === "custom" ? null : TEAM_ROLE_LABELS[member.role],
    TEAM_WORKSPACE_LABELS[member.workspace],
    stepText.charAt(0).toUpperCase() + stepText.slice(1),
  ]
    .filter((part) => part !== null)
    .join(" · ");
  const name = memberName(member);
  const remove = (
    <Button
      size="icon-xs"
      variant="ghost-destructive"
      aria-label={`Remove ${name}`}
      disabled={props.disabled || steps.length > 0}
      onClick={() => props.onChange({ type: "agent.remove", agentId: member.id })}
    >
      <Trash2Icon aria-hidden />
    </Button>
  );
  return (
    <li className="flex min-h-11.5 flex-col justify-center gap-2 rounded-md py-1 ps-2 pe-1">
      <div className="flex items-center gap-2.5">
        <TeamMemberMark member={member} name={agentTitle} size="lg" />
        <div className="flex min-w-0 flex-1 flex-col">
          {member.agent === undefined ? (
            <span className="truncate font-medium">{name}</span>
          ) : (
            <TeamChooseAgentMenu
              member={member}
              yours={props.yours}
              catalog={props.catalog}
              disabled={props.disabled}
              onChange={props.onChange}
              trigger={
                <InlineButton
                  tone="picker"
                  aria-label={`Change agent for ${name}`}
                  className="min-w-0 max-w-full self-start"
                />
              }
            >
              <span className="truncate">{name}</span>
              <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            </TeamChooseAgentMenu>
          )}
          {suggestion === null ? null : (
            <span className="line-clamp-2 text-muted-foreground text-xs">
              {suggestion.description}
            </span>
          )}
          <span className="truncate text-muted-foreground text-xs">{details}</span>
        </div>
        <TeamAgentModelPicker
          agent={member}
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
      </div>
      {suggestion === null ? null : (
        <div className="flex flex-wrap items-center gap-1.5 ps-11.5">
          <Button
            size="xs"
            variant="outline"
            aria-label={`Create agent for ${name}`}
            disabled={props.disabled}
            onClick={() =>
              void navigate({
                to: "/agents/new",
                search: {
                  machine: props.leadRef.environmentId,
                  lead: props.leadRef.threadId,
                  member: member.id,
                },
              })
            }
          >
            <UserPlusIcon aria-hidden />
            Create agent
          </Button>
          <TeamChooseAgentMenu
            member={member}
            yours={props.yours}
            catalog={props.catalog}
            disabled={props.disabled}
            onChange={props.onChange}
            trigger={<Button size="xs" variant="outline" aria-label={`Choose agent for ${name}`} />}
          >
            Choose agent
            <ChevronDownIcon aria-hidden />
          </TeamChooseAgentMenu>
        </div>
      )}
    </li>
  );
}

/**
 * Runs a member as one of the user's agents, on that agent's model when it has one: a suggested
 * member gets its agent here, and a member with one can change it.
 */
function TeamChooseAgentMenu(props: {
  member: TeamAgent;
  yours: YourAgents;
  catalog: TeamModelCatalog;
  disabled: boolean;
  onChange: OnTeamDraftChange;
  /** The control that opens the menu, and what it shows. */
  trigger: ReactElement;
  children: ReactNode;
}) {
  const { member, yours } = props;
  return (
    <Menu>
      <MenuTrigger disabled={props.disabled} render={props.trigger}>
        {props.children}
      </MenuTrigger>
      <MenuPopup align="start" className="w-72">
        <MenuGroup>
          <MenuGroupLabel>Your agents</MenuGroupLabel>
          <MenuRadioGroup
            value={member.agent ?? null}
            onValueChange={(value) => {
              const agent = yours.agents.find((candidate) => candidate.name === value);
              if (agent === undefined || agent.name === member.agent) return;
              props.onChange({
                type: "agent.assign",
                agentId: member.id,
                agent: agent.name,
                label: agent.title,
                modelSelection:
                  agent.model === null
                    ? member.modelSelection
                    : agentChatModelSelection(props.catalog.entries, agent.model),
              });
            }}
          >
            {yours.agents.map((agent) => (
              <MenuRadioItem key={agent.name} value={agent.name} closeOnClick>
                <span className="flex items-center gap-2.5">
                  <ConnectorMark name={agent.title} size="sm" tone="agent" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{agent.title}</span>
                    <span className="truncate text-muted-foreground text-xs">
                      {agent.description}
                    </span>
                  </span>
                  <MenuRadioItemIndicator />
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        {yours.agents.length === 0 ? (
          <p className="px-2 py-1 text-muted-foreground text-xs">
            {yours.loading ? "Loading your agents…" : (yours.error ?? "You have no agents yet.")}
          </p>
        ) : null}
      </MenuPopup>
    </Menu>
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
  const name = memberName(agent);
  const steps = stepsOf(draft, agent.id);
  const note =
    steps.length === 0
      ? `${name} has no steps yet.`
      : steps.length === 1
        ? `${name} runs ${teamStepList(steps)}.`
        : `${name} runs ${teamStepList(steps)}, so this changes ${steps.length === 2 ? "both" : "all of them"}.`;
  return (
    <TeamModelPicker
      catalog={catalog}
      selection={agent.modelSelection}
      label={`Model for ${name}`}
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
  agents: ReadonlyArray<AgentSummary>;
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
          agents={props.agents}
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
  agents: ReadonlyArray<AgentSummary>;
  disabled: boolean;
  canAddAgent: boolean;
  onNewAgent: () => void;
  onChange: OnTeamDraftChange;
}) {
  const { task, draft } = props;
  const agent = draft.agents.find((candidate) => candidate.id === task.agentId) ?? null;
  const label = agent === null ? task.agentId : memberName(agent);
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
        {agent === null ? null : (
          <TeamMemberMark member={agent} name={agentTitleOf(agent, props.agents)} size="xs" />
        )}
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
                    <TeamMemberMark
                      member={candidate}
                      name={agentTitleOf(candidate, props.agents)}
                      size="md"
                    />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{memberName(candidate)}</span>
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
          Add agent…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/** Adds one of the user's agents to the team, on the agent's own model. */
function TeamAgentForm(props: {
  environmentId: ScopedThreadRef["environmentId"];
  yours: YourAgents;
  catalog: TeamModelCatalog;
  /** The model an agent without one starts on. */
  fallbackModelSelection: ModelSelection | null;
  disabled: boolean;
  onAdd: (member: {
    agent: AgentName;
    label: string;
    role: TeamAgentRole;
    modelSelection: ModelSelection;
    workspace: TeamWorkspace;
  }) => void;
  onClose: () => void;
}) {
  const { yours } = props;
  const id = useId();
  const [name, setName] = useState<AgentName | null>(null);
  const [role, setRole] = useState<TeamAgentRole>("implement");
  const [workspace, setWorkspace] = useState<TeamWorkspace>("shared");
  const agent = yours.agents.find((candidate) => candidate.name === name) ?? null;
  const modelSelection =
    agent?.model == null
      ? props.fallbackModelSelection
      : agentChatModelSelection(props.catalog.entries, agent.model);
  if (yours.agents.length === 0) {
    return (
      <div className="m-1 flex flex-col gap-3 rounded-md border bg-background p-3">
        <p className="text-muted-foreground text-xs">
          {yours.loading
            ? "Loading your agents…"
            : (yours.error ??
              "A team is built from your agents, and you have none yet. Create one on the Agents page first.")}
        </p>
        <div className="flex items-center justify-end gap-1">
          <Button size="xs" variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            size="xs"
            variant="outline"
            render={<Link to="/agents" search={{ machine: props.environmentId }} />}
          >
            Open Agents
          </Button>
        </div>
      </div>
    );
  }
  return (
    <form
      aria-label="Add agent"
      className="m-1 flex flex-col gap-3 rounded-md border bg-background p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!props.disabled && agent !== null && modelSelection !== null) {
          props.onAdd({ agent: agent.name, label: agent.title, role, modelSelection, workspace });
        }
      }}
    >
      <div className="flex flex-wrap gap-2">
        <div className="flex min-w-36 flex-1 flex-col gap-1">
          <span id={`${id}-agent`} className="text-muted-foreground text-xs">
            Agent
          </span>
          <Select value={name} onValueChange={(value) => setName(value)}>
            <SelectTrigger size="sm" autoFocus aria-labelledby={`${id}-agent`}>
              <SelectValue>
                {(value: AgentName | null) =>
                  yours.agents.find((candidate) => candidate.name === value)?.title ??
                  "Choose one of your agents"
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {yours.agents.map((candidate) => (
                <SelectItem key={candidate.name} value={candidate.name}>
                  <span className="flex min-w-0 items-center gap-2">
                    <ConnectorMark name={candidate.title} size="sm" tone="agent" />
                    <span className="truncate">{candidate.title}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
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
      {agent === null || modelSelection === null ? null : (
        <p className="text-muted-foreground text-xs">
          Runs on {teamModelLine(props.catalog, modelSelection)}. You can change it for this team
          once it is added.
        </p>
      )}
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
      <div className="flex items-center justify-end gap-1">
        <Button size="xs" variant="ghost" onClick={props.onClose}>
          Cancel
        </Button>
        <Button
          size="xs"
          variant="outline"
          type="submit"
          disabled={props.disabled || agent === null || modelSelection === null}
        >
          Add agent
        </Button>
      </div>
    </form>
  );
}
