import { CONNECTOR_OAUTH_CALLBACK_PATH } from "@codenine/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { parseBearerToken } from "../auth/EnvironmentAuth.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import { requestUrl } from "../requestUrl.ts";
import * as ConnectorGateway from "./ConnectorGateway.ts";
import * as Connectors from "./Connectors.ts";

/** Each chat reaches a connection here with the credential its Codenine MCP server uses. */
const CONNECTOR_GATEWAY_PATH = "/mcp/connectors/:connectionId";

const NO_STORE = { "cache-control": "no-store" };

/** Agents inside Codenine already hold a credential; there is no sign-in to offer here. */
const unauthorized = HttpServerResponse.jsonUnsafe(
  { error: "invalid_mcp_credential", message: "A valid Codenine MCP credential is required." },
  { status: 401, headers: { ...NO_STORE, "www-authenticate": "Bearer" } },
);

const parseError = HttpServerResponse.jsonUnsafe(
  { jsonrpc: "2.0", id: null, error: { code: -32700, message: "The body is not JSON." } },
  { status: 400, headers: NO_STORE },
);

const methodNotAllowed = HttpServerResponse.empty({
  status: 405,
  headers: { ...NO_STORE, allow: "POST" },
});

const redirect = (location: string) =>
  HttpServerResponse.empty({
    status: 302,
    headers: { ...NO_STORE, location, "referrer-policy": "no-referrer" },
  });

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const registry = yield* McpSessionRegistry.McpSessionRegistry;
    const gateway = yield* ConnectorGateway.ConnectorGateway;
    const connectors = yield* Connectors.Connectors;

    const gatewayRoute = HttpRouter.add(
      "POST",
      CONNECTOR_GATEWAY_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const scope = yield* registry.resolve(parseBearerToken(request) ?? "");
        if (scope === undefined) return unauthorized;
        const connectionId = (yield* HttpRouter.params)["connectionId"] ?? "";
        const body = yield* request.json.pipe(Effect.option);
        if (Option.isNone(body)) return parseError;
        const handle = (message: unknown) =>
          gateway.handle({ threadId: scope.thread.threadId, connectionId, message });
        const responses = Array.isArray(body.value)
          ? (yield* Effect.forEach(body.value, handle)).filter((response) => response !== undefined)
          : [yield* handle(body.value)].filter((response) => response !== undefined);
        if (responses.length === 0) return HttpServerResponse.empty({ status: 202 });
        return HttpServerResponse.jsonUnsafe(Array.isArray(body.value) ? responses : responses[0], {
          headers: NO_STORE,
        });
      }),
    );

    const callbackRoute = HttpRouter.add(
      "GET",
      CONNECTOR_OAUTH_CALLBACK_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const params = Option.match(requestUrl(request), {
          onNone: () => new URLSearchParams(),
          onSome: (url) => url.searchParams,
        });
        const value = (name: string) => params.get(name) ?? undefined;
        const finished = yield* connectors
          .finishSignIn({
            state: value("state"),
            code: value("code"),
            error: value("error"),
            iss: value("iss"),
          })
          .pipe(Effect.result);
        return finished._tag === "Success"
          ? redirect(`/connectors/${encodeURIComponent(finished.success)}?signedIn=1`)
          : redirect(`/connectors?signInError=${encodeURIComponent(finished.failure.detail)}`);
      }),
    );

    return Layer.mergeAll(
      gatewayRoute,
      HttpRouter.add("GET", CONNECTOR_GATEWAY_PATH, methodNotAllowed),
      HttpRouter.add("DELETE", CONNECTOR_GATEWAY_PATH, methodNotAllowed),
      callbackRoute,
    );
  }),
);
