import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as Digest from "effect/crypto/Digest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { Installation } from "../installation/Installation.ts";
import { Profiles } from "../profiles/Profiles.ts";
import { type ContainerSpec, DockerEngine } from "./DockerEngine.ts";
import {
  cachedTargets,
  type WorkspaceKey,
  workspaceIdOf,
  WorkspaceManager,
  WorkspaceUnavailableError,
} from "./WorkspaceManager.ts";
import { WorkspaceTokens } from "./WorkspaceTokens.ts";
import {
  allowedHostsFromConfig,
  EGRESS_PORT,
  egressProxyConfig,
  WORKSPACE_HOME,
  WORKSPACE_UID,
  WorkspaceConfig,
  WorkspaceDialPort,
  workspaceEnv,
  workspaceLabels,
} from "./workspaceSpec.ts";

const WORKSPACE_USER = `${WORKSPACE_UID}:${WORKSPACE_UID}`;
/** How long a starting workspace may take before a request gives up. */
const START_TIMEOUT = Duration.seconds(90);
/** Records what a container was made from, so one made from an older image or settings is made again. */
export const SPEC_LABEL = "codenine.spec";

/** Workspaces reach the egress proxy by this name on their own network. */
const EGRESS_ALIAS = "egress";
const EGRESS_URL = `http://${EGRESS_ALIAS}:${EGRESS_PORT}`;

/** Names for a workspace's container, volume and network, unique to this installation. */
export const workspaceNames = (installationId: string, workspaceId: string) => {
  const base = `codenine-${installationId}-${workspaceId}`;
  return { container: base, volume: `${base}-home`, network: base };
};

/** Names for the installation's egress proxy and the network it reaches out on. */
export const egressNames = (installationId: string) => {
  const base = `codenine-${installationId}-egress`;
  return { container: base, network: base };
};

const encoder = new TextEncoder();

/**
 * One container per person and department, made on its first request from the profile it
 * gets: its own volume, internal network and limits, and a token audience no other workspace
 * accepts. A stopped one starts on the next request, made again first if its image or settings
 * changed; a running one is never replaced.
 */
export const make = Effect.gen(function* () {
  const engine = yield* DockerEngine;
  const installation = yield* Installation;
  const { verifier } = yield* WorkspaceTokens;
  const profiles = yield* Profiles;
  const config = yield* WorkspaceConfig;
  const client = yield* HttpClient.HttpClient;
  const digest = yield* Digest.Digest;
  const dialPort = yield* WorkspaceDialPort;
  const sha256 = (text: string) => digest.digestHex(Digest.sha256, encoder.encode(text));

  const egress = egressNames(installation.id);
  const egressConfig = egressProxyConfig(yield* allowedHostsFromConfig);
  const proxy: ContainerSpec = {
    image: config.image,
    command: [
      "/bin/sh",
      "-c",
      'printf "%s\\n" "$SQUID_CONF" > /tmp/squid.conf && exec /usr/sbin/squid -N -f /tmp/squid.conf',
    ],
    env: { SQUID_CONF: egressConfig },
    labels: {
      "codenine.installation": installation.id,
      "codenine.role": "egress",
      // Only a change of hosts replaces the proxy, which cuts the connections it carries.
      [SPEC_LABEL]: yield* sha256(egressConfig),
    },
    user: WORKSPACE_USER,
    network: egress.network,
    nanoCpus: 1e9,
    memoryBytes: 256 * 1024 ** 2,
    restart: "unless-stopped",
  };

  const egressLock = yield* Semaphore.make(1);
  const ensureEgress = egressLock.withPermit(
    Effect.gen(function* () {
      const found = yield* engine.inspect(egress.container);
      const replaced =
        Option.isSome(found) && found.value.labels[SPEC_LABEL] !== proxy.labels[SPEC_LABEL];
      if (replaced) {
        yield* engine.removeContainer(egress.container);
      }
      if (Option.isNone(found) || replaced) {
        yield* engine.ensureNetwork(egress.network, proxy.labels, { internal: false });
        yield* engine.ensureContainer(egress.container, proxy);
        // A new proxy joins every workspace's network.
        const networks = yield* engine.listNetworks([
          `codenine.installation=${installation.id}`,
          "codenine.person",
        ]);
        for (const network of networks) {
          yield* engine.connect(network, egress.container, EGRESS_ALIAS);
        }
      }
      if (Option.isNone(found) || replaced || !found.value.running) {
        yield* engine.start(egress.container);
      }
    }),
  );

  const answers = (url: string) =>
    client
      .get(`${url}/.well-known/codenine/environment`)
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk), Effect.asVoid);

  /** What the workspace's container should be made from now. */
  const desired = Effect.fn("DockerWorkspaces.desired")(function* (key: WorkspaceKey) {
    const workspaceId = workspaceIdOf(key);
    const names = workspaceNames(installation.id, workspaceId);
    const owner = workspaceLabels(installation.id, key);
    const plan = yield* profiles.effective(key.personId, key.departmentId);
    const image = plan.image ?? config.image;
    const env = workspaceEnv({
      verifier,
      workspaceId,
      sleepMinutes: plan.sleepMinutes,
      proxyUrl: EGRESS_URL,
    });
    const nanoCpus = Math.round(plan.cpus * 1e9);
    const memoryBytes = Math.round(plan.memoryGb * 1024 ** 3);
    // The image by its ID, not its tag, so rebuilding the same tag counts as a change.
    const madeFrom = [
      yield* engine.imageId(image),
      ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
      WORKSPACE_USER,
      names.network,
      names.volume,
      WORKSPACE_HOME,
      nanoCpus,
      memoryBytes,
    ];
    const container: ContainerSpec = {
      image,
      env,
      labels: { ...owner, [SPEC_LABEL]: yield* sha256(madeFrom.join("\n")) },
      user: WORKSPACE_USER,
      network: names.network,
      volume: { name: names.volume, mountPath: WORKSPACE_HOME },
      nanoCpus,
      memoryBytes,
      restart: "no",
    };
    return { names, owner, container, workspaceId };
  });

  const start = Effect.fn("DockerWorkspaces.start")(
    function* (key: WorkspaceKey) {
      yield* ensureEgress;
      const { names, owner, container, workspaceId } = yield* desired(key);
      const found = yield* engine.inspect(names.container);
      const outdated =
        Option.isSome(found) &&
        !found.value.running &&
        found.value.labels[SPEC_LABEL] !== container.labels[SPEC_LABEL];
      if (outdated) {
        yield* engine.removeContainer(names.container);
      }
      const existing = outdated ? Option.none() : found;
      if (Option.isNone(existing)) {
        yield* engine.ensureVolume(names.volume, owner);
        yield* engine.ensureNetwork(names.network, owner, { internal: true });
        yield* engine.ensureContainer(names.container, container);
      }
      yield* engine.connect(names.network, egress.container, EGRESS_ALIAS);
      if (Option.isNone(existing) || !existing.value.running) {
        yield* engine.start(names.container);
      }
      const running = yield* engine.inspect(names.container);
      const address = Option.getOrUndefined(running)?.addresses[names.network];
      if (address === undefined) {
        return yield* new WorkspaceUnavailableError({
          cause: "The container has no address on its network.",
        });
      }
      const url = `http://${address}:${dialPort}`;
      // A fresh container takes a few seconds before its server answers.
      yield* answers(url).pipe(
        Effect.retry(Schedule.spaced("250 millis")),
        Effect.timeout(START_TIMEOUT),
      );
      return { url, workspaceId };
    },
    Effect.mapError((cause) => new WorkspaceUnavailableError({ cause })),
  );

  const targets = yield* cachedTargets(start);

  const ownedBy = (personId: string) => [
    `codenine.installation=${installation.id}`,
    `codenine.person=${personId}`,
  ];

  return WorkspaceManager.of({
    targetFor: Effect.fn("WorkspaceManager.targetFor")(function* (key: WorkspaceKey) {
      return yield* targets.targetFor(key);
    }),
    forget: Effect.fn("WorkspaceManager.forget")(function* (key: WorkspaceKey) {
      yield* targets.forget(key);
    }),
    isAsleep: Effect.fn("WorkspaceManager.isAsleep")(
      function* (key: WorkspaceKey) {
        const found = yield* engine.inspect(
          workspaceNames(installation.id, workspaceIdOf(key)).container,
        );
        return Option.isNone(found) || !found.value.running;
      },
      Effect.mapError((cause) => new WorkspaceUnavailableError({ cause })),
    ),
    retire: Effect.fn("WorkspaceManager.retire")(
      function* (key: WorkspaceKey) {
        const workspaceId = workspaceIdOf(key);
        const names = workspaceNames(installation.id, workspaceId);
        const removed = yield* engine.removeContainer(names.container);
        yield* engine.removeNetwork(names.network);
        yield* targets.drop(workspaceId);
        return removed;
      },
      Effect.mapError((cause) => new WorkspaceUnavailableError({ cause })),
    ),
    retireAll: Effect.fn("WorkspaceManager.retireAll")(
      function* (personId: string) {
        const containers = yield* engine.listContainers(ownedBy(personId));
        for (const container of containers) {
          yield* engine.removeContainer(container.name);
          // Each workspace's network has its container's name.
          yield* engine.removeNetwork(container.name);
          yield* targets.drop(container.labels["codenine.workspace"] ?? personId);
        }
        return containers.length > 0;
      },
      Effect.mapError((cause) => new WorkspaceUnavailableError({ cause })),
    ),
    removeFiles: Effect.fn("WorkspaceManager.removeFiles")(
      function* (personId: string) {
        const volumes = yield* engine.listVolumes(ownedBy(personId));
        for (const volume of volumes) {
          yield* engine.removeVolume(volume);
        }
        return volumes.length > 0;
      },
      Effect.mapError((cause) => new WorkspaceUnavailableError({ cause })),
    ),
  });
});

/** Docker workspaces, when `CODENINE_CONTROL_WORKSPACE_DRIVER` is `docker`. */
export const layer = Layer.effect(WorkspaceManager, make).pipe(
  Layer.provide(DockerEngine.layer),
  Layer.provide(NodeHttpClient.layerUndici),
);
