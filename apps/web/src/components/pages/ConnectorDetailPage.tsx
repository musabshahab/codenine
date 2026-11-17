import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@codenine/client-runtime/environment";
import { isAtomCommandInterrupted, settlePromise } from "@codenine/client-runtime/state/runtime";
import type { ConnectionId, ConnectionSnapshot, EnvironmentId } from "@codenine/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { usePrimarySettings } from "../../hooks/useSettings";
import { commandErrorMessage } from "../../lib/commandError";
import { ensureLocalApi } from "../../localApi";
import { connectorsEnvironment } from "../../state/connectors";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatDayAwareTimestamp } from "../../timestampFormat";
import { ConnectorActions } from "../connectors/ConnectorActions";
import { ConnectorMark } from "../connectors/ConnectorMark";
import {
  ACTIVITY_OUTCOME_LABELS,
  CONNECTION_STATUS,
  connectionSummary,
  webPageUrl,
} from "../connectors/connectors.logic";
import {
  reserveSignInTab,
  SignInAddressWarning,
  useSignInReturnOrigin,
} from "../connectors/signIn";
import { useAccessEnvironment } from "../settings/useAccessEnvironment";
import { Badge } from "../ui/badge";
import { Button, InlineButton } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { WorkspacePage } from "./WorkspacePage";

/** One connection: what it can do, where it is used, and what agents did with it. */
export function ConnectorDetailPage(props: {
  /** Null when the address names no valid connector. */
  readonly connectionId: ConnectionId | null;
  readonly machine: EnvironmentId | null;
  readonly signedIn: boolean;
}) {
  const { environment } = useAccessEnvironment(props.machine);
  const environmentId = environment?.environmentId ?? null;
  const connected = environment?.connection.phase === "connected";
  const state = useEnvironmentQuery(
    environmentId !== null && connected
      ? connectorsEnvironment.state({ environmentId, input: {} })
      : null,
  );
  const connection =
    state.data?.connections.find((candidate) => candidate.id === props.connectionId) ?? null;
  useSignedInNotice(connection, props);

  const breadcrumb = (
    <span className="flex min-w-0 items-center gap-1">
      <Link
        to="/connectors"
        search={props.machine === null ? {} : { machine: props.machine }}
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        Connectors
      </Link>
      <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{connection?.name ?? "Connector"}</span>
    </span>
  );
  return (
    <WorkspacePage area="connector" title={breadcrumb}>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6">
        {environmentId === null || !connected ? (
          <p className="text-sm text-muted-foreground">
            Connect the computer this connector is on to manage it.
          </p>
        ) : connection === null ? (
          state.data === null && state.error === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>This connector is not here</EmptyTitle>
                <EmptyDescription>
                  {state.error ?? "It may have been disconnected, or it is on another computer."}
                </EmptyDescription>
              </EmptyHeader>
              <Button
                size="sm"
                variant="outline"
                render={<Link to="/connectors" search={{ machine: environmentId }} />}
              >
                All connectors
              </Button>
            </Empty>
          )
        ) : (
          <ConnectionDetail
            key={connection.id}
            environmentId={environmentId}
            connection={connection}
          />
        )}
      </div>
    </WorkspacePage>
  );
}

/** A sign-in that finished comes back as `?signedIn=1`; say so once and clear it. */
function useSignedInNotice(
  connection: Pick<ConnectionSnapshot, "id" | "name"> | null,
  { machine, signedIn }: { readonly machine: EnvironmentId | null; readonly signedIn: boolean },
) {
  const navigate = useNavigate();
  const shown = useRef(false);
  const connectionId = connection?.id ?? null;
  const name = connection?.name ?? null;
  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- reports the sign-in result the server put in the address, once, then removes it from the address
  useEffect(() => {
    if (!signedIn || connectionId === null || name === null || shown.current) return;
    shown.current = true;
    toastManager.add({ type: "success", title: `Signed in to ${name}` });
    void navigate({
      to: "/connectors/$connectionId",
      params: { connectionId },
      search: machine === null ? {} : { machine },
      replace: true,
    });
  }, [connectionId, machine, name, navigate, signedIn]);
}

function ConnectionDetail({
  environmentId,
  connection,
}: {
  readonly environmentId: EnvironmentId;
  readonly connection: ConnectionSnapshot;
}) {
  const navigate = useNavigate();
  const switchId = useId();
  const canManage = useAtomValue(connectorsEnvironment.update.permissionAtom(environmentId));
  const returnOrigin = useSignInReturnOrigin(environmentId);
  const test = useAtomCommand(connectorsEnvironment.test, { reportFailure: false });
  const signIn = useAtomCommand(connectorsEnvironment.signIn, { reportFailure: false });
  const update = useAtomCommand(connectorsEnvironment.update, { reportFailure: false });
  const disconnect = useAtomCommand(connectorsEnvironment.disconnect, { reportFailure: false });
  const [busy, setBusy] = useState<"test" | "sign-in" | "disconnect" | null>(null);
  const [onByDefault, setOnByDefault] = useState<boolean | null>(null);
  const status = CONNECTION_STATUS[connection.status];
  const summary = connectionSummary(connection);
  const input = { connectionId: connection.id };

  const runTest = async () => {
    setBusy("test");
    const result = await test({ environmentId, input });
    setBusy(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: `Could not reach ${connection.name}`,
          description: commandErrorMessage(result, "Try again."),
        });
      }
      return;
    }
    const { ok, toolCount, detail } = result.value;
    toastManager.add({
      type: ok ? "success" : "error",
      title: ok ? `${connection.name} works` : `${connection.name} did not answer as expected`,
      description:
        detail ??
        (toolCount === null ? undefined : `${toolCount} ${toolCount === 1 ? "action" : "actions"}`),
    });
  };

  const runSignIn = async () => {
    if (returnOrigin === null) return;
    setBusy("sign-in");
    const tab = reserveSignInTab();
    const result = await signIn({
      environmentId,
      input: { ...input, redirectOrigin: returnOrigin },
    });
    setBusy(null);
    if (result._tag === "Failure") {
      tab.cancel();
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: `Could not start signing in to ${connection.name}`,
          description: commandErrorMessage(result, "Try again."),
        });
      }
      return;
    }
    const authorizeUrl = webPageUrl(result.value.authorizeUrl);
    if (authorizeUrl === null) {
      tab.cancel();
      toastManager.add({
        type: "error",
        title: `${connection.name} gave a sign-in address that is not a web page`,
      });
      return;
    }
    if (!(await tab.open(authorizeUrl))) {
      toastManager.add({
        type: "warning",
        title: "The sign-in page did not open",
        description: "Allow pop-ups for Codenine, then try again.",
      });
    }
  };

  const runDisconnect = async () => {
    const confirmed = await settlePromise(() =>
      ensureLocalApi().dialogs.confirm(
        `Disconnect ${connection.name}?\nIts saved sign-in and activity are removed, and chats stop using it.`,
        { variant: "destructive" },
      ),
    );
    if (confirmed._tag !== "Success" || !confirmed.value) return;
    setBusy("disconnect");
    const result = await disconnect({ environmentId, input });
    setBusy(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: `Could not disconnect ${connection.name}`,
          description: commandErrorMessage(result, "Try again."),
        });
      }
      return;
    }
    toastManager.add({ type: "success", title: `${connection.name} is disconnected` });
    void navigate({ to: "/connectors", search: { machine: environmentId } });
  };

  const changeOnByDefault = async (next: boolean) => {
    setOnByDefault(next);
    const result = await update({ environmentId, input: { ...input, onByDefault: next } });
    setOnByDefault(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: "Could not change where it's used",
        description: commandErrorMessage(result, "Try again."),
      });
    }
  };

  return (
    <>
      <header className="flex flex-wrap items-center gap-4">
        <ConnectorMark name={connection.name} size="lg" />
        <div className="flex min-w-60 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-2xl font-semibold text-foreground">{connection.name}</h2>
            <Badge variant={status.variant}>{status.label}</Badge>
          </div>
          {summary === "" ? null : <p className="text-sm text-muted-foreground">{summary}</p>}
          {connection.address === null ? null : (
            <p className="font-mono text-xs break-all text-muted-foreground">
              {connection.address}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {connection.status === "needs-sign-in" ? (
            <Button
              size="sm"
              disabled={!canManage || busy !== null || returnOrigin === null}
              onClick={() => void runSignIn()}
            >
              {busy === "sign-in" ? "Opening…" : "Sign in again"}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={!canManage || busy !== null}
            onClick={() => void runTest()}
          >
            {busy === "test" ? "Testing…" : "Test connection"}
          </Button>
          <Button
            size="sm"
            variant="destructive-outline"
            disabled={!canManage || busy !== null}
            onClick={() => void runDisconnect()}
          >
            Disconnect
          </Button>
        </div>
      </header>
      {connection.status === "needs-sign-in" ? (
        <SignInAddressWarning returnOrigin={returnOrigin} service={connection.name} />
      ) : null}

      <ConnectorActions
        environmentId={environmentId}
        connection={connection}
        canManage={canManage}
      />

      <section aria-labelledby="connector-use" className="flex flex-col gap-3">
        <h2 id="connector-use" className="text-base font-semibold text-foreground">
          Where it's used
        </h2>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3.5">
          <span className="flex min-w-60 flex-1 flex-col gap-0.5">
            <label htmlFor={switchId} className="text-sm text-foreground">
              On by default in chats
            </label>
            <span className="text-xs text-muted-foreground">
              Chats that haven't picked their own connectors use it. Any chat can turn it on or off
              from the + menu.
            </span>
          </span>
          <Switch
            id={switchId}
            checked={onByDefault ?? connection.onByDefault}
            disabled={!canManage || onByDefault !== null}
            onCheckedChange={(checked) => void changeOnByDefault(checked)}
          />
        </div>
      </section>

      <ConnectorActivity environmentId={environmentId} connectionId={connection.id} />
    </>
  );
}

function ConnectorActivity({
  environmentId,
  connectionId,
}: {
  readonly environmentId: EnvironmentId;
  readonly connectionId: ConnectionId;
}) {
  const navigate = useNavigate();
  const activity = useEnvironmentQuery(
    connectorsEnvironment.activity({ environmentId, input: { connectionId, limit: 20 } }),
  );
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const nowMs = Date.parse(`${useNowMinute()}Z`);
  const entries = activity.data?.entries ?? [];
  return (
    <section aria-labelledby="connector-activity" className="flex flex-col gap-3">
      <h2 id="connector-activity" className="text-base font-semibold text-foreground">
        Recent activity
      </h2>
      {activity.data === null ? (
        <p className="text-sm text-muted-foreground">{activity.error ?? "Loading activity…"}</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No agent has used it yet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-card">
          {entries.map((entry) => (
            <li
              key={`${entry.at}:${entry.tool}:${entry.summary}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3"
            >
              <span className="flex min-w-60 flex-1 flex-col gap-0.5">
                <span className="text-sm text-foreground">{entry.summary}</span>
                {entry.threadId === null ? null : (
                  <span className="text-xs">
                    <InlineButton
                      tone="muted"
                      onClick={() => {
                        if (entry.threadId === null) return;
                        void navigate({
                          to: "/$environmentId/$threadId",
                          params: buildThreadRouteParams(
                            scopeThreadRef(environmentId, entry.threadId),
                          ),
                        });
                      }}
                    >
                      Chat: {entry.threadTitle ?? "Untitled"}
                    </InlineButton>
                  </span>
                )}
              </span>
              <span className="text-xs text-muted-foreground">
                {ACTIVITY_OUTCOME_LABELS[entry.outcome]}
              </span>
              <span className="min-w-20 text-right text-xs text-muted-foreground tabular-nums">
                {formatDayAwareTimestamp(entry.at, timestampFormat, nowMs)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
