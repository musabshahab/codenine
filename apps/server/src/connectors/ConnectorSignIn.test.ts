import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ConnectionId, ConnectorCatalogId, DEFAULT_CONNECTOR_APPROVALS } from "@codenine/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { ConnectorFetch } from "./ConnectorFetch.ts";
import * as ConnectorSignIn from "./ConnectorSignIn.ts";
import * as ConnectorStore from "./ConnectorStore.ts";

describe("connectorRedirectUri", () => {
  it.each([
    ["http://localhost:5173", "http://localhost:5173/oauth/connectors/callback"],
    ["http://127.0.0.1:3773", "http://127.0.0.1:3773/oauth/connectors/callback"],
    ["https://box.tail1234.ts.net", "https://box.tail1234.ts.net/oauth/connectors/callback"],
  ])("comes back to %s", (origin, expected) => {
    assert.strictEqual(ConnectorSignIn.connectorRedirectUri(origin), expected);
  });

  it.each([
    "http://192.168.1.20:3773",
    "https://box.example.com/codenine",
    "https://box.example.com/",
    "ftp://box.example.com",
    "not an address",
  ])("refuses %s", (origin) => {
    const result = ConnectorSignIn.connectorRedirectUri(origin);
    assert.notStrictEqual(typeof result, "string");
  });
});

interface Recorded {
  readonly url: string;
  readonly body: string;
}

/** Answers like the services in each test; any other address is a 404. */
const fakeFetch = (
  routes: Record<string, (body: string) => { readonly status?: number; readonly json: unknown }>,
  recorded: Array<Recorded>,
) =>
  ((url: string | URL, init?: RequestInit) => {
    const href = String(url);
    const body = typeof init?.body === "string" ? init.body : String(init?.body ?? "");
    recorded.push({ url: href, body });
    const route = routes[href.split("?")[0] ?? href];
    if (route === undefined) return Promise.resolve(new Response("not found", { status: 404 }));
    const answer = route(body);
    return Promise.resolve(
      new Response(JSON.stringify(answer.json), {
        status: answer.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) satisfies (url: string | URL, init?: RequestInit) => Promise<Response>;

const stored = (id: string, catalogId: string | null): ConnectorStore.StoredConnection => ({
  id: ConnectionId.make(id),
  catalogId: catalogId === null ? null : ConnectorCatalogId.make(catalogId),
  custom:
    catalogId === null
      ? { transport: { type: "http", url: "https://mcp.example.com/mcp" }, auth: "sign-in" }
      : null,
  name: id,
  onByDefault: true,
  approvals: DEFAULT_CONNECTOR_APPROVALS,
  toolApprovals: {},
  inputs: {},
  account: null,
  connectedAt: "2026-11-17T10:00:00.000Z",
  lastUsedAt: null,
});

const layerSignIn = Layer.fresh(
  ConnectorSignIn.layer.pipe(
    Layer.provideMerge(ConnectorStore.layer),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "codenine-connector-sign-in-test-" }),
    ),
  ),
);

const googleTokens = {
  access_token: "google-access",
  refresh_token: "google-refresh",
  expires_in: 3600,
  token_type: "Bearer",
  // A header and a payload naming the account; Codenine only shows the email.
  id_token: `e30.${Buffer.from(JSON.stringify({ email: "sam@example.com" })).toString("base64url")}.sig`,
};

const startGmail = Effect.gen(function* () {
  const store = yield* ConnectorStore.ConnectorStore;
  const signIn = yield* ConnectorSignIn.ConnectorSignIn;
  const gmail = yield* store.create("gmail", (id) => ({ ...stored(id, "gmail") }));
  yield* store.writeOwnApp("google", { clientId: "client-id", clientSecret: "client-secret" });
  const authorizeUrl = new URL(
    yield* signIn.start({ connection: gmail, redirectOrigin: "http://localhost:5173" }),
  );
  return { store, signIn, gmail, authorizeUrl, state: authorizeUrl.searchParams.get("state") };
});

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("ConnectorSignIn", (it) => {
  it.effect("signs in to Google with the user's own app and saves the tokens", () => {
    const recorded: Array<Recorded> = [];
    return Effect.gen(function* () {
      const { store, signIn, gmail, authorizeUrl, state } = yield* startGmail;
      assert.strictEqual(
        authorizeUrl.origin + authorizeUrl.pathname,
        "https://accounts.google.com/o/oauth2/v2/auth",
      );
      assert.strictEqual(authorizeUrl.searchParams.get("client_id"), "client-id");
      assert.strictEqual(
        authorizeUrl.searchParams.get("redirect_uri"),
        "http://localhost:5173/oauth/connectors/callback",
      );
      assert.strictEqual(authorizeUrl.searchParams.get("access_type"), "offline");
      assert.strictEqual(authorizeUrl.searchParams.get("prompt"), "consent");
      assert.strictEqual(authorizeUrl.searchParams.get("code_challenge_method"), "S256");
      const scopes = authorizeUrl.searchParams.get("scope")?.split(" ") ?? [];
      assert.include(scopes, "https://www.googleapis.com/auth/gmail.modify");
      assert.notInclude(scopes, "https://mail.google.com/");
      assert.isTrue(yield* signIn.isPending(gmail.id));
      assert.deepStrictEqual(recorded, []);

      const finished = yield* signIn.finish({
        state: state ?? undefined,
        code: "the-code",
        error: undefined,
        iss: "https://accounts.google.com",
      });
      assert.strictEqual(finished, gmail.id);
      assert.isFalse(yield* signIn.isPending(gmail.id));
      const exchange = new URLSearchParams(recorded[0]?.body ?? "");
      assert.strictEqual(recorded[0]?.url, "https://oauth2.googleapis.com/token");
      assert.strictEqual(exchange.get("code"), "the-code");
      assert.strictEqual(
        exchange.get("redirect_uri"),
        "http://localhost:5173/oauth/connectors/callback",
      );
      assert.isNotNull(exchange.get("code_verifier"));
      const auth = yield* store.readAuth(gmail.id);
      assert.strictEqual(auth?.accessToken, "google-access");
      assert.strictEqual(auth?.refreshToken, "google-refresh");
      assert.deepStrictEqual(auth?.client, { kind: "own-app", app: "google" });

      // The flow is used up, so the same answer cannot sign in twice.
      const again = yield* signIn
        .finish({ state: state ?? undefined, code: "the-code", error: undefined, iss: undefined })
        .pipe(Effect.flip);
      assert.strictEqual(again._tag === "ConnectorError" && again.reason, "sign-in-failed");
    }).pipe(
      Effect.provideService(
        ConnectorFetch,
        fakeFetch(
          { "https://oauth2.googleapis.com/token": () => ({ json: googleTokens }) },
          recorded,
        ),
      ),
      Effect.provide(layerSignIn),
    );
  });

  it.effect("refuses an answer from another issuer, a cancelled sign-in and an old one", () => {
    const recorded: Array<Recorded> = [];
    return Effect.gen(function* () {
      const mixedUp = yield* startGmail;
      const wrongIssuer = yield* mixedUp.signIn
        .finish({
          state: mixedUp.state ?? undefined,
          code: "code",
          error: undefined,
          iss: "https://attacker.example.com",
        })
        .pipe(Effect.flip);
      assert.strictEqual(
        wrongIssuer._tag === "ConnectorError" && wrongIssuer.reason,
        "sign-in-failed",
      );
      assert.isUndefined(yield* mixedUp.store.readAuth(mixedUp.gmail.id));

      const cancelled = yield* mixedUp.signIn.start({
        connection: mixedUp.gmail,
        redirectOrigin: "http://localhost:5173",
      });
      const denied = yield* mixedUp.signIn
        .finish({
          state: new URL(cancelled).searchParams.get("state") ?? undefined,
          code: undefined,
          error: "access_denied",
          iss: undefined,
        })
        .pipe(Effect.flip);
      assert.strictEqual(denied.message, "Signing in was cancelled.");

      const late = yield* mixedUp.signIn.start({
        connection: mixedUp.gmail,
        redirectOrigin: "http://localhost:5173",
      });
      yield* TestClock.adjust("16 minutes");
      assert.isFalse(yield* mixedUp.signIn.isPending(mixedUp.gmail.id));
      const expired = yield* mixedUp.signIn
        .finish({
          state: new URL(late).searchParams.get("state") ?? undefined,
          code: "code",
          error: undefined,
          iss: undefined,
        })
        .pipe(Effect.flip);
      assert.strictEqual(expired.message, "This sign-in has expired. Start signing in again.");
      assert.deepStrictEqual(recorded, []);
    }).pipe(
      Effect.provideService(
        ConnectorFetch,
        fakeFetch(
          { "https://oauth2.googleapis.com/token": () => ({ json: googleTokens }) },
          recorded,
        ),
      ),
      Effect.provide(layerSignIn),
    );
  });

  it.effect("registers once per authorization server and redirect address", () => {
    const recorded: Array<Recorded> = [];
    const routes = {
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp": () => ({
        json: {
          resource: "https://mcp.example.com/mcp",
          authorization_servers: ["https://auth.example.com"],
        },
      }),
      "https://auth.example.com/.well-known/oauth-authorization-server": () => ({
        json: {
          issuer: "https://auth.example.com",
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          registration_endpoint: "https://auth.example.com/register",
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
        },
      }),
      "https://auth.example.com/register": () => ({
        status: 201,
        json: {
          client_id: "registered-client",
          redirect_uris: ["http://localhost:5173/oauth/connectors/callback"],
        },
      }),
    };
    return Effect.gen(function* () {
      const store = yield* ConnectorStore.ConnectorStore;
      const signIn = yield* ConnectorSignIn.ConnectorSignIn;
      const custom = yield* store.create("example", (id) => stored(id, null));
      const first = new URL(
        yield* signIn.start({ connection: custom, redirectOrigin: "http://localhost:5173" }),
      );
      const second = new URL(
        yield* signIn.start({ connection: custom, redirectOrigin: "http://localhost:5173" }),
      );
      assert.strictEqual(first.origin + first.pathname, "https://auth.example.com/authorize");
      assert.strictEqual(first.searchParams.get("client_id"), "registered-client");
      assert.strictEqual(first.searchParams.get("resource"), "https://mcp.example.com/mcp");
      assert.strictEqual(second.searchParams.get("client_id"), "registered-client");
      assert.strictEqual(
        recorded.filter((request) => request.url === "https://auth.example.com/register").length,
        1,
      );
    }).pipe(
      Effect.provideService(ConnectorFetch, fakeFetch(routes, recorded)),
      Effect.provide(layerSignIn),
    );
  });

  it.effect("renews an expired token, and a refused renewal needs signing in again", () => {
    const recorded: Array<Recorded> = [];
    let refuse = false;
    return Effect.gen(function* () {
      const store = yield* ConnectorStore.ConnectorStore;
      const signIn = yield* ConnectorSignIn.ConnectorSignIn;
      const gmail = yield* store.create("gmail", (id) => stored(id, "gmail"));
      yield* store.writeOwnApp("google", { clientId: "client-id", clientSecret: "client-secret" });
      yield* store.writeAuth(gmail.id, {
        accessToken: "old-access",
        refreshToken: "refresh",
        expiresAt: 0,
        issuer: "https://accounts.google.com",
        authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenEndpoint: "https://oauth2.googleapis.com/token",
        client: { kind: "own-app", app: "google" },
      });
      yield* TestClock.adjust("1 hour");
      assert.strictEqual(yield* signIn.accessToken(gmail.id), "new-access");
      assert.strictEqual(
        new URLSearchParams(recorded[0]?.body ?? "").get("refresh_token"),
        "refresh",
      );
      assert.strictEqual((yield* store.readAuth(gmail.id))?.refreshToken, "refresh");

      refuse = true;
      const refused = yield* signIn.accessToken(gmail.id, { renew: true }).pipe(Effect.flip);
      assert.strictEqual(
        refused._tag === "ConnectorCredentialError" && refused.kind,
        "needs-sign-in",
      );
      assert.isUndefined(yield* store.readAuth(gmail.id));
    }).pipe(
      Effect.provideService(
        ConnectorFetch,
        fakeFetch(
          {
            "https://oauth2.googleapis.com/token": () =>
              refuse
                ? { status: 400, json: { error: "invalid_grant" } }
                : { json: { access_token: "new-access", token_type: "Bearer", expires_in: 3600 } },
          },
          recorded,
        ),
      ),
      Effect.provide(layerSignIn),
    );
  });
});
