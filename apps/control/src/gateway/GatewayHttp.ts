// @effect-diagnostics nodeBuiltinImport:off - NodeHttpServer listens on a Node http.Server.
import * as NodeHttp from "node:http";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { EnvHttpProxyAgent } from "undici";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

import { Gateway, type GatewayReply } from "./Gateway.ts";

/** Anthropic's own limit on one request. */
const MAX_REQUEST = ByteSize.mebibytes(32);
const CLAUDE_PREFIX = "/anthropic";

const toResponse = (reply: GatewayReply) =>
  reply.body instanceof Uint8Array
    ? HttpServerResponse.uint8Array(reply.body, { status: reply.status, headers: reply.headers })
    : HttpServerResponse.stream(reply.body, { status: reply.status, headers: reply.headers });

const tooLarge = HttpServerResponse.jsonUnsafe(
  {
    type: "error",
    error: { type: "request_too_large", message: "The request is larger than 32 MB." },
  },
  { status: 413 },
);

/**
 * The gateway's routes, served on their own port that only workspaces reach:
 * Claude's API under `/anthropic`, and a health check.
 */
export const layerRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const gateway = yield* Gateway;
    yield* router.add(
      "*",
      `${CLAUDE_PREFIX}/*`,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.url, "http://gateway.invalid");
        const body =
          request.method === "GET" || request.method === "HEAD"
            ? null
            : new Uint8Array(yield* request.arrayBuffer);
        const reply = yield* gateway.claude({
          method: request.method,
          path: url.pathname.slice(CLAUDE_PREFIX.length),
          search: url.search,
          headers: request.headers,
          body,
        });
        return toResponse(reply);
      }).pipe(
        Effect.provideService(HttpIncomingMessage.MaxBodySize, MAX_REQUEST),
        Effect.catchTags({
          HttpServerError: (error) =>
            error.reason._tag === "RequestParseError" && error.reason.reason === "BodyTooLarge"
              ? Effect.succeed(tooLarge)
              : Effect.fail(error),
        }),
      ),
    );
    yield* router.add("GET", "/health", Effect.succeed(HttpServerResponse.text("ok")));
  }),
);

/** The gateway on its own address, without an access log: the usage record covers each call. */
export const layerServer = (options: { readonly host: string; readonly port: number }) =>
  HttpRouter.serve(layerRoutes, { disableLogger: true }).pipe(
    Layer.provide(NodeHttpServer.layer(NodeHttp.createServer, options)),
  );

/**
 * How the gateway calls providers: through the proxy `HTTPS_PROXY` names
 * unless `NO_PROXY` exempts the host, as company networks often require.
 * Undici leaves bodies as sent, so streams pass through as they arrive.
 */
export const layerProviderClient = NodeHttpClient.layerUndiciNoDispatcher.pipe(
  Layer.provide(
    Layer.effect(
      NodeHttpClient.Dispatcher,
      Effect.acquireRelease(
        Effect.sync(() => new EnvHttpProxyAgent()),
        (agent) => Effect.promise(() => agent.destroy()),
      ),
    ),
  ),
);
