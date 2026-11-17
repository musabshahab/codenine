import {
  type AgentName,
  type EnvironmentId,
  type ProjectId,
  skillTitle,
} from "@codenine/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";

import { agentsEnvironment } from "../../state/agents";
import { useEnvironmentQuery } from "../../state/query";
import { AgentForm } from "../agents/AgentForm";
import { useAccessEnvironment } from "../settings/useAccessEnvironment";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { WorkspacePage } from "./WorkspacePage";

export type AgentEditorTarget =
  | { readonly kind: "new" }
  | { readonly kind: "edit"; readonly name: AgentName }
  | { readonly kind: "invalid" };

/** Makes an agent or changes one: what it does, its model and effort, and what it may use. */
export function AgentEditorPage(props: {
  readonly target: AgentEditorTarget;
  readonly machine: EnvironmentId | null;
  readonly workspace: ProjectId | null;
}) {
  const { environment } = useAccessEnvironment(props.machine);
  const environmentId = environment?.environmentId ?? null;
  const connected = environment?.connection.phase === "connected";
  const editing = props.target.kind === "edit" ? props.target : null;
  const detail = useEnvironmentQuery(
    editing !== null && environmentId !== null && connected
      ? agentsEnvironment.read({ environmentId, input: { name: editing.name } })
      : null,
  );
  const title = detail.data?.title ?? (editing === null ? "New agent" : skillTitle(editing.name));
  const breadcrumb = (
    <span className="flex min-w-0 items-center gap-1">
      <Link
        to="/agents"
        search={{ machine: environmentId ?? undefined, workspace: props.workspace ?? undefined }}
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        Agents
      </Link>
      <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{title}</span>
    </span>
  );
  return (
    <WorkspacePage area="agent" title={breadcrumb}>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6">
        {props.target.kind === "invalid" ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>This agent is not here</EmptyTitle>
              <EmptyDescription>The address does not name an agent.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : environmentId === null || !connected ? (
          <p className="text-sm text-muted-foreground">
            Connect the computer the agent is on to change it.
          </p>
        ) : editing === null ? (
          <AgentForm environmentId={environmentId} workspace={props.workspace} agent={null} />
        ) : detail.data === null ? (
          detail.error === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>This agent could not open</EmptyTitle>
                <EmptyDescription>{detail.error}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )
        ) : (
          // Keyed so the form starts from the agent it opened, even if the agent changes later.
          <AgentForm
            key={detail.data.name}
            environmentId={environmentId}
            workspace={props.workspace}
            agent={detail.data}
          />
        )}
      </div>
    </WorkspacePage>
  );
}
