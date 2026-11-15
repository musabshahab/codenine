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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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
    readonly Labels: Readonly<Record<string, string>>;
    readonly HostConfig: Record<string, unknown>;
  };
}

/** An Engine API that keeps containers in memory; each publishes the same stand-in workspace. */
const fakeDocker = (workspacePort: number) => {
  const created: Array<CreatedContainer> = [];
  const starts: Array<string> = [];
  const removed: Array<string> = [];
  const removedNetworks: Array<string> = [];
  const removedVolumes: Array<string> = [];
  const running = new Map<string, boolean>();
  const labels = new Map<string, Readonly<Record<string, string>>>();
  const image = { id: "sha256:first" };
  /** Set to make the next start wait: it signals `arrived`, then waits for `release`. */
  const held: {
    next?: { readonly arrived: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> };
  } = {};
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
      "GET",
      "/v1.44/images/*",
      Effect.sync(() => HttpServerResponse.jsonUnsafe({ Id: image.id })),
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
        const body = (yield* request.json) as CreatedContainer["body"];
        created.push({ name, body });
        running.set(name, false);
        labels.set(name, body.Labels);
        return HttpServerResponse.empty({ status: 201 });
      }).pipe(Effect.orDie),
    ),
    HttpRouter.add(
      "POST",
      "/v1.44/containers/:name/start",
      Effect.gen(function* () {
        const name = yield* nameParam;
        starts.push(name);
        const hold = held.next;
        delete held.next;
        if (hold !== undefined) {
          yield* Deferred.succeed(hold.arrived, undefined);
          yield* Deferred.await(hold.release);
        }
        const wasRunning = running.get(name) === true;
        running.set(name, true);
        return HttpServerResponse.empty({ status: wasRunning ? 304 : 204 });
      }),
    ),
    HttpRouter.add(
      "DELETE",
      "/v1.44/containers/:name",
      Effect.gen(function* () {
        const name = yield* nameParam;
        if (!running.has(name)) {
          return HttpServerResponse.empty({ status: 404 });
        }
        removed.push(name);
        running.delete(name);
        labels.delete(name);
        return HttpServerResponse.empty({ status: 204 });
      }),
    ),
    HttpRouter.add(
      "DELETE",
      "/v1.44/networks/:name",
      Effect.map(nameParam, (name) => {
        removedNetworks.push(name);
        return HttpServerResponse.empty({ status: 204 });
      }),
    ),
    HttpRouter.add(
      "DELETE",
      "/v1.44/volumes/:name",
      Effect.map(nameParam, (name) => {
        removedVolumes.push(name);
        return HttpServerResponse.empty({ status: 204 });
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
              Config: { Labels: labels.get(name) ?? null },
              NetworkSettings: {
                Ports: state
                  ? { "3773/tcp": [{ HostIp: "127.0.0.1", HostPort: String(workspacePort) }] }
                  : null,
              },
            });
      }),
    ),
  );
  const holdNextStart = Effect.gen(function* () {
    const hold = { arrived: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() };
    held.next = hold;
    return hold;
  });
  return {
    created,
    starts,
    removed,
    removedNetworks,
    removedVolumes,
    running,
    image,
    holdNextStart,
    routes,
  };
};

const serve = <E, R>(routes: Layer.Layer<never, E, R>, listen: NodeHttpServer.Options) =>
  Layer.build(
    HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(NodeHttp.createServer, listen)),
    ),
  ).pipe(Effect.map((context) => Context.get(context, HttpServer.HttpServer).address));

/** The Docker manager against a fake Engine API whose containers all publish one stand-in workspace. */
const withDockerWorkspaces = <A, E>(
  body: (fake: {
    readonly docker: ReturnType<typeof fakeDocker>;
    readonly workspacePort: number;
  }) => Effect.Effect<A, E, WorkspaceManager | Installation>,
) =>
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
    return yield* body({ docker, workspacePort }).pipe(Effect.provide(manager));
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

describe("DockerWorkspaces", () => {
  it.live("starts one hardened container per person, once, and restarts it after it stops", () =>
    withDockerWorkspaces(({ docker, workspacePort }) =>
      Effect.gen(function* () {
        const workspaces = yield* WorkspaceManager;
        const installation = yield* Installation;
        const ada = DockerWorkspaces.workspaceNames(installation.id, "per_ada");
        expect(yield* workspaces.isAsleep("per_ada")).toBe(true);

        const [first, second] = yield* Effect.all(
          [workspaces.targetFor("per_ada"), workspaces.targetFor("per_ada")],
          { concurrency: "unbounded" },
        );
        expect(first).toEqual({ url: `http://127.0.0.1:${workspacePort}`, workspaceId: "per_ada" });
        expect(second).toEqual(first);
        expect(yield* workspaces.isAsleep("per_ada")).toBe(false);
        expect(docker.created.map((container) => container.name)).toEqual([ada.container]);
        const [container] = docker.created;
        expect(container?.body.User).toBe("1000:1000");
        expect(container?.body.Env).toEqual(
          expect.arrayContaining([
            "CODENINE_MODE=managed",
            "CODENINE_MANAGED_WORKSPACE_ID=per_ada",
            "CODENINE_MANAGED_SLEEP_MINUTES=30",
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

        // A stopped container is asleep, and is started again, not created again.
        docker.running.set(ada.container, false);
        expect(yield* workspaces.isAsleep("per_ada")).toBe(true);
        yield* workspaces.forget("per_ada");
        expect(yield* workspaces.targetFor("per_ada")).toEqual(first);
        expect(docker.starts).toEqual([ada.container, ada.container]);
        expect(docker.created).toHaveLength(1);

        const bea = DockerWorkspaces.workspaceNames(installation.id, "per_bea");
        expect((yield* workspaces.targetFor("per_bea")).workspaceId).toBe("per_bea");
        expect(docker.created.map((created) => created.name)).toEqual([
          ada.container,
          bea.container,
        ]);

        // When Bea leaves, her container and network go; her files stay until they are removed.
        expect(yield* workspaces.retire("per_bea")).toBe(true);
        expect(yield* workspaces.retire("per_bea")).toBe(false);
        expect([docker.removed, docker.removedVolumes]).toEqual([[bea.container], []]);
        expect(docker.removedNetworks).toContain(bea.network);
        expect(yield* workspaces.isAsleep("per_bea")).toBe(true);
        yield* workspaces.removeFiles("per_bea");
        expect(docker.removedVolumes).toEqual([bea.volume]);
      }),
    ),
  );

  it.live("joins a start already under way when asked to look again, such as by a second tab", () =>
    withDockerWorkspaces(({ docker }) =>
      Effect.gen(function* () {
        const workspaces = yield* WorkspaceManager;
        const hold = yield* docker.holdNextStart;
        const first = yield* workspaces.targetFor("per_ada").pipe(Effect.forkChild);
        yield* Deferred.await(hold.arrived);

        yield* workspaces.forget("per_ada");
        const second = yield* workspaces.targetFor("per_ada").pipe(Effect.forkChild);
        yield* Deferred.succeed(hold.release, undefined);
        expect(yield* Fiber.join(second)).toBe(yield* Fiber.join(first));
        expect(docker.starts).toHaveLength(1);
      }),
    ),
  );

  it.live("makes a stopped workspace again from a new image, keeping its volume", () =>
    withDockerWorkspaces(({ docker }) =>
      Effect.gen(function* () {
        const workspaces = yield* WorkspaceManager;
        const installation = yield* Installation;
        const ada = DockerWorkspaces.workspaceNames(installation.id, "per_ada");
        yield* workspaces.targetFor("per_ada");

        // The tag now points at a rebuilt image. A running workspace keeps working as it is.
        docker.image.id = "sha256:second";
        yield* workspaces.forget("per_ada");
        yield* workspaces.targetFor("per_ada");
        expect(docker.removed).toEqual([]);

        docker.running.set(ada.container, false);
        yield* workspaces.forget("per_ada");
        yield* workspaces.targetFor("per_ada");
        expect(docker.removed).toEqual([ada.container]);
        const [before, after] = docker.created.map((created) => created.body);
        expect(after?.HostConfig).toMatchObject({ Mounts: [{ Source: ada.volume }] });
        expect(after?.Labels[DockerWorkspaces.SPEC_LABEL]).not.toBe(
          before?.Labels[DockerWorkspaces.SPEC_LABEL],
        );
        expect(yield* workspaces.isAsleep("per_ada")).toBe(false);
      }),
    ),
  );
});
