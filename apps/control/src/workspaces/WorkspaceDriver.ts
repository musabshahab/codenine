import * as Config from "effect/Config";
import type * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { Installation } from "../installation/Installation.ts";
import * as DockerWorkspaces from "./DockerWorkspaces.ts";
import * as KubernetesWorkspaces from "./KubernetesWorkspaces.ts";
import { WorkspaceManager } from "./WorkspaceManager.ts";
import type { WorkspaceTokens } from "./WorkspaceTokens.ts";

/** What any driver needs from the control server. */
type DriverLayer = Layer.Layer<
  WorkspaceManager,
  Config.ConfigError,
  Digest.Digest | Installation | WorkspaceTokens
>;

/**
 * The workspace manager `CODENINE_CONTROL_WORKSPACE_DRIVER` chooses: a Docker
 * container or a Kubernetes pod for each person, or one shared workspace
 * server at `CODENINE_CONTROL_WORKSPACE_URL`.
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const driver = yield* Config.String("CODENINE_CONTROL_WORKSPACE_DRIVER").pipe(
      Config.withDefault("shared"),
    );
    if (driver === "docker") {
      return DockerWorkspaces.layer satisfies DriverLayer as DriverLayer;
    }
    if (driver === "kubernetes") {
      return KubernetesWorkspaces.layer satisfies DriverLayer as DriverLayer;
    }
    if (driver !== "shared") {
      return yield* Effect.die(
        `CODENINE_CONTROL_WORKSPACE_DRIVER must be "docker", "kubernetes" or "shared", not "${driver}".`,
      );
    }
    const shared = yield* WorkspaceManager.sharedFromConfig;
    if (Option.isSome(shared)) {
      return Layer.succeed(WorkspaceManager, shared.value);
    }
    yield* Effect.logWarning(
      "No workspace is set up, so people can sign in but cannot work. Set CODENINE_CONTROL_WORKSPACE_DRIVER or CODENINE_CONTROL_WORKSPACE_URL.",
    );
    return Layer.succeed(WorkspaceManager, WorkspaceManager.none);
  }),
);
