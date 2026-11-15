// @effect-diagnostics nodeBuiltinImport:off - NodeHttpServer listens on a Node http.Server.
import * as NodeHttp from "node:http";

import {
  ControlApi,
  ControlForbiddenError,
  ControlLicenceInstallError,
  ControlPrincipal,
  ControlSessionAuth,
  ControlSignedOutError,
  ControlUnavailableError,
} from "@codenine/contracts/control";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { sql } from "drizzle-orm";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Cookies from "effect/http/Cookies";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpStaticServer from "effect/http/HttpStaticServer";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { Accounts, type IssuedLink } from "../accounts/Accounts.ts";
import { Sessions } from "../accounts/Sessions.ts";
import { ControlPublicUrl, enrolmentLink } from "../config.ts";
import { ControlDb } from "../db.ts";
import { LicenceService } from "../licence/LicenceService.ts";

const ok = { ok: true as const };

/** `__Host-` makes browsers refuse the cookie unless it is Secure, host-only and on `/`. */
export const sessionCookieName = (secure: boolean) =>
  secure ? "__Host-codenine_control_session" : "codenine_control_session";

const appendCookies = (cookies: Cookies.Cookies) =>
  HttpEffect.appendPreResponseHandler((_request, response) =>
    Effect.succeed(HttpServerResponse.mergeCookies(response, cookies)),
  );

const setSessionCookie = (secure: boolean, token: string, expiresAt: string) =>
  Effect.fromResult(
    Cookies.set(Cookies.empty, sessionCookieName(secure), token, {
      expires: DateTime.toDate(DateTime.makeUnsafe(expiresAt)),
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure,
    }),
  ).pipe(Effect.orDie, Effect.flatMap(appendCookies));

const clearSessionCookie = (secure: boolean) =>
  Effect.fromResult(
    Cookies.expireCookie(Cookies.empty, sessionCookieName(secure), {
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure,
    }),
  ).pipe(Effect.orDie, Effect.flatMap(appendCookies));

export const layerSessionAuth = Layer.effect(
  ControlSessionAuth,
  Effect.gen(function* () {
    const sessions = yield* Sessions;
    const { secure } = yield* ControlPublicUrl;
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const token = request.cookies[sessionCookieName(secure)];
        const session = token === undefined ? Option.none() : yield* sessions.authenticate(token);
        if (Option.isNone(session)) {
          return yield* new ControlSignedOutError({});
        }
        return yield* httpEffect.pipe(Effect.provideService(ControlPrincipal, session.value));
      });
  }),
);

/**
 * Refuses requests that change something and come from another site. The
 * session cookie is SameSite=Lax as well; this also covers sign-in itself.
 */
export const layerCrossSiteGuard = HttpRouter.middleware(
  Effect.gen(function* () {
    const { origin } = yield* ControlPublicUrl;
    return Effect.fnUntraced(function* <E, R>(
      httpEffect: Effect.Effect<
        HttpServerResponse.HttpServerResponse,
        E,
        HttpServerRequest.HttpServerRequest | R
      >,
    ) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const changes = request.method !== "GET" && request.method !== "HEAD";
      const requestOrigin = request.headers["origin"];
      if (
        changes &&
        request.url.startsWith("/control/") &&
        ((requestOrigin !== undefined && requestOrigin !== origin) ||
          request.headers["sec-fetch-site"] === "cross-site")
      ) {
        return HttpServerResponse.text("Requests from other sites are refused.", { status: 403 });
      }
      return yield* httpEffect;
    });
  }),
  { global: true },
);

export const layerHealthApi = HttpApiBuilder.group(
  ControlApi,
  "health",
  Effect.fnUntraced(function* (handlers) {
    const db = yield* ControlDb;
    return handlers.handle(
      "health",
      Effect.fn("ControlHttp.health")(
        function* () {
          yield* db.execute(sql`select 1`);
          return { ok: true as const, service: "control" as const };
        },
        Effect.catch(() => new ControlUnavailableError({ reason: "database-unavailable" })),
      ),
    );
  }),
);

export const layerAccountApi = HttpApiBuilder.group(
  ControlApi,
  "account",
  Effect.fnUntraced(function* (handlers) {
    const accounts = yield* Accounts;
    const sessions = yield* Sessions;
    const { secure } = yield* ControlPublicUrl;

    const startSession = Effect.fn("ControlHttp.startSession")(function* (personId: string) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const { token, session } = yield* sessions.create({
        personId,
        userAgent: request.headers["user-agent"] ?? null,
      });
      yield* setSessionCookie(secure, token, session.expiresAt);
      const signedIn = yield* sessions.authenticate(token);
      if (Option.isNone(signedIn)) {
        return yield* Effect.die("A session made a moment ago did not authenticate.");
      }
      return signedIn.value.person;
    });

    return handlers
      .handle("signIn", ({ payload }) => accounts.signIn(payload))
      .handle(
        "completeSignIn",
        Effect.fn("ControlHttp.completeSignIn")(function* ({ payload }) {
          const { personId } = yield* accounts.completeSignIn(payload);
          return yield* startSession(personId);
        }),
      )
      .handle("requestPasswordReset", ({ payload }) =>
        Effect.as(accounts.requestPasswordReset(payload.email), ok),
      )
      .handle("startEnrolment", ({ payload }) => accounts.startEnrolment(payload.token))
      .handle(
        "finishEnrolment",
        Effect.fn("ControlHttp.finishEnrolment")(function* ({ payload }) {
          const { personId, recoveryCodes } = yield* accounts.finishEnrolment(payload);
          return { me: yield* startSession(personId), recoveryCodes };
        }),
      );
  }),
);

export const layerMeApi = HttpApiBuilder.group(
  ControlApi,
  "me",
  Effect.fnUntraced(function* (handlers) {
    const sessions = yield* Sessions;
    const accounts = yield* Accounts;
    const { secure } = yield* ControlPublicUrl;
    return handlers
      .handle("me", () => ControlPrincipal.pipe(Effect.map((principal) => principal.person)))
      .handle(
        "signOut",
        Effect.fn("ControlHttp.signOut")(function* () {
          const { sessionId, person } = yield* ControlPrincipal;
          yield* sessions.revoke({ personId: person.id, sessionId });
          yield* clearSessionCookie(secure);
          return ok;
        }),
      )
      .handle(
        "sessions",
        Effect.fn("ControlHttp.sessions")(function* () {
          const { sessionId, person } = yield* ControlPrincipal;
          const list = yield* sessions.list(person.id);
          return list.map((session) => ({ ...session, current: session.id === sessionId }));
        }),
      )
      .handle(
        "revokeSession",
        Effect.fn("ControlHttp.revokeSession")(function* ({ params }) {
          const { person } = yield* ControlPrincipal;
          yield* sessions.revoke({ personId: person.id, sessionId: params.sessionId });
          return ok;
        }),
      )
      .handle(
        "signOutEverywhere",
        Effect.fn("ControlHttp.signOutEverywhere")(function* () {
          const { person } = yield* ControlPrincipal;
          yield* sessions.revokeAll(person.id);
          yield* clearSessionCookie(secure);
          return ok;
        }),
      )
      .handle("signInMethods", () =>
        ControlPrincipal.pipe(Effect.flatMap(({ person }) => accounts.signInMethods(person.id))),
      )
      .handle("startPasskey", () =>
        ControlPrincipal.pipe(Effect.flatMap(({ person }) => accounts.startPasskey(person.id))),
      )
      .handle("addPasskey", ({ payload }) =>
        ControlPrincipal.pipe(
          Effect.flatMap(({ person }) => accounts.addPasskey({ personId: person.id, ...payload })),
        ),
      )
      .handle("removePasskey", ({ params }) =>
        ControlPrincipal.pipe(
          Effect.flatMap(({ person }) =>
            accounts.removePasskey({ personId: person.id, passkeyId: params.passkeyId }),
          ),
          Effect.as(ok),
        ),
      );
  }),
);

const requireAdmin = Effect.gen(function* () {
  const { person } = yield* ControlPrincipal;
  if (person.role !== "owner" && person.role !== "admin") {
    return yield* new ControlForbiddenError({});
  }
});

export const layerAdminApi = HttpApiBuilder.group(
  ControlApi,
  "admin",
  Effect.fnUntraced(function* (handlers) {
    const accounts = yield* Accounts;
    const licence = yield* LicenceService;
    const { origin } = yield* ControlPublicUrl;
    const withLink = <E, R>(issued: Effect.Effect<IssuedLink, E, R>) =>
      Effect.map(issued, ({ person, token, emailed }) => ({
        person,
        link: enrolmentLink(origin, token),
        emailed,
      }));

    return handlers
      .handle("licence", () => Effect.andThen(requireAdmin, licence.overview))
      .handle(
        "installLicence",
        Effect.fn("ControlHttp.installLicence")(function* ({ payload }) {
          yield* requireAdmin;
          const { overview } = yield* licence
            .install(payload.token)
            .pipe(
              Effect.mapError((error) => new ControlLicenceInstallError({ problem: error.reason })),
            );
          return overview;
        }),
      )
      .handle("people", () => Effect.andThen(requireAdmin, accounts.listPeople))
      .handle("invite", ({ payload }) =>
        Effect.andThen(requireAdmin, withLink(accounts.invite(payload))),
      )
      .handle("deactivate", ({ params }) =>
        Effect.andThen(requireAdmin, Effect.as(accounts.deactivate(params.personId), ok)),
      )
      .handle("reactivate", ({ params }) =>
        Effect.andThen(requireAdmin, accounts.reactivate(params.personId)),
      )
      .handle("reset", ({ params }) =>
        Effect.andThen(requireAdmin, withLink(accounts.issueReset(params.personId))),
      )
      .handle("unlock", ({ params }) =>
        Effect.andThen(requireAdmin, Effect.as(accounts.unlock(params.personId), ok)),
      );
  }),
);

export const layerRoutes = Layer.mergeAll(
  HttpApiBuilder.layer(ControlApi).pipe(
    Layer.provide([layerHealthApi, layerAccountApi, layerMeApi, layerAdminApi]),
    Layer.provide(layerSessionAuth),
  ),
  layerCrossSiteGuard,
);

/**
 * Serves the built web app from `CODENINE_CONTROL_WEB_DIR`, falling back to
 * `index.html` for app routes. Managed workspaces do not serve it.
 */
export const layerWebApp = Layer.unwrap(
  Effect.gen(function* () {
    const root = yield* Config.option(Config.String("CODENINE_CONTROL_WEB_DIR"));
    return Option.isNone(root)
      ? Layer.empty
      : HttpStaticServer.layer({ root: root.value, spa: true });
  }),
);

export const layerServer = <E, R>(
  options: { readonly host: string; readonly port: number },
  moreRoutes: Layer.Layer<never, E, R>,
) =>
  HttpRouter.serve(Layer.mergeAll(layerRoutes, moreRoutes)).pipe(
    Layer.provide(NodeHttpServer.layer(NodeHttp.createServer, options)),
  );
