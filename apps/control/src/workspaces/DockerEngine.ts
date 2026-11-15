import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";

/** The Engine API version the requests are written against; Docker 25 and later accept it. */
const API = "http://docker/v1.44";

export class DockerEngineError extends Schema.TaggedError<DockerEngineError>()(
  "DockerEngineError",
  {
    operation: Schema.String,
    status: Schema.optionalKey(Schema.Number),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Docker refused to ${this.operation}${this.status === undefined ? "" : ` (HTTP ${this.status})`}.`;
  }
}

const Labels = Schema.NullOr(Schema.Record(Schema.String, Schema.String));
const decodeContainer = Schema.decodeUnknownEffect(
  Schema.Struct({
    State: Schema.Struct({ Running: Schema.Boolean }),
    Config: Schema.Struct({ Labels }),
    NetworkSettings: Schema.Struct({
      Networks: Schema.NullOr(
        Schema.Record(Schema.String, Schema.Struct({ IPAddress: Schema.String })),
      ),
    }),
  }),
);
const decodeNetwork = Schema.decodeUnknownEffect(
  Schema.Struct({
    Internal: Schema.Boolean,
    Containers: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
  }),
);
const decodeNetworks = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ Name: Schema.String })),
);
const decodeImage = Schema.decodeUnknownEffect(Schema.Struct({ Id: Schema.String }));

export interface ContainerState {
  readonly running: boolean;
  /** Its address on each network, while it runs. */
  readonly addresses: Readonly<Record<string, string>>;
  readonly labels: Readonly<Record<string, string>>;
}

export interface ContainerSpec {
  readonly image: string;
  /** Replaces the image's entrypoint. */
  readonly command?: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly labels: Readonly<Record<string, string>>;
  readonly user: string;
  /** The network it joins when created. */
  readonly network: string;
  readonly volume?: { readonly name: string; readonly mountPath: string };
  readonly nanoCpus: number;
  readonly memoryBytes: number;
  /** Whether Docker starts it again when it stops on its own. */
  readonly restart: "no" | "unless-stopped";
}

// Label filters are our own IDs; the Engine API takes them as JSON in the query.
const labelFilter = (labels: ReadonlyArray<string>) => JSON.stringify({ label: labels });

/** The few Engine API calls the workspace manager needs, over Docker's socket. */
export class DockerEngine extends Context.Service<
  DockerEngine,
  {
    readonly ensureVolume: (
      name: string,
      labels: Readonly<Record<string, string>>,
    ) => Effect.Effect<void, DockerEngineError>;
    /** Creates the network, or makes it again when it exists with the other kind. */
    readonly ensureNetwork: (
      name: string,
      labels: Readonly<Record<string, string>>,
      options: { readonly internal: boolean },
    ) => Effect.Effect<void, DockerEngineError>;
    /** Adds a container to a network under an alias, unless it is already there. */
    readonly connect: (
      network: string,
      container: string,
      alias: string,
    ) => Effect.Effect<void, DockerEngineError>;
    /** The names of the networks carrying all of these labels (`key` or `key=value`). */
    readonly listNetworks: (
      labels: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<string>, DockerEngineError>;
    /** Creates the container unless one with that name exists. */
    readonly ensureContainer: (
      name: string,
      spec: ContainerSpec,
    ) => Effect.Effect<void, DockerEngineError>;
    readonly start: (name: string) => Effect.Effect<void, DockerEngineError>;
    readonly inspect: (
      name: string,
    ) => Effect.Effect<Option.Option<ContainerState>, DockerEngineError>;
    /** The ID of the image a name or tag points to now. */
    readonly imageId: (image: string) => Effect.Effect<string, DockerEngineError>;
    readonly stop: (name: string) => Effect.Effect<void, DockerEngineError>;
    /** Each removal is true when there was something to remove. */
    readonly removeContainer: (name: string) => Effect.Effect<boolean, DockerEngineError>;
    readonly removeVolume: (name: string) => Effect.Effect<boolean, DockerEngineError>;
    /** Disconnects whatever is still on the network first. */
    readonly removeNetwork: (name: string) => Effect.Effect<boolean, DockerEngineError>;
  }
>()("@codenine/control/workspaces/DockerEngine") {
  static readonly make = Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;

    /** Sends one call; `accepted` lists statuses that mean done, such as 304 or 409. */
    const call = (
      operation: string,
      request: HttpClientRequest.HttpClientRequest,
      accepted: ReadonlyArray<number> = [],
    ) =>
      client.execute(request).pipe(
        Effect.mapError((cause) => new DockerEngineError({ operation, cause })),
        Effect.filterOrFail(
          (response) =>
            (response.status >= 200 && response.status < 300) || accepted.includes(response.status),
          (response) => new DockerEngineError({ operation, status: response.status }),
        ),
      );
    const read = <A>(
      operation: string,
      response: HttpClientResponse.HttpClientResponse,
      decode: (input: unknown) => Effect.Effect<A, unknown>,
    ) =>
      response.json.pipe(
        Effect.flatMap(decode),
        Effect.mapError((cause) => new DockerEngineError({ operation, cause })),
      );
    const path = (kind: string, name: string, rest = "") =>
      `${API}/${kind}/${encodeURIComponent(name)}${rest}`;

    const removeNetwork = Effect.fn("DockerEngine.removeNetwork")(function* (name: string) {
      const found = yield* call(
        "inspect a network",
        HttpClientRequest.get(path("networks", name)),
        [404],
      );
      if (found.status === 404) {
        return false;
      }
      const { Containers } = yield* read("read a network", found, decodeNetwork);
      for (const container of Object.keys(Containers ?? {})) {
        yield* call(
          "disconnect a container",
          HttpClientRequest.post(path("networks", name, "/disconnect")).pipe(
            HttpClientRequest.bodyJsonUnsafe({ Container: container, Force: true }),
          ),
        );
      }
      const removed = yield* call(
        "remove a network",
        HttpClientRequest.delete(path("networks", name)),
        [404],
      );
      return removed.status !== 404;
    });

    const createNetwork = (
      name: string,
      labels: Readonly<Record<string, string>>,
      internal: boolean,
    ) =>
      call(
        "create a network",
        HttpClientRequest.post(`${API}/networks/create`).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            Name: name,
            Labels: labels,
            Internal: internal,
            CheckDuplicate: true,
          }),
        ),
        [409],
      );

    return DockerEngine.of({
      ensureVolume: Effect.fn("DockerEngine.ensureVolume")(function* (name, labels) {
        yield* call(
          "create a volume",
          HttpClientRequest.post(`${API}/volumes/create`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ Name: name, Labels: labels }),
          ),
        );
      }),
      ensureNetwork: Effect.fn("DockerEngine.ensureNetwork")(function* (name, labels, options) {
        const created = yield* createNetwork(name, labels, options.internal);
        if (created.status !== 409) {
          return;
        }
        const existing = yield* call(
          "inspect a network",
          HttpClientRequest.get(path("networks", name)),
        );
        const { Internal } = yield* read("read a network", existing, decodeNetwork);
        if (Internal !== options.internal) {
          yield* removeNetwork(name);
          yield* createNetwork(name, labels, options.internal);
        }
      }),
      connect: Effect.fn("DockerEngine.connect")(function* (network, container, alias) {
        // 403 is Docker's answer when the container is already on the network.
        yield* call(
          "connect a container",
          HttpClientRequest.post(path("networks", network, "/connect")).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              Container: container,
              EndpointConfig: { Aliases: [alias] },
            }),
          ),
          [403],
        );
      }),
      listNetworks: Effect.fn("DockerEngine.listNetworks")(function* (labels) {
        const response = yield* call(
          "list networks",
          HttpClientRequest.get(`${API}/networks`).pipe(
            HttpClientRequest.setUrlParam("filters", labelFilter(labels)),
          ),
        );
        const networks = yield* read("read networks", response, decodeNetworks);
        return networks.map((network) => network.Name);
      }),
      ensureContainer: Effect.fn("DockerEngine.ensureContainer")(function* (name, spec) {
        yield* call(
          "create a container",
          HttpClientRequest.post(`${API}/containers/create`).pipe(
            HttpClientRequest.setUrlParam("name", name),
            HttpClientRequest.bodyJsonUnsafe({
              Image: spec.image,
              ...(spec.command === undefined ? {} : { Entrypoint: spec.command, Cmd: [] }),
              Env: Object.entries(spec.env).map(([key, value]) => `${key}=${value}`),
              Labels: spec.labels,
              User: spec.user,
              HostConfig: {
                Mounts:
                  spec.volume === undefined
                    ? []
                    : [{ Type: "volume", Source: spec.volume.name, Target: spec.volume.mountPath }],
                // No published ports: the control server reaches it on its network.
                NetworkMode: spec.network,
                ReadonlyRootfs: true,
                Tmpfs: { "/tmp": "rw,nosuid,size=1g" },
                SecurityOpt: ["no-new-privileges"],
                CapDrop: ["ALL"],
                NanoCpus: spec.nanoCpus,
                Memory: spec.memoryBytes,
                PidsLimit: 4096,
                RestartPolicy: { Name: spec.restart },
              },
            }),
          ),
          [409],
        );
      }),
      start: Effect.fn("DockerEngine.start")(function* (name) {
        yield* call(
          "start a container",
          HttpClientRequest.post(path("containers", name, "/start")),
          [304],
        );
      }),
      inspect: Effect.fn("DockerEngine.inspect")(function* (name) {
        const response = yield* call(
          "inspect a container",
          HttpClientRequest.get(path("containers", name, "/json")),
          [404],
        );
        if (response.status === 404) {
          return Option.none();
        }
        const state = yield* read("read a container", response, decodeContainer);
        const addresses = Object.fromEntries(
          Object.entries(state.NetworkSettings.Networks ?? {}).flatMap(
            ([network, { IPAddress }]) => (IPAddress === "" ? [] : [[network, IPAddress]]),
          ),
        );
        return Option.some<ContainerState>({
          running: state.State.Running,
          addresses,
          labels: state.Config.Labels ?? {},
        });
      }),
      imageId: Effect.fn("DockerEngine.imageId")(function* (image) {
        const response = yield* call(
          "find the workspace image",
          // Registry paths keep their slashes, as the Docker CLI sends them.
          HttpClientRequest.get(`${API}/images/${encodeURI(image)}/json`),
        );
        const { Id } = yield* read("read the workspace image", response, decodeImage);
        return Id;
      }),
      stop: Effect.fn("DockerEngine.stop")(function* (name) {
        yield* call(
          "stop a container",
          HttpClientRequest.post(path("containers", name, "/stop")).pipe(
            HttpClientRequest.setUrlParam("t", "20"),
          ),
          [304, 404],
        );
      }),
      removeContainer: Effect.fn("DockerEngine.removeContainer")(function* (name) {
        const response = yield* call(
          "remove a container",
          HttpClientRequest.delete(path("containers", name)).pipe(
            HttpClientRequest.setUrlParam("force", "true"),
          ),
          [404],
        );
        return response.status !== 404;
      }),
      removeVolume: Effect.fn("DockerEngine.removeVolume")(function* (name) {
        const response = yield* call(
          "remove a volume",
          HttpClientRequest.delete(path("volumes", name)),
          [404],
        );
        return response.status !== 404;
      }),
      removeNetwork,
    });
  });

  /**
   * Talks to Docker over a Unix socket. The client is built here rather than
   * from a layer: Effect shares layers by reference, so another undici client
   * in the same program would hand this one its TCP dispatcher.
   */
  static readonly layerSocket = (socketPath: string) =>
    Layer.effect(
      DockerEngine,
      Effect.gen(function* () {
        const dispatcher = yield* NodeHttpClient.makeDispatcherOptions({ connect: { socketPath } });
        const client = yield* NodeHttpClient.makeUndici.pipe(
          Effect.provideService(NodeHttpClient.Dispatcher, dispatcher),
        );
        return yield* DockerEngine.make.pipe(Effect.provideService(HttpClient.HttpClient, client));
      }),
    );

  /** Talks to Docker over `CODENINE_CONTROL_DOCKER_SOCKET` (default `/var/run/docker.sock`). */
  static readonly layer = Layer.unwrap(
    Config.String("CODENINE_CONTROL_DOCKER_SOCKET").pipe(
      Config.withDefault("/var/run/docker.sock"),
      Effect.map(DockerEngine.layerSocket),
    ),
  );
}
