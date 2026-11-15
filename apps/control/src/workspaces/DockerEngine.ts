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

const ContainerState = Schema.Struct({
  State: Schema.Struct({ Running: Schema.Boolean }),
  NetworkSettings: Schema.Struct({
    Ports: Schema.NullOr(
      Schema.Record(
        Schema.String,
        Schema.NullOr(
          Schema.Array(Schema.Struct({ HostIp: Schema.String, HostPort: Schema.String })),
        ),
      ),
    ),
  }),
});
const decodeContainerState = Schema.decodeUnknownEffect(ContainerState);

export interface ContainerSpec {
  readonly image: string;
  readonly env: Readonly<Record<string, string>>;
  readonly labels: Readonly<Record<string, string>>;
  /** The port the workspace listens on inside the container. */
  readonly port: number;
  readonly volume: string;
  /** Where the volume is mounted: the person's home. */
  readonly mountPath: string;
  readonly network: string;
  readonly user: string;
  readonly nanoCpus: number;
  readonly memoryBytes: number;
}

/** The few Engine API calls the workspace manager needs, over Docker's socket. */
export class DockerEngine extends Context.Service<
  DockerEngine,
  {
    readonly ensureVolume: (
      name: string,
      labels: Readonly<Record<string, string>>,
    ) => Effect.Effect<void, DockerEngineError>;
    readonly ensureNetwork: (
      name: string,
      labels: Readonly<Record<string, string>>,
    ) => Effect.Effect<void, DockerEngineError>;
    /** Creates the container unless one with that name exists. */
    readonly ensureContainer: (
      name: string,
      spec: ContainerSpec,
    ) => Effect.Effect<void, DockerEngineError>;
    readonly start: (name: string) => Effect.Effect<void, DockerEngineError>;
    /** Whether it runs, and the host port its workspace port is published on. */
    readonly inspect: (
      name: string,
      port: number,
    ) => Effect.Effect<
      Option.Option<{ readonly running: boolean; readonly hostPort: number | null }>,
      DockerEngineError
    >;
    readonly stop: (name: string) => Effect.Effect<void, DockerEngineError>;
    readonly removeContainer: (name: string) => Effect.Effect<void, DockerEngineError>;
    readonly removeVolume: (name: string) => Effect.Effect<void, DockerEngineError>;
    readonly removeNetwork: (name: string) => Effect.Effect<void, DockerEngineError>;
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
    const json = (operation: string, response: HttpClientResponse.HttpClientResponse) =>
      response.json.pipe(Effect.mapError((cause) => new DockerEngineError({ operation, cause })));

    return DockerEngine.of({
      ensureVolume: Effect.fn("DockerEngine.ensureVolume")(function* (name, labels) {
        yield* call(
          "create a volume",
          HttpClientRequest.post(`${API}/volumes/create`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ Name: name, Labels: labels }),
          ),
        );
      }),
      ensureNetwork: Effect.fn("DockerEngine.ensureNetwork")(function* (name, labels) {
        yield* call(
          "create a network",
          HttpClientRequest.post(`${API}/networks/create`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ Name: name, Labels: labels, CheckDuplicate: true }),
          ),
          [409],
        );
      }),
      ensureContainer: Effect.fn("DockerEngine.ensureContainer")(function* (name, spec) {
        const portKey = `${spec.port}/tcp`;
        yield* call(
          "create a container",
          HttpClientRequest.post(`${API}/containers/create`).pipe(
            HttpClientRequest.setUrlParam("name", name),
            HttpClientRequest.bodyJsonUnsafe({
              Image: spec.image,
              Env: Object.entries(spec.env).map(([key, value]) => `${key}=${value}`),
              Labels: spec.labels,
              User: spec.user,
              ExposedPorts: { [portKey]: {} },
              HostConfig: {
                Mounts: [{ Type: "volume", Source: spec.volume, Target: spec.mountPath }],
                // Published on loopback only: the control server is the one way in.
                PortBindings: { [portKey]: [{ HostIp: "127.0.0.1", HostPort: "" }] },
                NetworkMode: spec.network,
                ReadonlyRootfs: true,
                Tmpfs: { "/tmp": "rw,nosuid,size=1g" },
                SecurityOpt: ["no-new-privileges"],
                CapDrop: ["ALL"],
                NanoCpus: spec.nanoCpus,
                Memory: spec.memoryBytes,
                PidsLimit: 4096,
                RestartPolicy: { Name: "no" },
              },
            }),
          ),
          [409],
        );
      }),
      start: Effect.fn("DockerEngine.start")(function* (name) {
        yield* call(
          "start a container",
          HttpClientRequest.post(`${API}/containers/${encodeURIComponent(name)}/start`),
          [304],
        );
      }),
      inspect: Effect.fn("DockerEngine.inspect")(function* (name, port) {
        const response = yield* call(
          "inspect a container",
          HttpClientRequest.get(`${API}/containers/${encodeURIComponent(name)}/json`),
          [404],
        );
        if (response.status === 404) {
          return Option.none();
        }
        const state = yield* json("inspect a container", response).pipe(
          Effect.flatMap(decodeContainerState),
          Effect.mapError(
            (cause) => new DockerEngineError({ operation: "read a container", cause }),
          ),
        );
        const published = state.NetworkSettings.Ports?.[`${port}/tcp`]?.[0]?.HostPort;
        return Option.some({
          running: state.State.Running,
          hostPort: published === undefined || published === "" ? null : Number(published),
        });
      }),
      stop: Effect.fn("DockerEngine.stop")(function* (name) {
        yield* call(
          "stop a container",
          HttpClientRequest.post(`${API}/containers/${encodeURIComponent(name)}/stop`).pipe(
            HttpClientRequest.setUrlParam("t", "20"),
          ),
          [304, 404],
        );
      }),
      removeContainer: Effect.fn("DockerEngine.removeContainer")(function* (name) {
        yield* call(
          "remove a container",
          HttpClientRequest.delete(`${API}/containers/${encodeURIComponent(name)}`).pipe(
            HttpClientRequest.setUrlParam("force", "true"),
          ),
          [404],
        );
      }),
      removeVolume: Effect.fn("DockerEngine.removeVolume")(function* (name) {
        yield* call(
          "remove a volume",
          HttpClientRequest.delete(`${API}/volumes/${encodeURIComponent(name)}`),
          [404],
        );
      }),
      removeNetwork: Effect.fn("DockerEngine.removeNetwork")(function* (name) {
        yield* call(
          "remove a network",
          HttpClientRequest.delete(`${API}/networks/${encodeURIComponent(name)}`),
          [404],
        );
      }),
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
