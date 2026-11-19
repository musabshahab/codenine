import type { ConnectionId } from "@codenine/contracts";
import {
  type AuthProvider,
  type CallToolResult,
  Client,
  type JsonSchemaValidator,
  type jsonSchemaValidator,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type Tool,
  type Transport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import * as HostProcess from "@codenine/shared/HostProcess";
import * as KeyedLock from "@codenine/shared/KeyedLock";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import packageJson from "../../package.json" with { type: "json" };
import {
  connectionAuthKind,
  type ResolvedServer,
  resolveServer,
  serverLocation,
} from "./connectionServer.ts";
import { ConnectorFetch } from "./ConnectorFetch.ts";
import * as ConnectorSignIn from "./ConnectorSignIn.ts";
import * as ConnectorStore from "./ConnectorStore.ts";

/**
 * `rejected` is a pasted token the service turned down; `needs-sign-in` is a lost sign-in;
 * `refused` is a working service turning one call down, such as for a missing argument.
 */
export class ConnectorCallError extends Schema.TaggedError<ConnectorCallError>()(
  "ConnectorCallError",
  {
    kind: Schema.Literals([
      "needs-sign-in",
      "rejected",
      "unreachable",
      "program-missing",
      "refused",
      "failed",
    ]),
    /** Plain words for the user and the agent; only `refused` quotes what the service said. */
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const IDLE_CLOSE_AFTER = Duration.minutes(10);
const IDLE_SWEEP_EVERY = Duration.minutes(1);
const LIST_TIMEOUT_MS = 60_000;
const CALL_TIMEOUT_MS = 15 * 60_000;
const REFUSAL_MAX_LENGTH = 500;
const MAX_TOOL_PAGES = 20;

/** Programs a local connector starts still need the network settings to download and connect. */
const NETWORK_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
];

// Results pass through to the agent as the service sent them; its provider checks them.
const passThroughValidator: jsonSchemaValidator = {
  getValidator<T>(): JsonSchemaValidator<T> {
    return (input) => ({ valid: true, data: input as T, errorMessage: undefined });
  },
};

/** The SDK failed; `callError` turns the cause into words before anything is shown. */
class UpstreamError extends Schema.TaggedError<UpstreamError>()("UpstreamError", {
  cause: Schema.Defect(),
}) {}

/** Servers from before Streamable HTTP answer its POST with 404 or 405. */
const isLegacyServer = (error: UpstreamError) =>
  error.cause instanceof SdkHttpError && (error.cause.status === 404 || error.cause.status === 405);

const serverSignature = (server: ResolvedServer, authKind: string, token: string | undefined) =>
  [
    authKind,
    token ?? "",
    ...(server.type === "http"
      ? [server.url]
      : [
          server.command,
          ...server.args,
          ...Object.entries(server.env).map(([key, value]) => `${key}=${value}`),
        ]),
  ].join("\u0000");

interface LiveClient {
  readonly client: Client;
  readonly server: ResolvedServer;
  readonly authKind: string;
  readonly signature: string;
  readonly lastUsedAt: Ref.Ref<number>;
  /** Requests still waiting for an answer; the idle sweep leaves such a client open. */
  readonly inFlight: Ref.Ref<number>;
  /** Credential failures happen inside the SDK's callbacks; the last one explains a failure. */
  readonly credentials: { last: ConnectorSignIn.ConnectorCredentialError | undefined };
}

const errorCode = (cause: unknown): string | undefined => {
  let current: unknown = cause;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const code = (current as NodeJS.ErrnoException).code;
    if (typeof code === "string") return code;
    current = current.cause;
  }
  return undefined;
};

const NETWORK_CODES = new Set([
  "ENOTFOUND",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** Plain words for a failed connection or call. */
const callError = (input: {
  readonly cause: unknown;
  readonly server: ResolvedServer;
  readonly authKind: string;
  readonly credential: ConnectorSignIn.ConnectorCredentialError | undefined;
}): ConnectorCallError => {
  const { cause, server } = input;
  const where = serverLocation(server);
  if (input.credential !== undefined) {
    return new ConnectorCallError({
      kind: input.credential.kind === "needs-sign-in" ? "needs-sign-in" : "unreachable",
      detail: input.credential.message,
      cause,
    });
  }
  const unauthorized =
    cause instanceof UnauthorizedError ||
    (cause instanceof SdkHttpError && (cause.status === 401 || cause.status === 403));
  if (unauthorized) {
    return input.authKind === "token"
      ? new ConnectorCallError({
          kind: "rejected",
          detail: "The service turned down the saved token. Paste a new one.",
          cause,
        })
      : input.authKind === "none"
        ? new ConnectorCallError({
            kind: "failed",
            detail: `${where} asks for a sign-in this connector does not have.`,
            cause,
          })
        : new ConnectorCallError({
            kind: "needs-sign-in",
            detail: "Sign in again to keep using it.",
            cause,
          });
  }
  const code = errorCode(cause);
  if (server.type === "stdio" && code === "ENOENT") {
    return new ConnectorCallError({
      kind: "program-missing",
      detail:
        server.command === "uvx"
          ? "uv is not installed on this computer. Install it, then try again."
          : server.command === "npx"
            ? "Node.js is not installed on this computer. Install it, then try again."
            : `${server.command} is not installed on this computer.`,
      cause,
    });
  }
  if ((code !== undefined && NETWORK_CODES.has(code)) || cause instanceof TypeError) {
    return new ConnectorCallError({
      kind: "unreachable",
      detail: `Codenine could not reach ${where}.`,
      cause,
    });
  }
  if (cause instanceof SdkError && cause.code === SdkErrorCode.RequestTimeout) {
    return new ConnectorCallError({
      kind: "unreachable",
      detail: `${where} took too long to answer.`,
      cause,
    });
  }
  if (cause instanceof SdkError && cause.code === SdkErrorCode.ConnectionClosed) {
    return new ConnectorCallError({
      kind: "unreachable",
      detail:
        server.type === "stdio"
          ? `${where} stopped before it answered.`
          : `${where} closed the connection.`,
      cause,
    });
  }
  if (cause instanceof ProtocolError) {
    // The agent needs the service's words to correct the call, as it gets them for a tool error.
    return new ConnectorCallError({
      kind: "refused",
      detail: `${where} turned the call down: ${cause.message.slice(0, REFUSAL_MAX_LENGTH)}`,
      cause,
    });
  }
  return new ConnectorCallError({
    kind: "failed",
    detail: `${where} could not be used.`,
    cause,
  });
};

/** Keeps what Codenine passes on, dropping values a service sent as null. */
const toUpstreamTool = (tool: Tool): ConnectorStore.UpstreamTool => {
  const annotations = tool.annotations;
  const hints =
    annotations === undefined || annotations === null
      ? undefined
      : {
          ...(typeof annotations.title === "string" ? { title: annotations.title } : {}),
          ...(typeof annotations.readOnlyHint === "boolean"
            ? { readOnlyHint: annotations.readOnlyHint }
            : {}),
          ...(typeof annotations.destructiveHint === "boolean"
            ? { destructiveHint: annotations.destructiveHint }
            : {}),
          ...(typeof annotations.idempotentHint === "boolean"
            ? { idempotentHint: annotations.idempotentHint }
            : {}),
          ...(typeof annotations.openWorldHint === "boolean"
            ? { openWorldHint: annotations.openWorldHint }
            : {}),
        };
  return {
    name: tool.name,
    ...(typeof tool.title === "string" ? { title: tool.title } : {}),
    ...(typeof tool.description === "string" ? { description: tool.description } : {}),
    inputSchema: { ...tool.inputSchema },
    ...(tool.outputSchema === undefined || tool.outputSchema === null
      ? {}
      : { outputSchema: { ...tool.outputSchema } }),
    ...(hints === undefined ? {} : { annotations: hints }),
  };
};

export class ConnectorClients extends Context.Service<
  ConnectorClients,
  {
    /** Lists the service's tools live and saves them as the connection's cached list. */
    readonly listTools: (
      connection: ConnectorStore.StoredConnection,
    ) => Effect.Effect<
      ReadonlyArray<ConnectorStore.UpstreamTool>,
      ConnectorCallError | ConnectorStore.ConnectorStoreError
    >;
    readonly callTool: (input: {
      readonly connection: ConnectorStore.StoredConnection;
      readonly name: string;
      readonly arguments: Readonly<Record<string, unknown>>;
    }) => Effect.Effect<CallToolResult, ConnectorCallError | ConnectorStore.ConnectorStoreError>;
    /** Stops the connection's live client, such as after its settings changed. */
    readonly close: (connectionId: ConnectionId) => Effect.Effect<void>;
  }
>()("codenine/connectors/ConnectorClients") {}

const make = Effect.gen(function* () {
  const store = yield* ConnectorStore.ConnectorStore;
  const signIn = yield* ConnectorSignIn.ConnectorSignIn;
  const live = yield* Ref.make<ReadonlyMap<ConnectionId, LiveClient>>(new Map());
  const scope = yield* Effect.scope;
  const openLock = yield* KeyedLock.make<ConnectionId>();
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());

  const closeClient = (client: LiveClient) =>
    Effect.promise(() => client.client.close().catch(() => undefined));

  const close: ConnectorClients["Service"]["close"] = Effect.fn("ConnectorClients.close")(
    function* (connectionId) {
      const removed = yield* Ref.modify(live, (current) => {
        const found = current.get(connectionId);
        if (found === undefined) return [undefined, current] as const;
        const next = new Map(current);
        next.delete(connectionId);
        return [found, next] as const;
      });
      if (removed !== undefined) yield* closeClient(removed);
    },
  );

  const open = Effect.fn("ConnectorClients.open")(function* (
    connection: ConnectorStore.StoredConnection,
  ) {
    const secrets = yield* store.readSecrets(connection.id);
    const server = resolveServer(connection, secrets);
    const authKind = connectionAuthKind(connection);
    if (server === undefined) {
      return yield* new ConnectorCallError({
        kind: "failed",
        detail: "This connector's server is not set up.",
      });
    }
    const signature = serverSignature(server, authKind, secrets.token);
    const existing = (yield* Ref.get(live)).get(connection.id);
    if (existing !== undefined && existing.signature === signature) return existing;
    if (existing !== undefined) yield* close(connection.id);

    const credentials: LiveClient["credentials"] = { last: undefined };
    const token = (renew: boolean) =>
      runPromise(
        signIn.accessToken(connection.id, { renew }).pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              credentials.last = error._tag === "ConnectorCredentialError" ? error : undefined;
            }),
          ),
        ),
      );
    const authProvider: AuthProvider | undefined =
      authKind === "token" && secrets.token !== undefined
        ? { token: () => Promise.resolve(secrets.token) }
        : authKind === "sign-in" || authKind === "own-app"
          ? {
              token: () => token(false),
              onUnauthorized: () => token(true).then(() => undefined),
            }
          : undefined;
    const fetchFn = yield* ConnectorFetch;
    const environment = yield* HostProcess.Environment;
    // A program writes beside itself, such as the Browser's snapshots, so keep it out of the server's folder.
    const workFolder =
      server.type === "stdio" ? yield* store.workDirectory(connection.id) : undefined;
    const client = new Client(
      { name: "Codenine", version: packageJson.version },
      { capabilities: {}, jsonSchemaValidator: passThroughValidator },
    );
    const connect = (transport: Transport) =>
      Effect.suspend(() => {
        const connecting = client.connect(transport);
        return Effect.tryPromise({
          try: () => connecting,
          catch: (cause) => new UpstreamError({ cause }),
        }).pipe(
          // An interrupt does not stop the connect, which may still start a local program.
          Effect.onInterrupt(() =>
            Effect.promise(() =>
              connecting.then(
                () => client.close(),
                () => undefined,
              ),
            ).pipe(Effect.ignore, Effect.forkIn(scope)),
          ),
        );
      });
    const transportFor = (kind: "streamable" | "sse"): Transport => {
      if (server.type === "stdio") {
        return new StdioClientTransport({
          command: server.command,
          args: [...server.args],
          ...(workFolder === undefined ? {} : { cwd: workFolder }),
          env: {
            ...Object.fromEntries(
              NETWORK_ENV_KEYS.flatMap((key) => {
                const value = environment[key];
                return value === undefined ? [] : [[key, value] as const];
              }),
            ),
            ...server.env,
          },
          // Its messages can carry secrets such as a database address.
          stderr: "ignore",
        });
      }
      const url = new URL(server.url);
      const options = { ...(authProvider === undefined ? {} : { authProvider }), fetch: fetchFn };
      return kind === "sse"
        ? new SSEClientTransport(url, options)
        : new StreamableHTTPClientTransport(url, options);
    };
    yield* connect(transportFor("streamable")).pipe(
      Effect.catchIf(
        (error) => server.type === "http" && connection.custom !== null && isLegacyServer(error),
        () => connect(transportFor("sse")),
      ),
      Effect.tapError((error) =>
        Effect.logWarning("connector could not connect", {
          connectionId: connection.id,
          location: serverLocation(server),
          cause: error.cause,
        }),
      ),
      Effect.mapError((error) =>
        callError({ cause: error.cause, server, authKind, credential: credentials.last }),
      ),
    );
    const liveClient: LiveClient = {
      client,
      server,
      authKind,
      signature,
      lastUsedAt: yield* Ref.make(yield* Clock.currentTimeMillis),
      inFlight: yield* Ref.make(0),
      credentials,
    };
    yield* Ref.update(live, (current) => new Map(current).set(connection.id, liveClient));
    return liveClient;
  });

  /** Runs one request on the connection's client, opening it first when needed. */
  const withClient = Effect.fn("ConnectorClients.withClient")(function* <A>(
    connection: ConnectorStore.StoredConnection,
    request: (client: Client) => Promise<A>,
  ) {
    const opened = yield* openLock.withLock(connection.id, open(connection));
    opened.credentials.last = undefined;
    yield* Ref.set(opened.lastUsedAt, yield* Clock.currentTimeMillis);
    yield* Ref.update(opened.inFlight, (count) => count + 1);
    return yield* Effect.tryPromise({
      try: () => request(opened.client),
      catch: (cause) =>
        callError({
          cause,
          server: opened.server,
          authKind: opened.authKind,
          credential: opened.credentials.last,
        }),
    }).pipe(
      Effect.tapError((error) =>
        // A dead connection is reopened by the next request.
        error.kind === "failed" || error.kind === "refused" ? Effect.void : close(connection.id),
      ),
      Effect.ensuring(
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) => Ref.set(opened.lastUsedAt, now)),
          Effect.andThen(Ref.update(opened.inFlight, (count) => count - 1)),
        ),
      ),
    );
  });

  const listTools: ConnectorClients["Service"]["listTools"] = Effect.fn(
    "ConnectorClients.listTools",
  )(function* (connection) {
    const tools = yield* withClient(connection, async (client) => {
      const listed: Array<Tool> = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
        const result = await client.listTools(cursor === undefined ? {} : { cursor }, {
          timeout: LIST_TIMEOUT_MS,
        });
        listed.push(...result.tools);
        cursor = result.nextCursor ?? undefined;
        if (cursor === undefined) break;
      }
      return listed.map(toUpstreamTool);
    });
    yield* store.writeTools(connection.id, tools);
    return tools;
  });

  const callTool: ConnectorClients["Service"]["callTool"] = Effect.fn("ConnectorClients.callTool")(
    function* (input) {
      const reconnecting = !(yield* Ref.get(live)).has(input.connection.id);
      const result = yield* withClient(input.connection, (client) =>
        client.callTool(
          { name: input.name, arguments: { ...input.arguments } },
          { timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true },
        ),
      );
      // The saved list can be older than the service; refresh it whenever a connection reopens.
      if (reconnecting) {
        yield* listTools(input.connection).pipe(Effect.ignore, Effect.forkIn(scope));
      }
      return result;
    },
  );

  const closeIdle = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    for (const [connectionId, client] of yield* Ref.get(live)) {
      // A call may run longer than the idle time; closing under it would report it as stopped.
      if ((yield* Ref.get(client.inFlight)) > 0) continue;
      if (now - (yield* Ref.get(client.lastUsedAt)) >= Duration.toMillis(IDLE_CLOSE_AFTER)) {
        yield* close(connectionId);
      }
    }
  });
  yield* Effect.sleep(IDLE_SWEEP_EVERY).pipe(
    Effect.andThen(closeIdle),
    Effect.forever,
    Effect.forkScoped,
  );
  // Programs Codenine started stop with it.
  yield* Effect.addFinalizer(() =>
    Ref.getAndSet(live, new Map()).pipe(
      Effect.flatMap((current) =>
        Effect.forEach(current.values(), closeClient, { concurrency: "unbounded", discard: true }),
      ),
    ),
  );

  return ConnectorClients.of({ listTools, callTool, close });
});

export const layer = Layer.effect(ConnectorClients, make);
