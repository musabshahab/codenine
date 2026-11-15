import { SAML, ValidateInResponseTo } from "@node-saml/node-saml";
import type { ControlRole } from "@codenine/contracts/control";
import { and, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { Base64Url, Hex } from "effect/encoding";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as client from "openid-client";

import { Accounts } from "../accounts/Accounts.ts";
import { type AdminActor, Administration } from "../admin/Administration.ts";
import type { RequestSource } from "../audit/AuditLog.ts";
import { ControlPublicUrl } from "../config.ts";
import { ControlDb } from "../db.ts";
import { Departments } from "../departments/Departments.ts";
import {
  controlDepartments,
  controlDirectoryGroups,
  controlPeople,
  controlSsoIdentities,
  controlSsoRequests,
} from "../persistence/schema.ts";
import { ssoAddresses, SsoConnections, type SsoSetup } from "./SsoConnections.ts";

/** What OIDC discovery and token requests go through when set; tests answer them in process. */
export const SsoFetch = Context.Reference<client.CustomFetch | null>(
  "@codenine/control/sso/SingleSignOn/SsoFetch",
  { defaultValue: () => null },
);

export class SsoSignInError extends Schema.TaggedError<SsoSignInError>()("SsoSignInError", {
  reason: Schema.Literals(["failed", "not-in-domain", "unknown-person", "deactivated", "no-seat"]),
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/** Who the identity provider says signed in. */
export interface SsoIdentity {
  readonly subject: string;
  readonly email: string;
  readonly displayName: string;
  /** Null when the setup reads no groups, or the provider sent none. */
  readonly groups: ReadonlyArray<string> | null;
}

/** Signs people in through an identity provider, from the first redirect to their session. */
export class SingleSignOn extends Context.Service<
  SingleSignOn,
  {
    /** Where to send the browser, and the binding it must bring back as a cookie. */
    readonly start: (
      connectionId: string,
      next: string,
    ) => Effect.Effect<{ readonly location: string; readonly binding: string }, SsoSignInError>;
    /** OIDC sends the browser back here with its code. */
    readonly oidcCallback: (
      connectionId: string,
      url: URL,
      binding: string | null,
      source: RequestSource,
    ) => Effect.Effect<{ readonly personId: string; readonly next: string }, SsoSignInError>;
    /** SAML posts its response here; the browser then finishes with the request's ID. */
    readonly samlResponse: (
      connectionId: string,
      form: { readonly samlResponse: string; readonly relayState: string },
      source: RequestSource,
    ) => Effect.Effect<string, SsoSignInError>;
    /** Only the browser that started a SAML sign-in can finish it. */
    readonly finish: (
      requestId: string,
      binding: string | null,
    ) => Effect.Effect<{ readonly personId: string; readonly next: string }, SsoSignInError>;
    readonly samlMetadata: (connectionId: string) => Effect.Effect<string, SsoSignInError>;
  }
>()("@codenine/control/sso/SingleSignOn") {}

const REQUEST_MINUTES = 10;
/** Only the desktop app's code page asks to come back; anything else goes home. */
export const safeNext = (next: string | null | undefined) =>
  typeof next === "string" && next.startsWith("/admin/desktop-code?") ? next.slice(0, 512) : "/";

const encoder = new TextEncoder();
const failed = (cause: unknown) => new SsoSignInError({ reason: "failed", cause });
const dieOnDatabaseError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.catchTags({ EffectDrizzleQueryError: Effect.die, SqlError: Effect.die }));

const text = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;
const texts = (value: unknown) =>
  (Array.isArray(value) ? value : [value]).flatMap((item) => {
    const found = text(item);
    return found === null ? [] : [found];
  });
const firstOf = (source: Readonly<Record<string, unknown>>, names: ReadonlyArray<string>) => {
  for (const name of names) {
    const found = texts(source[name])[0];
    if (found !== undefined) return found;
  }
  return null;
};

/** The groups a token or assertion lists, or null when it lists none. */
const groupsOf = (source: Readonly<Record<string, unknown>>, claim: string | null) =>
  claim === null || source[claim] === undefined ? null : texts(source[claim]);

export const oidcIdentity = (
  setup: SsoSetup,
  claims: Readonly<Record<string, unknown>>,
): Result.Result<SsoIdentity, SsoSignInError> => {
  const subject = text(claims["sub"]);
  const email = [claims["email"], claims["preferred_username"], claims["upn"]]
    .map(text)
    .find((value): value is string => value !== null && value.includes("@"));
  if (subject === null || email === undefined || claims["email_verified"] === false) {
    return Result.fail(
      new SsoSignInError({ reason: "failed", cause: "No verified email in the ID token." }),
    );
  }
  // Google names the Workspace an account belongs to; anyone else could own an address there.
  if (
    claims["iss"] === "https://accounts.google.com" &&
    !setup.domains.includes(text(claims["hd"])?.toLowerCase() ?? "")
  ) {
    return Result.fail(new SsoSignInError({ reason: "not-in-domain" }));
  }
  const fullName = [text(claims["given_name"]), text(claims["family_name"])]
    .filter((part) => part !== null)
    .join(" ");
  return Result.succeed({
    subject,
    email,
    displayName: text(claims["name"]) ?? (fullName || email),
    groups: groupsOf(claims, setup.groupsClaim),
  });
};

const EMAIL_ATTRIBUTES = [
  "email",
  "mail",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
  "urn:oid:0.9.2342.19200300.100.1.3",
];
const NAME_ATTRIBUTES = [
  "displayName",
  "http://schemas.microsoft.com/identity/claims/displayname",
  "name",
];

export const samlIdentity = (
  setup: SsoSetup,
  profile: Readonly<Record<string, unknown>>,
): Result.Result<SsoIdentity, SsoSignInError> => {
  const nameId = text(profile["nameID"]);
  const email =
    firstOf(profile, EMAIL_ATTRIBUTES) ?? (nameId?.includes("@") === true ? nameId : null);
  if (email === null) {
    return Result.fail(
      new SsoSignInError({ reason: "failed", cause: "No email in the assertion." }),
    );
  }
  // A transient name changes at each sign-in, so the address stands in for it.
  const transient = text(profile["nameIDFormat"])?.endsWith(":transient") === true;
  return Result.succeed({
    subject: nameId === null || transient ? `email:${email.toLowerCase()}` : nameId,
    email,
    displayName: firstOf(profile, NAME_ATTRIBUTES) ?? email,
    groups: groupsOf(profile, setup.groupsClaim),
  });
};

/** The InResponseTo of the signed assertion's subject confirmation, whatever its prefixes. */
const assertionInResponseTo = (node: unknown): string | null => {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = assertionInResponseTo(item);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof node !== "object" || node === null) return null;
  for (const [key, value] of Object.entries(node)) {
    if (key.split(":").at(-1) === "SubjectConfirmationData") {
      const items: ReadonlyArray<unknown> = Array.isArray(value) ? value : [value];
      for (const item of items) {
        const attributes = (item as { readonly $?: Record<string, unknown> }).$;
        const found = text(attributes?.["InResponseTo"]);
        if (found !== null) return found;
      }
    }
    const found = assertionInResponseTo(value);
    if (found !== null) return found;
  }
  return null;
};

export const make = Effect.gen(function* () {
  const db = yield* ControlDb;
  const connections = yield* SsoConnections;
  const admin = yield* Administration;
  const accounts = yield* Accounts;
  const departments = yield* Departments;
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;
  const { origin } = yield* ControlPublicUrl;
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const hash = (value: string) => digest.digestHex(Digest.sha256, encoder.encode(value));

  const setupOf = (connectionId: string) =>
    connections.setup(connectionId).pipe(Effect.mapError(failed));

  /** Discovery is cached for each version of a setup, and tried again after a failure. */
  const discovered = new Map<string, Promise<client.Configuration>>();
  const oidcConfig = Effect.fn("SingleSignOn.oidcConfig")(function* (setup: SsoSetup) {
    const oidc = setup.oidc;
    if (oidc === null) {
      return yield* failed("Not an OIDC setup.");
    }
    const key = `${setup.id}@${setup.updatedAt}`;
    const fetch = yield* SsoFetch;
    let pending = discovered.get(key);
    if (pending === undefined) {
      pending = client.discovery(
        new URL(oidc.issuer),
        oidc.clientId,
        undefined,
        client.ClientSecretPost(oidc.clientSecret),
        fetch === null ? {} : { [client.customFetch]: fetch },
      );
      discovered.set(key, pending);
    }
    return yield* Effect.tryPromise({
      try: () => pending,
      catch: (cause) => {
        discovered.delete(key);
        return failed(cause);
      },
    });
  });

  const samlFor = (setup: SsoSetup, requestId?: string) => {
    const saml = setup.saml;
    if (saml === null) return null;
    const addresses = ssoAddresses(origin, setup.id, "saml");
    const entityId = addresses.serviceEntityId ?? addresses.redirectUrl;
    return new SAML({
      callbackUrl: addresses.redirectUrl,
      entryPoint: saml.entryPoint,
      issuer: entityId,
      audience: entityId,
      idpIssuer: saml.issuer,
      idpCert: saml.certificate,
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: false,
      // Checked below against this server's own request, which a cache cannot tie to the browser.
      validateInResponseTo: ValidateInResponseTo.never,
      acceptedClockSkewMs: 3 * 60 * 1000,
      identifierFormat: null,
      disableRequestedAuthnContext: true,
      signatureAlgorithm: "sha256",
      digestAlgorithm: "sha256",
      ...(requestId === undefined ? {} : { generateUniqueId: () => `_${requestId}` }),
    });
  };

  /** Takes a request once: it must be this connection's and unexpired. */
  const takeRequest = Effect.fn("SingleSignOn.takeRequest")(function* (
    id: string,
    connectionId: string | null,
  ) {
    const [row] = yield* db
      .delete(controlSsoRequests)
      .where(
        and(
          eq(controlSsoRequests.id, id),
          connectionId === null ? undefined : eq(controlSsoRequests.connectionId, connectionId),
          gt(controlSsoRequests.expiresAt, yield* nowIso),
        ),
      )
      .returning();
    if (row === undefined) {
      return yield* failed("The sign-in expired, was used, or was never started.");
    }
    return row;
  }, dieOnDatabaseError);

  const requireBinding = Effect.fn("SingleSignOn.requireBinding")(function* (
    bindingHash: string,
    binding: string | null,
  ) {
    if (binding === null || (yield* hash(binding)) !== bindingHash) {
      return yield* failed("Another browser started this sign-in.");
    }
  });

  /** The departments and role the provider's groups give, as owners set them up. */
  const applyGroups = Effect.fn("SingleSignOn.applyGroups")(function* (
    actor: AdminActor,
    setup: SsoSetup,
    personId: string,
    groups: ReadonlyArray<string>,
  ) {
    const named = new Set(groups.map((group) => group.toLowerCase()));
    const known = yield* db
      .select({
        id: controlDepartments.id,
        name: controlDepartments.name,
        externalId: controlDirectoryGroups.externalId,
      })
      .from(controlDepartments)
      .leftJoin(
        controlDirectoryGroups,
        eq(controlDirectoryGroups.departmentId, controlDepartments.id),
      );
    const wanted = known
      .filter(
        ({ name, externalId }) =>
          named.has(name.toLowerCase()) ||
          (externalId !== null && named.has(externalId.toLowerCase())),
      )
      .map(({ id }) => id);
    const current = yield* departments.ofPerson(personId);
    for (const departmentId of current.filter((id) => !wanted.includes(id))) {
      yield* admin.removeDepartmentMember(actor, departmentId, personId);
    }
    for (const departmentId of wanted.filter((id) => !current.includes(id))) {
      yield* admin.addDepartmentMember(actor, departmentId, personId);
    }
    if (setup.roleGroups.length > 0) {
      const role: ControlRole =
        setup.roleGroups.find((rule) => named.has(rule.group.toLowerCase()))?.role ?? "member";
      if ((yield* accounts.findPerson(personId)).role !== role) {
        yield* admin.setRole(actor, { personId, role }).pipe(
          Effect.catchTags({
            ControlAccountError: (error) =>
              Effect.logWarning(`Single sign-on left the role of ${personId} as it was.`, error),
          }),
        );
      }
    }
  });

  /** Finds or adds the person, keeps their identity, and applies their groups. */
  const admit = Effect.fn("SingleSignOn.admit")(function* (
    setup: SsoSetup,
    identity: SsoIdentity,
    source: RequestSource,
  ) {
    const email = identity.email.trim();
    if (!setup.domains.includes(email.toLowerCase().split("@").at(-1) ?? "")) {
      return yield* new SsoSignInError({ reason: "not-in-domain" });
    }
    const actor: AdminActor = {
      role: "owner",
      who: { kind: "provisioning", id: setup.id, label: `Single sign-on (${setup.name})` },
      source,
    };
    const [known] = yield* db
      .select({ personId: controlSsoIdentities.personId })
      .from(controlSsoIdentities)
      .where(
        and(
          eq(controlSsoIdentities.connectionId, setup.id),
          eq(controlSsoIdentities.subject, identity.subject),
        ),
      );
    const [byEmail] =
      known === undefined
        ? yield* db
            .select({ id: controlPeople.id })
            .from(controlPeople)
            .where(eq(sql`lower(${controlPeople.email})`, email.toLowerCase()))
        : [];
    let personId = known?.personId ?? byEmail?.id;
    if (personId === undefined) {
      if (!setup.createPeople) {
        return yield* new SsoSignInError({ reason: "unknown-person" });
      }
      const added = yield* admin
        .provisionPerson(actor, { email, displayName: identity.displayName })
        .pipe(
          Effect.mapError((error) =>
            error._tag === "ControlAccountError" && error.reason === "no-free-seat"
              ? new SsoSignInError({ reason: "no-seat" })
              : failed(error),
          ),
        );
      personId = added.id;
    }
    const person = yield* accounts.findPerson(personId).pipe(Effect.mapError(failed));
    if (person.status === "deactivated") {
      return yield* new SsoSignInError({ reason: "deactivated" });
    }
    // The provider's address is the one in use; another person keeping it leaves theirs.
    if (known !== undefined && person.email.toLowerCase() !== email.toLowerCase()) {
      yield* admin.updatePerson(actor, { personId, email }).pipe(
        Effect.catchTags({
          ControlAccountError: (error) => Effect.logWarning("Kept an email.", error),
          ControlForbiddenError: (error) => Effect.logWarning("Kept an email.", error),
        }),
      );
    }
    const now = yield* nowIso;
    yield* db
      .insert(controlSsoIdentities)
      .values({
        connectionId: setup.id,
        subject: identity.subject,
        personId,
        createdAt: now,
        lastUsedAt: now,
      })
      .onConflictDoUpdate({
        target: [controlSsoIdentities.connectionId, controlSsoIdentities.subject],
        set: { personId, lastUsedAt: now },
      });
    if (person.status === "invited") {
      yield* accounts.activate(personId).pipe(Effect.mapError(failed));
    }
    if (setup.groupsClaim !== null && identity.groups !== null) {
      yield* applyGroups(actor, setup, personId, identity.groups).pipe(Effect.mapError(failed));
    }
    return personId;
  }, dieOnDatabaseError);

  return SingleSignOn.of({
    start: Effect.fn("SingleSignOn.start")(function* (connectionId: string, next: string) {
      const setup = yield* setupOf(connectionId);
      const id = Hex.encode(yield* random.randomBytes(16));
      const binding = Base64Url.encode(yield* random.randomBytes(32));
      const expiresAt = DateTime.formatIso(
        DateTime.add(yield* DateTime.now, { minutes: REQUEST_MINUTES }),
      );
      let location: string;
      let codeVerifier: string | null = null;
      let nonce: string | null = null;
      if (setup.protocol === "oidc") {
        const config = yield* oidcConfig(setup);
        codeVerifier = client.randomPKCECodeVerifier();
        nonce = client.randomNonce();
        const verifier = codeVerifier;
        const challenge = yield* Effect.tryPromise({
          try: () => client.calculatePKCECodeChallenge(verifier),
          catch: failed,
        });
        location = client
          .buildAuthorizationUrl(config, {
            redirect_uri: ssoAddresses(origin, setup.id, "oidc").redirectUrl,
            scope: "openid email profile",
            code_challenge: challenge,
            code_challenge_method: "S256",
            state: id,
            nonce,
          })
          .toString();
      } else {
        const saml = samlFor(setup, id);
        if (saml === null) {
          return yield* failed("Not a SAML setup.");
        }
        location = yield* Effect.tryPromise({
          try: () => saml.getAuthorizeUrlAsync(id, undefined, {}),
          catch: failed,
        });
      }
      yield* db
        .insert(controlSsoRequests)
        .values({
          id,
          connectionId,
          bindingHash: yield* hash(binding),
          codeVerifier,
          nonce,
          next: safeNext(next),
          expiresAt,
        })
        .pipe(Effect.orDie);
      return { location, binding };
    }),
    oidcCallback: Effect.fn("SingleSignOn.oidcCallback")(function* (
      connectionId: string,
      url: URL,
      binding: string | null,
      source: RequestSource,
    ) {
      const request = yield* takeRequest(url.searchParams.get("state") ?? "", connectionId);
      yield* requireBinding(request.bindingHash, binding);
      const setup = yield* setupOf(connectionId);
      const config = yield* oidcConfig(setup);
      const tokens = yield* Effect.tryPromise({
        try: () =>
          client.authorizationCodeGrant(config, url, {
            pkceCodeVerifier: request.codeVerifier ?? "",
            expectedState: request.id,
            expectedNonce: request.nonce ?? "",
            idTokenExpected: true,
          }),
        catch: failed,
      });
      const identity = yield* Effect.fromResult(oidcIdentity(setup, tokens.claims() ?? {}));
      return { personId: yield* admit(setup, identity, source), next: request.next };
    }),
    samlResponse: Effect.fn("SingleSignOn.samlResponse")(function* (
      connectionId: string,
      form: { readonly samlResponse: string; readonly relayState: string },
      source: RequestSource,
    ) {
      const setup = yield* setupOf(connectionId);
      const saml = samlFor(setup);
      if (saml === null) {
        return yield* failed("Not a SAML setup.");
      }
      const [request] = yield* db
        .select()
        .from(controlSsoRequests)
        .where(
          and(
            eq(controlSsoRequests.id, form.relayState),
            eq(controlSsoRequests.connectionId, connectionId),
            isNull(controlSsoRequests.personId),
            gt(controlSsoRequests.expiresAt, yield* nowIso),
          ),
        )
        .pipe(Effect.orDie);
      if (request === undefined) {
        return yield* failed("The sign-in expired, was used, or was never started.");
      }
      const { profile } = yield* Effect.tryPromise({
        try: () => saml.validatePostResponseAsync({ SAMLResponse: form.samlResponse }),
        catch: failed,
      });
      if (profile === null) {
        return yield* failed("The response named nobody.");
      }
      // The signed assertion must answer this very request.
      if (assertionInResponseTo(profile.getAssertion?.()) !== `_${request.id}`) {
        return yield* failed("The assertion answers another request.");
      }
      const identity = yield* Effect.fromResult(samlIdentity(setup, profile));
      const personId = yield* admit(setup, identity, source);
      const [named] = yield* db
        .update(controlSsoRequests)
        .set({ personId })
        .where(and(eq(controlSsoRequests.id, request.id), isNull(controlSsoRequests.personId)))
        .returning({ id: controlSsoRequests.id })
        .pipe(Effect.orDie);
      if (named === undefined) {
        return yield* failed("The response was used already.");
      }
      return named.id;
    }),
    finish: Effect.fn("SingleSignOn.finish")(function* (requestId: string, binding: string | null) {
      const [ready] = yield* db
        .select({ id: controlSsoRequests.id })
        .from(controlSsoRequests)
        .where(and(eq(controlSsoRequests.id, requestId), isNotNull(controlSsoRequests.personId)))
        .pipe(Effect.orDie);
      if (ready === undefined) {
        return yield* failed("The sign-in has not been answered.");
      }
      const request = yield* takeRequest(requestId, null);
      yield* requireBinding(request.bindingHash, binding);
      if (request.personId === null) {
        return yield* failed("The sign-in has not been answered.");
      }
      return { personId: request.personId, next: request.next };
    }),
    samlMetadata: Effect.fn("SingleSignOn.samlMetadata")(function* (connectionId: string) {
      const saml = samlFor(yield* setupOf(connectionId));
      if (saml === null) {
        return yield* failed("Not a SAML setup.");
      }
      return saml.generateServiceProviderMetadata(null, null);
    }),
  });
});

export const layer = Layer.effect(SingleSignOn, make);
