import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Cookies from "effect/http/Cookies";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as UrlParams from "effect/http/UrlParams";

import { ControlPublicUrl } from "../config.ts";
import { makeStartSession, requestSource } from "../http/ControlHttp.ts";
import { SingleSignOn, type SsoSignInError } from "./SingleSignOn.ts";

/**
 * The browser's side of single sign-on under `/control/sso`: off to the
 * identity provider, back with its answer, and into a session. A sign-in it
 * refuses lands on the sign-in page, which says why.
 */
export const layer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const sso = yield* SingleSignOn;
    const startSession = yield* makeStartSession;
    const { origin, secure } = yield* ControlPublicUrl;
    // Binds a sign-in to the browser that started it, so nobody can finish it in another's.
    const bindingCookie = secure ? "__Host-codenine_sso" : "codenine_sso";
    const cookieOptions = { httpOnly: true, path: "/", sameSite: "lax", secure } as const;

    const idOf = HttpRouter.params.pipe(Effect.map((params) => params["id"] ?? ""));
    const urlOf = (request: HttpServerRequest.HttpServerRequest) => new URL(request.url, origin);
    const bindingOf = (request: HttpServerRequest.HttpServerRequest) =>
      request.cookies[bindingCookie] ?? null;
    const refused = (error: SsoSignInError) =>
      Effect.logInfo(`Single sign-on refused: ${error.reason}`, error.cause).pipe(
        Effect.as(
          HttpServerResponse.redirect(`/admin/sign-in?sso=${error.reason}`, { status: 303 }),
        ),
      );
    /** Signs them in and sends them on, forgetting the binding. */
    const signedIn = Effect.fn("SsoHttp.signedIn")(function* (signIn: {
      readonly personId: string;
      readonly next: string;
    }) {
      yield* startSession(signIn.personId, "single-sign-on");
      return HttpServerResponse.redirect(signIn.next, {
        status: 303,
        cookies: yield* Effect.fromResult(
          Cookies.expireCookie(Cookies.empty, bindingCookie, cookieOptions),
        ).pipe(Effect.orDie),
      });
    });

    yield* router.add(
      "GET",
      "/control/sso/:id/start",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const { location, binding } = yield* sso.start(
          yield* idOf,
          urlOf(request).searchParams.get("next") ?? "/",
        );
        const cookies = yield* Effect.fromResult(
          Cookies.set(Cookies.empty, bindingCookie, binding, {
            ...cookieOptions,
            maxAge: "10 minutes",
          }),
        ).pipe(Effect.orDie);
        return HttpServerResponse.redirect(location, { status: 302, cookies });
      }).pipe(Effect.catchTags({ SsoSignInError: refused })),
    );

    yield* router.add(
      "GET",
      "/control/sso/:id/oidc/callback",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        return yield* signedIn(
          yield* sso.oidcCallback(
            yield* idOf,
            urlOf(request),
            bindingOf(request),
            requestSource(request),
          ),
        );
      }).pipe(Effect.catchTags({ SsoSignInError: refused })),
    );

    // The identity provider posts here from its own site, which the browser sends without
    // our cookies; the browser then finishes with a plain request that carries them.
    yield* router.add(
      "POST",
      "/control/sso/:id/saml/acs",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const form = yield* request.urlParamsBody.pipe(Effect.orElseSucceed(() => UrlParams.empty));
        const requestId = yield* sso.samlResponse(
          yield* idOf,
          {
            samlResponse: Option.getOrElse(UrlParams.getFirst(form, "SAMLResponse"), () => ""),
            relayState: Option.getOrElse(UrlParams.getFirst(form, "RelayState"), () => ""),
          },
          requestSource(request),
        );
        return HttpServerResponse.redirect(
          `/control/sso/finish?request=${encodeURIComponent(requestId)}`,
          { status: 303 },
        );
      }).pipe(Effect.catchTags({ SsoSignInError: refused })),
    );

    yield* router.add(
      "GET",
      "/control/sso/finish",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        return yield* signedIn(
          yield* sso.finish(urlOf(request).searchParams.get("request") ?? "", bindingOf(request)),
        );
      }).pipe(Effect.catchTags({ SsoSignInError: refused })),
    );

    yield* router.add(
      "GET",
      "/control/sso/:id/saml/metadata",
      Effect.flatMap(idOf, sso.samlMetadata).pipe(
        Effect.map((metadata) =>
          HttpServerResponse.text(metadata, { contentType: "application/samlmetadata+xml" }),
        ),
        Effect.catchTags({
          SsoSignInError: () => Effect.succeed(HttpServerResponse.empty({ status: 404 })),
        }),
      ),
    );
  }),
);
