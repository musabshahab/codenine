import type { EnvironmentId, ProjectId, ProjectScript, VcsStatusResult } from "@codenine/contracts";
import { skillTitle } from "@codenine/contracts";
import { Link } from "@tanstack/react-router";
import { GitBranchIcon } from "lucide-react";

import { openExternalLink } from "~/lib/openExternalLink";
import { connectorsEnvironment } from "~/state/connectors";
import { useEnvironmentQuery } from "~/state/query";
import { skillsEnvironment } from "~/state/skills";

import { CONNECTION_STATUS } from "../connectors/connectors.logic";
import { ConnectorMark } from "../connectors/ConnectorMark";
import { ScriptIcon } from "../projectScriptEditor";
import { Badge } from "../ui/badge";
import { InlineButton } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { HomeCard } from "./HomeSection";

const ROW =
  "flex h-8 min-w-0 items-center gap-2 rounded-md px-1 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

function SkeletonRows({ count }: { count: number }) {
  return (
    <div aria-hidden className="flex flex-col">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex h-8 items-center gap-2 px-1">
          <Skeleton className="size-4.5" />
          <Skeleton className="h-3.5 w-24" />
        </div>
      ))}
    </div>
  );
}

const PR_STATE = {
  open: { label: "Open", variant: "success" },
  closed: { label: "Closed", variant: "error" },
  merged: { label: "Merged", variant: "info" },
} as const;

/** A Code workspace's checkout: its branch, what is uncommitted, and the branch's pull request. */
export function HomeCheckoutCard(props: {
  readonly status: VcsStatusResult | null;
  /** The status never arrives from a machine that is not connected, so nothing loads then. */
  readonly connected: boolean;
  readonly error: string | null;
  readonly onRetry: () => void;
}) {
  const { status } = props;
  const pr = status?.pr ?? null;
  const changed = status?.workingTree.files.length ?? 0;
  return (
    <HomeCard title="Checkout">
      {status === null ? (
        !props.connected ? (
          <p className="px-1 py-1.5 text-muted-foreground text-sm">
            Reconnect this machine to see its checkout.
          </p>
        ) : props.error === null ? (
          <SkeletonRows count={3} />
        ) : (
          <p className="px-1 py-1.5 text-muted-foreground text-sm">
            The checkout could not be read.{" "}
            <InlineButton onClick={props.onRetry}>Try again</InlineButton>
          </p>
        )
      ) : !status.isRepo ? (
        <p className="px-1 py-1.5 text-muted-foreground text-sm">
          This folder is not a Git repository.
        </p>
      ) : (
        <dl className="flex flex-col text-sm">
          <div className="flex h-8 items-center gap-2 px-1">
            <dt className="w-20 shrink-0 text-muted-foreground">Branch</dt>
            <dd className="flex min-w-0 items-center gap-1.5 text-foreground">
              <GitBranchIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{status.refName ?? "Detached"}</span>
            </dd>
          </div>
          <div className="flex h-8 items-center gap-2 px-1">
            <dt className="w-20 shrink-0 text-muted-foreground">Changes</dt>
            <dd className="truncate text-foreground tabular-nums">
              {changed === 0
                ? "Clean"
                : `${changed} file${changed === 1 ? "" : "s"}, +${status.workingTree.insertions} −${status.workingTree.deletions}`}
            </dd>
          </div>
          <div className="flex h-8 items-center gap-2 px-1">
            <dt className="w-20 shrink-0 text-muted-foreground">Pull request</dt>
            <dd className="flex min-w-0 items-center gap-1.5">
              {pr === null ? (
                <span className="text-muted-foreground">None for this branch</span>
              ) : (
                <>
                  <InlineButton
                    title={pr.title}
                    onClick={() => void openExternalLink(pr.url).catch(() => undefined)}
                  >
                    #{pr.number}
                  </InlineButton>
                  <Badge variant={PR_STATE[pr.state].variant} size="sm">
                    {pr.isDraft === true && pr.state === "open"
                      ? "Draft"
                      : PR_STATE[pr.state].label}
                  </Badge>
                </>
              )}
            </dd>
          </div>
        </dl>
      )}
    </HomeCard>
  );
}

/** The workspace's saved commands, as the thread header's command button lists them. */
export function HomeCommandsCard(props: {
  readonly scripts: ReadonlyArray<ProjectScript>;
  readonly onOpenSettings: () => void;
}) {
  return (
    <HomeCard title="Commands">
      {props.scripts.length === 0 ? (
        <p className="px-1 py-1.5 text-muted-foreground text-sm">
          None yet.{" "}
          <InlineButton onClick={props.onOpenSettings}>Add them in workspace settings</InlineButton>
        </p>
      ) : (
        <ul className="flex flex-wrap gap-1.5 px-1 py-1">
          {props.scripts.map((script) => (
            <li key={script.id}>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-foreground text-xs" />
                  }
                >
                  <ScriptIcon
                    icon={script.icon}
                    className={
                      script.icon === "play"
                        ? "size-3 shrink-0 fill-current text-success-foreground"
                        : "size-3.5 shrink-0 text-muted-foreground"
                    }
                  />
                  {script.name}
                </TooltipTrigger>
                <TooltipPopup side="top">
                  <code>{script.command}</code>
                </TooltipPopup>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}
    </HomeCard>
  );
}

/** The connectors this kind of workspace usually wants, each with whether it is connected. */
export function HomeConnectorsCard(props: {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  readonly suggested: ReadonlyArray<string>;
}) {
  const { environmentId } = props;
  const state = useEnvironmentQuery(
    props.connected ? connectorsEnvironment.state({ environmentId, input: {} }) : null,
  );
  const rows =
    state.data === null
      ? null
      : props.suggested.flatMap((id) => {
          const entry = state.data?.catalog.find((candidate) => candidate.id === id);
          if (entry === undefined) return [];
          const connection =
            state.data?.connections.find((candidate) => candidate.catalogId === id) ?? null;
          return [{ entry, connection }];
        });
  return (
    <HomeCard
      title="Connectors"
      action={
        <InlineButton render={<Link to="/connectors" search={{ machine: environmentId }} />}>
          All
        </InlineButton>
      }
    >
      {!props.connected ? (
        <p className="px-1 py-1.5 text-muted-foreground text-sm">
          Reconnect this machine to see its connectors.
        </p>
      ) : rows === null ? (
        state.error === null ? (
          <SkeletonRows count={props.suggested.length} />
        ) : (
          <p className="px-1 py-1.5 text-muted-foreground text-sm">
            Connectors could not load.{" "}
            <InlineButton onClick={state.refresh}>Try again</InlineButton>
          </p>
        )
      ) : rows.length === 0 ? (
        <p className="px-1 py-1.5 text-muted-foreground text-sm">
          None suggested for this workspace.
        </p>
      ) : (
        <ul className="flex flex-col">
          {rows.map(({ entry, connection }) => (
            <li key={entry.id}>
              <Link
                className={ROW}
                title={entry.description}
                {...(connection === null
                  ? { to: "/connectors", search: { machine: environmentId } }
                  : {
                      to: "/connectors/$connectionId",
                      params: { connectionId: connection.id },
                      search: { machine: environmentId },
                    })}
              >
                <ConnectorMark name={entry.name} size="sm" />
                <span className="min-w-0 flex-1 truncate text-foreground">{entry.name}</span>
                {connection === null ? (
                  <span className="text-muted-foreground text-xs">Connect</span>
                ) : (
                  <Badge variant={CONNECTION_STATUS[connection.status].variant} size="sm">
                    {CONNECTION_STATUS[connection.status].label}
                  </Badge>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </HomeCard>
  );
}

/** The library skills this kind of workspace usually wants, each with whether it was added. */
export function HomeSkillsCard(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly connected: boolean;
  readonly suggested: ReadonlyArray<string>;
}) {
  const { environmentId, projectId } = props;
  const list = useEnvironmentQuery(
    props.connected ? skillsEnvironment.list({ environmentId, input: { projectId } }) : null,
  );
  const search = { machine: environmentId, workspace: projectId };
  const rows =
    list.data === null
      ? null
      : props.suggested.flatMap((name) => {
          const skill = list.data?.library.find((candidate) => candidate.name === name);
          return skill === undefined ? [] : [skill];
        });
  return (
    <HomeCard
      title="Skills"
      action={<InlineButton render={<Link to="/skills" search={search} />}>All</InlineButton>}
    >
      {!props.connected ? (
        <p className="px-1 py-1.5 text-muted-foreground text-sm">
          Reconnect this machine to see its skills.
        </p>
      ) : rows === null ? (
        list.error === null ? (
          <SkeletonRows count={props.suggested.length} />
        ) : (
          <p className="px-1 py-1.5 text-muted-foreground text-sm">
            Skills could not load. <InlineButton onClick={list.refresh}>Try again</InlineButton>
          </p>
        )
      ) : rows.length === 0 ? (
        <p className="px-1 py-1.5 text-muted-foreground text-sm">
          None suggested for this workspace.
        </p>
      ) : (
        <ul className="flex flex-col">
          {rows.map((skill) => (
            <li key={skill.name}>
              <Link className={ROW} title={skill.description} to="/skills" search={search}>
                <span className="min-w-0 flex-1 truncate text-foreground">
                  {skillTitle(skill.name)}
                </span>
                {skill.added ? (
                  <Badge variant="success" size="sm">
                    Added
                  </Badge>
                ) : (
                  <span className="text-muted-foreground text-xs">Add</span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </HomeCard>
  );
}
