import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeWS from "@effect/platform-node/NodeWS";
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
import { workspaceScopes } from "../admin/roles.ts";
import { ControlPublicUrl } from "../config.ts";
import { sessionCookieName } from "../http/ControlHttp.ts";
import { LicenceService, workspaceAccess } from "../licence/LicenceService.ts";
import { Profiles } from "../profiles/Profiles.ts";
import { type WorkspaceKey, type WorkspaceTarget, WorkspaceManager } from "./WorkspaceManager.ts";
import { WorkspaceTokens } from "./WorkspaceTokens.ts";
import { Workplace } from "./Workplace.ts";

// Hop-by-hop headers and our own cookie and credentials. Encodings pass through untouched.
const REQUEST_HEADERS_DROPPED = new Set([
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

interface Authorized {
  readonly token: string;
  readonly session: AuthenticatedSession;
  readonly key: WorkspaceKey;
  /** The person's workspace in their department; their token works there and nowhere else. */
  readonly target: WorkspaceTarget;
}

/**
 * Who is asking, their workspace in the department they work in, and the token
 * to forward with their request. Their role and that department's profile
 * decide what the token allows, and the licence whether it can change anything.
 */
export const makeWorkspaceAuthorizer = Effect.gen(function* () {
  const sessions = yield* Sessions;
  const tokens = yield* WorkspaceTokens;
  const manager = yield* WorkspaceManager;
  const workplace = yield* Workplace;
  const profiles = yield* Profiles;
  const { secure } = yield* ControlPublicUrl;
  const licence = yield* LicenceService;
  // Licence standing changes daily at most; this spares a query per request.
  const allowsWork = yield* Effect.cachedWithTTL(
    licence.overview.pipe(Effect.map(({ licence: applied }) => workspaceAccess(applied).canWork)),
    Duration.minutes(1),
  );
  return Effect.fn("WorkspaceProxy.authorize")(function* (
    request: HttpServerRequest.HttpServerRequest,
  ) {
    const cookie = request.cookies[sessionCookieName(secure)];
    const session = cookie === undefined ? Option.none() : yield* sessions.authenticate(cookie);
    if (Option.isNone(session)) {
      return Option.none<Authorized>();
    }
    const { person, sessionId, departmentId, viewing } = session.value;
    const key = yield* workplace.keyFor({ sessionId, personId: person.id, departmentId, viewing });
    const profile = yield* profiles.effective(key.personId, key.departmentId);
    const target = yield* manager.targetFor(key);
    const token = yield* tokens.mint({
      personId: person.id,
      sessionId: session.value.sessionId,
      name: person.displayName,
      workspaceId: target.workspaceId,
      // An owner in someone else's workspace may look but change nothing.
      scopes: workspaceScopes(person.role, viewing === null && (yield* allowsWork), profile),
    });
    return Option.some<Authorized>({ token, session: session.value, key, target });
  });
});

const unavailable = HttpServerResponse.jsonUnsafe(
  { _tag: "WorkspaceUnavailable", message: "The workspace server is not answering." },
  { status: 502 },
);

export const layerHttpForwarding = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const authorize = yield* makeWorkspaceAuthorizer;
    const manager = yield* WorkspaceManager;
    const client = yield* HttpClient.HttpClient;
    const forwardRequest = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const authorized = yield* authorize(request);
      if (Option.isNone(authorized)) {
        return signedOut;
      }
      const { target, key } = authorized.value;
      const hasBody = request.method !== "GET" && request.method !== "HEAD";
      const forwarded = HttpClientRequest.make(request.method as "GET")(
        `${target.url}${request.url}`,
      ).pipe(
        HttpClientRequest.setHeaders({
          ...keep(request.headers, REQUEST_HEADERS_DROPPED),
          authorization: `Bearer ${authorized.value.token}`,
        }),
        hasBody ? HttpClientRequest.bodyStream(request.stream) : (self) => self,
      );
      const response = yield* client
        .execute(forwarded)
        .pipe(Effect.tapError(() => manager.forget(key)));
      // Whatever answers there refuses this person's token, such as another workspace that took
      // the port after theirs stopped, so the next request looks for their workspace again.
      if (response.status === 401) {
        yield* manager.forget(key);
      }
      return HttpServerResponse.stream(response.stream, {
        status: response.status,
        headers: keep(response.headers, RESPONSE_HEADERS_DROPPED),
      });
    }).pipe(
      Effect.catchTags({
        HttpClientError: () => Effect.succeed(unavailable),
        WorkspaceUnavailableError: () => Effect.succeed(unavailable),
      }),
    );
    yield* router.add("*", "/api/*", forwardRequest);
    // The app reads the workspace's descriptor before it opens /ws.
    yield* router.add("GET", "/.well-known/codenine/*", forwardRequest);
  }),
).pipe(
  // Undici's request client leaves bodies as sent. Fetch would unzip them and keep the
  // encoding header, and remote browsers would pay for uncompressed snapshots.
  Layer.provide(NodeHttpClient.layerUndici),
);

/**
 * Sockets to the workspace use `ws`, which pauses reads when the browser falls
 * behind, so the proxy does not buffer without limit. Frames between the two
 * servers stay uncompressed: the browser's side is compressed, and deflating
 * both hops would cost each message three passes.
 */
const layerWorkspaceSocket = Layer.succeed(Socket.WebSocketConstructor)(
  (url, options) =>
    new NodeWS.WebSocket(
      url,
      typeof options === "object" && !Array.isArray(options) ? options.protocols : options,
      {
        perMessageDeflate: false,
        ...(typeof options === "object" && !Array.isArray(options) && options.headers
          ? { headers: options.headers }
          : {}),
      },
    ) as unknown as globalThis.WebSocket,
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
    const manager = yield* WorkspaceManager;
    const constructor = yield* Socket.WebSocketConstructor;
    yield* router.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const authorized = yield* authorize(request).pipe(
          Effect.catchTags({ WorkspaceUnavailableError: () => Effect.succeed(null) }),
        );
        if (authorized === null) {
          return unavailable;
        }
        if (Option.isNone(authorized)) {
          return signedOut;
        }
        const { target } = authorized.value;
        const protocols = request.headers["sec-websocket-protocol"]
          ?.split(",")
          .map((protocol) => protocol.trim())
          .filter((protocol) => protocol.length > 0);
        const workspace = yield* Socket.makeWebSocket(
          `${target.url.replace(/^http/u, "ws")}${request.url}`,
          {
            headers: { authorization: `Bearer ${authorized.value.token}` },
            ...(protocols === undefined || protocols.length === 0 ? {} : { protocols }),
          },
        ).pipe(Effect.provideService(Socket.WebSocketConstructor, constructor));
        // Taking the reader opens the connection, so a refusal is a 502 before the browser upgrades.
        const fromWorkspace = yield* workspace.reader.pipe(Effect.option);
        if (Option.isNone(fromWorkspace)) {
          yield* manager.forget(authorized.value.key);
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
).pipe(Layer.provide(layerWorkspaceSocket));

/** Forwards `/api`, `/ws` and the workspace descriptor to each person's workspace. */
export const layerForwarding = Layer.mergeAll(layerHttpForwarding, layerSocketForwarding);
