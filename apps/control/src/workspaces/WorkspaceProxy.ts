import { licenceAllowsWork } from "@codenine/shared/licence";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Headers from "effect/http/Headers";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Socket from "effect/socket/Socket";

import { type AuthenticatedSession, Sessions } from "../accounts/Sessions.ts";
import { ControlPublicUrl } from "../config.ts";
import { sessionCookieName } from "../http/ControlHttp.ts";
import { LicenceService } from "../licence/LicenceService.ts";
import { WorkspaceTokens } from "./WorkspaceTokens.ts";

/** The workspace server everyone reaches in this first version; phase 2 gives each person their own. */
export class WorkspaceUpstream extends Context.Service<
  WorkspaceUpstream,
  { readonly url: string; readonly workspaceId: string }
>()("@codenine/control/workspaces/WorkspaceProxy/WorkspaceUpstream") {
  static readonly layer = Layer.effect(
    WorkspaceUpstream,
    Config.all({
      url: Config.String("CODENINE_CONTROL_WORKSPACE_URL"),
      workspaceId: Config.String("CODENINE_CONTROL_WORKSPACE_ID").pipe(
        Config.withDefault("workspace"),
      ),
    }).pipe(Effect.map(({ url, workspaceId }) => ({ url: url.replace(/\/+$/u, ""), workspaceId }))),
  );
}

// Hop-by-hop headers, our own cookie and credentials, and encodings fetch undoes on its own.
const REQUEST_HEADERS_DROPPED = new Set([
  "accept-encoding",
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "host",
  "keep-alive",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const RESPONSE_HEADERS_DROPPED = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "set-cookie",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const keep = (headers: Headers.Headers, dropped: ReadonlySet<string>) =>
  Object.fromEntries(Object.entries(headers).filter(([name]) => !dropped.has(name.toLowerCase())));

const signedOut = HttpServerResponse.jsonUnsafe(
  { _tag: "ControlSignedOutError", message: "Sign in to continue." },
  { status: 401 },
);

/**
 * Who is asking, and the workspace token to forward with their request. The
 * licence decides whether the token can change anything.
 */
export const makeWorkspaceAuthorizer = Effect.gen(function* () {
  const sessions = yield* Sessions;
  const tokens = yield* WorkspaceTokens;
  const upstream = yield* WorkspaceUpstream;
  const { secure } = yield* ControlPublicUrl;
  const licence = yield* LicenceService;
  // Licence standing changes daily at most; this spares a query per request.
  const allowsWork = yield* Effect.cachedWithTTL(
    licence.overview.pipe(
      Effect.map(
        ({ licence: applied }) => applied._tag === "installed" && licenceAllowsWork(applied.status),
      ),
    ),
    Duration.minutes(1),
  );
  return Effect.fn("WorkspaceProxy.authorize")(function* (
    request: HttpServerRequest.HttpServerRequest,
  ) {
    const cookie = request.cookies[sessionCookieName(secure)];
    const session = cookie === undefined ? Option.none() : yield* sessions.authenticate(cookie);
    if (Option.isNone(session)) {
      return Option.none<{ readonly token: string; readonly session: AuthenticatedSession }>();
    }
    const token = yield* tokens.mint({
      personId: session.value.person.id,
      sessionId: session.value.sessionId,
      name: session.value.person.displayName,
      workspaceId: upstream.workspaceId,
      readOnly: !(yield* allowsWork),
    });
    return Option.some({ token, session: session.value });
  });
});

const unavailable = HttpServerResponse.jsonUnsafe(
  { _tag: "WorkspaceUnavailable", message: "The workspace server is not answering." },
  { status: 502 },
);

export const layerHttpForwarding = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const authorize = yield* makeWorkspaceAuthorizer;
    const upstream = yield* WorkspaceUpstream;
    const client = yield* HttpClient.HttpClient;
    const forwardRequest = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const authorized = yield* authorize(request);
      if (Option.isNone(authorized)) {
        return signedOut;
      }
      const hasBody = request.method !== "GET" && request.method !== "HEAD";
      const forwarded = HttpClientRequest.make(request.method as "GET")(
        `${upstream.url}${request.url}`,
      ).pipe(
        HttpClientRequest.setHeaders({
          ...keep(request.headers, REQUEST_HEADERS_DROPPED),
          authorization: `Bearer ${authorized.value.token}`,
        }),
        hasBody ? HttpClientRequest.bodyStream(request.stream) : (self) => self,
      );
      const response = yield* client.execute(forwarded);
      return HttpServerResponse.stream(response.stream, {
        status: response.status,
        headers: keep(response.headers, RESPONSE_HEADERS_DROPPED),
      });
    }).pipe(Effect.catchTags({ HttpClientError: () => Effect.succeed(unavailable) }));
    yield* router.add("*", "/api/*", forwardRequest);
    // The app reads the workspace's descriptor before it opens /ws.
    yield* router.add("GET", "/.well-known/codenine/*", forwardRequest);
  }),
);

/** Copies messages one way until either side closes. */
const forward = Effect.fnUntraced(function* (from: Socket.Reader, to: Socket.Socket) {
  const writer = yield* to.writer;
  return yield* Effect.forever(Effect.flatMap(from.pull, writer.writeAll));
});

export const layerSocketForwarding = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const authorize = yield* makeWorkspaceAuthorizer;
    const sessions = yield* Sessions;
    const upstream = yield* WorkspaceUpstream;
    const constructor = yield* Socket.WebSocketConstructor;
    yield* router.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const authorized = yield* authorize(request);
        if (Option.isNone(authorized)) {
          return signedOut;
        }
        const protocols = request.headers["sec-websocket-protocol"]
          ?.split(",")
          .map((protocol) => protocol.trim())
          .filter((protocol) => protocol.length > 0);
        const workspace = yield* Socket.makeWebSocket(
          `${upstream.url.replace(/^http/u, "ws")}${request.url}`,
          {
            headers: { authorization: `Bearer ${authorized.value.token}` },
            ...(protocols === undefined || protocols.length === 0 ? {} : { protocols }),
          },
        ).pipe(Effect.provideService(Socket.WebSocketConstructor, constructor));
        // Taking the reader opens the connection, so a refusal is a 502 before the browser upgrades.
        const fromWorkspace = yield* workspace.reader.pipe(Effect.option);
        if (Option.isNone(fromWorkspace)) {
          return unavailable;
        }
        const browser = yield* request.upgrade;
        const fromBrowser = yield* browser.reader;
        yield* Effect.raceFirst(
          Effect.raceFirst(forward(fromBrowser, workspace), forward(fromWorkspace.value, browser)),
          sessions.awaitEnd(authorized.value.session),
        ).pipe(Effect.ignore);
        return HttpServerResponse.empty();
      }).pipe(Effect.scoped),
    );
  }),
);

/**
 * Forwards `/api` and `/ws` when `CODENINE_CONTROL_WORKSPACE_URL` is set;
 * without it the control server serves only its own routes.
 */
export const layerForwarding = Layer.unwrap(
  Effect.gen(function* () {
    const url = yield* Config.option(Config.String("CODENINE_CONTROL_WORKSPACE_URL"));
    return Option.isNone(url)
      ? Layer.empty
      : Layer.mergeAll(layerHttpForwarding, layerSocketForwarding).pipe(
          Layer.provide(WorkspaceUpstream.layer),
        );
  }),
);
