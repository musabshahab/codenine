import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as Cache from "effect/Cache";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { Installation } from "../installation/Installation.ts";
import { DockerEngine } from "./DockerEngine.ts";
import { WorkspaceManager, WorkspaceUnavailableError } from "./WorkspaceManager.ts";
import { WorkspaceTokens } from "./WorkspaceTokens.ts";

/** The port the workspace server listens on inside its container. */
export const WORKSPACE_PORT = 3773;
/** The person's home in the container, kept on their own volume. */
export const WORKSPACE_HOME = "/home/codenine";
const WORKSPACE_USER = "1000:1000";
/** How long a starting workspace may take before a request gives up. */
const START_TIMEOUT = Duration.seconds(90);

const DockerWorkspacesConfig = Config.all({
  image: Config.String("CODENINE_CONTROL_WORKSPACE_IMAGE"),
  cpus: Config.Number("CODENINE_CONTROL_WORKSPACE_CPUS").pipe(Config.withDefault(2)),
  memoryGb: Config.Number("CODENINE_CONTROL_WORKSPACE_MEMORY_GB").pipe(Config.withDefault(4)),
});

/** Names for a person's container, volume and network, unique to this installation. */
export const workspaceNames = (installationId: string, personId: string) => {
  const base = `codenine-${installationId}-${personId}`;
  return { container: base, volume: `${base}-home`, network: base };
};

/**
 * One container per person, created on their first request: their own volume
 * for their home, their own network, CPU and memory limits, and a token
 * audience no other workspace accepts.
 */
export const make = Effect.gen(function* () {
  const engine = yield* DockerEngine;
  const installation = yield* Installation;
  const { verifier } = yield* WorkspaceTokens;
  const config = yield* DockerWorkspacesConfig;
  const client = yield* HttpClient.HttpClient;

  const answers = (url: string) =>
    client
      .get(`${url}/.well-known/codenine/environment`)
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk), Effect.asVoid);

  const start = Effect.fn("DockerWorkspaces.start")(
    function* (personId: string) {
      const names = workspaceNames(installation.id, personId);
      const labels = { "codenine.installation": installation.id, "codenine.person": personId };
      const existing = yield* engine.inspect(names.container, WORKSPACE_PORT);
      if (Option.isNone(existing)) {
        yield* engine.ensureVolume(names.volume, labels);
        yield* engine.ensureNetwork(names.network, labels);
        yield* engine.ensureContainer(names.container, {
          image: config.image,
          env: {
            CODENINE_MODE: "managed",
            CODENINE_MANAGED_ISSUER: verifier.issuer,
            CODENINE_MANAGED_KEY_ID: verifier.keyId,
            CODENINE_MANAGED_PUBLIC_KEY: verifier.publicKey,
            CODENINE_MANAGED_WORKSPACE_ID: personId,
          },
          labels,
          port: WORKSPACE_PORT,
          volume: names.volume,
          mountPath: WORKSPACE_HOME,
          network: names.network,
          user: WORKSPACE_USER,
          nanoCpus: Math.round(config.cpus * 1e9),
          memoryBytes: Math.round(config.memoryGb * 1024 ** 3),
        });
      }
      if (Option.isNone(existing) || !existing.value.running) {
        yield* engine.start(names.container);
      }
      const running = yield* engine.inspect(names.container, WORKSPACE_PORT);
      const hostPort = Option.getOrUndefined(running)?.hostPort ?? null;
      if (hostPort === null) {
        return yield* new WorkspaceUnavailableError({
          cause: "The container has no published port.",
        });
      }
      const url = `http://127.0.0.1:${hostPort}`;
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
      yield* Cache.invalidate(targets, personId);
    }),
  });
});

/** Docker workspaces, when `CODENINE_CONTROL_WORKSPACE_DRIVER` is `docker`. */
export const layer = Layer.effect(WorkspaceManager, make).pipe(
  Layer.provide(DockerEngine.layer),
  Layer.provide(NodeHttpClient.layerUndici),
);
