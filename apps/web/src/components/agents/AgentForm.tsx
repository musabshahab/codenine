import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted, settlePromise } from "@codenine/client-runtime/state/runtime";
import {
  type AgentAbilities,
  type AgentConnector,
  type AgentDetail,
  type AgentEffort,
  type AgentModel,
  type AgentSummary,
  type ConnectionSnapshot,
  type ConnectorApprovalMode,
  type EnvironmentId,
  type ProjectId,
  type SkillName,
  skillTitle,
} from "@codenine/contracts";
import { useNavigate } from "@tanstack/react-router";
import { PlusIcon, SparklesIcon } from "lucide-react";
import { useId, useState } from "react";

import { commandErrorMessage } from "../../lib/commandError";
import { useEditorDraft } from "../../hooks/useEditorDraft";
import { ensureLocalApi } from "../../localApi";
import { agentsEnvironment } from "../../state/agents";
import { projectPreset } from "../../workspaceKind";
import { connectorsEnvironment } from "../../state/connectors";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { AddSkillDialog } from "../chat/AddSkillDialog";
import { ChoiceChip } from "../chat/ComposerChoiceChips";
import { useCodenineSkills } from "../chat/useComposerSkills";
import { ConnectorMark } from "../connectors/ConnectorMark";
import {
  APPROVAL_MODE_LABELS,
  CONNECTION_STATUS,
  connectionSummary,
  RISK_GROUPS,
} from "../connectors/connectors.logic";
import { skillNameFromTitle } from "../skills/skills.logic";
import { TextField } from "../TextField";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { AgentModelDialog, type AgentModelChoiceValue } from "./AgentModelDialog";
import {
  AGENT_EFFORT_LABELS,
  AGENT_EFFORTS,
  type AgentDraftErrors,
  agentModelProblem,
  checkAgentDraft,
  effectiveApproval,
  modelInfoLine,
} from "./agents.logic";
import { describeAgentModel, useAgentModelCatalog } from "./useAgents";
import { useAgentChatWorkspace, useStartAgentChat } from "./useStartAgentChat";

const APPROVAL_MODES = ["auto", "ask"] as const satisfies ReadonlyArray<ConnectorApprovalMode>;

const ABILITIES = [
  { key: "readFiles", title: "Read files", hint: "Open files in the chat's workspace." },
  { key: "editFiles", title: "Edit files", hint: "Change files in the chat's workspace." },
  { key: "runCommands", title: "Run commands", hint: "Run programs in the chat's workspace." },
  { key: "searchWeb", title: "Search the web", hint: "Use the model's own web search." },
] as const satisfies ReadonlyArray<{
  readonly key: keyof AgentAbilities;
  readonly title: string;
  readonly hint: string;
}>;

const NO_CONNECTIONS: ReadonlyArray<ConnectionSnapshot> = [];

/** What a new agent made from a team's suggestion starts with. */
export interface AgentFormStart {
  readonly title: string;
  readonly description: string;
  readonly instructions: string;
  readonly model: AgentModel | null;
  readonly connectors: ReadonlyArray<AgentConnector>;
  readonly abilities: AgentAbilities;
}

/** Making an agent a lead suggested: Save hands it back to join the team, with no chat to start. */
export interface AgentFormForTeam {
  readonly start: AgentFormStart;
  readonly onSaved: (agent: AgentSummary) => void;
  readonly onCancel: () => void;
  /** Why the agent is being made, under its name; a team's wording when left out. */
  readonly intro?: string;
}

function draftOf(
  agent: AgentDetail | null,
  start: AgentFormStart | undefined,
  /** The workspace preset's abilities, for a new agent no suggestion describes. */
  presetAbilities: AgentAbilities,
) {
  const model = agent === null ? (start?.model ?? null) : agent.model;
  const modelChoice: AgentModelChoiceValue | null =
    model === null ? null : { instanceId: model.instanceId, model: model.model };
  const effort: AgentEffort = model?.effort ?? "medium";
  const skills: ReadonlyArray<SkillName> = agent?.skills ?? [];
  const connectors: ReadonlyArray<AgentConnector> = agent?.connectors ?? start?.connectors ?? [];
  return {
    title: agent?.title ?? start?.title ?? "",
    description: agent?.description ?? start?.description ?? "",
    instructions: agent?.instructions ?? start?.instructions ?? "",
    modelChoice,
    effort,
    skills,
    connectors,
    abilities: agent?.abilities ?? start?.abilities ?? presetAbilities,
  };
}

/**
 * The agent editor's form; `agent` is null for a new agent. It stays open while the computer is
 * away, with `connected` false, so a dropped connection keeps what was typed.
 */
export function AgentForm({
  environmentId,
  workspace,
  agent,
  connected,
  forTeam,
}: {
  readonly environmentId: EnvironmentId;
  readonly workspace: ProjectId | null;
  readonly agent: AgentDetail | null;
  readonly connected: boolean;
  readonly forTeam?: AgentFormForTeam | undefined;
}) {
  const instructionsId = useId();
  const effortId = useId();
  const navigate = useNavigate();
  const canSave = useAtomValue(agentsEnvironment.save.permissionAtom(environmentId));
  const save = useAtomCommand(agentsEnvironment.save, { reportFailure: false });
  const remove = useAtomCommand(agentsEnvironment.delete, { reportFailure: false });
  const startChat = useStartAgentChat();
  const catalog = useAgentModelCatalog(environmentId);
  const chatWorkspace = useAgentChatWorkspace(environmentId, workspace);
  const codenineSkills = useCodenineSkills(environmentId, null);
  const connectors = useEnvironmentQuery(connectorsEnvironment.state({ environmentId, input: {} }));
  const connections = connectors.data?.connections ?? NO_CONNECTIONS;
  const [errors, setErrors] = useState<AgentDraftErrors & { readonly form?: string }>({});
  const [busy, setBusy] = useState(false);
  const { draft, newer, follow, change, release, saved } = useEditorDraft(
    agent,
    (from) => draftOf(from, forTeam?.start, projectPreset(chatWorkspace).agentAbilities),
    busy,
  );
  const { title, description, instructions, modelChoice, effort, skills, abilities } = draft;
  const agentConnectors = draft.connectors;
  const [pickingModel, setPickingModel] = useState(false);
  const [pickingSkill, setPickingSkill] = useState(false);
  const disabled = busy || !canSave;
  const cannotSave = disabled || !connected;
  const model = modelChoice === null ? null : { ...modelChoice, effort };
  const described = model === null ? null : describeAgentModel(catalog, model);
  const savedName = agent?.name ?? skillNameFromTitle(title);
  const shownTitle = agent?.title ?? (title.trim() === "" ? "New agent" : title.trim());
  // The saved agent's status speaks for its saved model only.
  const savedProblem =
    agent !== null &&
    agent.model?.instanceId === modelChoice?.instanceId &&
    agent.model?.model === modelChoice?.model
      ? agentModelProblem(agent.modelStatus)
      : null;
  const addable = connections.filter(
    (connection) => !agentConnectors.some((connector) => connector.id === connection.id),
  );
  const backToAgents = () =>
    void navigate({
      to: "/agents",
      search: { machine: environmentId, workspace: workspace ?? undefined },
    });
  const cancel = () => {
    release();
    (forTeam?.onCancel ?? backToAgents)();
  };

  const submit = async (then: "list" | "chat") => {
    if (busy) return;
    const checked = checkAgentDraft(
      {
        title,
        description,
        instructions,
        model,
        skills,
        connectors: agentConnectors,
        abilities,
      },
      described?.info?.usesTools ?? null,
      agent?.name,
    );
    if (checked.errors !== undefined) {
      setErrors(checked.errors);
      return;
    }
    if (then === "chat" && model === null) {
      setErrors({ model: "Choose a model to chat with this agent." });
      return;
    }
    setErrors({});
    setBusy(true);
    const result = await save({
      environmentId,
      input: {
        agent: checked.agent,
        ...(agent === null ? {} : { previousName: agent.name }),
      },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setErrors({ form: commandErrorMessage(result, "The agent was not saved.") });
      }
      return;
    }
    saved();
    const savedAgent = result.value;
    toastManager.add({ type: "success", title: `Saved ${savedAgent.title}` });
    if (forTeam !== undefined) {
      forTeam.onSaved(savedAgent);
      return;
    }
    if (then === "list") {
      backToAgents();
      return;
    }
    if (agentModelProblem(savedAgent.modelStatus) !== null) {
      // Saved, but it can't run yet: its page says why.
      void navigate({
        to: "/agents/$name/edit",
        params: { name: savedAgent.name },
        search: { machine: environmentId, workspace: workspace ?? undefined },
        replace: true,
      });
      return;
    }
    await startChat({ environmentId, agent: savedAgent, workspace: chatWorkspace });
  };

  const deleteAgent = async () => {
    if (agent === null || busy) return;
    const confirmed = await settlePromise(() =>
      ensureLocalApi().dialogs.confirm(
        `Delete ${agent.title}?\nIts file is removed from your Codenine folder.`,
        { variant: "destructive" },
      ),
    );
    if (confirmed._tag !== "Success" || !confirmed.value) return;
    setBusy(true);
    const result = await remove({ environmentId, input: { name: agent.name } });
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setErrors({ form: commandErrorMessage(result, "The agent was not deleted.") });
      }
      return;
    }
    release();
    toastManager.add({ type: "success", title: `Deleted ${agent.title}` });
    backToAgents();
  };

  const setConnector = (next: AgentConnector) =>
    change({
      connectors: agentConnectors.map((connector) => (connector.id === next.id ? next : connector)),
    });

  return (
    <>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3.5">
          <ConnectorMark name={shownTitle} size="lg" tone="agent" />
          <span className="flex min-w-0 flex-col gap-1">
            <h2 className="truncate text-2xl font-semibold text-foreground">{shownTitle}</h2>
            <span className="text-sm text-muted-foreground">
              {forTeam === undefined
                ? "What it does, the model it runs on, and what it may use."
                : (forTeam.intro ??
                  "The lead suggested this agent for its team. Save it to add it to the team.")}
            </span>
          </span>
        </div>
        {agent === null ? null : (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || agentModelProblem(agent.modelStatus) !== null}
            onClick={() => void startChat({ environmentId, agent, workspace: chatWorkspace })}
          >
            Start chat
          </Button>
        )}
      </header>
      <form
        noValidate
        className="flex flex-col gap-9"
        onSubmit={(event) => {
          event.preventDefault();
          void submit("list");
        }}
      >
        <section aria-label="What it does" className="flex flex-col gap-4">
          <h3 className="text-base font-semibold text-foreground">What it does</h3>
          <TextField
            label="Name"
            placeholder="Code reviewer"
            value={title}
            disabled={disabled}
            error={errors.title}
            hint={savedName === "" ? undefined : `Saved as ${savedName}`}
            onChange={(next) => change({ title: next })}
          />
          <TextField
            label="Use it for…"
            placeholder="Reviewing a change for bugs, risky edits and missing tests."
            value={description}
            disabled={disabled}
            error={errors.description}
            hint="Chats and lead agents read this line to decide when this agent fits."
            onChange={(next) => change({ description: next })}
          />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={instructionsId}>Instructions</Label>
            <Textarea
              id={instructionsId}
              font="mono"
              rows={9}
              spellCheck={false}
              value={instructions}
              disabled={disabled}
              onChange={(event) => change({ instructions: event.currentTarget.value })}
            />
          </div>
        </section>

        <section aria-label="Model" className="flex flex-col gap-3.5">
          <h3 className="text-base font-semibold text-foreground">Model</h3>
          <div className="flex flex-wrap items-center gap-3.5 rounded-xl border border-border bg-card px-4 py-3.5">
            <span className="flex min-w-60 flex-1 flex-col gap-1">
              <span className="text-sm font-medium text-foreground">
                {described?.name ?? "No model yet"}
              </span>
              <span className="text-xs text-muted-foreground">
                {described === null
                  ? "Choose the model this agent runs on."
                  : [
                      described.account ?? "Its account is off or gone",
                      modelInfoLine(described.info),
                    ]
                      .filter((part) => part !== "")
                      .join(" · ")}
              </span>
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => setPickingModel(true)}
            >
              {model === null ? "Choose" : "Change"}
            </Button>
          </div>
          {savedProblem === null ? null : (
            <Alert variant="warning">
              <AlertDescription>{savedProblem.warning}</AlertDescription>
            </Alert>
          )}
          {errors.model === undefined ? null : (
            <p role="alert" className="text-sm text-destructive-foreground">
              {errors.model}
            </p>
          )}
          <div className="flex flex-col gap-2">
            <span id={effortId} className="text-sm font-medium text-foreground">
              Effort
            </span>
            <ToggleGroup
              aria-labelledby={effortId}
              value={[effort]}
              disabled={disabled}
              onValueChange={(next) => {
                const level = AGENT_EFFORTS.find((candidate) => candidate === next[0]);
                if (level !== undefined) change({ effort: level });
              }}
            >
              {AGENT_EFFORTS.map((level) => (
                <Toggle key={level} value={level}>
                  {AGENT_EFFORT_LABELS[level]}
                </Toggle>
              ))}
            </ToggleGroup>
            <span className="text-xs text-muted-foreground">
              More effort thinks longer and costs more. Codenine matches these to each account's own
              levels.
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            A chat or a team can switch the model for one conversation without changing the agent.
          </p>
        </section>

        <section aria-label="Skills" className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h3 className="text-base font-semibold text-foreground">Skills</h3>
            <p className="text-sm text-muted-foreground">
              The agent reads a skill when a task fits it.
            </p>
          </div>
          <ul aria-label="The agent's skills" className="flex flex-wrap items-center gap-1.5">
            {skills.map((name) => (
              <ChoiceChip
                key={name}
                skill
                icon={<SparklesIcon />}
                label={skillTitle(name)}
                removeLabel={`Remove ${skillTitle(name)}`}
                disabled={disabled}
                onRemove={() => change({ skills: skills.filter((skill) => skill !== name) })}
              />
            ))}
            <li>
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => setPickingSkill(true)}
              >
                <PlusIcon />
                Add skill
              </Button>
            </li>
          </ul>
        </section>

        <section aria-label="Connectors" className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h3 className="text-base font-semibold text-foreground">Connectors</h3>
            <p className="text-sm text-muted-foreground">
              Services this agent may use, and which of their actions ask you first. These choices
              apply only to this agent; a group you leave alone follows the connector.
            </p>
          </div>
          {agentConnectors.length === 0 ? null : (
            <div className="divide-y divide-border rounded-xl border border-border bg-card">
              {agentConnectors.map((connector) => (
                <AgentConnectorRow
                  key={connector.id}
                  connector={connector}
                  connection={
                    connections.find((connection) => connection.id === connector.id) ?? null
                  }
                  disabled={disabled}
                  onChange={setConnector}
                  onRemove={() =>
                    change({
                      connectors: agentConnectors.filter(
                        (candidate) => candidate.id !== connector.id,
                      ),
                    })
                  }
                />
              ))}
            </div>
          )}
          <Menu>
            <MenuTrigger
              disabled={disabled}
              render={<Button size="sm" variant="outline" className="self-start" />}
            >
              <PlusIcon />
              Add connector
            </MenuTrigger>
            <MenuPopup align="start" className="w-72">
              {addable.map((connection) => (
                <MenuItem
                  key={connection.id}
                  onClick={() =>
                    change({
                      connectors: [...agentConnectors, { id: connection.id, approvals: {} }],
                    })
                  }
                >
                  <ConnectorMark name={connection.name} size="sm" />
                  <span className="min-w-0 flex-1 truncate">{connection.name}</span>
                  {connection.status === "connected" ? null : (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {CONNECTION_STATUS[connection.status].label}
                    </span>
                  )}
                </MenuItem>
              ))}
              {addable.length === 0 ? (
                <p className="px-2 py-1 text-xs text-muted-foreground">
                  {connectors.error ??
                    (connections.length === 0
                      ? "None connected yet."
                      : "Every connector is on this agent.")}
                </p>
              ) : null}
              <MenuItem
                onClick={() =>
                  void navigate({ to: "/connectors", search: { machine: environmentId } })
                }
              >
                Connect a service…
              </MenuItem>
            </MenuPopup>
          </Menu>
        </section>

        <section aria-label="On this computer" className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h3 className="text-base font-semibold text-foreground">On this computer</h3>
            <p className="text-sm text-muted-foreground">
              Turn on only what the job needs. An email agent needs none of these.
            </p>
          </div>
          <div className="divide-y divide-border rounded-xl border border-border bg-card">
            {ABILITIES.map((ability) => (
              <AbilityRow
                key={ability.key}
                title={ability.title}
                hint={ability.hint}
                stuckOn={
                  !abilities[ability.key] &&
                  described?.account != null &&
                  described.turnsOff !== null &&
                  !described.turnsOff.includes(ability.key)
                    ? `Stays on with ${described.account}, which can't turn it off.`
                    : null
                }
                checked={abilities[ability.key]}
                disabled={disabled}
                onCheckedChange={(checked) =>
                  change({ abilities: { ...abilities, [ability.key]: checked } })
                }
              />
            ))}
          </div>
        </section>

        {errors.form === undefined ? null : (
          <p role="alert" className="text-sm text-destructive-foreground">
            {errors.form}
          </p>
        )}
        {connected ? null : (
          <p role="status" className="text-sm text-muted-foreground">
            This computer is not connected. You can save once it is back.
          </p>
        )}
        {newer ? (
          <p
            role="status"
            className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
          >
            This agent changed since you opened it. Saving replaces that change.
            <Button variant="outline" size="xs" disabled={busy} onClick={follow}>
              Load the newer agent
            </Button>
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          {agent === null ? (
            <span />
          ) : (
            <Button
              variant="destructive-outline"
              size="sm"
              disabled={cannotSave}
              onClick={() => void deleteAgent()}
            >
              Delete agent
            </Button>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={busy} onClick={cancel}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={forTeam === undefined ? "outline" : "default"}
              size="sm"
              disabled={cannotSave}
            >
              {busy ? "Saving…" : "Save"}
            </Button>
            {forTeam === undefined ? (
              <Button size="sm" disabled={cannotSave} onClick={() => void submit("chat")}>
                Save and start chat
              </Button>
            ) : null}
          </div>
        </div>
      </form>
      {pickingModel ? (
        <AgentModelDialog
          environmentId={environmentId}
          agentTitle={title.trim()}
          needsTools={agentConnectors.length > 0}
          value={modelChoice}
          onPick={(choice) => {
            change({ modelChoice: choice });
            setErrors(({ model: _model, ...rest }) => rest);
            setPickingModel(false);
          }}
          onClose={() => setPickingModel(false)}
        />
      ) : null}
      <AddSkillDialog
        open={pickingSkill}
        skills={codenineSkills}
        keptOn={skills}
        actionLabel="Add to this agent"
        emptyMessage={
          codenineSkills.length === 0
            ? "No Codenine skills yet. Add some on the Skills page."
            : "Every skill is already on this agent."
        }
        onOpenChange={setPickingSkill}
        onPick={(name) => {
          if (!skills.includes(name)) change({ skills: [...skills, name] });
        }}
      />
    </>
  );
}

function AgentConnectorRow({
  connector,
  connection,
  disabled,
  onChange,
  onRemove,
}: {
  readonly connector: AgentConnector;
  readonly connection: ConnectionSnapshot | null;
  readonly disabled: boolean;
  readonly onChange: (next: AgentConnector) => void;
  readonly onRemove: () => void;
}) {
  const name = connection?.name ?? connector.id;
  const summary =
    connection === null
      ? "Not connected. Connect it again, or remove it."
      : connectionSummary(connection) || CONNECTION_STATUS[connection.status].label;
  return (
    <div className="flex flex-col pb-1.5">
      <div className="flex flex-wrap items-center gap-3 px-4 pt-3.5 pb-2">
        <ConnectorMark name={name} />
        <span className="flex min-w-48 flex-1 flex-col gap-0.5">
          <span className="text-sm font-medium text-foreground">{name}</span>
          <span className="text-xs text-muted-foreground">{summary}</span>
        </span>
        <Button
          size="sm"
          variant="ghost-muted"
          disabled={disabled}
          aria-label={`Remove ${name}`}
          onClick={onRemove}
        >
          Remove
        </Button>
      </div>
      {RISK_GROUPS.map((group) => {
        const mode = effectiveApproval(connector, connection, group.risk);
        return (
          <div
            key={group.risk}
            className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 py-2 ps-16 pe-4"
          >
            <span className="flex min-w-48 flex-1 flex-col gap-0.5">
              <span className="text-sm text-foreground">{group.title}</span>
              <span className="text-xs text-muted-foreground">{group.hint}</span>
            </span>
            <Select
              value={mode}
              disabled={disabled}
              onValueChange={(next) => {
                if (next !== "auto" && next !== "ask") return;
                onChange({
                  ...connector,
                  approvals: { ...connector.approvals, [group.risk]: next },
                });
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-auto"
                aria-label={`${name}, ${group.title.toLowerCase()} actions`}
              >
                <SelectValue>
                  {(value: ConnectorApprovalMode) => APPROVAL_MODE_LABELS[value]}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {APPROVAL_MODES.map((option) => (
                  <SelectItem hideIndicator key={option} value={option}>
                    {APPROVAL_MODE_LABELS[option]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {group.risk === "irreversible" && mode === "auto" ? (
              <p className="w-full text-xs text-warning-foreground">
                What this agent reads could carry instructions meant to trick it. Choose Automatic
                only when you trust what it reads.
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function AbilityRow(props: {
  readonly title: string;
  readonly hint: string;
  /** Why the ability stays on although the switch is off. */
  readonly stuckOn: string | null;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <span className="flex min-w-0 flex-col gap-0.5">
        <label htmlFor={id} className="text-sm text-foreground">
          {props.title}
        </label>
        <span className="text-xs text-muted-foreground">{props.hint}</span>
        {props.stuckOn === null ? null : (
          <span className="text-xs text-warning-foreground">{props.stuckOn}</span>
        )}
      </span>
      <Switch
        id={id}
        checked={props.checked}
        disabled={props.disabled}
        onCheckedChange={props.onCheckedChange}
      />
    </div>
  );
}
