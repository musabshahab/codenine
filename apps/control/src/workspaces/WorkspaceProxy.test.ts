// @effect-diagnostics nodeBuiltinImport:off - both test servers listen on Node http.Servers.
import * as NodeHttp from "node:http";
import * as NodeZlib from "node:zlib";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  importWorkspacePublicKey,
  verifyWorkspaceToken,
  type WorkspaceTokenError,
} from "@codenine/shared/workspaceToken";
import type { AuthGrantScope } from "@codenine/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Socket from "effect/socket/Socket";

import { Sessions } from "../accounts/Sessions.ts";
import { ControlDb } from "../db.ts";
import { sessionCookieName } from "../http/ControlHttp.ts";
import { LicenceService } from "../licence/LicenceService.ts";
import { controlPeople } from "../persistence/schema.ts";
import { layerTestServices } from "../testing/layerTestServices.ts";
import { signTestLicence, testClaims, testKeyPair } from "../testing/testLicence.ts";
import { WorkspaceManager } from "./WorkspaceManager.ts";
import * as WorkspaceProxy from "./WorkspaceProxy.ts";
import * as WorkspaceTokens from "./WorkspaceTokens.ts";

const echo = (workspace: string) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    return HttpServerResponse.jsonUnsafe({
      workspace,
      method: request.method,
      url: request.url,
      authorization: request.headers["authorization"] ?? null,
      cookie: request.headers["cookie"] ?? null,
      body: request.method === "POST" ? yield* request.text : null,
    });
  }).pipe(Effect.orDie);

const COMPRESSIBLE = "codenine ".repeat(1_000);

/** Stands in for a person's workspace server: it reports what reached it. */
const fakeWorkspace = (name: string) =>
  Layer.mergeAll(
    HttpRouter.add("*", "/api/echo", echo(name)),
    HttpRouter.add(
      "GET",
      "/api/compressed",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        return (request.headers["accept-encoding"] ?? "").includes("gzip")
          ? HttpServerResponse.uint8Array(NodeZlib.gzipSync(COMPRESSIBLE), {
              contentType: "text/plain",
              headers: { "content-encoding": "gzip" },
            })
          : HttpServerResponse.text(COMPRESSIBLE);
      }),
    ),
    HttpRouter.add("GET", "/.well-known/codenine/environment", echo(name)),
    HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const socket = yield* request.upgrade;
        yield* Effect.gen(function* () {
          const reader = yield* socket.reader;
          const writer = yield* socket.writer;
          yield* writer.write(
            `${name} authorization ${request.headers["authorization"] ?? "none"}`,
          );
          return yield* Effect.forever(
            Effect.flatMap(reader.pull, (chunks) =>
              writer.writeAll(
                Arr.map(chunks, (chunk) => (typeof chunk === "string" ? `echo ${chunk}` : chunk)),
              ),
            ),
          );
        }).pipe(Effect.scoped, Effect.ignore);
        return HttpServerResponse.empty();
      }).pipe(Effect.orDie),
    ),
  );

const EchoBody = Schema.Struct({
  workspace: Schema.String,
  method: Schema.String,
  url: Schema.String,
  authorization: Schema.NullOr(Schema.String),
  cookie: Schema.NullOr(Schema.String),
  body: Schema.NullOr(Schema.String),
});

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
      return `127.0.0.1:${"port" in address ? address.port : 0}`;
    }),
  );

/**
 * A control server in front of two fake workspaces, Ada's ("A") and Bea's
 * ("B"), and a cookie for each of them.
 */
const withProxy = <A, E, R>(
  body: (proxy: {
    readonly host: string;
    readonly cookie: string;
    readonly beaCookie: string;
    /** Checks a forwarded token as the named workspace would, and returns its scopes. */
    readonly scopesOf: (
      authorization: string,
      workspaceId?: string,
    ) => Effect.Effect<ReadonlyArray<AuthGrantScope>, WorkspaceTokenError>;
  }) => Effect.Effect<A, E, R>,
  options: { readonly licensed: boolean },
) =>
  Effect.gen(function* () {
    const keys = yield* testKeyPair;
    const workspaces = {
      per_ada: { url: `http://${yield* listen(fakeWorkspace("A"))}`, workspaceId: "ws-ada" },
      per_bea: { url: `http://${yield* listen(fakeWorkspace("B"))}`, workspaceId: "ws-bea" },
    };
    const manager = WorkspaceManager.of({
      targetFor: Effect.fn("test.targetFor")((personId: string) =>
        Effect.succeed(personId === "per_bea" ? workspaces.per_bea : workspaces.per_ada),
      ),
      forget: Effect.fn("test.forget")(() => Effect.void),
    });
    const services = WorkspaceTokens.layer.pipe(
      Layer.provideMerge(Layer.succeed(WorkspaceManager, manager)),
      Layer.provideMerge(layerTestServices(keys.publicKey)),
      Layer.provideMerge(
        Layer.mergeAll(FetchHttpClient.layer, NodeSocket.layerWebSocketConstructor),
      ),
    );
    return yield* Effect.gen(function* () {
      const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1_000);
      if (options.licensed) {
        const token = yield* signTestLicence(
          testClaims({ nbf: nowSeconds - 86_400, exp: nowSeconds + 86_400 * 30 }),
          keys.privateKey,
        );
        yield* (yield* LicenceService).install(token);
      }
      const now = DateTime.formatIso(yield* DateTime.now);
      const cookieFor = Effect.fn("test.cookieFor")(function* (id: string, name: string) {
        yield* (yield* ControlDb).insert(controlPeople).values({
          id,
          email: `${name.toLowerCase()}@acme.test`,
          displayName: name,
          role: "member",
          status: "active",
          createdAt: now,
          updatedAt: now,
        });
        const { token } = yield* (yield* Sessions).create({ personId: id, userAgent: null });
        return `${sessionCookieName(true)}=${token}`;
      });
      const cookie = yield* cookieFor("per_ada", "Ada");
      const beaCookie = yield* cookieFor("per_bea", "Bea");
      const host = yield* listen(
        Layer.mergeAll(WorkspaceProxy.layerHttpForwarding, WorkspaceProxy.layerSocketForwarding),
      );
      const { verifier } = yield* WorkspaceTokens.WorkspaceTokens;
      const publicKey = yield* importWorkspacePublicKey(verifier.publicKey);
      const scopesOf = (authorization: string, workspaceId = "ws-ada") =>
        verifyWorkspaceToken({
          token: authorization.replace(/^Bearer /u, ""),
          publicKey,
          keyId: verifier.keyId,
          issuer: verifier.issuer,
          audience: workspaceId,
          nowSeconds,
        }).pipe(
          Effect.map((claims) => claims.scopes),
          Effect.provide(NodeCrypto.layerSignature),
        );
      return yield* body({ host, cookie, beaCookie, scopesOf });
    }).pipe(Effect.provide(services));
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const call = (url: string, options: { readonly cookie?: string; readonly body?: string } = {}) =>
  Effect.gen(function* () {
    const request = HttpClientRequest.make(options.body === undefined ? "GET" : "POST")(url).pipe(
      HttpClientRequest.setHeaders(options.cookie === undefined ? {} : { cookie: options.cookie }),
      options.body === undefined
        ? (self) => self
        : HttpClientRequest.bodyText(options.body, "text/plain"),
    );
    const response = yield* (yield* HttpClient.HttpClient).execute(request);
    return {
      status: response.status,
      echo: response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(EchoBody)), Effect.orDie),
    };
  }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie);

/** A GET that leaves the body as it arrived, as a browser's network stack sees it. */
const getRaw = (url: string, headers: Readonly<Record<string, string>>) =>
  Effect.promise(
    () =>
      new Promise<{ readonly encoding: string | undefined; readonly body: Buffer }>(
        (resolve, reject) => {
          NodeHttp.get(url, { headers }, (response) => {
            const chunks: Array<Buffer> = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.once("error", reject);
            response.once("end", () =>
              resolve({
                encoding: response.headers["content-encoding"],
                body: Buffer.concat(chunks),
              }),
            );
          }).once("error", reject);
        },
      ),
  );

describe("WorkspaceProxy", () => {
  it.live("forwards API requests with a workspace token instead of the control cookie", () =>
    withProxy(
      ({ host, cookie, scopesOf }) =>
        Effect.gen(function* () {
          const forwarded = yield* call(`http://${host}/api/echo?x=1`, { cookie });
          expect(forwarded.status).toBe(200);
          const echo = yield* forwarded.echo;
          expect(echo).toMatchObject({ method: "GET", url: "/api/echo?x=1", cookie: null });
          expect(yield* scopesOf(echo.authorization ?? "")).toEqual(
            WorkspaceTokens.WORKSPACE_SCOPES,
          );

          const descriptor = yield* call(`http://${host}/.well-known/codenine/environment`, {
            cookie,
          });
          expect(yield* descriptor.echo).toMatchObject({
            url: "/.well-known/codenine/environment",
            cookie: null,
          });

          const posted = yield* call(`http://${host}/api/echo`, {
            cookie,
            body: "hello workspace",
          });
          expect(yield* posted.echo).toMatchObject({ method: "POST", body: "hello workspace" });

          expect((yield* call(`http://${host}/api/echo`)).status).toBe(401);

          // Bodies stay compressed on the way through, as the browser asked.
          const compressed = yield* getRaw(`http://${host}/api/compressed`, {
            cookie,
            "accept-encoding": "gzip",
          });
          expect(compressed.encoding).toBe("gzip");
          expect(NodeZlib.gunzipSync(compressed.body).toString()).toBe(COMPRESSIBLE);
        }),
      { licensed: true },
    ),
  );

  it.live(
    "forwards a WebSocket both ways, read-only without a working licence, until sign-out",
    () =>
      withProxy(
        ({ host, cookie, scopesOf }) =>
          Effect.gen(function* () {
            const socket = yield* Socket.makeWebSocket(`ws://${host}/ws`, { headers: { cookie } });
            const reader = yield* socket.reader;
            const writer = yield* socket.writer;
            const next = reader.pull.pipe(Effect.map((chunks) => String(chunks[0])));

            const greeting = yield* next;
            expect(greeting).toMatch(/^A authorization Bearer /u);
            expect(yield* scopesOf(greeting.replace(/^A authorization /u, ""))).toEqual(
              WorkspaceTokens.READ_ONLY_WORKSPACE_SCOPES,
            );
            yield* writer.write("ping");
            expect(yield* next).toBe("echo ping");

            yield* (yield* Sessions).revokeAll("per_ada");
            expect((yield* Effect.flip(reader.pull))._tag).toBe("SocketError");

            const anonymous = yield* Socket.makeWebSocket(`ws://${host}/ws`);
            expect((yield* Effect.flip(anonymous.reader))._tag).toBe("SocketError");
          }).pipe(Effect.scoped, Effect.provide(NodeSocket.layerWebSocketConstructor)),
        { licensed: false },
      ),
  );

  it.live("sends each person only to their own workspace, with a token only it accepts", () =>
    withProxy(
      ({ host, cookie, beaCookie, scopesOf }) =>
        Effect.gen(function* () {
          const ada = yield* (yield* call(`http://${host}/api/echo`, { cookie })).echo;
          const bea = yield* (yield* call(`http://${host}/api/echo`, { cookie: beaCookie })).echo;
          expect([ada.workspace, bea.workspace]).toEqual(["A", "B"]);
          expect(yield* scopesOf(bea.authorization ?? "", "ws-bea")).toEqual(
            WorkspaceTokens.WORKSPACE_SCOPES,
          );
          // A token minted for Ada's workspace is refused by Bea's.
          expect((yield* Effect.flip(scopesOf(ada.authorization ?? "", "ws-bea")))._tag).toBe(
            "WorkspaceTokenError",
          );

          const socket = yield* Socket.makeWebSocket(`ws://${host}/ws`, {
            headers: { cookie: beaCookie },
          });
          const greeting = yield* (yield* socket.reader).pull.pipe(
            Effect.map((chunks) => String(chunks[0])),
          );
          expect(greeting).toMatch(/^B authorization Bearer /u);
        }).pipe(Effect.scoped, Effect.provide(NodeSocket.layerWebSocketConstructor)),
      { licensed: true },
    ),
  );
});
