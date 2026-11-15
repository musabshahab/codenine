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
import type { ControlRole } from "@codenine/contracts/control";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Socket from "effect/socket/Socket";

import { ON_THE_SERVER } from "../audit/AuditLog.ts";
import { Sessions } from "../accounts/Sessions.ts";
import { Departments } from "../departments/Departments.ts";
import { Profiles } from "../profiles/Profiles.ts";
import { workspaceScopes } from "../admin/roles.ts";
import { ControlDb } from "../db.ts";
import { sessionCookieName } from "../http/ControlHttp.ts";
import { LicenceService } from "../licence/LicenceService.ts";
import { controlPeople } from "../persistence/schema.ts";
import { layerTestServices } from "../testing/layerTestServices.ts";
import { signTestLicence, testClaims, testKeyPair } from "../testing/testLicence.ts";
import { type WorkspaceKey, WorkspaceManager } from "./WorkspaceManager.ts";
import * as WorkspaceProxy from "./WorkspaceProxy.ts";
import * as WorkspaceTokens from "./WorkspaceTokens.ts";
import * as Workplace from "./Workplace.ts";

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
    // As a workspace answers a token minted for another.
    HttpRouter.add(
      "GET",
      "/api/refused",
      Effect.succeed(HttpServerResponse.empty({ status: 401 })),
    ),
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
    /** People whose workspace the proxy was told to look for again. */
    readonly forgotten: ReadonlyArray<string>;
    /** The workspaces the proxy asked for, in order. */
    readonly asked: ReadonlyArray<WorkspaceKey>;
  }) => Effect.Effect<A, E, R>,
  options: { readonly licensed: boolean },
) =>
  Effect.gen(function* () {
    const keys = yield* testKeyPair;
    const workspaces = {
      per_ada: { url: `http://${yield* listen(fakeWorkspace("A"))}`, workspaceId: "ws-ada" },
      per_bea: { url: `http://${yield* listen(fakeWorkspace("B"))}`, workspaceId: "ws-bea" },
    };
    const forgotten: Array<string> = [];
    const asked: Array<WorkspaceKey> = [];
    const manager = WorkspaceManager.of({
      targetFor: Effect.fn("test.targetFor")((key: WorkspaceKey) =>
        Effect.sync(() => {
          asked.push(key);
          return key.personId === "per_bea" ? workspaces.per_bea : workspaces.per_ada;
        }),
      ),
      forget: Effect.fn("test.forget")((key: WorkspaceKey) =>
        Effect.sync(() => void forgotten.push(key.personId)),
      ),
      applyNetwork: Effect.fn("test.applyNetwork")(() => Effect.void),
      isAsleep: Effect.fn("test.isAsleep")(() => Effect.succeed(false)),
      retire: Effect.fn("test.retire")(() => Effect.succeed(false)),
      retireAll: Effect.fn("test.retireAll")(() => Effect.succeed(false)),
      removeFiles: Effect.fn("test.removeFiles")(() => Effect.succeed(false)),
    });
    const services = Workplace.layer.pipe(
      Layer.provideMerge(WorkspaceTokens.layer),
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
      const cookieFor = Effect.fn("test.cookieFor")(function* (
        id: string,
        name: string,
        role: ControlRole,
      ) {
        yield* (yield* ControlDb).insert(controlPeople).values({
          id,
          email: `${name.toLowerCase()}@acme.test`,
          displayName: name,
          role,
          status: "active",
          createdAt: now,
          updatedAt: now,
        });
        const { token } = yield* (yield* Sessions).create({
          personId: id,
          source: ON_THE_SERVER,
          method: "password",
        });
        return `${sessionCookieName(true)}=${token}`;
      });
      const cookie = yield* cookieFor("per_ada", "Ada", "member");
      const beaCookie = yield* cookieFor("per_bea", "Bea", "restricted");
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
      return yield* body({ host, cookie, beaCookie, scopesOf, forgotten, asked });
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
            workspaceScopes("member", true, { terminal: true }),
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
              workspaceScopes("member", false, { terminal: true }),
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
      ({ host, cookie, beaCookie, scopesOf, forgotten }) =>
        Effect.gen(function* () {
          const ada = yield* (yield* call(`http://${host}/api/echo`, { cookie })).echo;
          const bea = yield* (yield* call(`http://${host}/api/echo`, { cookie: beaCookie })).echo;
          expect([ada.workspace, bea.workspace]).toEqual(["A", "B"]);
          // Bea is restricted, and her token says so.
          expect(yield* scopesOf(bea.authorization ?? "", "ws-bea")).toEqual(
            workspaceScopes("restricted", true, { terminal: true }),
          );
          // A token minted for Ada's workspace is refused by Bea's.
          expect((yield* Effect.flip(scopesOf(ada.authorization ?? "", "ws-bea")))._tag).toBe(
            "WorkspaceTokenError",
          );
          // Looking at Bea's workspace in an emergency, Ada gets there, but may only look.
          const sessions = yield* Sessions;
          const adaSession = Option.getOrThrow(
            yield* sessions.authenticate(cookie.split("=")[1] ?? ""),
          );
          const there = { personId: "per_ada", sessionId: adaSession.sessionId };
          yield* sessions.view({
            ...there,
            viewing: { personId: "per_bea", departmentId: null, until: "2100-01-01T00:00:00.000Z" },
          });
          const looking = yield* (yield* call(`http://${host}/api/echo`, { cookie })).echo;
          expect(looking.workspace).toBe("B");
          expect(yield* scopesOf(looking.authorization ?? "", "ws-bea")).toEqual(
            workspaceScopes("member", false, { terminal: true }),
          );
          yield* sessions.stopViewing(there);
          expect((yield* (yield* call(`http://${host}/api/echo`, { cookie })).echo).workspace).toBe(
            "A",
          );

          // A workspace that refuses the token is not Ada's any more, so the proxy looks again.
          expect(forgotten).toEqual([]);
          expect((yield* call(`http://${host}/api/refused`, { cookie })).status).toBe(401);
          expect(forgotten).toEqual(["per_ada"]);

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
  it.live("works in the department chosen in the browser, with that department's profile", () =>
    withProxy(
      ({ host, cookie, scopesOf, asked }) =>
        Effect.gen(function* () {
          const departments = yield* Departments;
          const design = yield* departments.create("Design");
          const sales = yield* departments.create("Sales");
          yield* departments.addMember(design.id, "per_ada");
          yield* departments.addMember(sales.id, "per_ada");
          yield* (yield* Profiles).save({
            id: `department:${design.id}`,
            settings: { terminal: "block" },
            note: "",
            testWith: null,
            by: "test",
          });
          const echoed = Effect.flatMap(
            call(`http://${host}/api/echo`, { cookie }),
            ({ echo }) => echo,
          );

          // Ada joined Design first, so she works there, without a terminal.
          const inDesign = yield* echoed;
          expect(asked.at(-1)).toEqual({ personId: "per_ada", departmentId: design.id });
          expect(yield* scopesOf(inDesign.authorization ?? "")).toEqual(
            workspaceScopes("member", true, { terminal: false }),
          );

          // Choosing Sales in this browser ends its sockets, and its next requests go there.
          const socket = yield* Socket.makeWebSocket(`ws://${host}/ws`, { headers: { cookie } });
          const reader = yield* socket.reader;
          yield* reader.pull;
          const session = yield* (yield* Sessions).authenticate(cookie.split("=")[1] ?? "");
          const here = {
            sessionId: Option.getOrThrow(session).sessionId,
            personId: "per_ada",
            departmentId: null,
            viewing: null,
          };
          const workplace = yield* Workplace.Workplace;
          expect(yield* Effect.flip(workplace.choose(here, "dep_elsewhere"))).toMatchObject({
            reason: "not-found",
          });
          expect((yield* workplace.choose(here, sales.id)).current).toBe(sales.id);
          expect((yield* Effect.flip(reader.pull))._tag).toBe("SocketError");
          const inSales = yield* echoed;
          expect(asked.at(-1)).toEqual({ personId: "per_ada", departmentId: sales.id });
          expect(yield* scopesOf(inSales.authorization ?? "")).toEqual(
            workspaceScopes("member", true, { terminal: true }),
          );
        }).pipe(Effect.scoped, Effect.provide(NodeSocket.layerWebSocketConstructor)),
      { licensed: true },
    ),
  );
});
