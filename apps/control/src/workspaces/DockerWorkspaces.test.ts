// @effect-diagnostics nodeBuiltinImport:off - the fake Docker Engine listens on a Unix socket, as Docker does.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { Installation } from "../installation/Installation.ts";
import { layerTestServices } from "../testing/layerTestServices.ts";
import { testKeyPair } from "../testing/testLicence.ts";
import { DockerEngine } from "./DockerEngine.ts";
import * as DockerWorkspaces from "./DockerWorkspaces.ts";
import { WorkspaceManager } from "./WorkspaceManager.ts";
import * as WorkspaceTokens from "./WorkspaceTokens.ts";

interface CreatedContainer {
  readonly name: string;
  readonly body: {
    readonly Env: ReadonlyArray<string>;
    readonly User: string;
    readonly HostConfig: Record<string, unknown>;
  };
}

/** An Engine API that keeps containers in memory; each publishes the same stand-in workspace. */
const fakeDocker = (workspacePort: number) => {
  const created: Array<CreatedContainer> = [];
  const starts: Array<string> = [];
  const running = new Map<string, boolean>();
  const nameParam = HttpRouter.params.pipe(Effect.map((params) => params["name"] ?? ""));
  const routes = Layer.mergeAll(
    HttpRouter.add(
      "POST",
      "/v1.44/volumes/create",
      Effect.succeed(HttpServerResponse.empty({ status: 201 })),
    ),
    HttpRouter.add(
      "POST",
      "/v1.44/networks/create",
      Effect.succeed(HttpServerResponse.empty({ status: 201 })),
    ),
    HttpRouter.add(
      "POST",
      "/v1.44/containers/create",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const name = new URL(request.url, "http://docker").searchParams.get("name") ?? "";
        if (running.has(name)) {
          return HttpServerResponse.empty({ status: 409 });
        }
        created.push({ name, body: (yield* request.json) as CreatedContainer["body"] });
        running.set(name, false);
        return HttpServerResponse.empty({ status: 201 });
      }).pipe(Effect.orDie),
    ),
    HttpRouter.add(
      "POST",
      "/v1.44/containers/:name/start",
      Effect.gen(function* () {
        const name = yield* nameParam;
        starts.push(name);
        const wasRunning = running.get(name) === true;
        running.set(name, true);
        return HttpServerResponse.empty({ status: wasRunning ? 304 : 204 });
      }),
    ),
    HttpRouter.add(
      "GET",
      "/v1.44/containers/:name/json",
      Effect.gen(function* () {
        const name = yield* nameParam;
        const state = running.get(name);
        return state === undefined
          ? HttpServerResponse.empty({ status: 404 })
          : HttpServerResponse.jsonUnsafe({
              State: { Running: state },
              NetworkSettings: {
                Ports: state
                  ? { "3773/tcp": [{ HostIp: "127.0.0.1", HostPort: String(workspacePort) }] }
                  : null,
              },
            });
      }),
    ),
  );
  return { created, starts, running, routes };
};

const serve = <E, R>(routes: Layer.Layer<never, E, R>, listen: NodeHttpServer.Options) =>
  Layer.build(
    HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(NodeHttp.createServer, listen)),
    ),
  ).pipe(Effect.map((context) => Context.get(context, HttpServer.HttpServer).address));

describe("DockerWorkspaces", () => {
  it.live("starts one hardened container per person, once, and restarts it after it stops", () =>
    Effect.gen(function* () {
      const keys = yield* testKeyPair;
      const workspace = yield* serve(
        HttpRouter.add(
          "GET",
          "/.well-known/codenine/environment",
          Effect.succeed(HttpServerResponse.jsonUnsafe({})),
        ),
        { host: "127.0.0.1", port: 0 },
      );
      const workspacePort = "port" in workspace ? workspace.port : 0;
      const docker = fakeDocker(workspacePort);
      const socketPath = NodePath.join(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codenine-docker-")),
        "docker.sock",
      );
      yield* serve(docker.routes, { path: socketPath });

      const manager = Layer.effect(WorkspaceManager, DockerWorkspaces.make).pipe(
        Layer.provide(DockerEngine.layerSocket(socketPath)),
        Layer.provide(NodeHttpClient.layerUndici),
        Layer.provideMerge(WorkspaceTokens.layer),
        Layer.provideMerge(layerTestServices(keys.publicKey)),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: { CODENINE_CONTROL_WORKSPACE_IMAGE: "codenine-workspace:test" },
            }),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const workspaces = yield* WorkspaceManager;
        const installation = yield* Installation;
        const ada = DockerWorkspaces.workspaceNames(installation.id, "per_ada");

        const [first, second] = yield* Effect.all(
          [workspaces.targetFor("per_ada"), workspaces.targetFor("per_ada")],
          { concurrency: "unbounded" },
        );
        expect(first).toEqual({ url: `http://127.0.0.1:${workspacePort}`, workspaceId: "per_ada" });
        expect(second).toEqual(first);
        expect(docker.created.map((container) => container.name)).toEqual([ada.container]);
        const [container] = docker.created;
        expect(container?.body.User).toBe("1000:1000");
        expect(container?.body.Env).toEqual(
          expect.arrayContaining([
            "CODENINE_MODE=managed",
            "CODENINE_MANAGED_WORKSPACE_ID=per_ada",
          ]),
        );
        expect(container?.body.HostConfig).toMatchObject({
          Mounts: [{ Type: "volume", Source: ada.volume, Target: DockerWorkspaces.WORKSPACE_HOME }],
          PortBindings: { "3773/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] },
          NetworkMode: ada.network,
          ReadonlyRootfs: true,
          SecurityOpt: ["no-new-privileges"],
          CapDrop: ["ALL"],
          NanoCpus: 2e9,
          Memory: 4 * 1024 ** 3,
        });

        // A stopped container is started again, not created again.
        docker.running.set(ada.container, false);
        yield* workspaces.forget("per_ada");
        expect(yield* workspaces.targetFor("per_ada")).toEqual(first);
        expect(docker.starts).toEqual([ada.container, ada.container]);
        expect(docker.created).toHaveLength(1);

        const bea = yield* workspaces.targetFor("per_bea");
        expect(bea.workspaceId).toBe("per_bea");
        expect(docker.created.map((created) => created.name)).toEqual([
          ada.container,
          DockerWorkspaces.workspaceNames(installation.id, "per_bea").container,
        ]);
      }).pipe(Effect.provide(manager));
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
});
