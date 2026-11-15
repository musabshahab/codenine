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

import { ControlDb } from "../db.ts";
import { Departments } from "../departments/Departments.ts";
import { Installation } from "../installation/Installation.ts";
import { controlPeople } from "../persistence/schema.ts";
import { Profiles } from "../profiles/Profiles.ts";
import { layerTestServices } from "../testing/layerTestServices.ts";
import { testKeyPair } from "../testing/testLicence.ts";
import { DockerEngine } from "./DockerEngine.ts";
import * as DockerWorkspaces from "./DockerWorkspaces.ts";
import { WorkspaceManager } from "./WorkspaceManager.ts";
import * as WorkspaceTokens from "./WorkspaceTokens.ts";
import { WORKSPACE_HOME, WorkspaceDialPort } from "./workspaceSpec.ts";

interface CreatedContainer {
  readonly name: string;
  readonly body: {
    readonly Image: string;
    readonly Entrypoint?: ReadonlyArray<string>;
    readonly Env: ReadonlyArray<string>;
    readonly User: string;
    readonly Labels: Readonly<Record<string, string>>;
    readonly HostConfig: Record<string, unknown> & { readonly NetworkMode: string };
  };
}

interface FakeNetwork {
  readonly internal: boolean;
  readonly labels: Readonly<Record<string, string>>;
  /** Each container on it, with its aliases. */
  readonly containers: Map<string, ReadonlyArray<string>>;
}

/** An Engine API that keeps containers and networks in memory, refusing what Docker refuses. */
const fakeDocker = () => {
  const created: Array<CreatedContainer> = [];
  const starts: Array<string> = [];
  const removed: Array<string> = [];
  const removedNetworks: Array<string> = [];
  const removedVolumes: Array<string> = [];
  const running = new Map<string, boolean>();
  const labels = new Map<string, Readonly<Record<string, string>>>();
  const networks = new Map<string, FakeNetwork>();
  const volumes = new Map<string, Readonly<Record<string, string>>>();
  const image = { id: "sha256:first" };
  /** Set to make the next start of one container wait: it signals `arrived`, then waits for `release`. */
  const held: {
    next?: {
      readonly name: string;
      readonly arrived: Deferred.Deferred<void>;
      readonly release: Deferred.Deferred<void>;
    };
  } = {};
  const nameParam = HttpRouter.params.pipe(Effect.map((params) => params["name"] ?? ""));
  const body = <A>() =>
    HttpServerRequest.HttpServerRequest.pipe(
      Effect.flatMap((request) => request.json),
      Effect.map((json) => json as A),
      Effect.orDie,
    );
  /** Whether labels carry every `key` or `key=value` of the request's label filter. */
  const matching = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const filters = JSON.parse(
      new URL(request.url, "http://docker").searchParams.get("filters") ?? "{}",
    ) as { label?: Array<string> };
    return (carried: Readonly<Record<string, string>>) =>
      (filters.label ?? []).every((wanted) => {
        const [key = "", value] = wanted.split("=");
        return value === undefined ? key in carried : carried[key] === value;
      });
  });
  const routes = Layer.mergeAll(
    HttpRouter.add(
      "POST",
      "/v1.44/volumes/create",
      Effect.gen(function* () {
        const { Name, Labels } = yield* body<{ Name: string; Labels: Record<string, string> }>();
        if (!volumes.has(Name)) volumes.set(Name, Labels);
        return HttpServerResponse.empty({ status: 201 });
      }),
    ),
    HttpRouter.add(
      "GET",
      "/v1.44/volumes",
      Effect.map(matching, (matches) =>
        HttpServerResponse.jsonUnsafe({
          Volumes: [...volumes].flatMap(([Name, carried]) => (matches(carried) ? [{ Name }] : [])),
        }),
      ),
    ),
    HttpRouter.add(
      "GET",
      "/v1.44/containers/json",
      Effect.map(matching, (matches) =>
        HttpServerResponse.jsonUnsafe(
          [...labels].flatMap(([name, carried]) =>
            matches(carried) ? [{ Names: [`/${name}`], Labels: carried }] : [],
          ),
        ),
      ),
    ),
    HttpRouter.add(
      "POST",
      "/v1.44/networks/create",
      Effect.gen(function* () {
        const { Name, Internal, Labels } = yield* body<{
          Name: string;
          Internal: boolean;
          Labels: Record<string, string>;
        }>();
        if (networks.has(Name)) {
          return HttpServerResponse.empty({ status: 409 });
        }
        networks.set(Name, { internal: Internal, labels: Labels, containers: new Map() });
        return HttpServerResponse.empty({ status: 201 });
      }),
    ),
    HttpRouter.add(
      "GET",
      "/v1.44/networks",
      Effect.map(matching, (matches) =>
        HttpServerResponse.jsonUnsafe(
          [...networks].flatMap(([Name, network]) => (matches(network.labels) ? [{ Name }] : [])),
        ),
      ),
    ),
    HttpRouter.add(
      "GET",
      "/v1.44/networks/:name",
      Effect.map(nameParam, (name) => {
        const network = networks.get(name);
        return network === undefined
          ? HttpServerResponse.empty({ status: 404 })
          : HttpServerResponse.jsonUnsafe({
              Internal: network.internal,
              Containers: Object.fromEntries([...network.containers.keys()].map((id) => [id, {}])),
            });
      }),
    ),
    HttpRouter.add(
      "POST",
      "/v1.44/networks/:name/connect",
      Effect.gen(function* () {
        const network = networks.get(yield* nameParam);
        const { Container, EndpointConfig } = yield* body<{
          Container: string;
          EndpointConfig: { Aliases: Array<string> };
        }>();
        if (network === undefined) {
          return HttpServerResponse.empty({ status: 404 });
        }
        if (network.containers.has(Container)) {
          return HttpServerResponse.empty({ status: 403 });
        }
        network.containers.set(Container, EndpointConfig.Aliases);
        return HttpServerResponse.empty({ status: 200 });
      }),
    ),
    HttpRouter.add(
      "POST",
      "/v1.44/networks/:name/disconnect",
      Effect.gen(function* () {
        const network = networks.get(yield* nameParam);
        const { Container } = yield* body<{ Container: string }>();
        return HttpServerResponse.empty({
          status: network?.containers.delete(Container) === true ? 200 : 500,
        });
      }),
    ),
    HttpRouter.add(
      "DELETE",
      "/v1.44/networks/:name",
      Effect.map(nameParam, (name) => {
        const network = networks.get(name);
        if (network === undefined) {
          return HttpServerResponse.empty({ status: 404 });
        }
        if (network.containers.size > 0) {
          return HttpServerResponse.empty({ status: 403 });
        }
        networks.delete(name);
        removedNetworks.push(name);
        return HttpServerResponse.empty({ status: 204 });
      }),
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
        const container = yield* body<CreatedContainer["body"]>();
        created.push({ name, body: container });
        running.set(name, false);
        labels.set(name, container.Labels);
        networks.get(container.HostConfig.NetworkMode)?.containers.set(name, []);
        return HttpServerResponse.empty({ status: 201 });
      }),
    ),
    HttpRouter.add(
      "POST",
      "/v1.44/containers/:name/start",
      Effect.gen(function* () {
        const name = yield* nameParam;
        starts.push(name);
        const hold = held.next?.name === name ? held.next : undefined;
        if (hold !== undefined) {
          delete held.next;
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
      Effect.map(nameParam, (name) => {
        if (!running.has(name)) {
          return HttpServerResponse.empty({ status: 404 });
        }
        removed.push(name);
        running.delete(name);
        labels.delete(name);
        for (const network of networks.values()) network.containers.delete(name);
        return HttpServerResponse.empty({ status: 204 });
      }),
    ),
    HttpRouter.add(
      "DELETE",
      "/v1.44/volumes/:name",
      Effect.map(nameParam, (name) => {
        if (!volumes.delete(name)) {
          return HttpServerResponse.empty({ status: 404 });
        }
        removedVolumes.push(name);
        return HttpServerResponse.empty({ status: 204 });
      }),
    ),
    HttpRouter.add(
      "GET",
      "/v1.44/containers/:name/json",
      Effect.map(nameParam, (name) => {
        const state = running.get(name);
        // Every container answers on loopback, where the stand-in workspace listens.
        const on = [...networks].filter(([, network]) => network.containers.has(name));
        return state === undefined
          ? HttpServerResponse.empty({ status: 404 })
          : HttpServerResponse.jsonUnsafe({
              State: { Running: state },
              Config: { Labels: labels.get(name) ?? null },
              NetworkSettings: {
                Networks: Object.fromEntries(
                  on.map(([network]) => [network, { IPAddress: state ? "127.0.0.1" : "" }]),
                ),
              },
            });
      }),
    ),
  );
  const holdNextStart = (name: string) =>
    Effect.gen(function* () {
      const hold = {
        name,
        arrived: yield* Deferred.make<void>(),
        release: yield* Deferred.make<void>(),
      };
      held.next = hold;
      return hold;
    });
  /** Workspace containers made, leaving out the egress proxy. */
  const workspacesCreated = () =>
    created.filter((container) => container.body.Labels["codenine.person"] !== undefined);
  return {
    created,
    workspacesCreated,
    starts,
    removed,
    removedNetworks,
    removedVolumes,
    running,
    labels,
    networks,
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

/** The Docker manager against a fake Engine API whose containers all answer as one stand-in workspace. */
const withDockerWorkspaces = <A, E>(
  body: (fake: {
    readonly docker: ReturnType<typeof fakeDocker>;
    readonly workspacePort: number;
  }) => Effect.Effect<A, E, WorkspaceManager | Installation | ControlDb | Departments | Profiles>,
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
    const docker = fakeDocker();
    const socketPath = NodePath.join(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codenine-docker-")),
      "docker.sock",
    );
    yield* serve(docker.routes, { path: socketPath });

    const manager = Layer.effect(WorkspaceManager, DockerWorkspaces.make).pipe(
      Layer.provide(DockerEngine.layerSocket(socketPath)),
      Layer.provide(NodeHttpClient.layerUndici),
      Layer.provide(Layer.succeed(WorkspaceDialPort, workspacePort)),
      Layer.provideMerge(WorkspaceTokens.layer),
      Layer.provideMerge(layerTestServices(keys.publicKey)),
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              CODENINE_CONTROL_WORKSPACE_IMAGE: "codenine-workspace:test",
              CODENINE_CONTROL_WORKSPACE_ALLOWED_HOSTS: "git.acme.test, api.github.com",
            },
          }),
        ),
      ),
    );
    return yield* body({ docker, workspacePort }).pipe(Effect.provide(manager));
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const ADA = { personId: "per_ada", departmentId: null };
const BEA = { personId: "per_bea", departmentId: null };

describe("DockerWorkspaces", () => {
  it.live("starts one hardened container per person, once, and restarts it after it stops", () =>
    withDockerWorkspaces(({ docker, workspacePort }) =>
      Effect.gen(function* () {
        const workspaces = yield* WorkspaceManager;
        const installation = yield* Installation;
        const ada = DockerWorkspaces.workspaceNames(installation.id, "per_ada");
        expect(yield* workspaces.isAsleep(ADA)).toBe(true);

        const [first, second] = yield* Effect.all(
          [workspaces.targetFor(ADA), workspaces.targetFor(ADA)],
          { concurrency: "unbounded" },
        );
        expect(first).toEqual({ url: `http://127.0.0.1:${workspacePort}`, workspaceId: "per_ada" });
        expect(second).toEqual(first);
        expect(yield* workspaces.isAsleep(ADA)).toBe(false);
        expect(docker.workspacesCreated().map((container) => container.name)).toEqual([
          ada.container,
        ]);
        const [container] = docker.workspacesCreated();
        expect(container?.body.User).toBe("1000:1000");
        expect(container?.body.Env).toEqual(
          expect.arrayContaining([
            "CODENINE_MODE=managed",
            "CODENINE_MANAGED_WORKSPACE_ID=per_ada",
            "CODENINE_MANAGED_SLEEP_MINUTES=30",
          ]),
        );
        expect(container?.body.HostConfig).toMatchObject({
          Mounts: [{ Type: "volume", Source: ada.volume, Target: WORKSPACE_HOME }],
          NetworkMode: ada.network,
          ReadonlyRootfs: true,
          SecurityOpt: ["no-new-privileges"],
          CapDrop: ["ALL"],
          NanoCpus: 2e9,
          Memory: 4 * 1024 ** 3,
        });

        // A stopped container is asleep, and is started again, not created again.
        docker.running.set(ada.container, false);
        expect(yield* workspaces.isAsleep(ADA)).toBe(true);
        yield* workspaces.forget(ADA);
        expect(yield* workspaces.targetFor(ADA)).toEqual(first);
        expect(docker.starts.filter((name) => name === ada.container)).toHaveLength(2);
        expect(docker.workspacesCreated()).toHaveLength(1);

        const bea = DockerWorkspaces.workspaceNames(installation.id, "per_bea");
        expect((yield* workspaces.targetFor(BEA)).workspaceId).toBe("per_bea");
        expect(docker.workspacesCreated().map((created) => created.name)).toEqual([
          ada.container,
          bea.container,
        ]);

        // When Bea leaves, her container and network go; her files stay until they are removed.
        expect(yield* workspaces.retire(BEA)).toBe(true);
        expect(yield* workspaces.retire(BEA)).toBe(false);
        expect([docker.removed, docker.removedVolumes]).toEqual([[bea.container], []]);
        expect(docker.removedNetworks).toContain(bea.network);
        expect(yield* workspaces.isAsleep(BEA)).toBe(true);
        yield* workspaces.removeFiles("per_bea");
        expect(docker.removedVolumes).toEqual([bea.volume]);
      }),
    ),
  );

  it.live("joins a start already under way when asked to look again, such as by a second tab", () =>
    withDockerWorkspaces(({ docker }) =>
      Effect.gen(function* () {
        const workspaces = yield* WorkspaceManager;
        const installation = yield* Installation;
        const ada = DockerWorkspaces.workspaceNames(installation.id, "per_ada");
        const hold = yield* docker.holdNextStart(ada.container);
        const first = yield* workspaces.targetFor(ADA).pipe(Effect.forkChild);
        yield* Deferred.await(hold.arrived);

        yield* workspaces.forget(ADA);
        const second = yield* workspaces.targetFor(ADA).pipe(Effect.forkChild);
        yield* Deferred.succeed(hold.release, undefined);
        expect(yield* Fiber.join(second)).toBe(yield* Fiber.join(first));
        expect(docker.starts.filter((name) => name === ada.container)).toHaveLength(1);
      }),
    ),
  );

  it.live("keeps each workspace on an internal network, reaching out only through the proxy", () =>
    withDockerWorkspaces(({ docker }) =>
      Effect.gen(function* () {
        const workspaces = yield* WorkspaceManager;
        const installation = yield* Installation;
        const ada = DockerWorkspaces.workspaceNames(installation.id, "per_ada");
        const egress = DockerWorkspaces.egressNames(installation.id);
        yield* workspaces.targetFor(ADA);

        expect(docker.networks.get(ada.network)?.internal).toBe(true);
        expect(docker.networks.get(egress.network)?.internal).toBe(false);
        expect(docker.networks.get(ada.network)?.containers.get(egress.container)).toEqual([
          "egress",
        ]);
        const [workspace] = docker.workspacesCreated();
        expect(workspace?.body.Env).toContain("HTTPS_PROXY=http://egress:3128");
        expect(workspace?.body.HostConfig).not.toHaveProperty("PortBindings");
        const proxy = docker.created.find((created) => created.name === egress.container);
        expect(proxy?.body.HostConfig).toMatchObject({
          NetworkMode: egress.network,
          RestartPolicy: { Name: "unless-stopped" },
          ReadonlyRootfs: true,
          CapDrop: ["ALL"],
        });
        // The admin's host joins the defaults; one a default already covers is left out.
        const squid = proxy?.body.Env.find((entry) => entry.startsWith("SQUID_CONF=")) ?? "";
        expect(squid).toContain(" .github.com ");
        expect(squid).toContain(" git.acme.test");
        expect(squid).not.toContain("api.github.com");

        // A proxy made for other hosts is replaced, and the new one joins every workspace's network.
        docker.labels.set(egress.container, {
          ...proxy?.body.Labels,
          [DockerWorkspaces.SPEC_LABEL]: "older hosts",
        });
        docker.running.set(ada.container, false);
        yield* workspaces.forget(ADA);
        yield* workspaces.targetFor(ADA);
        expect(docker.removed).toEqual([egress.container]);
        expect(docker.networks.get(ada.network)?.containers.get(egress.container)).toEqual([
          "egress",
        ]);
      }),
    ),
  );

  it.live("makes a stopped workspace again from a new image, keeping its volume", () =>
    withDockerWorkspaces(({ docker }) =>
      Effect.gen(function* () {
        const workspaces = yield* WorkspaceManager;
        const installation = yield* Installation;
        const ada = DockerWorkspaces.workspaceNames(installation.id, "per_ada");
        yield* workspaces.targetFor(ADA);

        // The tag now points at a rebuilt image. A running workspace keeps working as it is.
        docker.image.id = "sha256:second";
        yield* workspaces.forget(ADA);
        yield* workspaces.targetFor(ADA);
        expect(docker.removed).toEqual([]);

        docker.running.set(ada.container, false);
        yield* workspaces.forget(ADA);
        yield* workspaces.targetFor(ADA);
        expect(docker.removed).toEqual([ada.container]);
        const [before, after] = docker.workspacesCreated().map((created) => created.body);
        expect(after?.HostConfig).toMatchObject({ Mounts: [{ Source: ada.volume }] });
        expect(after?.Labels[DockerWorkspaces.SPEC_LABEL]).not.toBe(
          before?.Labels[DockerWorkspaces.SPEC_LABEL],
        );
        expect(yield* workspaces.isAsleep(ADA)).toBe(false);
      }),
    ),
  );
  it.live("makes a workspace per department from its profile, and retires them all at once", () =>
    withDockerWorkspaces(({ docker }) =>
      Effect.gen(function* () {
        const workspaces = yield* WorkspaceManager;
        const installation = yield* Installation;
        const departments = yield* Departments;
        yield* (yield* ControlDb).insert(controlPeople).values({
          id: "per_ada",
          email: "ada@acme.test",
          displayName: "Ada",
          role: "member",
          status: "active",
          createdAt: "2026-12-10T12:00:00.000Z",
          updatedAt: "2026-12-10T12:00:00.000Z",
        });
        const design = yield* departments.create("Design");
        yield* departments.addMember(design.id, "per_ada");
        yield* (yield* Profiles).save({
          id: `department:${design.id}`,
          settings: { image: "codenine-workspace:design", cpus: 4, memoryGb: 8, sleepMinutes: 60 },
          note: "",
          testWith: null,
          by: "test",
        });

        yield* workspaces.targetFor(ADA);
        const target = yield* workspaces.targetFor({
          personId: "per_ada",
          departmentId: design.id,
        });
        expect(target.workspaceId).toBe(`per_ada.${design.id}`);
        const outside = DockerWorkspaces.workspaceNames(installation.id, "per_ada");
        const inDesign = DockerWorkspaces.workspaceNames(installation.id, target.workspaceId);
        const container = docker
          .workspacesCreated()
          .find((created) => created.name === inDesign.container);
        expect(container?.body).toMatchObject({
          Image: "codenine-workspace:design",
          Labels: { "codenine.person": "per_ada", "codenine.department": design.id },
          HostConfig: {
            NanoCpus: 4e9,
            Memory: 8 * 1024 ** 3,
            Mounts: [{ Source: inDesign.volume }],
          },
        });
        expect(container?.body.Env).toEqual(
          expect.arrayContaining([
            `CODENINE_MANAGED_WORKSPACE_ID=per_ada.${design.id}`,
            "CODENINE_MANAGED_SLEEP_MINUTES=60",
          ]),
        );

        // When Ada leaves, both her workspaces stop; their files stay until they are removed.
        expect(yield* workspaces.retireAll("per_ada")).toBe(true);
        expect(docker.removed.toSorted()).toEqual(
          [outside.container, inDesign.container].toSorted(),
        );
        expect(docker.removedVolumes).toEqual([]);
        expect(yield* workspaces.removeFiles("per_ada")).toBe(true);
        expect(docker.removedVolumes.toSorted()).toEqual(
          [outside.volume, inDesign.volume].toSorted(),
        );
      }),
    ),
  );
});
