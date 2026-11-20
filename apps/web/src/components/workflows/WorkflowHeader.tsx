import type { EnvironmentId } from "@codenine/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { Fragment } from "react";

import { Toggle, ToggleGroup } from "../ui/toggle-group";

/** "Workflows › Weekly blog post › Run 12"; every part but the last links back. */
export function WorkflowBreadcrumb(props: {
  readonly machine: EnvironmentId | null;
  /** The workflow's title, linking to its canvas while `name` is given and it is not last. */
  readonly workflow: { readonly title: string; readonly name: string | null };
  readonly run?: number | undefined;
}) {
  const search = { machine: props.machine ?? undefined };
  const crumbs = [
    <Link
      key="list"
      to="/workflows"
      search={search}
      className="shrink-0 text-muted-foreground hover:text-foreground"
    >
      Workflows
    </Link>,
    props.run === undefined || props.workflow.name === null ? (
      <span key="workflow" className="truncate">
        {props.workflow.title}
      </span>
    ) : (
      <Link
        key="workflow"
        to="/workflows/$name"
        params={{ name: props.workflow.name }}
        search={search}
        className="truncate text-muted-foreground hover:text-foreground"
      >
        {props.workflow.title}
      </Link>
    ),
    ...(props.run === undefined
      ? []
      : [
          <span key="run" className="shrink-0">
            Run {props.run}
          </span>,
        ]),
  ];
  return (
    <span className="flex min-w-0 items-center gap-1">
      {crumbs.map((crumb, index) => (
        <Fragment key={crumb.key}>
          {index === 0 ? null : (
            <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          {crumb}
        </Fragment>
      ))}
    </span>
  );
}

/** Canvas | Runs for a saved workflow. */
export function WorkflowViewSwitch(props: {
  readonly machine: EnvironmentId | null;
  readonly name: string;
  readonly view: "canvas" | "runs";
}) {
  const navigate = useNavigate();
  const search = { machine: props.machine ?? undefined };
  return (
    <ToggleGroup
      aria-label="Workflow view"
      value={[props.view]}
      onValueChange={(next) => {
        if (next[0] === "canvas" && props.view !== "canvas") {
          void navigate({ to: "/workflows/$name", params: { name: props.name }, search });
        }
        if (next[0] === "runs" && props.view !== "runs") {
          void navigate({ to: "/workflows/$name/runs", params: { name: props.name }, search });
        }
      }}
    >
      <Toggle value="canvas">Canvas</Toggle>
      <Toggle value="runs">Runs</Toggle>
    </ToggleGroup>
  );
}
