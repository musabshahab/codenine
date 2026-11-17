import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@codenine/client-runtime/state/models";
import { isAtomCommandInterrupted, settlePromise } from "@codenine/client-runtime/state/runtime";
import type {
  AgentSummary,
  ConnectionSnapshot,
  EnvironmentId,
  ProjectId,
} from "@codenine/contracts";
import { useNavigate } from "@tanstack/react-router";
import { BotIcon, EllipsisIcon } from "lucide-react";
import { useState } from "react";

import { commandErrorMessage } from "../../lib/commandError";
import { ensureLocalApi } from "../../localApi";
import { agentsEnvironment } from "../../state/agents";
import { connectorsEnvironment } from "../../state/connectors";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import {
  agentAbilitiesLine,
  agentConnectorsLine,
  agentModelLine,
  agentModelProblem,
  agentSkillsLine,
  copyTitle,
} from "../agents/agents.logic";
import {
  type AgentModelCatalog,
  describeAgentModel,
  useAgentModelCatalog,
  useAgents,
} from "../agents/useAgents";
import { useAgentChatWorkspace, useStartAgentChat } from "../agents/useStartAgentChat";
import { ConnectorMark } from "../connectors/ConnectorMark";
import { skillNameFromTitle } from "../skills/skills.logic";
import { EnvironmentPagePicker } from "../settings/EnvironmentPagePicker";
import { useAccessEnvironment } from "../settings/useAccessEnvironment";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { WorkspacePage } from "./WorkspacePage";

/** Agents: specialists set up once, each with its model, skills and connectors. */
export function AgentsPage(props: {
  readonly machine: EnvironmentId | null;
  readonly workspace: ProjectId | null;
}) {
  const navigate = useNavigate();
  const [selectedMachine, setSelectedMachine] = useState(props.machine);
  const { candidates, environment, label } = useAccessEnvironment(selectedMachine);
  const environmentId = environment?.environmentId ?? null;
  const connected = environment?.connection.phase === "connected";
  const canSave = useAtomValue(agentsEnvironment.save.permissionAtom(environmentId));
  const newAgent = () =>
    void navigate({
      to: "/agents/new",
      search: { machine: environmentId ?? undefined, workspace: props.workspace ?? undefined },
    });
  return (
    <WorkspacePage
      area="agents"
      title="Agents"
      actions={
        environmentId !== null && connected ? (
          <Button size="sm" disabled={!canSave} onClick={newAgent}>
            New agent
          </Button>
        ) : null
      }
    >
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-8 sm:px-6">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Specialists you set up once: what each one does, the model it runs on, and the skills and
          connectors it uses. They work with any of your accounts, so you can move one to another
          model at any time.
        </p>
        {candidates.length > 1 && environment !== null ? (
          <div className="-mx-3 sm:-mx-4">
            <EnvironmentPagePicker
              label="Agents on"
              candidates={candidates}
              value={environment.environmentId}
              onChange={setSelectedMachine}
            />
          </div>
        ) : null}
        {environment === null ? (
          <p className="text-sm text-muted-foreground">Connect a computer to see its agents.</p>
        ) : !connected ? (
          <p className="text-sm text-muted-foreground">
            Reconnect {label ?? environment.label} to see its agents.
          </p>
        ) : (
          <AgentsOnMachine
            key={environment.environmentId}
            environmentId={environment.environmentId}
            workspace={props.workspace}
            canSave={canSave}
            onNewAgent={newAgent}
          />
        )}
        <p className="text-xs text-muted-foreground">
          Agents live in your Codenine folder, so backups include them. Each is a standard agent
          file you can open and share.
        </p>
      </div>
    </WorkspacePage>
  );
}

function AgentsOnMachine({
  environmentId,
  workspace,
  canSave,
  onNewAgent,
}: {
  readonly environmentId: EnvironmentId;
  readonly workspace: ProjectId | null;
  readonly canSave: boolean;
  readonly onNewAgent: () => void;
}) {
  const list = useAgents(environmentId);
  const catalog = useAgentModelCatalog(environmentId);
  const connectors = useEnvironmentQuery(connectorsEnvironment.state({ environmentId, input: {} }));
  const connections = connectors.data?.connections ?? NO_CONNECTIONS;
  const chatWorkspace = useAgentChatWorkspace(environmentId, workspace);
  if (list.data === null) {
    return list.error === null ? (
      <p className="text-sm text-muted-foreground">Loading agents…</p>
    ) : (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BotIcon />
          </EmptyMedia>
          <EmptyTitle>Agents could not load</EmptyTitle>
          <EmptyDescription>{list.error}</EmptyDescription>
        </EmptyHeader>
        <Button size="sm" variant="outline" onClick={list.refresh}>
          Try again
        </Button>
      </Empty>
    );
  }
  if (list.agents.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BotIcon />
          </EmptyMedia>
          <EmptyTitle>No agents yet</EmptyTitle>
          <EmptyDescription>
            An agent is a specialist for one kind of task, such as your email or code review: its
            instructions, the model it runs on, and the skills and connectors it may use. Make one,
            then pick it in any chat.
          </EmptyDescription>
        </EmptyHeader>
        <Button size="sm" disabled={!canSave} onClick={onNewAgent}>
          New agent
        </Button>
      </Empty>
    );
  }
  const sorted = list.agents.toSorted((left, right) => left.title.localeCompare(right.title));
  return (
    <div className="grid gap-3.5 lg:grid-cols-2">
      {sorted.map((agent) => (
        <AgentCard
          key={agent.name}
          environmentId={environmentId}
          agent={agent}
          takenNames={list.agents.map((candidate) => candidate.name)}
          catalog={catalog}
          connections={connections}
          workspace={chatWorkspace}
          canSave={canSave}
        />
      ))}
    </div>
  );
}

const NO_CONNECTIONS: ReadonlyArray<ConnectionSnapshot> = [];

function AgentCard({
  environmentId,
  agent,
  takenNames,
  catalog,
  connections,
  workspace,
  canSave,
}: {
  readonly environmentId: EnvironmentId;
  readonly agent: AgentSummary;
  readonly takenNames: ReadonlyArray<string>;
  readonly catalog: AgentModelCatalog;
  readonly connections: ReadonlyArray<ConnectionSnapshot>;
  readonly workspace: EnvironmentProject | null;
  readonly canSave: boolean;
}) {
  const navigate = useNavigate();
  const startChat = useStartAgentChat();
  const readAgent = useAtomQueryRunner(agentsEnvironment.read, { reportFailure: false });
  const save = useAtomCommand(agentsEnvironment.save, { reportFailure: false });
  const remove = useAtomCommand(agentsEnvironment.delete, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const problem = agentModelProblem(agent.modelStatus);
  const model = agent.model === null ? null : describeAgentModel(catalog, agent.model);

  const duplicate = async () => {
    setBusy(true);
    const detail = await readAgent({ environmentId, input: { name: agent.name } });
    if (detail._tag === "Failure") {
      setBusy(false);
      if (!isAtomCommandInterrupted(detail)) {
        toastManager.add({
          type: "error",
          title: `Could not copy ${agent.title}`,
          description: commandErrorMessage(detail, "Try again."),
        });
      }
      return;
    }
    const {
      path: _path,
      updatedAt: _updatedAt,
      modelStatus: _status,
      ...definition
    } = detail.value;
    const title = copyTitle(agent.title, takenNames);
    const result = await save({
      environmentId,
      input: { agent: { ...definition, title, name: skillNameFromTitle(title) } },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: `Could not copy ${agent.title}`,
          description: commandErrorMessage(result, "Try again."),
        });
      }
      return;
    }
    toastManager.add({ type: "success", title: `Made ${title}` });
  };

  const deleteAgent = async () => {
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
        toastManager.add({
          type: "error",
          title: `Could not delete ${agent.title}`,
          description: commandErrorMessage(result, "Try again."),
        });
      }
      return;
    }
    toastManager.add({ type: "success", title: `Deleted ${agent.title}` });
  };

  return (
    <article
      aria-labelledby={`agent-${agent.name}`}
      className="flex flex-col gap-3.5 rounded-xl border border-border bg-card p-4"
    >
      <div className="flex items-start gap-3">
        <ConnectorMark name={agent.title} tone="agent" />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 id={`agent-${agent.name}`} className="text-base font-semibold text-foreground">
            {agent.title}
          </h2>
          <span className="text-sm text-muted-foreground">{agent.description}</span>
        </span>
      </div>
      <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
        <dt className="text-muted-foreground">Model</dt>
        <dd className="text-foreground">
          {agentModelLine(
            agent.model === null || model === null
              ? null
              : {
                  name: model.name,
                  effort: model.hasEffort ? agent.model.effort : null,
                  account: model.account,
                },
          )}
        </dd>
        <dt className="text-muted-foreground">Connectors</dt>
        <dd className="text-foreground">{agentConnectorsLine(agent.connectors, connections)}</dd>
        <dt className="text-muted-foreground">Skills</dt>
        <dd className="text-foreground">{agentSkillsLine(agent.skills)}</dd>
        <dt className="text-muted-foreground">On this computer</dt>
        <dd className="text-foreground">{agentAbilitiesLine(agent.abilities)}</dd>
      </dl>
      {problem === null ? null : (
        <Alert variant="warning">
          <AlertDescription>{problem.warning}</AlertDescription>
        </Alert>
      )}
      <div className="mt-auto flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={problem !== null || busy}
          onClick={() => void startChat({ environmentId, agent, workspace })}
        >
          Start chat
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            void navigate({
              to: "/agents/$name/edit",
              params: { name: agent.name },
              search: { machine: environmentId, workspace: workspace?.id },
            })
          }
        >
          Edit
        </Button>
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost-muted"
                className="ms-auto"
                aria-label={`More for ${agent.title}`}
              />
            }
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem disabled={!canSave || busy} onClick={() => void duplicate()}>
              Duplicate
            </MenuItem>
            <MenuItem
              variant="destructive"
              disabled={!canSave || busy}
              onClick={() => void deleteAgent()}
            >
              Delete
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </article>
  );
}
