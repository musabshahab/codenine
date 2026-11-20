import {
  CONNECTOR_OAUTH_CALLBACK_PATH,
  type ConnectionId,
  ConnectorError,
  type ConnectorOwnApp,
} from "@codenine/contracts";
import {
  type AuthorizationServerMetadata,
  discoverOAuthServerInfo,
  exchangeAuthorization,
  type OAuthClientInformationMixed,
  type OAuthTokens,
  OAuthError,
  refreshAuthorization,
  registerClient,
  resourceUrlFromServerUrl,
  startAuthorization,
} from "@modelcontextprotocol/client";
import * as KeyedLock from "@codenine/shared/KeyedLock";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { OWN_APP_ENDPOINTS } from "./catalog.ts";
import { connectionAuthKind, connectionCatalog, resolveServer } from "./connectionServer.ts";
import { ConnectorFetch } from "./ConnectorFetch.ts";
import * as ConnectorStore from "./ConnectorStore.ts";

/** Why Codenine has no working token for a connection right now. */
export class ConnectorCredentialError extends Schema.TaggedError<ConnectorCredentialError>()(
  "ConnectorCredentialError",
  {
    kind: Schema.Literals(["needs-sign-in", "unreachable"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.kind === "needs-sign-in"
      ? "Sign in again to keep using it."
      : "Codenine could not reach the service to renew the sign-in.";
  }
}

/** A request the OAuth library made failed; the cause stays out of anything shown. */
class OAuthRequestError extends Schema.TaggedError<OAuthRequestError>()("OAuthRequestError", {
  step: Schema.Literals(["discover", "register", "authorize", "exchange", "refresh"]),
  cause: Schema.Defect(),
}) {}

/** What the service sent the browser back with. */
export interface SignInCallback {
  readonly state: string | undefined;
  readonly code: string | undefined;
  readonly error: string | undefined;
  readonly iss: string | undefined;
}

interface PendingSignIn {
  readonly connectionId: ConnectionId;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly metadata: AuthorizationServerMetadata;
  readonly clientInformation: OAuthClientInformationMixed;
  readonly client: ConnectorStore.ConnectionAuth["client"];
  readonly resource: string | undefined;
  readonly expiresAt: number;
}

const PENDING_SIGN_IN_TTL = Duration.minutes(15);
// Renew a little early so a call never starts with a token about to lapse.
const REFRESH_MARGIN_MS = 60_000;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Services send the browser back to `<origin>/oauth/connectors/callback`. Every service Codenine
 * signs in to accepts that only over https or on this computer, so other origins fail here.
 */
export const connectorRedirectUri = (redirectOrigin: string): string | ConnectorError => {
  const invalid = (detail: string) => new ConnectorError({ reason: "invalid", detail });
  if (!URL.canParse(redirectOrigin)) return invalid("The address to come back to is not valid.");
  const url = new URL(redirectOrigin);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.origin !== redirectOrigin) {
    return invalid("The address to come back to must be an http or https origin.");
  }
  if (
    url.protocol === "http:" &&
    !LOOPBACK_HOSTS.has(url.hostname) &&
    !url.hostname.endsWith(".localhost")
  ) {
    return invalid(
      "Signing in needs Codenine opened at an https address or on this computer at localhost.",
    );
  }
  return `${url.origin}${CONNECTOR_OAUTH_CALLBACK_PATH}`;
};

const ownAppMetadata = (app: ConnectorOwnApp): AuthorizationServerMetadata => {
  const endpoints = OWN_APP_ENDPOINTS[app];
  return {
    issuer: endpoints.issuer,
    authorization_endpoint: endpoints.authorizationEndpoint,
    token_endpoint: endpoints.tokenEndpoint,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: [...endpoints.tokenEndpointAuthMethods],
  };
};

const ownAppName = (app: ConnectorOwnApp) => (app === "google" ? "Google" : "Slack");

const signInFailed = (detail: string) => new ConnectorError({ reason: "sign-in-failed", detail });

/** An OAuth refusal means the saved grant is gone; anything else may pass. */
const isRejectedGrant = (cause: unknown) =>
  cause instanceof OAuthError &&
  ["invalid_grant", "invalid_client", "unauthorized_client", "invalid_token"].includes(cause.code);

export class ConnectorSignIn extends Context.Service<
  ConnectorSignIn,
  {
    /** Prepares signing in and returns the address to open in the browser. */
    readonly start: (input: {
      readonly connection: ConnectorStore.StoredConnection;
      readonly redirectOrigin: string;
    }) => Effect.Effect<string, ConnectorError | ConnectorStore.ConnectorStoreError>;
    readonly finish: (
      callback: SignInCallback,
    ) => Effect.Effect<ConnectionId, ConnectorError | ConnectorStore.ConnectorStoreError>;
    readonly isPending: (connectionId: ConnectionId) => Effect.Effect<boolean>;
    readonly forget: (connectionId: ConnectionId) => Effect.Effect<void>;
    /** A token for the next request, renewed when it expires or `renew` is set. */
    readonly accessToken: (
      connectionId: ConnectionId,
      options?: { readonly renew?: boolean },
    ) => Effect.Effect<string, ConnectorCredentialError | ConnectorStore.ConnectorStoreError>;
  }
>()("codenine/connectors/ConnectorSignIn") {}

const make = Effect.gen(function* () {
  const store = yield* ConnectorStore.ConnectorStore;
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;
  const pending = yield* Ref.make<ReadonlyMap<string, PendingSignIn>>(new Map());
  const refreshLock = yield* KeyedLock.make<ConnectionId>();
  const scope = yield* Effect.scope;

  /** Dynamic registrations are reused per authorization server and redirect address. */
  const registrationKey = (issuer: string, redirectUri: string) =>
    digest
      .digest(Digest.sha256, new TextEncoder().encode(`${issuer}\n${redirectUri}`))
      .pipe(Effect.map((bytes) => Buffer.from(bytes).toString("hex").slice(0, 32)));

  const clientInformationFor = Effect.fn("ConnectorSignIn.clientInformationFor")(function* (
    client: ConnectorStore.ConnectionAuth["client"],
  ) {
    if (client.kind === "own-app") {
      const credentials = yield* store.readOwnApp(client.app);
      return credentials === undefined
        ? undefined
        : ({
            client_id: credentials.clientId,
            client_secret: credentials.clientSecret,
          } satisfies OAuthClientInformationMixed);
    }
    const registered = yield* store.readRegisteredClient(client.key);
    return registered === undefined
      ? undefined
      : ({
          client_id: registered.clientId,
          ...(registered.clientSecret === undefined
            ? {}
            : { client_secret: registered.clientSecret }),
          ...(registered.tokenEndpointAuthMethod === undefined
            ? {}
            : { token_endpoint_auth_method: registered.tokenEndpointAuthMethod }),
        } satisfies OAuthClientInformationMixed);
  });

  const authFromTokens = (input: {
    readonly tokens: OAuthTokens;
    readonly metadata: AuthorizationServerMetadata;
    readonly client: ConnectorStore.ConnectionAuth["client"];
    readonly resource: string | undefined;
    readonly now: number;
    readonly previous?: ConnectorStore.ConnectionAuth;
  }): ConnectorStore.ConnectionAuth => {
    const refreshToken = input.tokens.refresh_token ?? input.previous?.refreshToken;
    const idToken = input.tokens.id_token ?? input.previous?.idToken;
    const scope = input.tokens.scope ?? input.previous?.scope;
    return {
      accessToken: input.tokens.access_token,
      ...(refreshToken === undefined ? {} : { refreshToken }),
      ...(input.tokens.expires_in === undefined
        ? {}
        : { expiresAt: input.now + input.tokens.expires_in * 1000 }),
      ...(scope === undefined ? {} : { scope }),
      issuer: input.metadata.issuer,
      authorizationEndpoint: input.metadata.authorization_endpoint,
      tokenEndpoint: input.metadata.token_endpoint,
      ...(input.metadata.token_endpoint_auth_methods_supported === undefined
        ? {}
        : { tokenEndpointAuthMethods: input.metadata.token_endpoint_auth_methods_supported }),
      ...(input.resource === undefined ? {} : { resource: input.resource }),
      client: input.client,
      ...(idToken === undefined ? {} : { idToken }),
    };
  };

  const start: ConnectorSignIn["Service"]["start"] = Effect.fn("ConnectorSignIn.start")(function* ({
    connection,
    redirectOrigin,
  }) {
    const redirectUri = connectorRedirectUri(redirectOrigin);
    if (typeof redirectUri !== "string") return yield* redirectUri;
    const authKind = connectionAuthKind(connection);
    const catalog = connectionCatalog(connection);
    const server = resolveServer(connection, yield* store.readSecrets(connection.id));
    if (server?.type !== "http" || (authKind !== "sign-in" && authKind !== "own-app")) {
      return yield* new ConnectorError({
        reason: "invalid",
        detail: "This connector does not sign in.",
      });
    }
    const fetchFn = yield* ConnectorFetch;

    const prepared = yield* Effect.gen(function* () {
      const ownApp = catalog?.entry.ownApp;
      if (authKind === "own-app" && ownApp !== undefined) {
        const credentials = yield* store.readOwnApp(ownApp);
        if (credentials === undefined) {
          return yield* new ConnectorError({
            reason: "invalid",
            detail: `Add your ${ownAppName(ownApp)} app's client ID and secret first.`,
          });
        }
        return {
          metadata: ownAppMetadata(ownApp),
          clientInformation: {
            client_id: credentials.clientId,
            client_secret: credentials.clientSecret,
          } satisfies OAuthClientInformationMixed,
          client: { kind: "own-app", app: ownApp } as const,
          scope: catalog?.scopes?.join(" "),
          resource: undefined,
        };
      }
      const info = yield* Effect.tryPromise({
        try: () => discoverOAuthServerInfo(server.url, { fetchFn }),
        catch: (cause) => new OAuthRequestError({ step: "discover", cause }),
      }).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("connector sign-in discovery failed", {
            connectionId: connection.id,
            cause,
          }),
        ),
        Effect.mapError(() =>
          signInFailed(`Codenine could not reach ${new URL(server.url).host} to sign in.`),
        ),
      );
      const metadata = info.authorizationServerMetadata;
      if (metadata === undefined) {
        return yield* signInFailed("This service does not say how to sign in.");
      }
      const scope =
        catalog?.scopes?.join(" ") ?? info.resourceMetadata?.scopes_supported?.join(" ");
      const key = yield* registrationKey(metadata.issuer, redirectUri);
      const registered =
        (yield* store.readRegisteredClient(key)) ??
        (yield* Effect.gen(function* () {
          if (metadata.registration_endpoint === undefined) {
            return yield* signInFailed(
              "This service only signs in apps registered by hand, which Codenine cannot do yet.",
            );
          }
          const full = yield* Effect.tryPromise({
            try: () =>
              registerClient(info.authorizationServerUrl, {
                metadata,
                clientMetadata: {
                  client_name: "Codenine",
                  redirect_uris: [redirectUri],
                  grant_types: ["authorization_code", "refresh_token"],
                  response_types: ["code"],
                  token_endpoint_auth_method: "none",
                },
                ...(scope === undefined ? {} : { scope }),
                fetchFn,
              }),
            catch: (cause) => new OAuthRequestError({ step: "register", cause }),
          }).pipe(
            Effect.tapError((cause) =>
              Effect.logWarning("connector client registration failed", {
                connectionId: connection.id,
                cause,
              }),
            ),
            Effect.mapError(() => signInFailed("The service would not register Codenine.")),
          );
          const client: ConnectorStore.RegisteredClient = {
            clientId: full.client_id,
            ...(full.client_secret === undefined ? {} : { clientSecret: full.client_secret }),
            ...(full.token_endpoint_auth_method === undefined
              ? {}
              : { tokenEndpointAuthMethod: full.token_endpoint_auth_method }),
          };
          yield* store.writeRegisteredClient(key, client);
          return client;
        }));
      return {
        metadata,
        clientInformation: {
          client_id: registered.clientId,
          ...(registered.clientSecret === undefined
            ? {}
            : { client_secret: registered.clientSecret }),
          ...(registered.tokenEndpointAuthMethod === undefined
            ? {}
            : { token_endpoint_auth_method: registered.tokenEndpointAuthMethod }),
        } satisfies OAuthClientInformationMixed,
        client: { kind: "registered", key } as const,
        scope,
        // RFC 8707: the metadata's own spelling, else the server's address.
        resource: info.resourceMetadata?.resource ?? resourceUrlFromServerUrl(server.url).href,
      };
    });

    const state = Buffer.from(yield* random.randomBytes(32)).toString("base64url");
    const { authorizationUrl, codeVerifier } = yield* Effect.tryPromise({
      try: () =>
        startAuthorization(prepared.metadata.issuer, {
          metadata: prepared.metadata,
          clientInformation: prepared.clientInformation,
          redirectUrl: redirectUri,
          state,
          ...(prepared.scope === undefined ? {} : { scope: prepared.scope }),
          ...(prepared.resource === undefined ? {} : { resource: prepared.resource }),
        }),
      catch: (cause) => new OAuthRequestError({ step: "authorize", cause }),
    }).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("connector sign-in could not start", {
          connectionId: connection.id,
          cause,
        }),
      ),
      Effect.mapError(() => signInFailed("This service's sign-in does not work with Codenine.")),
    );
    for (const [name, value] of Object.entries(catalog?.authorizeParams ?? {})) {
      authorizationUrl.searchParams.set(name, value);
    }
    const now = yield* Clock.currentTimeMillis;
    yield* Ref.update(pending, (current) => {
      const next = new Map(
        Array.from(current).filter(
          ([, flow]) => flow.expiresAt > now && flow.connectionId !== connection.id,
        ),
      );
      next.set(state, {
        connectionId: connection.id,
        codeVerifier,
        redirectUri,
        metadata: prepared.metadata,
        clientInformation: prepared.clientInformation,
        client: prepared.client,
        resource: prepared.resource,
        expiresAt: now + Duration.toMillis(PENDING_SIGN_IN_TTL),
      });
      return next;
    });
    yield* store.notifyChanged;
    // The connection stops showing as signing in once the flow expires.
    yield* Effect.sleep(PENDING_SIGN_IN_TTL).pipe(
      Effect.andThen(store.notifyChanged),
      Effect.forkIn(scope),
    );
    return authorizationUrl.href;
  });

  const finish: ConnectorSignIn["Service"]["finish"] = Effect.fn("ConnectorSignIn.finish")(
    function* (callback) {
      const now = yield* Clock.currentTimeMillis;
      const flow =
        callback.state === undefined
          ? undefined
          : yield* Ref.modify(pending, (current) => {
              const found = current.get(callback.state ?? "");
              if (found === undefined) return [undefined, current] as const;
              const next = new Map(current);
              next.delete(callback.state ?? "");
              return [found, next] as const;
            });
      if (flow === undefined || flow.expiresAt <= now) {
        return yield* signInFailed("This sign-in has expired. Start signing in again.");
      }
      yield* store.notifyChanged;
      if (callback.error !== undefined || callback.code === undefined) {
        return yield* signInFailed(
          callback.error === "access_denied"
            ? "Signing in was cancelled."
            : "The service did not finish signing in.",
        );
      }
      const fetchFn = yield* ConnectorFetch;
      const code = callback.code;
      const tokens = yield* Effect.tryPromise({
        try: () =>
          exchangeAuthorization(flow.metadata.issuer, {
            metadata: flow.metadata,
            clientInformation: flow.clientInformation,
            authorizationCode: code,
            ...(callback.iss === undefined ? {} : { iss: callback.iss }),
            codeVerifier: flow.codeVerifier,
            redirectUri: flow.redirectUri,
            ...(flow.resource === undefined ? {} : { resource: flow.resource }),
            fetchFn,
          }),
        catch: (cause) => new OAuthRequestError({ step: "exchange", cause }),
      }).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("connector sign-in code exchange failed", {
            connectionId: flow.connectionId,
            cause,
          }),
        ),
        Effect.mapError(() => signInFailed("The service did not accept the sign-in.")),
      );
      yield* store.writeAuth(
        flow.connectionId,
        authFromTokens({
          tokens,
          metadata: flow.metadata,
          client: flow.client,
          resource: flow.resource,
          now: yield* Clock.currentTimeMillis,
        }),
      );
      return flow.connectionId;
    },
  );

  const renew = Effect.fn("ConnectorSignIn.renew")(function* (
    connectionId: ConnectionId,
    auth: ConnectorStore.ConnectionAuth,
  ) {
    const clearSignIn = store
      .writeAuth(connectionId, undefined)
      .pipe(Effect.andThen(Effect.fail(new ConnectorCredentialError({ kind: "needs-sign-in" }))));
    const clientInformation = yield* clientInformationFor(auth.client);
    if (auth.refreshToken === undefined || clientInformation === undefined)
      return yield* clearSignIn;
    const refreshToken = auth.refreshToken;
    const metadata: AuthorizationServerMetadata = {
      issuer: auth.issuer ?? new URL(auth.tokenEndpoint).origin,
      authorization_endpoint: auth.authorizationEndpoint,
      token_endpoint: auth.tokenEndpoint,
      response_types_supported: ["code"],
      ...(auth.tokenEndpointAuthMethods === undefined
        ? {}
        : { token_endpoint_auth_methods_supported: [...auth.tokenEndpointAuthMethods] }),
    };
    const fetchFn = yield* ConnectorFetch;
    const tokens = yield* Effect.tryPromise({
      try: () =>
        refreshAuthorization(metadata.issuer, {
          metadata,
          clientInformation,
          refreshToken,
          ...(auth.resource === undefined ? {} : { resource: auth.resource }),
          fetchFn,
        }),
      catch: (cause) => new OAuthRequestError({ step: "refresh", cause }),
    }).pipe(Effect.result);
    if (tokens._tag === "Failure") {
      yield* Effect.logWarning("connector token refresh failed", {
        connectionId,
        cause: tokens.failure,
      });
      return isRejectedGrant(tokens.failure.cause)
        ? yield* clearSignIn
        : yield* new ConnectorCredentialError({ kind: "unreachable", cause: tokens.failure });
    }
    const next = authFromTokens({
      tokens: tokens.success,
      metadata,
      client: auth.client,
      resource: auth.resource,
      now: yield* Clock.currentTimeMillis,
      previous: auth,
    });
    yield* store.writeAuth(connectionId, next);
    return next.accessToken;
  });

  const accessToken: ConnectorSignIn["Service"]["accessToken"] = Effect.fn(
    "ConnectorSignIn.accessToken",
  )(function* (connectionId, options) {
    return yield* refreshLock.withLock(
      connectionId,
      Effect.gen(function* () {
        const auth = yield* store.readAuth(connectionId);
        if (auth === undefined) {
          return yield* new ConnectorCredentialError({ kind: "needs-sign-in" });
        }
        const now = yield* Clock.currentTimeMillis;
        const fresh = auth.expiresAt === undefined || auth.expiresAt - now > REFRESH_MARGIN_MS;
        return options?.renew !== true && fresh
          ? auth.accessToken
          : yield* renew(connectionId, auth);
      }),
    );
  });

  return ConnectorSignIn.of({
    start,
    finish,
    isPending: Effect.fn("ConnectorSignIn.isPending")(function* (connectionId) {
      const now = yield* Clock.currentTimeMillis;
      return Array.from((yield* Ref.get(pending)).values()).some(
        (flow) => flow.connectionId === connectionId && flow.expiresAt > now,
      );
    }),
    forget: Effect.fn("ConnectorSignIn.forget")(function* (connectionId) {
      yield* Ref.update(
        pending,
        (current) =>
          new Map(Array.from(current).filter(([, flow]) => flow.connectionId !== connectionId)),
      );
    }),
    accessToken,
  });
});

export const layer = Layer.effect(ConnectorSignIn, make);
