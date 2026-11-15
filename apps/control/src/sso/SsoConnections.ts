import {
  type ControlSsoChoice,
  type ControlSsoConnection,
  ControlSsoError,
  type ControlSsoProtocol,
  type ControlSsoSettings,
} from "@codenine/contracts/control";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { Hex } from "effect/encoding";
import * as Layer from "effect/Layer";

import { SecretBox } from "../accounts/SecretBox.ts";
import { ControlPublicUrl } from "../config.ts";
import { ControlDb } from "../db.ts";
import {
  controlCredentials,
  controlPeople,
  controlSsoConnections,
  type SsoProtocolSettings,
} from "../persistence/schema.ts";

/** One setup with its secret opened, for signing someone in. */
export interface SsoSetup {
  readonly id: string;
  readonly protocol: ControlSsoProtocol;
  readonly name: string;
  readonly domains: ReadonlyArray<string>;
  readonly createPeople: boolean;
  readonly groupsClaim: string | null;
  readonly roleGroups: ControlSsoConnection["roleGroups"];
  readonly oidc: {
    readonly issuer: string;
    readonly clientId: string;
    readonly clientSecret: string;
  } | null;
  readonly saml: {
    readonly entryPoint: string;
    readonly issuer: string;
    readonly certificate: string;
  } | null;
  /** Changes whenever its settings do, so a cached client is made again. */
  readonly updatedAt: string;
}

/** Where people come back to, and what SAML calls this service. */
export const ssoAddresses = (origin: string, id: string, protocol: ControlSsoProtocol) => {
  const base = `${origin}/control/sso/${id}`;
  return protocol === "oidc"
    ? { redirectUrl: `${base}/oidc/callback`, serviceEntityId: null, metadataUrl: null }
    : {
        redirectUrl: `${base}/saml/acs`,
        serviceEntityId: `${base}/saml/metadata`,
        metadataUrl: `${base}/saml/metadata`,
      };
};

/** The identity providers set up for signing in, as owners keep them. */
export class SsoConnections extends Context.Service<
  SsoConnections,
  {
    readonly list: Effect.Effect<ReadonlyArray<ControlSsoConnection>>;
    readonly choices: Effect.Effect<ReadonlyArray<ControlSsoChoice>>;
    readonly setup: (id: string) => Effect.Effect<SsoSetup, ControlSsoError>;
    readonly create: (
      protocol: ControlSsoProtocol,
      settings: ControlSsoSettings,
    ) => Effect.Effect<ControlSsoConnection, ControlSsoError>;
    readonly update: (
      id: string,
      settings: ControlSsoSettings,
    ) => Effect.Effect<ControlSsoConnection, ControlSsoError>;
    readonly remove: (id: string) => Effect.Effect<ControlSsoConnection, ControlSsoError>;
    /**
     * Whether an active owner could still sign in with a password: an emergency
     * owner, or one whose domain no required setup covers.
     */
    readonly ownerKeepsPassword: (change: {
      readonly required?: { readonly id: string | null; readonly domains: ReadonlyArray<string> };
      /** An owner counted as no longer an emergency owner. */
      readonly notEmergency?: string;
    }) => Effect.Effect<boolean>;
  }
>()("@codenine/control/sso/SsoConnections") {}

const SECRET_CONTEXT = "sso-client-secret";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const dieOnDatabaseError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.catchTags({ EffectDrizzleQueryError: Effect.die, SqlError: Effect.die }));

const notFound = () => new ControlSsoError({ reason: "not-found" });

export const make = Effect.gen(function* () {
  const db = yield* ControlDb;
  const box = yield* SecretBox;
  const random = yield* SecureRandom.SecureRandom;
  const { origin } = yield* ControlPublicUrl;
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const toConnection = (row: typeof controlSsoConnections.$inferSelect): ControlSsoConnection => ({
    id: row.id,
    protocol: row.protocol,
    name: row.name,
    domains: row.domains,
    required: row.required,
    createPeople: row.createPeople,
    groupsClaim: row.groupsClaim,
    roleGroups: row.roleGroups,
    oidc:
      row.protocol === "oidc" && "clientId" in row.settings
        ? { issuer: row.settings.issuer, clientId: row.settings.clientId }
        : null,
    saml:
      row.protocol === "saml" && "entryPoint" in row.settings
        ? {
            entryPoint: row.settings.entryPoint,
            issuer: row.settings.issuer,
            certificate: row.settings.certificate,
          }
        : null,
    ...ssoAddresses(origin, row.id, row.protocol),
  });

  const rows = db
    .select()
    .from(controlSsoConnections)
    .orderBy(asc(controlSsoConnections.createdAt));

  const ownerKeepsPassword = Effect.fn("SsoConnections.ownerKeepsPassword")(function* (change: {
    readonly required?: { readonly id: string | null; readonly domains: ReadonlyArray<string> };
    readonly notEmergency?: string;
  }) {
    const required = new Set(
      (yield* rows)
        .filter((row) => row.required && row.id !== change.required?.id)
        .flatMap((row) => row.domains),
    );
    for (const domain of change.required?.domains ?? []) required.add(domain);
    const owners = yield* db
      .select({
        id: controlPeople.id,
        email: controlPeople.email,
        emergency: controlPeople.emergency,
      })
      .from(controlPeople)
      .innerJoin(controlCredentials, eq(controlCredentials.personId, controlPeople.id))
      .where(
        and(
          eq(controlPeople.role, "owner"),
          eq(controlPeople.status, "active"),
          isNotNull(controlCredentials.passwordHash),
        ),
      );
    return owners.some(
      (owner) =>
        (owner.emergency && owner.id !== change.notEmergency) ||
        !required.has(owner.email.toLowerCase().split("@").at(-1) ?? ""),
    );
  }, dieOnDatabaseError);

  /** Checks a save: its protocol's settings, its domains, and that an owner keeps a password. */
  const prepare = Effect.fn("SsoConnections.prepare")(function* (
    id: string | null,
    protocol: ControlSsoProtocol,
    settings: ControlSsoSettings,
    keptSecret: string | null,
  ) {
    const domains = [...new Set(settings.domains.map((domain) => domain.toLowerCase()))];
    const taken = (yield* rows).some(
      (row) => row.id !== id && row.domains.some((domain) => domains.includes(domain)),
    );
    if (taken) {
      return yield* new ControlSsoError({ reason: "domain-taken" });
    }
    if (settings.required && !(yield* ownerKeepsPassword({ required: { id, domains } }))) {
      return yield* new ControlSsoError({ reason: "no-emergency-owner" });
    }
    let protocolSettings: SsoProtocolSettings;
    let sealedSecret = keptSecret;
    if (protocol === "oidc") {
      if (
        settings.oidc === undefined ||
        (settings.oidc.clientSecret === undefined && keptSecret === null)
      ) {
        return yield* new ControlSsoError({ reason: "protocol-settings" });
      }
      protocolSettings = { issuer: settings.oidc.issuer, clientId: settings.oidc.clientId };
      if (settings.oidc.clientSecret !== undefined) {
        sealedSecret = yield* box.seal(encoder.encode(settings.oidc.clientSecret), SECRET_CONTEXT);
      }
    } else {
      if (settings.saml === undefined) {
        return yield* new ControlSsoError({ reason: "protocol-settings" });
      }
      protocolSettings = settings.saml;
      sealedSecret = null;
    }
    return {
      name: settings.name,
      domains,
      required: settings.required,
      createPeople: settings.createPeople,
      groupsClaim: settings.groupsClaim,
      roleGroups: settings.roleGroups,
      settings: protocolSettings,
      sealedSecret,
      updatedAt: yield* nowIso,
    };
  });

  const find = Effect.fn("SsoConnections.find")(function* (id: string) {
    const [row] = yield* db
      .select()
      .from(controlSsoConnections)
      .where(eq(controlSsoConnections.id, id));
    if (row === undefined) {
      return yield* notFound();
    }
    return row;
  }, dieOnDatabaseError);

  return SsoConnections.of({
    list: rows.pipe(
      Effect.map((found) => found.map(toConnection)),
      Effect.orDie,
      Effect.withSpan("SsoConnections.list"),
    ),
    choices: rows.pipe(
      Effect.map((found) => found.map(({ id, name }) => ({ id, name }))),
      Effect.orDie,
      Effect.withSpan("SsoConnections.choices"),
    ),
    setup: Effect.fn("SsoConnections.setup")(function* (id: string) {
      const row = yield* find(id);
      const clientSecret =
        row.sealedSecret === null
          ? null
          : decoder.decode(yield* box.open(row.sealedSecret, SECRET_CONTEXT).pipe(Effect.orDie));
      return {
        id: row.id,
        protocol: row.protocol,
        name: row.name,
        domains: row.domains,
        createPeople: row.createPeople,
        groupsClaim: row.groupsClaim,
        roleGroups: row.roleGroups,
        oidc:
          "clientId" in row.settings && clientSecret !== null
            ? { issuer: row.settings.issuer, clientId: row.settings.clientId, clientSecret }
            : null,
        saml: "entryPoint" in row.settings ? row.settings : null,
        updatedAt: row.updatedAt,
      } satisfies SsoSetup;
    }),
    create: Effect.fn("SsoConnections.create")(function* (
      protocol: ControlSsoProtocol,
      settings: ControlSsoSettings,
    ) {
      const values = yield* prepare(null, protocol, settings, null);
      const id = `sso_${Hex.encode(yield* random.randomBytes(8))}`;
      const [row] = yield* db
        .insert(controlSsoConnections)
        .values({ id, protocol, ...values, createdAt: values.updatedAt })
        .returning();
      if (row === undefined) {
        return yield* Effect.die("An inserted single sign-on setup did not come back.");
      }
      return toConnection(row);
    }, dieOnDatabaseError),
    update: Effect.fn("SsoConnections.update")(function* (
      id: string,
      settings: ControlSsoSettings,
    ) {
      const current = yield* find(id);
      const values = yield* prepare(id, current.protocol, settings, current.sealedSecret);
      const [row] = yield* db
        .update(controlSsoConnections)
        .set(values)
        .where(eq(controlSsoConnections.id, id))
        .returning();
      if (row === undefined) {
        return yield* notFound();
      }
      return toConnection(row);
    }, dieOnDatabaseError),
    remove: Effect.fn("SsoConnections.remove")(function* (id: string) {
      const [row] = yield* db
        .delete(controlSsoConnections)
        .where(eq(controlSsoConnections.id, id))
        .returning();
      if (row === undefined) {
        return yield* notFound();
      }
      return toConnection(row);
    }, dieOnDatabaseError),
    ownerKeepsPassword,
  });
});

export const layer = Layer.effect(SsoConnections, make);
