import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { Installation } from "../installation/Installation.ts";
import { KubernetesApi, type PodState } from "./KubernetesApi.ts";
import { cachedTargets, WorkspaceManager, WorkspaceUnavailableError } from "./WorkspaceManager.ts";
import { WorkspaceTokens } from "./WorkspaceTokens.ts";
import {
  EGRESS_PORT,
  WORKSPACE_HOME,
  WORKSPACE_PORT,
  WORKSPACE_UID,
  WorkspaceConfig,
  WorkspaceDialPort,
  workspaceEnv,
} from "./workspaceSpec.ts";

/** A first start pulls the image, which can take minutes on a fresh node. */
const START_TIMEOUT = Duration.minutes(5);
const POD_CHECK_INTERVAL = Duration.millis(500);
/** The egress proxy's service, from `images/workspace/kubernetes.yaml`. */
const EGRESS_URL = `http://codenine-egress:${EGRESS_PORT}`;

const KubernetesConfig = Config.all({
  diskGb: Config.Number("CODENINE_CONTROL_WORKSPACE_DISK_GB").pipe(Config.withDefault(20)),
  storageClass: Config.option(Config.String("CODENINE_CONTROL_WORKSPACE_STORAGE_CLASS")),
});

/** Names for a person's pod and claim; Kubernetes names allow no underscores. */
export const podNames = (personId: string) => {
  const pod = `codenine-${personId.replaceAll("_", "-").toLowerCase()}`;
  return { pod, claim: `${pod}-home` };
};

class PodNotReady extends Schema.TaggedError<PodNotReady>()("PodNotReady", {}) {}

/**
 * One pod per person on their own claim, made on their first request. A pod
 * that slept or stopped cannot start again, so the next request replaces it;
 * a running one is never replaced, and the new one takes the current settings.
 */
export const make = Effect.gen(function* () {
  const api = yield* KubernetesApi;
  const installation = yield* Installation;
  const { verifier } = yield* WorkspaceTokens;
  const config = yield* WorkspaceConfig;
  const kubernetes = yield* KubernetesConfig;
  const client = yield* HttpClient.HttpClient;
  const dialPort = yield* WorkspaceDialPort;

  const labels = (personId: string) => ({
    "app.kubernetes.io/name": "codenine-workspace",
    "app.kubernetes.io/part-of": "codenine",
    "codenine.installation": installation.id,
    "codenine.person": personId,
  });

  const claimManifest = (personId: string) => ({
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: { name: podNames(personId).claim, labels: labels(personId) },
    spec: {
      accessModes: ["ReadWriteOnce"],
      resources: { requests: { storage: `${kubernetes.diskGb}Gi` } },
      ...Option.match(kubernetes.storageClass, {
        onNone: () => ({}),
        onSome: (storageClassName) => ({ storageClassName }),
      }),
    },
  });

  const podManifest = (personId: string) => {
    const env = workspaceEnv({
      verifier,
      personId,
      sleepMinutes: config.sleepMinutes,
      proxyUrl: EGRESS_URL,
    });
    return {
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: podNames(personId).pod, labels: labels(personId) },
      spec: {
        // It stops itself to sleep, and the next request makes a new pod.
        restartPolicy: "Never",
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        securityContext: {
          runAsUser: WORKSPACE_UID,
          runAsGroup: WORKSPACE_UID,
          fsGroup: WORKSPACE_UID,
          runAsNonRoot: true,
          seccompProfile: { type: "RuntimeDefault" },
        },
        containers: [
          {
            name: "workspace",
            image: config.image,
            env: Object.entries(env).map(([name, value]) => ({ name, value })),
            ports: [{ containerPort: WORKSPACE_PORT }],
            // Requests are a quarter of the limits, so idle workspaces pack onto fewer nodes.
            resources: {
              limits: { cpu: String(config.cpus), memory: `${config.memoryGb}Gi` },
              requests: { cpu: String(config.cpus / 4), memory: `${config.memoryGb / 4}Gi` },
            },
            securityContext: {
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true,
              capabilities: { drop: ["ALL"] },
            },
            volumeMounts: [
              { name: "home", mountPath: WORKSPACE_HOME },
              { name: "tmp", mountPath: "/tmp" },
            ],
          },
        ],
        volumes: [
          { name: "home", persistentVolumeClaim: { claimName: podNames(personId).claim } },
          { name: "tmp", emptyDir: { sizeLimit: "1Gi" } },
        ],
      },
    };
  };

  const finished = (phase: string) => phase === "Succeeded" || phase === "Failed";

  const readyAddress = (
    pod: Option.Option<PodState>,
  ): Effect.Effect<string, PodNotReady | WorkspaceUnavailableError> => {
    if (Option.isSome(pod) && pod.value.phase === "Running" && pod.value.address !== null) {
      return Effect.succeed(pod.value.address);
    }
    return Option.isSome(pod) && !finished(pod.value.phase)
      ? Effect.fail(new PodNotReady())
      : Effect.fail(new WorkspaceUnavailableError({ cause: "The pod stopped while starting." }));
  };

  const answers = (url: string) =>
    client
      .get(`${url}/.well-known/codenine/environment`)
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk), Effect.asVoid);

  const start = Effect.fn("KubernetesWorkspaces.start")(
    function* (personId: string) {
      const names = podNames(personId);
      const found = yield* api.getPod(names.pod);
      if (Option.isSome(found) && finished(found.value.phase)) {
        yield* api.deletePod(names.pod, { now: true });
        // A name is free once the old pod is gone from the API.
        yield* api
          .getPod(names.pod)
          .pipe(
            Effect.repeat({ schedule: Schedule.spaced(POD_CHECK_INTERVAL), until: Option.isNone }),
          );
      }
      if (Option.isNone(found) || finished(found.value.phase)) {
        yield* api.createClaim(claimManifest(personId));
        yield* api.createPod(podManifest(personId));
      }
      // Pending while it is scheduled and its image is pulled.
      const address = yield* api.getPod(names.pod).pipe(
        Effect.flatMap(readyAddress),
        Effect.retry({
          schedule: Schedule.spaced(POD_CHECK_INTERVAL),
          while: (error) => error._tag === "PodNotReady",
        }),
      );
      const url = `http://${address}:${dialPort}`;
      yield* answers(url).pipe(Effect.retry(Schedule.spaced("250 millis")));
      return { url, workspaceId: personId };
    },
    Effect.timeout(START_TIMEOUT),
    Effect.mapError((cause) =>
      cause._tag === "WorkspaceUnavailableError" ? cause : new WorkspaceUnavailableError({ cause }),
    ),
  );

  const targets = yield* cachedTargets(start);

  return WorkspaceManager.of({
    targetFor: Effect.fn("WorkspaceManager.targetFor")(function* (personId: string) {
      return yield* targets.targetFor(personId);
    }),
    forget: Effect.fn("WorkspaceManager.forget")(function* (personId: string) {
      yield* targets.forget(personId);
    }),
    isAsleep: Effect.fn("WorkspaceManager.isAsleep")(
      function* (personId: string) {
        const pod = yield* api.getPod(podNames(personId).pod);
        return Option.isNone(pod) || finished(pod.value.phase);
      },
      Effect.mapError((cause) => new WorkspaceUnavailableError({ cause })),
    ),
    retire: Effect.fn("WorkspaceManager.retire")(
      function* (personId: string) {
        // Its agents get the usual grace period to stop.
        const removed = yield* api.deletePod(podNames(personId).pod);
        yield* targets.drop(personId);
        return removed;
      },
      Effect.mapError((cause) => new WorkspaceUnavailableError({ cause })),
    ),
    removeFiles: Effect.fn("WorkspaceManager.removeFiles")(
      function* (personId: string) {
        return yield* api.deleteClaim(podNames(personId).claim);
      },
      Effect.mapError((cause) => new WorkspaceUnavailableError({ cause })),
    ),
  });
});

/** Kubernetes workspaces, when `CODENINE_CONTROL_WORKSPACE_DRIVER` is `kubernetes`. */
export const layer = Layer.effect(WorkspaceManager, make).pipe(
  Layer.provide(KubernetesApi.layer.pipe(Layer.provide(NodeFileSystem.layer))),
  Layer.provide(NodeHttpClient.layerUndici),
);
