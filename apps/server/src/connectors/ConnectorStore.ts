import {
  ConnectionId,
  ConnectorActivityEntry,
  ConnectorApprovalMode,
  ConnectorApprovals,
  ConnectorCatalogId,
  ConnectorOwnApp,
  ConnectorTransport,
  IsoDateTime,
  TrimmedNonEmptyString,
} from "@codenine/contracts";
import { writeFileStringAtomically } from "@codenine/shared/atomicWrite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { catalogConnector } from "./catalog.ts";

export class ConnectorStoreError extends Schema.TaggedError<ConnectorStoreError>()(
  "ConnectorStoreError",
  {
    operation: Schema.Literals(["read", "write", "secret"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.operation === "read"
      ? "Codenine could not read its saved connectors."
      : "Codenine could not save the connector.";
  }
}

export const CustomServer = Schema.Struct({
  transport: ConnectorTransport,
  auth: Schema.Literals(["none", "sign-in", "token"]),
});
export type CustomServer = typeof CustomServer.Type;

export const StoredConnection = Schema.Struct({
  id: ConnectionId,
  catalogId: Schema.NullOr(ConnectorCatalogId),
  custom: Schema.NullOr(CustomServer),
  name: TrimmedNonEmptyString,
  onByDefault: Schema.Boolean,
  approvals: ConnectorApprovals,
  /** One action's own choice, by tool name. */
  toolApprovals: Schema.Record(Schema.String, ConnectorApprovalMode),
  /** Non-secret answers to the catalogue's inputs; secret ones live in the secret store. */
  inputs: Schema.Record(Schema.String, Schema.String),
  account: Schema.NullOr(Schema.String),
  connectedAt: IsoDateTime,
  lastUsedAt: Schema.NullOr(IsoDateTime),
});
export type StoredConnection = typeof StoredConnection.Type;

const ConnectorsFile = Schema.Struct({
  version: Schema.Literal(1),
  connections: Schema.Array(StoredConnection),
});
const decodeConnectorsFile = Schema.decodeUnknownEffect(Schema.fromJsonString(ConnectorsFile));
const encodeConnectorsFile = Schema.encodeEffect(Schema.fromJsonString(ConnectorsFile));

const ToolAnnotations = Schema.Struct({
  title: Schema.optional(Schema.String),
  readOnlyHint: Schema.optional(Schema.Boolean),
  destructiveHint: Schema.optional(Schema.Boolean),
  idempotentHint: Schema.optional(Schema.Boolean),
  openWorldHint: Schema.optional(Schema.Boolean),
});

/** A tool as a service lists it, keeping only what Codenine passes on to agents. */
export const UpstreamTool = Schema.Struct({
  name: Schema.String,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  inputSchema: Schema.Record(Schema.String, Schema.Unknown),
  outputSchema: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  annotations: Schema.optional(ToolAnnotations),
});
export type UpstreamTool = typeof UpstreamTool.Type;

const ToolsFile = Schema.Struct({ version: Schema.Literal(1), tools: Schema.Array(UpstreamTool) });
const decodeToolsFile = Schema.decodeUnknownOption(Schema.fromJsonString(ToolsFile));
const encodeToolsFile = Schema.encodeEffect(Schema.fromJsonString(ToolsFile));

const decodeActivityLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(ConnectorActivityEntry),
);
const encodeActivityLine = Schema.encodeEffect(Schema.fromJsonString(ConnectorActivityEntry));

/** A signed-in connection's tokens and how to refresh them. */
export const ConnectionAuth = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.optional(Schema.String),
  /** Epoch milliseconds. */
  expiresAt: Schema.optional(Schema.Number),
  scope: Schema.optional(Schema.String),
  issuer: Schema.optional(Schema.String),
  authorizationEndpoint: Schema.String,
  tokenEndpoint: Schema.String,
  tokenEndpointAuthMethods: Schema.optional(Schema.Array(Schema.String)),
  resource: Schema.optional(Schema.String),
  client: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("registered"), key: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("own-app"), app: ConnectorOwnApp }),
  ]),
  /** Set when the service's id token names the account, such as Google's email. */
  idToken: Schema.optional(Schema.String),
});
export type ConnectionAuth = typeof ConnectionAuth.Type;

/** A pasted access token and the catalogue's secret inputs. */
export const ConnectionSecrets = Schema.Struct({
  token: Schema.optional(Schema.String),
  inputs: Schema.Record(Schema.String, Schema.String),
});
export type ConnectionSecrets = typeof ConnectionSecrets.Type;

export const OwnAppCredentials = Schema.Struct({
  clientId: Schema.String,
  clientSecret: Schema.String,
});
export type OwnAppCredentials = typeof OwnAppCredentials.Type;

/** What a service's dynamic client registration gave Codenine for one redirect address. */
export const RegisteredClient = Schema.Struct({
  clientId: Schema.String,
  clientSecret: Schema.optional(Schema.String),
  tokenEndpointAuthMethod: Schema.optional(Schema.String),
});
export type RegisteredClient = typeof RegisteredClient.Type;

/**
 * - `checking`: Codenine is connecting to it now.
 * - `rejected`: the service turned down the saved credential.
 * - `error`: the last attempt failed for another reason.
 */
export type ConnectionRuntime =
  | { readonly phase: "checking" }
  | { readonly phase: "rejected"; readonly detail: string }
  | { readonly phase: "error"; readonly detail: string };

const runtimeKey = (runtime: ConnectionRuntime | undefined) =>
  runtime === undefined
    ? ""
    : runtime.phase === "checking"
      ? runtime.phase
      : `${runtime.phase}:${runtime.detail}`;

const ACTIVITY_LIMIT = 500;
// Trim only once the log is this far over, so most appends stay appends.
const ACTIVITY_TRIM_SLACK = 100;

/** The connections a chat reaches: its own list, or the ones on by default, that can be used now. */
export const effectiveConnectionIds = (
  selection: ReadonlyArray<ConnectionId> | undefined,
  connections: ReadonlyArray<{
    readonly id: ConnectionId;
    readonly onByDefault: boolean;
    readonly ready: boolean;
  }>,
): ReadonlyArray<ConnectionId> => {
  const chosen = selection === undefined ? null : new Set(selection);
  return connections
    .filter(
      (connection) =>
        connection.ready && (chosen === null ? connection.onByDefault : chosen.has(connection.id)),
    )
    .map((connection) => connection.id);
};

export class ConnectorStore extends Context.Service<
  ConnectorStore,
  {
    readonly list: Effect.Effect<ReadonlyArray<StoredConnection>, ConnectorStoreError>;
    readonly get: (
      id: ConnectionId,
    ) => Effect.Effect<StoredConnection | undefined, ConnectorStoreError>;
    /** Adds a connection under the first free id that starts with `preferredId`. */
    readonly create: (
      preferredId: string,
      make: (id: ConnectionId) => StoredConnection,
    ) => Effect.Effect<StoredConnection, ConnectorStoreError>;
    readonly update: (
      id: ConnectionId,
      change: (connection: StoredConnection) => StoredConnection,
    ) => Effect.Effect<StoredConnection | undefined, ConnectorStoreError>;
    /** Forgets the connection with its secrets, tools and activity. */
    readonly remove: (id: ConnectionId) => Effect.Effect<void, ConnectorStoreError>;

    readonly readAuth: (
      id: ConnectionId,
    ) => Effect.Effect<ConnectionAuth | undefined, ConnectorStoreError>;
    readonly writeAuth: (
      id: ConnectionId,
      auth: ConnectionAuth | undefined,
    ) => Effect.Effect<void, ConnectorStoreError>;
    /** Where a program the connector runs works: inside its own folder, removed on disconnect. */
    readonly workDirectory: (id: ConnectionId) => Effect.Effect<string, ConnectorStoreError>;
    readonly readSecrets: (
      id: ConnectionId,
    ) => Effect.Effect<ConnectionSecrets, ConnectorStoreError>;
    readonly writeSecrets: (
      id: ConnectionId,
      secrets: ConnectionSecrets,
    ) => Effect.Effect<void, ConnectorStoreError>;
    readonly readOwnApp: (
      app: ConnectorOwnApp,
    ) => Effect.Effect<OwnAppCredentials | undefined, ConnectorStoreError>;
    readonly writeOwnApp: (
      app: ConnectorOwnApp,
      credentials: OwnAppCredentials,
    ) => Effect.Effect<void, ConnectorStoreError>;
    readonly readRegisteredClient: (
      key: string,
    ) => Effect.Effect<RegisteredClient | undefined, ConnectorStoreError>;
    readonly writeRegisteredClient: (
      key: string,
      client: RegisteredClient,
    ) => Effect.Effect<void, ConnectorStoreError>;

    readonly readTools: (
      id: ConnectionId,
    ) => Effect.Effect<ReadonlyArray<UpstreamTool> | undefined, ConnectorStoreError>;
    readonly writeTools: (
      id: ConnectionId,
      tools: ReadonlyArray<UpstreamTool>,
    ) => Effect.Effect<void, ConnectorStoreError>;

    readonly appendActivity: (
      id: ConnectionId,
      entry: ConnectorActivityEntry,
    ) => Effect.Effect<void, ConnectorStoreError>;
    /** Newest first. */
    readonly readActivity: (
      id: ConnectionId,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<ConnectorActivityEntry>, ConnectorStoreError>;

    readonly runtime: (id: ConnectionId) => Effect.Effect<ConnectionRuntime | undefined>;
    readonly setRuntime: (
      id: ConnectionId,
      runtime: ConnectionRuntime | undefined,
    ) => Effect.Effect<void>;
    /** Whether the connection holds what it needs to reach its service. */
    readonly isReady: (connection: StoredConnection) => Effect.Effect<boolean, ConnectorStoreError>;
    readonly effectiveConnectionIds: (
      selection: ReadonlyArray<ConnectionId> | undefined,
    ) => Effect.Effect<ReadonlyArray<ConnectionId>, ConnectorStoreError>;
    /** Signals once on subscribing, then after any change a connection's snapshot could show. */
    readonly changes: Stream.Stream<void>;
    readonly notifyChanged: Effect.Effect<void>;
  }
>()("codenine/connectors/ConnectorStore") {}

/** Provider MCP servers already use these names in every chat. */
const RESERVED_IDS = new Set(["codenine", "codenine-direct"]);

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");

const authSecret = (id: ConnectionId) => `connector-${id}-auth`;
const secretsSecret = (id: ConnectionId) => `connector-${id}-secrets`;
const ownAppSecret = (app: ConnectorOwnApp) => `connector-app-${app}`;
const registeredClientSecret = (key: string) => `connector-client-${key}`;

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const filePath = path.join(config.stateDir, "connectors.json");
  const connectionDirectory = (id: ConnectionId) => path.join(config.stateDir, "connectors", id);
  const writer = yield* Semaphore.make(1);
  const cached = yield* Ref.make<ReadonlyArray<StoredConnection> | undefined>(undefined);
  const runtimes = yield* Ref.make<ReadonlyMap<ConnectionId, ConnectionRuntime>>(new Map());
  // Replaying the last signal starts each subscriber with one, so nothing slips in between.
  const changed = yield* PubSub.unbounded<void>({ replay: 1 });
  const notifyChanged = PubSub.publish(changed, undefined).pipe(Effect.asVoid);
  yield* notifyChanged;
  // Appends to one activity log run one at a time so a trim never drops a line.
  const activityWriter = yield* Semaphore.make(1);
  const activityLines = yield* Ref.make<ReadonlyMap<ConnectionId, number>>(new Map());

  const storeError = (operation: ConnectorStoreError["operation"]) => (cause: unknown) =>
    new ConnectorStoreError({ operation, cause });

  const load = Effect.gen(function* () {
    const current = yield* Ref.get(cached);
    if (current !== undefined) return current;
    const exists = yield* fileSystem.exists(filePath);
    const connections = exists
      ? (yield* fileSystem.readFileString(filePath).pipe(Effect.flatMap(decodeConnectorsFile)))
          .connections
      : [];
    yield* Ref.set(cached, connections);
    return connections;
  }).pipe(Effect.mapError(storeError("read")));

  const writeAtomically = (target: string, contents: string) =>
    writeFileStringAtomically({ filePath: target, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  const persist = Effect.fn("ConnectorStore.persist")(
    function* (connections: ReadonlyArray<StoredConnection>) {
      const contents = yield* encodeConnectorsFile({ version: 1, connections });
      yield* writeAtomically(filePath, `${contents}\n`);
      yield* Ref.set(cached, connections);
    },
    Effect.mapError(storeError("write")),
  );

  const readJsonSecret = <A, I>(
    schema: Schema.Codec<A, I>,
    name: string,
  ): Effect.Effect<A | undefined, ConnectorStoreError> =>
    secretStore.get(name).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.undefined,
          onSome: (bytes) =>
            Schema.decodeEffect(Schema.fromJsonString(schema))(new TextDecoder().decode(bytes)),
        }),
      ),
      Effect.mapError(storeError("secret")),
    );

  const writeJsonSecret = <A, I>(
    schema: Schema.Codec<A, I>,
    name: string,
    value: A | undefined,
  ): Effect.Effect<void, ConnectorStoreError> =>
    (value === undefined
      ? secretStore.remove(name)
      : Schema.encodeEffect(Schema.fromJsonString(schema))(value).pipe(
          Effect.flatMap((json) => secretStore.set(name, new TextEncoder().encode(json))),
        )
    ).pipe(Effect.mapError(storeError("secret")));

  const list = writer.withPermits(1)(load);

  const get: ConnectorStore["Service"]["get"] = Effect.fn("ConnectorStore.get")(function* (id) {
    return (yield* list).find((connection) => connection.id === id);
  });

  const create: ConnectorStore["Service"]["create"] = Effect.fn("ConnectorStore.create")(
    function* (preferredId, makeConnection) {
      const created = yield* writer.withPermits(1)(
        Effect.gen(function* () {
          const connections = yield* load;
          const taken = new Set<string>([
            ...RESERVED_IDS,
            ...connections.map((connection) => connection.id),
          ]);
          const base = slugify(preferredId) || "connector";
          let candidate = base;
          for (let suffix = 2; taken.has(candidate); suffix += 1) {
            candidate = `${base}-${suffix}`;
          }
          const connection = makeConnection(ConnectionId.make(candidate));
          yield* persist([...connections, connection]);
          return connection;
        }),
      );
      yield* notifyChanged;
      return created;
    },
  );

  const update: ConnectorStore["Service"]["update"] = Effect.fn("ConnectorStore.update")(
    function* (id, change) {
      const updated = yield* writer.withPermits(1)(
        Effect.gen(function* () {
          const connections = yield* load;
          const existing = connections.find((connection) => connection.id === id);
          if (existing === undefined) return undefined;
          const next = change(existing);
          yield* persist(
            connections.map((connection) => (connection.id === id ? next : connection)),
          );
          return next;
        }),
      );
      if (updated !== undefined) yield* notifyChanged;
      return updated;
    },
  );

  const remove: ConnectorStore["Service"]["remove"] = Effect.fn("ConnectorStore.remove")(
    function* (id) {
      yield* writer.withPermits(1)(
        Effect.gen(function* () {
          const connections = yield* load;
          if (connections.some((connection) => connection.id === id)) {
            yield* persist(connections.filter((connection) => connection.id !== id));
          }
        }),
      );
      yield* secretStore.remove(authSecret(id)).pipe(Effect.mapError(storeError("secret")));
      yield* secretStore.remove(secretsSecret(id)).pipe(Effect.mapError(storeError("secret")));
      yield* activityWriter.withPermits(1)(
        fileSystem.remove(connectionDirectory(id), { recursive: true, force: true }).pipe(
          Effect.andThen(
            Ref.update(activityLines, (current) => {
              const next = new Map(current);
              next.delete(id);
              return next;
            }),
          ),
          Effect.mapError(storeError("write")),
        ),
      );
      yield* Ref.update(runtimes, (current) => {
        const next = new Map(current);
        next.delete(id);
        return next;
      });
      yield* notifyChanged;
    },
  );

  const readAuth: ConnectorStore["Service"]["readAuth"] = (id) =>
    readJsonSecret(ConnectionAuth, authSecret(id));
  const writeAuth: ConnectorStore["Service"]["writeAuth"] = Effect.fn("ConnectorStore.writeAuth")(
    function* (id, auth) {
      yield* writeJsonSecret(ConnectionAuth, authSecret(id), auth);
      yield* notifyChanged;
    },
  );
  const workDirectory: ConnectorStore["Service"]["workDirectory"] = Effect.fn(
    "ConnectorStore.workDirectory",
  )(function* (id) {
    const folder = path.join(connectionDirectory(id), "files");
    yield* fileSystem
      .makeDirectory(folder, { recursive: true })
      .pipe(Effect.mapError(storeError("write")));
    return folder;
  });

  const readSecrets: ConnectorStore["Service"]["readSecrets"] = (id) =>
    readJsonSecret(ConnectionSecrets, secretsSecret(id)).pipe(
      Effect.map((secrets) => secrets ?? { inputs: {} }),
    );
  const writeSecrets: ConnectorStore["Service"]["writeSecrets"] = Effect.fn(
    "ConnectorStore.writeSecrets",
  )(function* (id, secrets) {
    const empty = secrets.token === undefined && Object.keys(secrets.inputs).length === 0;
    yield* writeJsonSecret(ConnectionSecrets, secretsSecret(id), empty ? undefined : secrets);
    yield* notifyChanged;
  });

  const readTools: ConnectorStore["Service"]["readTools"] = (id) => {
    const toolsPath = path.join(connectionDirectory(id), "tools.json");
    return fileSystem.exists(toolsPath).pipe(
      Effect.flatMap((exists) =>
        exists
          ? fileSystem
              .readFileString(toolsPath)
              .pipe(
                Effect.map((text) =>
                  Option.getOrUndefined(Option.map(decodeToolsFile(text), (file) => file.tools)),
                ),
              )
          : Effect.undefined,
      ),
      Effect.mapError(storeError("read")),
    );
  };
  const writeTools: ConnectorStore["Service"]["writeTools"] = Effect.fn(
    "ConnectorStore.writeTools",
  )(function* (id, tools) {
    const contents = yield* encodeToolsFile({ version: 1, tools }).pipe(
      Effect.mapError(storeError("write")),
    );
    yield* writeAtomically(path.join(connectionDirectory(id), "tools.json"), contents).pipe(
      Effect.mapError(storeError("write")),
    );
    yield* notifyChanged;
  });

  const activityPath = (id: ConnectionId) => path.join(connectionDirectory(id), "activity.jsonl");
  const readActivityLines = (id: ConnectionId) =>
    fileSystem.exists(activityPath(id)).pipe(
      Effect.flatMap((exists) =>
        exists ? fileSystem.readFileString(activityPath(id)) : Effect.succeed(""),
      ),
      Effect.map((text) => text.split("\n").filter((line) => line.trim().length > 0)),
    );

  const appendActivity: ConnectorStore["Service"]["appendActivity"] = Effect.fn(
    "ConnectorStore.appendActivity",
  )(function* (id, entry) {
    const line = yield* encodeActivityLine(entry).pipe(Effect.mapError(storeError("write")));
    yield* activityWriter.withPermits(1)(
      Effect.gen(function* () {
        const known = (yield* Ref.get(activityLines)).get(id);
        const count = known ?? (yield* readActivityLines(id)).length;
        if (count + 1 > ACTIVITY_LIMIT + ACTIVITY_TRIM_SLACK) {
          const kept = [...(yield* readActivityLines(id)), line].slice(-ACTIVITY_LIMIT);
          yield* writeAtomically(activityPath(id), `${kept.join("\n")}\n`);
          yield* Ref.update(activityLines, (current) => new Map(current).set(id, kept.length));
          return;
        }
        yield* fileSystem.makeDirectory(connectionDirectory(id), { recursive: true });
        yield* fileSystem.writeFileString(activityPath(id), `${line}\n`, { flag: "a" });
        yield* Ref.update(activityLines, (current) => new Map(current).set(id, count + 1));
      }).pipe(Effect.mapError(storeError("write"))),
    );
  });

  const readActivity: ConnectorStore["Service"]["readActivity"] = Effect.fn(
    "ConnectorStore.readActivity",
  )(function* (id, limit) {
    const lines = yield* readActivityLines(id).pipe(Effect.mapError(storeError("read")));
    const entries: Array<ConnectorActivityEntry> = [];
    for (let index = lines.length - 1; index >= 0 && entries.length < limit; index -= 1) {
      const decoded = decodeActivityLine(lines[index] ?? "");
      if (Option.isSome(decoded)) entries.push(decoded.value);
    }
    return entries;
  });

  const isReady: ConnectorStore["Service"]["isReady"] = Effect.fn("ConnectorStore.isReady")(
    function* (connection) {
      const catalog =
        connection.catalogId === null ? undefined : catalogConnector(connection.catalogId);
      const auth = catalog?.entry.auth ?? connection.custom?.auth ?? "none";
      const secretInputs = (catalog?.entry.inputs ?? []).filter(
        (input) => input.secret && input.required,
      );
      const secrets =
        auth === "token" || secretInputs.length > 0 ? yield* readSecrets(connection.id) : undefined;
      if (secretInputs.some((input) => !secrets?.inputs[input.key])) return false;
      switch (auth) {
        case "none":
          return true;
        case "token":
          return secrets?.token !== undefined;
        case "sign-in":
        case "own-app":
          return (yield* readAuth(connection.id)) !== undefined;
      }
    },
  );

  return ConnectorStore.of({
    list,
    get,
    create,
    update,
    remove,
    workDirectory,
    readAuth,
    writeAuth,
    readSecrets,
    writeSecrets,
    readOwnApp: Effect.fn("ConnectorStore.readOwnApp")(function* (app) {
      return yield* readJsonSecret(OwnAppCredentials, ownAppSecret(app));
    }),
    writeOwnApp: Effect.fn("ConnectorStore.writeOwnApp")(function* (app, credentials) {
      yield* writeJsonSecret(OwnAppCredentials, ownAppSecret(app), credentials);
      yield* notifyChanged;
    }),
    readRegisteredClient: Effect.fn("ConnectorStore.readRegisteredClient")(function* (key) {
      return yield* readJsonSecret(RegisteredClient, registeredClientSecret(key));
    }),
    writeRegisteredClient: Effect.fn("ConnectorStore.writeRegisteredClient")(
      function* (key, client) {
        yield* writeJsonSecret(RegisteredClient, registeredClientSecret(key), client);
      },
    ),
    readTools,
    writeTools,
    appendActivity,
    readActivity,
    runtime: Effect.fn("ConnectorStore.runtime")(function* (id) {
      return (yield* Ref.get(runtimes)).get(id);
    }),
    setRuntime: Effect.fn("ConnectorStore.setRuntime")(function* (id, runtime) {
      const changedRuntime = yield* Ref.modify(runtimes, (current) => {
        const previous = current.get(id);
        if (runtimeKey(previous) === runtimeKey(runtime)) return [false, current];
        const next = new Map(current);
        if (runtime === undefined) next.delete(id);
        else next.set(id, runtime);
        return [true, next];
      });
      if (changedRuntime) yield* notifyChanged;
    }),
    isReady,
    effectiveConnectionIds: Effect.fn("ConnectorStore.effectiveConnectionIds")(
      function* (selection) {
        const connections = yield* list;
        const withReadiness = yield* Effect.forEach(connections, (connection) =>
          isReady(connection).pipe(Effect.map((ready) => ({ ...connection, ready }))),
        );
        return effectiveConnectionIds(selection, withReadiness);
      },
    ),
    changes: Stream.fromPubSub(changed),
    notifyChanged,
  });
});

export const layer = Layer.effect(ConnectorStore, make);
