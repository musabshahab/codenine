// @effect-diagnostics nodeBuiltinImport:off - the fake API server and stand-in workspace listen on local ports.
import * as NodeHttp from "node:http";

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

import { layerTestServices } from "../testing/layerTestServices.ts";
import { testKeyPair } from "../testing/testLicence.ts";
import { KubernetesApi } from "./KubernetesApi.ts";
import * as KubernetesWorkspaces from "./KubernetesWorkspaces.ts";
import { WorkspaceManager } from "./WorkspaceManager.ts";
import * as WorkspaceTokens from "./WorkspaceTokens.ts";
import { WorkspaceDialPort } from "./workspaceSpec.ts";

interface PodManifest {
  readonly metadata: { readonly name: string };
  readonly spec: {
    readonly containers: ReadonlyArray<{
      readonly env: ReadonlyArray<{ readonly name: string; readonly value: string }>;
    }>;
  } & Record<string, unknown>;
}

const NAMESPACE = "codenine";

/** A Kubernetes API that keeps pods and claims in memory; a new pod is pending once, then runs. */
const fakeKubernetes = () => {
  const created: Array<PodManifest> = [];
  const deleted: Array<{ readonly name: string; readonly now: boolean }> = [];
  const pods = new Map<string, { phase: string; checked: number }>();
  const claims = new Map<string, unknown>();
  const base = `/api/v1/namespaces/${NAMESPACE}`;
  const nameParam = HttpRouter.params.pipe(Effect.map((params) => params["name"] ?? ""));
  const body = <A>() =>
    HttpServerRequest.HttpServerRequest.pipe(
      Effect.flatMap((request) => request.json),
      Effect.map((json) => json as A),
      Effect.orDie,
    );
  const routes = Layer.mergeAll(
    HttpRouter.add(
      "GET",
      `${base}/pods/:name`,
      Effect.map(nameParam, (name) => {
        const pod = pods.get(name);
        if (pod === undefined) {
          return HttpServerResponse.jsonUnsafe({ kind: "Status", code: 404 }, { status: 404 });
        }
        pod.checked += 1;
        const phase = pod.phase === "Pending" && pod.checked > 1 ? "Running" : pod.phase;
        pod.phase = phase;
        return HttpServerResponse.jsonUnsafe({
          status: { phase, ...(phase === "Running" ? { podIP: "127.0.0.1" } : {}) },
        });
      }),
    ),
    HttpRouter.add(
      "POST",
      `${base}/pods`,
      Effect.gen(function* () {
        const manifest = yield* body<PodManifest>();
        if (pods.has(manifest.metadata.name)) {
          return HttpServerResponse.empty({ status: 409 });
        }
        created.push(manifest);
        pods.set(manifest.metadata.name, { phase: "Pending", checked: 0 });
        return HttpServerResponse.jsonUnsafe(manifest, { status: 201 });
      }),
    ),
    HttpRouter.add(
      "DELETE",
      `${base}/pods/:name`,
      Effect.gen(function* () {
        const name = yield* nameParam;
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (!pods.delete(name)) {
          return HttpServerResponse.empty({ status: 404 });
        }
        const grace = new URL(request.url, "http://kubernetes").searchParams.get(
          "gracePeriodSeconds",
        );
        deleted.push({ name, now: grace === "0" });
        return HttpServerResponse.jsonUnsafe({}, { status: 200 });
      }),
    ),
    HttpRouter.add(
      "POST",
      `${base}/persistentvolumeclaims`,
      Effect.gen(function* () {
        const manifest = yield* body<{ metadata: { name: string } }>();
        if (claims.has(manifest.metadata.name)) {
          return HttpServerResponse.empty({ status: 409 });
        }
        claims.set(manifest.metadata.name, manifest);
        return HttpServerResponse.jsonUnsafe(manifest, { status: 201 });
      }),
    ),
    HttpRouter.add(
      "DELETE",
      `${base}/persistentvolumeclaims/:name`,
      Effect.map(nameParam, (name) =>
        claims.delete(name)
          ? HttpServerResponse.jsonUnsafe({}, { status: 200 })
          : HttpServerResponse.empty({ status: 404 }),
      ),
    ),
  );
  return { created, deleted, pods, claims, routes };
};

const listen = <E, R>(routes: Layer.Layer<never, E, R>) =>
  Layer.build(
    HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(
        NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: 0 }),
      ),
    ),
  ).pipe(
    Effect.map((context) => {
      const { address } = Context.get(context, HttpServer.HttpServer);
      return "port" in address ? address.port : 0;
    }),
  );

describe("KubernetesWorkspaces", () => {
  it.live(
    "runs one locked-down pod per person on their own claim, and a new one after it sleeps",
    () =>
      Effect.gen(function* () {
        const keys = yield* testKeyPair;
        const workspacePort = yield* listen(
          HttpRouter.add(
            "GET",
            "/.well-known/codenine/environment",
            Effect.succeed(HttpServerResponse.jsonUnsafe({})),
          ),
        );
        const api = fakeKubernetes();
        const apiPort = yield* listen(api.routes);
        const manager = Layer.effect(WorkspaceManager, KubernetesWorkspaces.make).pipe(
          Layer.provide(KubernetesApi.layerUrl(`http://127.0.0.1:${apiPort}`, NAMESPACE)),
          Layer.provide(NodeHttpClient.layerUndici),
          Layer.provide(Layer.succeed(WorkspaceDialPort, workspacePort)),
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
          const ada = KubernetesWorkspaces.podNames("per_ada");
          expect(ada).toEqual({ pod: "codenine-per-ada", claim: "codenine-per-ada-home" });
          expect(yield* workspaces.isAsleep("per_ada")).toBe(true);

          const [first, second] = yield* Effect.all(
            [workspaces.targetFor("per_ada"), workspaces.targetFor("per_ada")],
            { concurrency: "unbounded" },
          );
          expect(first).toEqual({
            url: `http://127.0.0.1:${workspacePort}`,
            workspaceId: "per_ada",
          });
          expect(second).toEqual(first);
          expect(api.created.map((pod) => pod.metadata.name)).toEqual([ada.pod]);
          const [pod] = api.created;
          expect(pod?.spec).toMatchObject({
            restartPolicy: "Never",
            automountServiceAccountToken: false,
            securityContext: {
              runAsUser: 1000,
              runAsNonRoot: true,
              seccompProfile: { type: "RuntimeDefault" },
            },
            containers: [
              {
                image: "codenine-workspace:test",
                resources: {
                  limits: { cpu: "2", memory: "4Gi" },
                  requests: { cpu: "0.5", memory: "1Gi" },
                },
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ["ALL"] },
                },
              },
            ],
            volumes: [
              { name: "home", persistentVolumeClaim: { claimName: ada.claim } },
              { name: "tmp" },
            ],
          });
          expect(pod?.spec.containers[0]?.env).toEqual(
            expect.arrayContaining([
              { name: "CODENINE_MANAGED_WORKSPACE_ID", value: "per_ada" },
              { name: "HTTPS_PROXY", value: "http://codenine-egress:3128" },
            ]),
          );
          expect(api.claims.get(ada.claim)).toMatchObject({
            spec: { resources: { requests: { storage: "20Gi" } } },
          });

          // It slept: the finished pod gives way at once to a new one on the same claim.
          api.pods.set(ada.pod, { phase: "Succeeded", checked: 0 });
          expect(yield* workspaces.isAsleep("per_ada")).toBe(true);
          yield* workspaces.forget("per_ada");
          expect(yield* workspaces.targetFor("per_ada")).toEqual(first);
          expect(api.deleted).toEqual([{ name: ada.pod, now: true }]);
          expect(api.created).toHaveLength(2);

          // Leaving stops the pod with the usual grace; the files go when they are removed.
          expect(yield* workspaces.retire("per_ada")).toBe(true);
          expect(api.deleted.at(-1)).toEqual({ name: ada.pod, now: false });
          expect(api.claims.has(ada.claim)).toBe(true);
          expect(yield* workspaces.removeFiles("per_ada")).toBe(true);
          expect(api.claims.has(ada.claim)).toBe(false);
        }).pipe(Effect.provide(manager));
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
});
