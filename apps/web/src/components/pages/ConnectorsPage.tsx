import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted } from "@codenine/client-runtime/state/runtime";
import type {
  ConnectionSnapshot,
  ConnectorCatalogEntry,
  ConnectorCategory,
  ConnectorsState,
  EnvironmentId,
} from "@codenine/contracts";
import { useNavigate } from "@tanstack/react-router";
import { PlugIcon, SearchIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { commandErrorMessage } from "../../lib/commandError";
import { connectorsEnvironment } from "../../state/connectors";
import type { EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { ConnectDialog } from "../connectors/ConnectDialog";
import { ConnectorMark } from "../connectors/ConnectorMark";
import {
  CATEGORY_LABELS,
  CONNECTION_STATUS,
  connectionSummary,
  connectsWithLabel,
  filterLibrary,
  libraryCategories,
} from "../connectors/connectors.logic";
import { CustomConnectorDialog } from "../connectors/CustomConnectorDialog";
import { EnvironmentPagePicker } from "../settings/EnvironmentPagePicker";
import { useAccessEnvironment } from "../settings/useAccessEnvironment";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { WorkspacePage } from "./WorkspacePage";

const ALL_CATEGORIES = "all";

/** The services agents and chats can use: what is connected, and the library to add more. */
export function ConnectorsPage(props: {
  readonly machine: EnvironmentId | null;
  readonly signInError: string | null;
}) {
  const [selected, setSelected] = useState(props.machine);
  const { candidates, environment, label } = useAccessEnvironment(selected);
  const [addingCustom, setAddingCustom] = useState(false);
  useSignInErrorNotice(props.signInError, props.machine);
  return (
    <WorkspacePage
      area="connectors"
      title="Connectors"
      actions={
        environment?.connection.phase === "connected" ? (
          <Button size="sm" variant="outline" onClick={() => setAddingCustom(true)}>
            Add custom connector
          </Button>
        ) : null
      }
    >
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-8 sm:px-6">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Services your agents and chats can use. Codenine keeps every sign-in itself, so a
          connector works the same with every model.
        </p>
        {candidates.length > 1 && environment !== null ? (
          <div className="-mx-3 sm:-mx-4">
            <EnvironmentPagePicker
              label="Connectors on"
              candidates={candidates}
              value={environment.environmentId}
              onChange={setSelected}
            />
          </div>
        ) : null}
        {environment === null ? (
          <p className="text-sm text-muted-foreground">Connect a computer to add connectors.</p>
        ) : (
          // Keyed so dialogs and filters never carry over to another machine.
          <ConnectorsOnMachine
            key={environment.environmentId}
            environment={environment}
            label={label ?? environment.label}
            addingCustom={addingCustom}
            onAddingCustomChange={setAddingCustom}
          />
        )}
      </div>
    </WorkspacePage>
  );
}

/** A sign-in that failed comes back as `?signInError=`; say so once and clear it. */
function useSignInErrorNotice(signInError: string | null, machine: EnvironmentId | null) {
  const navigate = useNavigate();
  const shown = useRef<string | null>(null);
  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- reports the sign-in result the server put in the address, once, then removes it from the address
  useEffect(() => {
    if (signInError === null || shown.current === signInError) return;
    shown.current = signInError;
    toastManager.add({ type: "error", title: "Sign-in did not finish", description: signInError });
    void navigate({
      to: "/connectors",
      search: machine === null ? {} : { machine },
      replace: true,
    });
  }, [machine, navigate, signInError]);
}

function ConnectorsOnMachine({
  environment,
  label,
  addingCustom,
  onAddingCustomChange,
}: {
  readonly environment: EnvironmentPresentation;
  readonly label: string;
  readonly addingCustom: boolean;
  readonly onAddingCustomChange: (open: boolean) => void;
}) {
  const { environmentId } = environment;
  const connected = environment.connection.phase === "connected";
  const state = useEnvironmentQuery(
    connected ? connectorsEnvironment.state({ environmentId, input: {} }) : null,
  );
  const canManage = useAtomValue(connectorsEnvironment.connect.permissionAtom(environmentId));
  const connectRightAway = useAtomCommand(connectorsEnvironment.connect, { reportFailure: false });
  const [connecting, setConnecting] = useState<ConnectorCatalogEntry | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  if (!connected) {
    return (
      <p className="text-sm text-muted-foreground">Reconnect {label} to see its connectors.</p>
    );
  }
  if (state.data === null) {
    return state.error === null ? (
      <p className="text-sm text-muted-foreground">Loading connectors…</p>
    ) : (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <PlugIcon />
          </EmptyMedia>
          <EmptyTitle>Connectors could not load</EmptyTitle>
          <EmptyDescription>{state.error}</EmptyDescription>
        </EmptyHeader>
        <Button size="sm" variant="outline" onClick={state.refresh}>
          Try again
        </Button>
      </Empty>
    );
  }
  const data = state.data;

  const connect = async (entry: ConnectorCatalogEntry) => {
    if (entry.auth !== "none" || entry.inputs.length > 0) {
      setConnecting(entry);
      return;
    }
    setBusyId(entry.id);
    const result = await connectRightAway({ environmentId, input: { catalogId: entry.id } });
    setBusyId(null);
    if (result._tag === "Success") {
      toastManager.add({ type: "success", title: `${entry.name} is connected` });
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: `Could not connect ${entry.name}`,
        description: commandErrorMessage(result, "Try again."),
      });
    }
  };

  return (
    <>
      <ConnectedSection environmentId={environmentId} connections={data.connections} />
      <LibrarySection
        environmentId={environmentId}
        state={data}
        canManage={canManage}
        busyId={busyId}
        onConnect={(entry) => void connect(entry)}
        onAddCustom={() => onAddingCustomChange(true)}
      />
      {connecting === null ? null : (
        <ConnectDialog
          environmentId={environmentId}
          entry={connecting}
          savedApps={data.ownApps}
          connections={data.connections}
          onClose={() => setConnecting(null)}
        />
      )}
      {addingCustom ? (
        <CustomConnectorDialog
          environmentId={environmentId}
          onClose={() => onAddingCustomChange(false)}
        />
      ) : null}
    </>
  );
}

function ConnectedSection({
  environmentId,
  connections,
}: {
  readonly environmentId: EnvironmentId;
  readonly connections: ReadonlyArray<ConnectionSnapshot>;
}) {
  const navigate = useNavigate();
  return (
    <section aria-labelledby="connectors-connected" className="flex flex-col gap-3">
      <h2 id="connectors-connected" className="text-sm font-semibold text-foreground">
        Connected <span className="font-normal text-muted-foreground">{connections.length}</span>
      </h2>
      {connections.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing yet. Connect a service from the library below.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-card">
          {connections.map((connection) => {
            const status = CONNECTION_STATUS[connection.status];
            const summary = connectionSummary(connection);
            return (
              <li
                key={connection.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3"
              >
                <ConnectorMark name={connection.name} />
                <span className="flex min-w-48 flex-1 flex-col gap-0.5">
                  <span className="text-sm font-medium text-foreground">{connection.name}</span>
                  {summary === "" ? null : (
                    <span className="text-xs text-muted-foreground">{summary}</span>
                  )}
                </span>
                <Badge variant={status.variant}>{status.label}</Badge>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void navigate({
                      to: "/connectors/$connectionId",
                      params: { connectionId: connection.id },
                      search: { machine: environmentId },
                    })
                  }
                >
                  Manage
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function LibrarySection({
  environmentId,
  state,
  canManage,
  busyId,
  onConnect,
  onAddCustom,
}: {
  readonly environmentId: EnvironmentId;
  readonly state: ConnectorsState;
  readonly canManage: boolean;
  readonly busyId: string | null;
  readonly onConnect: (entry: ConnectorCatalogEntry) => void;
  readonly onAddCustom: () => void;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<ConnectorCategory | null>(null);
  const categories = libraryCategories(state.catalog);
  const entries = filterLibrary(state.catalog, { query, category });
  return (
    <section aria-labelledby="connectors-library" className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="connectors-library" className="text-sm font-semibold text-foreground">
          Library
        </h2>
        <InputGroup className="sm:w-80">
          <InputGroupAddon>
            <SearchIcon aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            aria-label="Search connectors"
            placeholder="Search connectors"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </InputGroup>
      </div>
      {categories.length > 1 ? (
        <ToggleGroup
          aria-label="Categories"
          variant="default"
          className="flex-wrap"
          value={[category ?? ALL_CATEGORIES]}
          onValueChange={(next) => {
            const value = next[0];
            setCategory(
              value === undefined || value === ALL_CATEGORIES
                ? null
                : (categories.find((candidate) => candidate === value) ?? null),
            );
          }}
        >
          <Toggle value={ALL_CATEGORIES} variant="outline" size="xs">
            All
          </Toggle>
          {categories.map((value) => (
            <Toggle key={value} value={value} variant="outline" size="xs">
              {CATEGORY_LABELS[value]}
            </Toggle>
          ))}
        </ToggleGroup>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {entries.map((entry) => {
          const connection = state.connections.find(
            (candidate) => candidate.catalogId === entry.id,
          );
          return (
            <div
              key={entry.id}
              className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4"
            >
              <div className="flex items-center gap-3">
                <ConnectorMark name={entry.name} />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-medium text-foreground">{entry.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {CATEGORY_LABELS[entry.category]}
                  </span>
                </span>
              </div>
              <p className="flex-1 text-sm text-muted-foreground">{entry.description}</p>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">{connectsWithLabel(entry)}</span>
                {connection === undefined ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!canManage || busyId === entry.id}
                    onClick={() => onConnect(entry)}
                  >
                    {busyId === entry.id ? "Connecting…" : "Connect"}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void navigate({
                        to: "/connectors/$connectionId",
                        params: { connectionId: connection.id },
                        search: { machine: environmentId },
                      })
                    }
                  >
                    Manage
                  </Button>
                )}
              </div>
            </div>
          );
        })}
        {query === "" && category === null ? (
          <div className="flex flex-col gap-2.5 rounded-xl border border-dashed border-border p-4">
            <span className="text-sm font-medium text-foreground">Custom connector</span>
            <p className="flex-1 text-sm text-muted-foreground">
              Any MCP server, by its web address or a command that runs on the computer Codenine
              runs on.
            </p>
            <Button
              size="sm"
              variant="outline"
              className="self-start"
              disabled={!canManage}
              onClick={onAddCustom}
            >
              Add custom connector
            </Button>
          </div>
        ) : null}
      </div>
      {entries.length === 0 && (query !== "" || category !== null) ? (
        <p className="text-sm text-muted-foreground">No connector matches. Try another word.</p>
      ) : null}
      {canManage ? null : (
        <p className="text-xs text-muted-foreground">
          This connection can see connectors but cannot add or change them.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Agents choose which connectors they use. In a chat, turn connectors on from the + menu next
        to the message box. Not here yet: Figma, Asana, HubSpot, Vercel and Microsoft 365, which
        only accept apps they have approved.
      </p>
    </section>
  );
}
