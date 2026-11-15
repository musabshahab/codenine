import type { ControlEffectiveProfile } from "@codenine/contracts/control";
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
  egressHosts,
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

/** The network every egress proxy reaches out on, and each proxy's name by its settings' digest. */
export const egressNames = (installationId: string) => {
  const network = `codenine-${installationId}-egress`;
  return { network, proxy: (digest: string) => `${network}-${digest.slice(0, 12)}` };
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

  const installationHosts = yield* allowedHostsFromConfig;
  const egressLabels = { "codenine.installation": installation.id, "codenine.role": "egress" };
  const egressFilter = Object.entries(egressLabels).map(([key, value]) => `${key}=${value}`);
  const egress = egressNames(installation.id);

  /** The proxy allowing what one profile may reach, shared by every workspace with the same hosts. */
  const proxyFor = Effect.fn("DockerWorkspaces.proxyFor")(function* (
    profile: ControlEffectiveProfile,
  ) {
    const hosts = egressHosts(installationHosts, profile);
    const settings = egressProxyConfig(hosts.allowed, hosts.blocked);
    const name = egress.proxy(yield* sha256(settings));
    const spec: ContainerSpec = {
      image: config.image,
      command: [
        "/bin/sh",
        "-c",
        'printf "%s\\n" "$SQUID_CONF" > /tmp/squid.conf && exec /usr/sbin/squid -N -f /tmp/squid.conf',
      ],
      env: { SQUID_CONF: settings },
      labels: egressLabels,
      user: WORKSPACE_USER,
      network: egress.network,
      nanoCpus: 1e9,
      memoryBytes: 256 * 1024 ** 2,
      restart: "unless-stopped",
    };
    return { name, spec };
  });

  // Every change to which proxy serves which network holds this, so none sees another's half.
  const egressLock = yield* Semaphore.make(1);

  /**
   * Puts the proxy for the workspace's hosts on its network as the only one
   * answering to the egress name. The profile is read here, under the lock, so
   * the last change to land is the one that stays.
   */
  const attachEgress = Effect.fn("DockerWorkspaces.attachEgress")(function* (
    network: string,
    key: WorkspaceKey,
  ) {
    const proxy = yield* proxyFor(yield* profiles.effective(key.personId, key.departmentId));
    const found = yield* engine.inspect(proxy.name);
    if (Option.isNone(found)) {
      yield* engine.ensureNetwork(egress.network, egressLabels, { internal: false });
      yield* engine.ensureContainer(proxy.name, proxy.spec);
    }
    if (Option.isNone(found) || !found.value.running) {
      yield* engine.start(proxy.name);
    }
    // The old proxy leaves first: for a moment nothing answers, rather than both.
    for (const other of yield* engine.listContainers(egressFilter)) {
      if (other.name !== proxy.name && other.networks.includes(network)) {
        yield* engine.disconnect(network, other.name);
      }
    }
    yield* engine.connect(network, proxy.name, EGRESS_ALIAS);
  });

  /** Removes the proxies no workspace's network carries any more. */
  const pruneEgress = Effect.gen(function* () {
    for (const proxy of yield* engine.listContainers(egressFilter)) {
      if (proxy.networks.every((network) => network === egress.network)) {
        yield* engine.removeContainer(proxy.name);
      }
    }
  }).pipe(Effect.withSpan("DockerWorkspaces.pruneEgress"));

  /** Gives each of these workspaces that is made the proxy for its hosts now. */
  const reroute = Effect.fn("DockerWorkspaces.reroute")(function* (
    keys: ReadonlyArray<WorkspaceKey>,
  ) {
    for (const key of keys) {
      const names = workspaceNames(installation.id, workspaceIdOf(key));
      // A start in between takes the lock too, and no network goes while its container is there.
      yield* egressLock.withPermit(
        Effect.gen(function* () {
          if (Option.isSome(yield* engine.inspect(names.container))) {
            yield* attachEgress(names.network, key);
          }
        }),
      );
    }
    yield* egressLock.withPermit(pruneEgress);
  });

  // At start and every hour after, for what changed with no admin action: the installation's
  // hosts, a change made while the server was down, or an exception that ran out.
  yield* Effect.gen(function* () {
    const made = yield* engine.listContainers([
      `codenine.installation=${installation.id}`,
      "codenine.person",
    ]);
    yield* reroute(
      made.flatMap(({ labels }) => {
        const personId = labels["codenine.person"];
        return personId === undefined
          ? []
          : [{ personId, departmentId: labels["codenine.department"] ?? null }];
      }),
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("Workspaces' egress proxies could not be brought up to date.", cause),
    ),
    Effect.repeat(Schedule.spaced(Duration.hours(1))),
    Effect.forkScoped,
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
      yield* egressLock.withPermit(
        attachEgress(names.network, key).pipe(Effect.andThen(pruneEgress)),
      );
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
    applyNetwork: Effect.fn("WorkspaceManager.applyNetwork")(
      function* (keys: ReadonlyArray<WorkspaceKey>) {
        yield* reroute(keys);
      },
      Effect.mapError((cause) => new WorkspaceUnavailableError({ cause })),
    ),
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
        yield* egressLock.withPermit(
          engine.removeNetwork(names.network).pipe(Effect.andThen(pruneEgress)),
        );
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
          yield* targets.drop(container.labels["codenine.workspace"] ?? personId);
        }
        yield* egressLock.withPermit(
          Effect.gen(function* () {
            for (const container of containers) {
              // Each workspace's network has its container's name.
              yield* engine.removeNetwork(container.name);
            }
            yield* pruneEgress;
          }),
        );
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
