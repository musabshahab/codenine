import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@codenine/client-runtime/environment";
import type { AgentModel, EnvironmentId, TeamAgent, ThreadId } from "@codenine/contracts";
import type { ReactNode } from "react";

import { useQuietThreadShell, useThreadStatus } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { savedWorkflowsEnvironment } from "../../state/savedWorkflows";
import { environmentThreadDetails } from "../../state/threads";
import { agentModelOfSelection, useAgentModelCatalog, useAgents } from "../agents/useAgents";
import { useAccessEnvironment } from "../settings/useAccessEnvironment";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import {
  useWorkflowEdit,
  type WorkflowEditTarget,
  workflowEditKey,
} from "../workflows/workflowEditStore";
import { WorkflowEditor } from "../workflows/WorkflowEditor";
import { WorkflowBreadcrumb } from "../workflows/WorkflowHeader";
import {
  blankWorkflow,
  workflowFromDraft,
  workflowFromTeamPlan,
} from "../workflows/workflows.logic";
import { WorkspacePage } from "./WorkspacePage";

export type WorkflowEditorTarget = WorkflowEditTarget | { readonly kind: "invalid" };

const BLANK = blankWorkflow();

/** A saved workflow's canvas, or a new one: blank, from a chat's draft, or from a finished team. */
export function WorkflowEditorPage(props: {
  readonly target: WorkflowEditorTarget;
  readonly machine: EnvironmentId | null;
}) {
  const { environment } = useAccessEnvironment(props.machine);
  const environmentId = environment?.environmentId ?? null;
  const connected = environment?.connection.phase === "connected";
  const { target } = props;
  if (target.kind === "invalid") {
    return (
      <EditorMessage machine={environmentId} title="Workflow">
        <EmptyTitle>This workflow is not here</EmptyTitle>
        <EmptyDescription>The address does not name a workflow.</EmptyDescription>
      </EditorMessage>
    );
  }
  if (environmentId === null || !connected) {
    return (
      <EditorMessage
        machine={environmentId}
        title={target.kind === "new" ? "New workflow" : "Workflow"}
      >
        <EmptyTitle>Not connected</EmptyTitle>
        <EmptyDescription>Connect the computer the workflow is on to change it.</EmptyDescription>
      </EditorMessage>
    );
  }
  if (target.kind === "saved") {
    return <SavedWorkflowEditor environmentId={environmentId} name={target.name} />;
  }
  const editKey = workflowEditKey(target);
  switch (target.from.kind) {
    case "blank":
      return (
        <WorkflowEditor
          environmentId={environmentId}
          editKey={editKey}
          saved={null}
          start={BLANK}
          notice={null}
        />
      );
    case "draft":
      return (
        <DraftWorkflowEditor
          environmentId={environmentId}
          editKey={editKey}
          threadId={target.from.threadId}
        />
      );
    case "team":
      return (
        <TeamWorkflowEditor
          environmentId={environmentId}
          editKey={editKey}
          threadId={target.from.threadId}
        />
      );
  }
}

function EditorMessage(props: {
  readonly machine: EnvironmentId | null;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <WorkspacePage
      area="workflow"
      title={
        <WorkflowBreadcrumb machine={props.machine} workflow={{ title: props.title, name: null }} />
      }
    >
      <Empty className="h-full">
        <EmptyHeader>{props.children}</EmptyHeader>
      </Empty>
    </WorkspacePage>
  );
}

function SavedWorkflowEditor(props: {
  readonly environmentId: EnvironmentId;
  readonly name: string;
}) {
  const { environmentId, name } = props;
  const detail = useEnvironmentQuery(
    savedWorkflowsEnvironment.read({ environmentId, input: { name } }),
  );
  if (detail.data === null) {
    return detail.error === null ? (
      <EditorMessage machine={environmentId} title="Workflow">
        <EmptyDescription>Loading…</EmptyDescription>
      </EditorMessage>
    ) : (
      <EditorMessage machine={environmentId} title="Workflow">
        <EmptyTitle>This workflow could not open</EmptyTitle>
        <EmptyDescription>{detail.error}</EmptyDescription>
      </EditorMessage>
    );
  }
  return (
    <WorkflowEditor
      environmentId={environmentId}
      editKey={workflowEditKey({ kind: "saved", name: detail.data.name })}
      saved={detail.data}
      start={BLANK}
      notice={null}
    />
  );
}

/** Starts from the workflow a lead drafted in a chat, led on the chat's own model and workspace. */
function DraftWorkflowEditor(props: {
  readonly environmentId: EnvironmentId;
  readonly editKey: string;
  readonly threadId: ThreadId;
}) {
  const { environmentId, editKey } = props;
  const ref = scopeThreadRef(environmentId, props.threadId);
  const draft = useAtomValue(environmentThreadDetails.workflowDraftAtom(ref));
  const status = useThreadStatus(ref);
  const shell = useQuietThreadShell(ref);
  const catalog = useAgentModelCatalog(environmentId);
  const edit = useWorkflowEdit(environmentId, editKey);
  if (draft === null && edit === null && status !== "live" && status !== "deleted") {
    return (
      <EditorMessage machine={environmentId} title="New workflow">
        <EmptyDescription>Loading the chat's draft…</EmptyDescription>
      </EditorMessage>
    );
  }
  const start =
    draft === null
      ? BLANK
      : workflowFromDraft(draft, {
          model:
            shell === null ? null : agentModelOfSelection(catalog.entries, shell.modelSelection),
          projectId: shell?.projectId ?? null,
        });
  return (
    <WorkflowEditor
      environmentId={environmentId}
      editKey={editKey}
      saved={null}
      start={start}
      notice={
        draft === null && edit === null
          ? "The chat has no workflow draft any more, so this one starts blank."
          : null
      }
    />
  );
}

/** Starts from a finished team: a step per task, for the same agents, on the same models. */
function TeamWorkflowEditor(props: {
  readonly environmentId: EnvironmentId;
  readonly editKey: string;
  readonly threadId: ThreadId;
}) {
  const { environmentId, editKey } = props;
  const ref = scopeThreadRef(environmentId, props.threadId);
  const plan = useAtomValue(environmentThreadDetails.teamAtom(ref));
  const status = useThreadStatus(ref);
  const shell = useQuietThreadShell(ref);
  const agents = useAgents(environmentId);
  const catalog = useAgentModelCatalog(environmentId);
  const edit = useWorkflowEdit(environmentId, editKey);
  const agentsLoaded = agents.data !== null || agents.error !== null;
  if (
    edit === null &&
    ((plan === null && status !== "live" && status !== "deleted") || !agentsLoaded)
  ) {
    return (
      <EditorMessage machine={environmentId} title="New workflow">
        <EmptyDescription>Loading the team…</EmptyDescription>
      </EditorMessage>
    );
  }
  // A member keeps its own model only where it differs from its agent's.
  const stepModel = (member: TeamAgent): AgentModel | null => {
    const model = agentModelOfSelection(catalog.entries, member.modelSelection);
    const own =
      member.agent === undefined
        ? null
        : (agents.agents.find((agent) => agent.name === member.agent)?.model ?? null);
    return own !== null &&
      own.instanceId === model.instanceId &&
      own.model === model.model &&
      own.effort === model.effort
      ? null
      : model;
  };
  const start =
    plan === null
      ? BLANK
      : workflowFromTeamPlan(plan, {
          title: shell?.title ?? "",
          model:
            shell === null ? null : agentModelOfSelection(catalog.entries, shell.modelSelection),
          projectId: shell?.projectId ?? null,
          stepModel,
        });
  return (
    <WorkflowEditor
      environmentId={environmentId}
      editKey={editKey}
      saved={null}
      start={start}
      notice={
        plan === null && edit === null
          ? "That chat has no team any more, so this workflow starts blank."
          : null
      }
    />
  );
}
