import {
  type ConnectionId,
  type ConnectionSnapshot,
  type ConnectionStatus,
  type ConnectorActivityEntry,
  type ConnectorConnectInput,
  type ConnectorConnectResult,
  ConnectorError,
  type ConnectorOwnApp,
  type ConnectorsState,
  type ConnectorTestResult,
  type ConnectorTool,
  type ConnectorUpdateInput,
  DEFAULT_CONNECTOR_APPROVALS,
} from "@codenine/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { type CatalogConnector, CONNECTOR_CATALOG, catalogConnector } from "./catalog.ts";
import { codenineTools, gitHubLogin, idTokenEmail } from "./codenineTools.ts";
import { connectionAuthKind, connectionCatalog } from "./connectionServer.ts";
import { toolApproval, toolRisk } from "./ConnectorApprovals.ts";
import * as ConnectorClients from "./ConnectorClients.ts";
import { ConnectorFetch } from "./ConnectorFetch.ts";
import * as ConnectorSignIn from "./ConnectorSignIn.ts";
import * as ConnectorStore from "./ConnectorStore.ts";

const OWN_APPS: ReadonlyArray<ConnectorOwnApp> = ["google", "slack"];
const DEFAULT_ACTIVITY_LIMIT = 50;

/** Passes on what can be shown; a store failure becomes a plain message. */
const fromStoreError = (error: ConnectorStore.ConnectorStoreError) =>
  new ConnectorError({ reason: "failed", detail: error.message });

const fromCallError = (error: ConnectorClients.ConnectorCallError) =>
  new ConnectorError({
    reason:
      error.kind === "needs-sign-in" || error.kind === "rejected"
        ? "sign-in-failed"
        : error.kind === "failed"
          ? "failed"
          : "unreachable",
    detail: error.detail,
  });

const notFound = (connectionId: string) =>
  new ConnectorError({
    reason: "not-found",
    detail: `There is no connector called ${connectionId}.`,
  });

const invalid = (detail: string) => new ConnectorError({ reason: "invalid", detail });

/** The library's own tools plus the ones Codenine adds, with how each one is approved. */
const describeTools = (input: {
  readonly connection: ConnectorStore.StoredConnection;
  readonly catalog: CatalogConnector | undefined;
  readonly upstream: ReadonlyArray<ConnectorStore.UpstreamTool>;
}): ReadonlyArray<ConnectorTool> => {
  const extras = codenineTools(input.catalog?.codenineTools);
  const extraNames = new Set(extras.map((tool) => tool.name));
  return [...input.upstream.filter((tool) => !extraNames.has(tool.name)), ...extras]
    .filter((tool) => tool.name.trim().length > 0)
    .map((tool) => {
      const risk = toolRisk(tool, input.catalog?.risks);
      return {
        name: tool.name,
        title: tool.title ?? tool.annotations?.title ?? null,
        description: tool.description ?? "",
        risk,
        approval: toolApproval({
          tool: tool.name,
          risk,
          approvals: input.connection.approvals,
          toolApprovals: input.connection.toolApprovals,
        }).mode,
        overridden: input.connection.toolApprovals[tool.name] !== undefined,
        providedByCodenine: extraNames.has(tool.name),
      };
    });
};

export class Connectors extends Context.Service<
  Connectors,
  {
    readonly state: Effect.Effect<ConnectorsState, ConnectorError>;
    /** The current state, then again after every change. */
    readonly stateChanges: Stream.Stream<ConnectorsState, ConnectorError>;
    readonly connect: (
      input: ConnectorConnectInput,
    ) => Effect.Effect<ConnectorConnectResult, ConnectorError>;
    readonly signIn: (input: {
      readonly connectionId: ConnectionId;
      readonly redirectOrigin: string;
    }) => Effect.Effect<{ readonly authorizeUrl: string }, ConnectorError>;
    /** Completes a sign-in the service sent the browser back from. */
    readonly finishSignIn: (
      callback: ConnectorSignIn.SignInCallback,
    ) => Effect.Effect<ConnectionId, ConnectorError>;
    readonly update: (input: ConnectorUpdateInput) => Effect.Effect<void, ConnectorError>;
    readonly disconnect: (connectionId: ConnectionId) => Effect.Effect<void, ConnectorError>;
    readonly test: (
      connectionId: ConnectionId,
    ) => Effect.Effect<ConnectorTestResult, ConnectorError>;
    readonly tools: (
      connectionId: ConnectionId,
    ) => Effect.Effect<{ readonly tools: ReadonlyArray<ConnectorTool> }, ConnectorError>;
    readonly activity: (input: {
      readonly connectionId: ConnectionId;
      readonly limit?: number;
    }) => Effect.Effect<
      { readonly entries: ReadonlyArray<ConnectorActivityEntry> },
      ConnectorError
    >;
    /** The service's tools, from the saved list when there is one. */
    readonly upstreamTools: (
      connection: ConnectorStore.StoredConnection,
    ) => Effect.Effect<
      ReadonlyArray<ConnectorStore.UpstreamTool>,
      ConnectorClients.ConnectorCallError | ConnectorStore.ConnectorStoreError
    >;
    /** Records how a call went for the connection's status. */
    readonly noteCallFailure: (
      connectionId: ConnectionId,
      error: ConnectorClients.ConnectorCallError,
    ) => Effect.Effect<void>;
  }
>()("codenine/connectors/Connectors") {}

const make = Effect.gen(function* () {
  const store = yield* ConnectorStore.ConnectorStore;
  const signIn = yield* ConnectorSignIn.ConnectorSignIn;
  const clients = yield* ConnectorClients.ConnectorClients;
  const scope = yield* Effect.scope;

  const requireConnection = (connectionId: ConnectionId) =>
    store.get(connectionId).pipe(
      Effect.mapError(fromStoreError),
      Effect.filterOrFail(
        (connection): connection is ConnectorStore.StoredConnection => connection !== undefined,
        () => notFound(connectionId),
      ),
    );

  const statusOf = Effect.fn("Connectors.statusOf")(function* (
    connection: ConnectorStore.StoredConnection,
  ) {
    const authKind = connectionAuthKind(connection);
    const runtime = yield* store.runtime(connection.id);
    const status = (value: ConnectionStatus, detail: string | null) => ({ value, detail });
    if (runtime?.phase === "checking") return status("connecting", "Checking the connection.");
    if (!(yield* store.isReady(connection))) {
      if (authKind === "sign-in" || authKind === "own-app") {
        return (yield* signIn.isPending(connection.id))
          ? status("connecting", "Waiting for you to finish signing in.")
          : status("needs-sign-in", "Sign in to use it.");
      }
      if (authKind === "token") return status("needs-sign-in", "Paste a token to use it.");
      const missing = connectionCatalog(connection)?.entry.inputs.find((input) => input.required);
      return status("error", `Fill in ${missing?.label ?? "its settings"} to use it.`);
    }
    if (runtime?.phase === "rejected") return status("needs-sign-in", runtime.detail);
    if (runtime?.phase === "error") return status("error", runtime.detail);
    return status("connected", null);
  });

  const snapshot = Effect.fn("Connectors.snapshot")(function* (
    connection: ConnectorStore.StoredConnection,
  ) {
    const catalog = connectionCatalog(connection);
    const secrets = yield* store.readSecrets(connection.id);
    const tools = yield* store.readTools(connection.id);
    const status = yield* statusOf(connection);
    const custom = connection.custom?.transport;
    return {
      id: connection.id,
      catalogId: connection.catalogId,
      name: connection.name,
      description: catalog?.entry.description ?? "",
      category: catalog?.entry.category ?? "other",
      auth: connectionAuthKind(connection),
      runsLocally: catalog?.entry.runsLocally ?? custom?.type === "stdio",
      address:
        custom === undefined
          ? null
          : custom.type === "http"
            ? custom.url
            : [custom.command, ...custom.args].join(" "),
      status: status.value,
      statusDetail: status.detail,
      account: connection.account,
      onByDefault: connection.onByDefault,
      approvals: connection.approvals,
      toolCount:
        tools === undefined ? null : describeTools({ connection, catalog, upstream: tools }).length,
      inputs: connection.inputs,
      secretInputsSet: Object.keys(secrets.inputs),
      connectedAt: connection.connectedAt,
      lastUsedAt: connection.lastUsedAt,
    } satisfies ConnectionSnapshot;
  });

  const state: Connectors["Service"]["state"] = Effect.gen(function* () {
    const connections = yield* store.list;
    const ownApps: Array<ConnectorOwnApp> = [];
    for (const app of OWN_APPS) {
      if ((yield* store.readOwnApp(app)) !== undefined) ownApps.push(app);
    }
    return {
      catalog: CONNECTOR_CATALOG.map((connector) => connector.entry),
      connections: yield* Effect.forEach(connections, snapshot),
      ownApps,
    } satisfies ConnectorsState;
  }).pipe(Effect.mapError(fromStoreError), Effect.withSpan("Connectors.state"));

  const noteCallFailure: Connectors["Service"]["noteCallFailure"] = (connectionId, error) =>
    store.setRuntime(
      connectionId,
      error.kind === "needs-sign-in" || error.kind === "rejected"
        ? { phase: "rejected", detail: error.detail }
        : { phase: "error", detail: error.detail },
    );

  const lookUpAccount = Effect.fn("Connectors.lookUpAccount")(function* (
    connection: ConnectorStore.StoredConnection,
  ) {
    const source = connectionCatalog(connection)?.account;
    if (source === "google-id-token") {
      return idTokenEmail((yield* store.readAuth(connection.id))?.idToken);
    }
    if (source === "github-user") {
      const token = (yield* store.readSecrets(connection.id)).token;
      if (token === undefined) return null;
      return yield* gitHubLogin(yield* ConnectorFetch, token).pipe(
        Effect.orElseSucceed(() => null),
      );
    }
    return null;
  });

  /** Connects, lists the tools and notes the account; the status shows how it went. */
  const check = Effect.fn("Connectors.check")(function* (connectionId: ConnectionId) {
    const connection = yield* store.get(connectionId);
    if (connection === undefined || !(yield* store.isReady(connection))) return undefined;
    yield* store.setRuntime(connectionId, { phase: "checking" });
    const listed = yield* clients.listTools(connection).pipe(
      Effect.tapError((error) =>
        error._tag === "ConnectorCallError"
          ? noteCallFailure(connectionId, error)
          : store.setRuntime(connectionId, { phase: "error", detail: error.message }),
      ),
      Effect.tap(() => store.setRuntime(connectionId, undefined)),
      Effect.result,
    );
    if (listed._tag === "Success") {
      const account = yield* lookUpAccount(connection);
      if (account !== null && account !== connection.account) {
        yield* store.update(connectionId, (current) => ({ ...current, account }));
      }
    }
    return listed;
  });

  const checkInBackground = (connectionId: ConnectionId) =>
    check(connectionId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("connector check failed", { connectionId, error: error.message }),
      ),
      Effect.forkIn(scope),
      Effect.asVoid,
    );

  const upstreamTools: Connectors["Service"]["upstreamTools"] = Effect.fn(
    "Connectors.upstreamTools",
  )(function* (connection) {
    return (yield* store.readTools(connection.id)) ?? (yield* clients.listTools(connection));
  });

  const connect: Connectors["Service"]["connect"] = Effect.fn("Connectors.connect")(
    function* (input) {
      if ((input.catalogId === undefined) === (input.custom === undefined)) {
        return yield* invalid("Choose a connector from the library, or describe your own.");
      }
      const answers = Object.fromEntries(
        Object.entries(input.inputs ?? {}).map(([key, value]) => [key, value.trim()]),
      );
      const catalog = input.catalogId === undefined ? undefined : catalogConnector(input.catalogId);
      if (input.catalogId !== undefined && catalog === undefined) {
        return yield* notFound(input.catalogId);
      }
      const custom = input.custom;
      const authKind = catalog?.entry.auth ?? custom?.auth ?? "none";
      const inputs: Record<string, string> = {};
      const secretInputs: Record<string, string> = {};
      for (const field of catalog?.entry.inputs ?? []) {
        const value = answers[field.key];
        if (value === undefined || value.length === 0) {
          if (field.required) return yield* invalid(`${field.label} is needed.`);
          continue;
        }
        (field.secret ? secretInputs : inputs)[field.key] = value;
      }
      const token = answers["token"];
      if (authKind === "token" && (token === undefined || token.length === 0)) {
        return yield* invalid(`${catalog?.entry.tokenLabel ?? "A token"} is needed.`);
      }
      if (custom !== undefined) {
        const transport = custom.transport;
        if (transport.type === "http") {
          const parsed = URL.canParse(transport.url) ? new URL(transport.url) : undefined;
          if (
            parsed === undefined ||
            (parsed.protocol !== "https:" && parsed.protocol !== "http:")
          ) {
            return yield* invalid("Enter the server's http or https address.");
          }
        } else if (custom.auth !== "none") {
          return yield* invalid("A program on this computer cannot sign in or use a token.");
        }
      }
      if (authKind === "sign-in" || authKind === "own-app") {
        if (input.redirectOrigin === undefined) {
          return yield* invalid("Signing in needs the address Codenine is open at.");
        }
        const redirectUri = ConnectorSignIn.connectorRedirectUri(input.redirectOrigin);
        if (typeof redirectUri !== "string") return yield* redirectUri;
      }
      const ownApp = catalog?.entry.ownApp;
      if (authKind === "own-app" && ownApp !== undefined) {
        if (input.ownApp !== undefined) {
          yield* store
            .writeOwnApp(ownApp, {
              clientId: input.ownApp.clientId,
              clientSecret: input.ownApp.clientSecret,
            })
            .pipe(Effect.mapError(fromStoreError));
        } else if (
          (yield* store.readOwnApp(ownApp).pipe(Effect.mapError(fromStoreError))) === undefined
        ) {
          return yield* invalid(
            `Add the client ID and secret of your ${ownApp === "google" ? "Google" : "Slack"} app.`,
          );
        }
      }

      const now = DateTime.formatIso(yield* DateTime.now);
      const connection = yield* store
        .create(catalog?.entry.id ?? custom?.name ?? "connector", (id) => ({
          id,
          catalogId: catalog?.entry.id ?? null,
          custom: custom === undefined ? null : { transport: custom.transport, auth: custom.auth },
          name: catalog?.entry.name ?? custom?.name ?? id,
          onByDefault: true,
          approvals: DEFAULT_CONNECTOR_APPROVALS,
          toolApprovals: {},
          inputs,
          account: null,
          connectedAt: now,
          lastUsedAt: null,
        }))
        .pipe(Effect.mapError(fromStoreError));
      yield* store
        .writeSecrets(connection.id, {
          ...(authKind === "token" && token !== undefined ? { token } : {}),
          inputs: secretInputs,
        })
        .pipe(Effect.mapError(fromStoreError));

      if (
        (authKind === "sign-in" || authKind === "own-app") &&
        input.redirectOrigin !== undefined
      ) {
        const authorizeUrl = yield* signIn
          .start({ connection, redirectOrigin: input.redirectOrigin })
          .pipe(
            Effect.catch((error) =>
              store
                .remove(connection.id)
                .pipe(
                  Effect.ignore,
                  Effect.andThen(
                    Effect.fail(error._tag === "ConnectorError" ? error : fromStoreError(error)),
                  ),
                ),
            ),
          );
        return { connectionId: connection.id, authorizeUrl };
      }
      yield* checkInBackground(connection.id);
      return { connectionId: connection.id, authorizeUrl: null };
    },
  );

  const startSignIn: Connectors["Service"]["signIn"] = Effect.fn("Connectors.signIn")(
    function* (input) {
      const connection = yield* requireConnection(input.connectionId);
      const authorizeUrl = yield* signIn
        .start({ connection, redirectOrigin: input.redirectOrigin })
        .pipe(
          Effect.mapError((error) =>
            error._tag === "ConnectorError" ? error : fromStoreError(error),
          ),
        );
      return { authorizeUrl };
    },
  );

  const finishSignIn: Connectors["Service"]["finishSignIn"] = Effect.fn("Connectors.finishSignIn")(
    function* (callback) {
      const connectionId = yield* signIn
        .finish(callback)
        .pipe(
          Effect.mapError((error) =>
            error._tag === "ConnectorError" ? error : fromStoreError(error),
          ),
        );
      yield* store.setRuntime(connectionId, undefined);
      yield* clients.close(connectionId);
      yield* checkInBackground(connectionId);
      return connectionId;
    },
  );

  const update: Connectors["Service"]["update"] = Effect.fn("Connectors.update")(function* (input) {
    const connection = yield* requireConnection(input.connectionId);
    const catalog = connectionCatalog(connection);
    const authKind = connectionAuthKind(connection);
    const fields = new Map((catalog?.entry.inputs ?? []).map((field) => [field.key, field]));
    const secrets = yield* store.readSecrets(connection.id).pipe(Effect.mapError(fromStoreError));
    const inputs = { ...connection.inputs };
    const secretInputs = { ...secrets.inputs };
    let token = secrets.token;
    for (const [key, raw] of Object.entries(input.inputs ?? {})) {
      const value = raw.trim();
      if (key === "token" && authKind === "token") {
        if (value.length === 0) return yield* invalid("The token cannot be empty.");
        token = value;
        continue;
      }
      const field = fields.get(key);
      if (field === undefined) return yield* invalid(`${connection.name} has no setting ${key}.`);
      const target = field.secret ? secretInputs : inputs;
      if (value.length === 0) {
        if (field.required) return yield* invalid(`${field.label} is needed.`);
        delete target[key];
      } else {
        target[key] = value;
      }
    }
    yield* store
      .update(connection.id, (current) => {
        const toolApprovals = { ...current.toolApprovals };
        for (const [tool, mode] of Object.entries(input.toolApprovals ?? {})) {
          if (mode === null) delete toolApprovals[tool];
          else toolApprovals[tool] = mode;
        }
        return {
          ...current,
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.onByDefault === undefined ? {} : { onByDefault: input.onByDefault }),
          approvals: { ...current.approvals, ...input.approvals },
          toolApprovals,
          inputs,
        };
      })
      .pipe(Effect.mapError(fromStoreError));
    if (input.inputs !== undefined) {
      yield* store
        .writeSecrets(connection.id, {
          ...(token === undefined ? {} : { token }),
          inputs: secretInputs,
        })
        .pipe(Effect.mapError(fromStoreError));
      yield* store.setRuntime(connection.id, undefined);
      yield* clients.close(connection.id);
      yield* checkInBackground(connection.id);
    }
  });

  const disconnect: Connectors["Service"]["disconnect"] = Effect.fn("Connectors.disconnect")(
    function* (connectionId) {
      yield* requireConnection(connectionId);
      yield* signIn.forget(connectionId);
      yield* clients.close(connectionId);
      yield* store.remove(connectionId).pipe(Effect.mapError(fromStoreError));
    },
  );

  const test: Connectors["Service"]["test"] = Effect.fn("Connectors.test")(
    function* (connectionId) {
      const connection = yield* requireConnection(connectionId);
      yield* clients.close(connectionId);
      const status = yield* statusOf(connection).pipe(Effect.mapError(fromStoreError));
      const checked = yield* check(connectionId).pipe(Effect.mapError(fromStoreError));
      if (checked === undefined) return { ok: false, toolCount: null, detail: status.detail };
      if (checked._tag === "Failure") {
        return {
          ok: false,
          toolCount: null,
          detail:
            checked.failure._tag === "ConnectorCallError"
              ? checked.failure.detail
              : checked.failure.message,
        };
      }
      return {
        ok: true,
        toolCount: describeTools({
          connection,
          catalog: connectionCatalog(connection),
          upstream: checked.success,
        }).length,
        detail: null,
      };
    },
  );

  const tools: Connectors["Service"]["tools"] = Effect.fn("Connectors.tools")(
    function* (connectionId) {
      const connection = yield* requireConnection(connectionId);
      const upstream = yield* upstreamTools(connection).pipe(
        Effect.mapError((error) =>
          error._tag === "ConnectorCallError" ? fromCallError(error) : fromStoreError(error),
        ),
      );
      return {
        tools: describeTools({ connection, catalog: connectionCatalog(connection), upstream }),
      };
    },
  );

  const activity: Connectors["Service"]["activity"] = Effect.fn("Connectors.activity")(
    function* (input) {
      yield* requireConnection(input.connectionId);
      const entries = yield* store
        .readActivity(input.connectionId, input.limit ?? DEFAULT_ACTIVITY_LIMIT)
        .pipe(Effect.mapError(fromStoreError));
      return { entries };
    },
  );

  return Connectors.of({
    state,
    stateChanges: store.changes.pipe(Stream.mapEffect(() => state)),
    connect,
    signIn: startSignIn,
    finishSignIn,
    update,
    disconnect,
    test,
    tools,
    activity,
    upstreamTools,
    noteCallFailure,
  });
});

export const layer = Layer.effect(Connectors, make);
