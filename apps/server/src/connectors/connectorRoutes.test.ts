import {
  ConnectionId,
  ConnectorError,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@codenine/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ConnectorGateway from "./ConnectorGateway.ts";
import * as ConnectorRoutes from "./connectorRoutes.ts";
import * as Connectors from "./Connectors.ts";

const threadId = ThreadId.make("thread:connector-routes");

const withRoutes = <A>(
  use: (
    send: (path: string, init?: RequestInit) => Effect.Effect<Response>,
    handled: Array<{ readonly threadId: string; readonly connectionId: string }>,
  ) => Effect.Effect<A>,
) => {
  const handled: Array<{ readonly threadId: string; readonly connectionId: string }> = [];
  const layerRoutes = ConnectorRoutes.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(McpSessionRegistry.McpSessionRegistry)({
          resolve: (token) =>
            Effect.succeed(
              token === "chat-token"
                ? {
                    environmentId: EnvironmentId.make("environment:connector-routes"),
                    requestNamespace: "provider-session",
                    thread: {
                      threadId,
                      providerSessionId: "provider-session",
                      providerInstanceId: ProviderInstanceId.make("codex"),
                    },
                    client: undefined,
                    capabilities: new Set(),
                    issuedAt: 1,
                  }
                : undefined,
            ),
        }),
        Layer.mock(ConnectorGateway.ConnectorGateway)({
          handle: (input) =>
            Effect.sync(() => {
              handled.push({ threadId: input.threadId, connectionId: input.connectionId });
              const message = input.message as { readonly id?: number };
              return message.id === undefined
                ? undefined
                : { jsonrpc: "2.0" as const, id: message.id, result: {} };
            }),
        }),
        Layer.mock(Connectors.Connectors)({
          finishSignIn: (callback) =>
            callback.state === "known" && callback.code === "code"
              ? Effect.succeed(ConnectionId.make("gmail"))
              : Effect.fail(
                  new ConnectorError({
                    reason: "sign-in-failed",
                    detail: "This sign-in has expired. Start signing in again.",
                  }),
                ),
        }),
      ),
    ),
  );
  return Effect.acquireUseRelease(
    Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
    (web) =>
      use(
        (path, init) =>
          Effect.promise(() =>
            web.handler(new Request(`http://127.0.0.1${path}`, init), Context.empty()),
          ),
        handled,
      ),
    (web) => Effect.promise(() => web.dispose()),
  );
};

const post = (body: unknown, token?: string): RequestInit => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
  },
  body: JSON.stringify(body),
});

it.effect("serves a chat's connection only with that chat's credential", () =>
  withRoutes((send, handled) =>
    Effect.gen(function* () {
      const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
      assert.strictEqual((yield* send("/mcp/connectors/gmail", post(ping))).status, 401);
      assert.strictEqual(
        (yield* send("/mcp/connectors/gmail", post(ping, "other-token"))).status,
        401,
      );
      const answered = yield* send("/mcp/connectors/gmail", post(ping, "chat-token"));
      assert.strictEqual(answered.status, 200);
      assert.deepStrictEqual(yield* Effect.promise(() => answered.json()), {
        jsonrpc: "2.0",
        id: 1,
        result: {},
      });
      const notified = yield* send(
        "/mcp/connectors/gmail",
        post({ jsonrpc: "2.0", method: "notifications/initialized" }, "chat-token"),
      );
      assert.strictEqual(notified.status, 202);
      assert.deepStrictEqual(handled, [
        { threadId, connectionId: "gmail" },
        { threadId, connectionId: "gmail" },
      ]);
      assert.strictEqual((yield* send("/mcp/connectors/gmail")).status, 405);
    }),
  ),
);

it.effect("sends the browser back to the connector after signing in, or says why not", () =>
  withRoutes((send) =>
    Effect.gen(function* () {
      const signedIn = yield* send("/oauth/connectors/callback?state=known&code=code");
      assert.strictEqual(signedIn.status, 302);
      assert.strictEqual(signedIn.headers.get("location"), "/connectors/gmail?signedIn=1");

      const failed = yield* send("/oauth/connectors/callback?state=unknown&code=code");
      assert.strictEqual(failed.status, 302);
      const location = new URL(failed.headers.get("location") ?? "", "http://127.0.0.1");
      assert.strictEqual(location.pathname, "/connectors");
      assert.strictEqual(
        location.searchParams.get("signInError"),
        "This sign-in has expired. Start signing in again.",
      );
    }),
  ),
);
