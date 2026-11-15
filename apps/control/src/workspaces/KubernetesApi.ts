import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

/** Where Kubernetes mounts a pod's service account. */
const SERVICE_ACCOUNT = "/var/run/secrets/kubernetes.io/serviceaccount";

export class KubernetesApiError extends Schema.TaggedError<KubernetesApiError>()(
  "KubernetesApiError",
  {
    operation: Schema.String,
    status: Schema.optionalKey(Schema.Number),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Kubernetes refused to ${this.operation}${this.status === undefined ? "" : ` (HTTP ${this.status})`}.`;
  }
}

const decodePod = Schema.decodeUnknownEffect(
  Schema.Struct({
    status: Schema.optionalKey(
      Schema.Struct({
        phase: Schema.optionalKey(Schema.String),
        podIP: Schema.optionalKey(Schema.String),
      }),
    ),
  }),
);

const decodeList = Schema.decodeUnknownEffect(
  Schema.Struct({
    items: Schema.Array(Schema.Struct({ metadata: Schema.Struct({ name: Schema.String }) })),
  }),
);

export interface PodState {
  /** `Pending`, `Running`, `Succeeded`, `Failed` or `Unknown`. */
  readonly phase: string;
  readonly address: string | null;
}

/** The pod and claim calls the workspace manager needs, in one namespace. */
export class KubernetesApi extends Context.Service<
  KubernetesApi,
  {
    readonly getPod: (name: string) => Effect.Effect<Option.Option<PodState>, KubernetesApiError>;
    /** Creates the pod unless one with that name exists. */
    readonly createPod: (manifest: object) => Effect.Effect<void, KubernetesApiError>;
    /** True when there was a pod; `now` skips the grace period, for one that already stopped. */
    readonly deletePod: (
      name: string,
      options?: { readonly now: boolean },
    ) => Effect.Effect<boolean, KubernetesApiError>;
    /** Creates the claim unless one with that name exists. */
    readonly createClaim: (manifest: object) => Effect.Effect<void, KubernetesApiError>;
    readonly deleteClaim: (name: string) => Effect.Effect<boolean, KubernetesApiError>;
    /** The names of the pods or claims matching a label selector such as `a=b,c=d`. */
    readonly list: (
      kind: "pods" | "persistentvolumeclaims",
      selector: string,
    ) => Effect.Effect<ReadonlyArray<string>, KubernetesApiError>;
  }
>()("@codenine/control/workspaces/KubernetesApi") {
  static readonly make = Effect.fn("KubernetesApi.make")(function* (options: {
    readonly baseUrl: string;
    readonly namespace: string;
    /** The bearer token for each call; service account tokens are rotated, so it is read each time. */
    readonly token: Effect.Effect<Option.Option<string>>;
  }) {
    const client = yield* HttpClient.HttpClient;
    const base = `${options.baseUrl.replace(/\/+$/u, "")}/api/v1/namespaces/${encodeURIComponent(options.namespace)}`;

    const call = Effect.fnUntraced(function* (
      operation: string,
      request: HttpClientRequest.HttpClientRequest,
      accepted: ReadonlyArray<number> = [],
    ) {
      const token = yield* options.token;
      const response = yield* client
        .execute(
          Option.isSome(token) ? HttpClientRequest.bearerToken(request, token.value) : request,
        )
        .pipe(Effect.mapError((cause) => new KubernetesApiError({ operation, cause })));
      if (
        (response.status < 200 || response.status >= 300) &&
        !accepted.includes(response.status)
      ) {
        return yield* new KubernetesApiError({ operation, status: response.status });
      }
      return response;
    });

    return KubernetesApi.of({
      getPod: Effect.fn("KubernetesApi.getPod")(function* (name) {
        const response = yield* call(
          "read a pod",
          HttpClientRequest.get(`${base}/pods/${encodeURIComponent(name)}`),
          [404],
        );
        if (response.status === 404) {
          return Option.none();
        }
        const pod = yield* response.json.pipe(
          Effect.flatMap(decodePod),
          Effect.mapError((cause) => new KubernetesApiError({ operation: "read a pod", cause })),
        );
        return Option.some<PodState>({
          phase: pod.status?.phase ?? "Pending",
          address: pod.status?.podIP ?? null,
        });
      }),
      createPod: Effect.fn("KubernetesApi.createPod")(function* (manifest) {
        yield* call(
          "create a pod",
          HttpClientRequest.post(`${base}/pods`).pipe(HttpClientRequest.bodyJsonUnsafe(manifest)),
          [409],
        );
      }),
      deletePod: Effect.fn("KubernetesApi.deletePod")(function* (name, deleteOptions) {
        const response = yield* call(
          "delete a pod",
          HttpClientRequest.delete(`${base}/pods/${encodeURIComponent(name)}`).pipe(
            deleteOptions?.now === true
              ? HttpClientRequest.setUrlParam("gracePeriodSeconds", "0")
              : (request) => request,
          ),
          [404],
        );
        return response.status !== 404;
      }),
      createClaim: Effect.fn("KubernetesApi.createClaim")(function* (manifest) {
        yield* call(
          "create a volume claim",
          HttpClientRequest.post(`${base}/persistentvolumeclaims`).pipe(
            HttpClientRequest.bodyJsonUnsafe(manifest),
          ),
          [409],
        );
      }),
      list: Effect.fn("KubernetesApi.list")(function* (kind, selector) {
        const response = yield* call(
          `list ${kind}`,
          HttpClientRequest.get(`${base}/${kind}`).pipe(
            HttpClientRequest.setUrlParam("labelSelector", selector),
          ),
        );
        const { items } = yield* response.json.pipe(
          Effect.flatMap(decodeList),
          Effect.mapError((cause) => new KubernetesApiError({ operation: `read ${kind}`, cause })),
        );
        return items.map((item) => item.metadata.name);
      }),
      deleteClaim: Effect.fn("KubernetesApi.deleteClaim")(function* (name) {
        const response = yield* call(
          "delete a volume claim",
          HttpClientRequest.delete(`${base}/persistentvolumeclaims/${encodeURIComponent(name)}`),
          [404],
        );
        return response.status !== 404;
      }),
    });
  });

  /** The API at `baseUrl`, without credentials; for tests and local clusters. */
  static readonly layerUrl = (baseUrl: string, namespace: string) =>
    Layer.effect(
      KubernetesApi,
      KubernetesApi.make({ baseUrl, namespace, token: Effect.succeedNone }),
    ).pipe(Layer.provide(NodeHttpClient.layerUndici));

  /**
   * The cluster the control server runs in, as its service account, in
   * `CODENINE_CONTROL_KUBERNETES_NAMESPACE` or the service account's own namespace.
   */
  static readonly layer = Layer.effect(
    KubernetesApi,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const host = yield* Config.String("KUBERNETES_SERVICE_HOST");
      const port = yield* Config.String("KUBERNETES_SERVICE_PORT").pipe(Config.withDefault("443"));
      const namespace = yield* Config.String("CODENINE_CONTROL_KUBERNETES_NAMESPACE").pipe(
        Config.option,
      );
      const ca = yield* fs.readFileString(`${SERVICE_ACCOUNT}/ca.crt`).pipe(Effect.orDie);
      const dispatcher = yield* NodeHttpClient.makeDispatcherOptions({ connect: { ca } });
      const client = yield* NodeHttpClient.makeUndici.pipe(
        Effect.provideService(NodeHttpClient.Dispatcher, dispatcher),
      );
      return yield* KubernetesApi.make({
        baseUrl: `https://${host.includes(":") ? `[${host}]` : host}:${port}`,
        namespace: Option.isSome(namespace)
          ? namespace.value
          : (yield* fs.readFileString(`${SERVICE_ACCOUNT}/namespace`).pipe(Effect.orDie)).trim(),
        token: fs.readFileString(`${SERVICE_ACCOUNT}/token`).pipe(
          Effect.map((token) => Option.some(token.trim())),
          Effect.orElseSucceed(() => Option.none()),
        ),
      }).pipe(Effect.provideService(HttpClient.HttpClient, client));
    }),
  );
}
