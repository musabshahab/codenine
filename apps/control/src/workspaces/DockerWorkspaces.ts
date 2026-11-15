import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as Cache from "effect/Cache";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { Installation } from "../installation/Installation.ts";
import { type ContainerSpec, DockerEngine } from "./DockerEngine.ts";
import { WorkspaceManager, WorkspaceUnavailableError } from "./WorkspaceManager.ts";
import { WorkspaceTokens } from "./WorkspaceTokens.ts";

/** The port the workspace server listens on inside its container. */
export const WORKSPACE_PORT = 3773;
/** The port the control server dials; tests point it at a stand-in workspace. */
export const WorkspaceDialPort = Context.Reference<number>(
  "@codenine/control/workspaces/DockerWorkspaces/WorkspaceDialPort",
  { defaultValue: () => WORKSPACE_PORT },
);
/** The person's home in the container, kept on their own volume. */
export const WORKSPACE_HOME = "/home/codenine";
const WORKSPACE_USER = "1000:1000";
/** How long a starting workspace may take before a request gives up. */
const START_TIMEOUT = Duration.seconds(90);
/** Records what a container was made from, so one made from an older image or settings is made again. */
export const SPEC_LABEL = "codenine.spec";

/** Workspaces reach the egress proxy by this name on their own network. */
const EGRESS_ALIAS = "egress";
const EGRESS_PORT = 3128;
const EGRESS_URL = `http://${EGRESS_ALIAS}:${EGRESS_PORT}`;

/** What every workspace may reach: model providers and their sign-in, GitHub, package registries. */
export const DEFAULT_ALLOWED_HOSTS: ReadonlyArray<string> = [
  ".anthropic.com",
  ".claude.ai",
  ".claude.com",
  ".openai.com",
  ".chatgpt.com",
  ".github.com",
  ".githubusercontent.com",
  ".npmjs.org",
  ".yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  ".crates.io",
  "proxy.golang.org",
  "sum.golang.org",
  "repo.maven.apache.org",
  "repo1.maven.org",
];
/** A host name, or with a leading dot, a domain and everything under it. */
const HOST = /^\.?[a-z0-9-]+(\.[a-z0-9-]+)+$/u;

/** The default hosts and an admin's own, leaving out any that a wider entry covers. */
export const allowedHosts = (extra: ReadonlyArray<string>) => {
  const all = [...new Set([...DEFAULT_ALLOWED_HOSTS, ...extra])];
  const covers = (wide: string, host: string) =>
    wide !== host && wide.startsWith(".") && (host === wide.slice(1) || host.endsWith(wide));
  return all.filter((host) => !all.some((other) => covers(other, host)));
};

/** Squid allowing only those hosts, on the usual web ports, with no cache. */
export const egressProxyConfig = (hosts: ReadonlyArray<string>) =>
  [
    `http_port ${EGRESS_PORT}`,
    "pid_filename none",
    "pinger_enable off",
    "netdb_filename none",
    "cache deny all",
    "coredump_dir /tmp",
    "access_log stdio:/dev/stdout",
    "cache_log /dev/stderr",
    // -n matches names only, so a request for a bare address never matches.
    `acl allowed dstdomain -n ${hosts.join(" ")}`,
    "acl SSL_ports port 443",
    "acl Safe_ports port 80 443",
    "acl CONNECT method CONNECT",
    "http_access deny !Safe_ports",
    "http_access deny CONNECT !SSL_ports",
    "http_access allow allowed",
    "http_access deny all",
  ].join("\n");

const DockerWorkspacesConfig = Config.all({
  image: Config.String("CODENINE_CONTROL_WORKSPACE_IMAGE"),
  cpus: Config.Number("CODENINE_CONTROL_WORKSPACE_CPUS").pipe(Config.withDefault(2)),
  memoryGb: Config.Number("CODENINE_CONTROL_WORKSPACE_MEMORY_GB").pipe(Config.withDefault(4)),
  sleepMinutes: Config.Number("CODENINE_CONTROL_WORKSPACE_SLEEP_MINUTES").pipe(
    Config.withDefault(30),
  ),
  allowedHosts: Config.String("CODENINE_CONTROL_WORKSPACE_ALLOWED_HOSTS").pipe(
    Config.withDefault(""),
    Config.map((value) =>
      value
        .split(/[\s,]+/u)
        .map((host) => host.toLowerCase())
        .filter((host) => host.length > 0),
    ),
  ),
});

/** Names for a person's container, volume and network, unique to this installation. */
export const workspaceNames = (installationId: string, personId: string) => {
  const base = `codenine-${installationId}-${personId}`;
  return { container: base, volume: `${base}-home`, network: base };
};

/** Names for the installation's egress proxy and the network it reaches out on. */
export const egressNames = (installationId: string) => {
  const base = `codenine-${installationId}-egress`;
  return { container: base, network: base };
};

const encoder = new TextEncoder();

/**
 * One container per person, made on their first request: their own volume, internal network and
 * limits, and a token audience no other workspace accepts. A stopped one starts on the next
 * request, made again first if its image or settings changed; a running one is never replaced.
 */
export const make = Effect.gen(function* () {
  const engine = yield* DockerEngine;
  const installation = yield* Installation;
  const { verifier } = yield* WorkspaceTokens;
  const config = yield* DockerWorkspacesConfig;
  const client = yield* HttpClient.HttpClient;
  const digest = yield* Digest.Digest;
  const dialPort = yield* WorkspaceDialPort;
  const sha256 = (text: string) => digest.digestHex(Digest.sha256, encoder.encode(text));

  const invalidHosts = config.allowedHosts.filter((host) => !HOST.test(host));
  if (invalidHosts.length > 0) {
    return yield* Effect.die(
      `CODENINE_CONTROL_WORKSPACE_ALLOWED_HOSTS has entries that are not host names: ${invalidHosts.join(", ")}.`,
    );
  }

  const egress = egressNames(installation.id);
  const egressConfig = egressProxyConfig(allowedHosts(config.allowedHosts));
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

  /** What the person's container should be made from now. */
  const desired = Effect.fn("DockerWorkspaces.desired")(function* (personId: string) {
    const names = workspaceNames(installation.id, personId);
    const owner = { "codenine.installation": installation.id, "codenine.person": personId };
    const env = {
      CODENINE_MODE: "managed",
      CODENINE_MANAGED_ISSUER: verifier.issuer,
      CODENINE_MANAGED_KEY_ID: verifier.keyId,
      CODENINE_MANAGED_PUBLIC_KEY: verifier.publicKey,
      CODENINE_MANAGED_WORKSPACE_ID: personId,
      CODENINE_MANAGED_SLEEP_MINUTES: String(config.sleepMinutes),
      // Its network leads nowhere else: everything outside goes through the proxy.
      HTTP_PROXY: EGRESS_URL,
      HTTPS_PROXY: EGRESS_URL,
      http_proxy: EGRESS_URL,
      https_proxy: EGRESS_URL,
      NO_PROXY: "localhost,127.0.0.1",
      no_proxy: "localhost,127.0.0.1",
      NODE_USE_ENV_PROXY: "1",
    };
    const nanoCpus = Math.round(config.cpus * 1e9);
    const memoryBytes = Math.round(config.memoryGb * 1024 ** 3);
    // The image by its ID, not its tag, so rebuilding the same tag counts as a change.
    const madeFrom = [
      yield* engine.imageId(config.image),
      ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
      WORKSPACE_USER,
      names.network,
      names.volume,
      WORKSPACE_HOME,
      nanoCpus,
      memoryBytes,
    ];
    const container: ContainerSpec = {
      image: config.image,
      env,
      labels: { ...owner, [SPEC_LABEL]: yield* sha256(madeFrom.join("\n")) },
      user: WORKSPACE_USER,
      network: names.network,
      volume: { name: names.volume, mountPath: WORKSPACE_HOME },
      nanoCpus,
      memoryBytes,
      restart: "no",
    };
    return { names, owner, container };
  });

  const start = Effect.fn("DockerWorkspaces.start")(
    function* (personId: string) {
      yield* ensureEgress;
      const { names, owner, container } = yield* desired(personId);
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
      return { url, workspaceId: personId };
    },
    Effect.mapError((cause) => new WorkspaceUnavailableError({ cause })),
  );

  // Concurrent first requests share one start; a failed start is tried again next time.
  const targets = yield* Cache.makeWith(start, {
    capacity: 10_000,
    timeToLive: (exit) => (Exit.isFailure(exit) ? Duration.zero : Duration.infinity),
  });

  return WorkspaceManager.of({
    targetFor: Effect.fn("WorkspaceManager.targetFor")(function* (personId: string) {
      return yield* Cache.get(targets, personId);
    }),
    forget: Effect.fn("WorkspaceManager.forget")(function* (personId: string) {
      // A start under way finds the workspace afresh; dropping it would run a second one beside it.
      const known = yield* Cache.getSuccess(targets, personId);
      if (Option.isSome(known)) {
        yield* Cache.invalidateWhen(targets, personId, (target) => target === known.value);
      }
    }),
    isAsleep: Effect.fn("WorkspaceManager.isAsleep")(
      function* (personId: string) {
        const found = yield* engine.inspect(workspaceNames(installation.id, personId).container);
        return Option.isNone(found) || !found.value.running;
      },
      Effect.mapError((cause) => new WorkspaceUnavailableError({ cause })),
    ),
    retire: Effect.fn("WorkspaceManager.retire")(
      function* (personId: string) {
        const names = workspaceNames(installation.id, personId);
        const removed = yield* engine.removeContainer(names.container);
        yield* engine.removeNetwork(names.network);
        yield* Cache.invalidate(targets, personId);
        return removed;
      },
      Effect.mapError((cause) => new WorkspaceUnavailableError({ cause })),
    ),
    removeFiles: Effect.fn("WorkspaceManager.removeFiles")(
      function* (personId: string) {
        return yield* engine.removeVolume(workspaceNames(installation.id, personId).volume);
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
