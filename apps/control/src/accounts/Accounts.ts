import {
  ControlAccountError,
  type ControlDesktopCode,
  type ControlEnrolment,
  type ControlPasskey,
  type ControlPerson,
  ControlSignInError,
  type ControlSignInMethods,
  type PasskeyAssertion,
  type PasskeyCreationOptions,
  type PasskeyRegistration,
  type PasskeyRequestOptions,
} from "@codenine/contracts/control";
import { licenceAllowsWork } from "@codenine/shared/licence";
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import type * as Kdf from "effect/crypto/Kdf";
import type * as Mac from "effect/crypto/Mac";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { Base64Url, Hex } from "effect/encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { ControlPublicUrl, enrolmentLink } from "../config.ts";
import { ControlDb } from "../db.ts";
import { LicenceService } from "../licence/LicenceService.ts";
import { type MailMessage, Mailer } from "../mail/Mailer.ts";
import { invitationMail, passwordResetMail, resetMail } from "../mail/messages.ts";
import {
  controlCredentials,
  controlPasskeys,
  controlPeople,
  controlRecoveryCodes,
  controlTickets,
} from "../persistence/schema.ts";
import {
  hashPassword,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  UNKNOWN_PERSON_HASH,
  verifyPassword,
} from "./passwords.ts";
import { SecretBox } from "./SecretBox.ts";
import { Sessions } from "./Sessions.ts";
import { authenticatorUri, base32, matchTotp } from "./totp.ts";
import { type StoredPasskey, WebAuthn } from "./WebAuthn.ts";

const INVITATION_DAYS = 7;
const RESET_DAYS = 1;
const PASSWORD_LINK_MINUTES = 60;
/** A forgotten-password request sends at most one email in this time, so the form cannot flood an inbox. */
const PASSWORD_LINK_COOLDOWN_MINUTES = 5;
const SIGN_IN_TICKET_MINUTES = 5;
const PASSKEY_TICKET_MINUTES = 5;
const DESKTOP_CODE_MINUTES = 5;
/** Easy to read and type: no I, L, O or U. 32 letters, so each random byte maps evenly. */
const DESKTOP_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** A typed code, read the way it was shown. */
const normalizeDesktopCode = (typed: string) =>
  typed
    .toUpperCase()
    .replace(/[^0-9A-Z]/gu, "")
    .replaceAll("O", "0")
    .replaceAll("I", "1")
    .replaceAll("L", "1");
const MAX_PASSKEY_NAME_LENGTH = 128;
const MAX_FAILED_ATTEMPTS = 10;
const LOCKOUT_MINUTES = 15;
const RECOVERY_CODE_COUNT = 10;
const AUTHENTICATOR_ISSUER = "Codenine";

type TicketPurpose = "invitation" | "reset" | "password" | "sign-in" | "passkey" | "desktop";

/** What proves it is the person after their password. Absent fields were not offered. */
interface SecondFactorProof {
  readonly code?: string;
  readonly passkey?: PasskeyAssertion;
}

export interface IssuedLink {
  readonly person: ControlPerson;
  /** Goes in the link's fragment, so it stays out of server logs. */
  readonly token: string;
  /** True when the link was also emailed to the person. */
  readonly emailed: boolean;
}

export class Accounts extends Context.Service<
  Accounts,
  {
    /** For the operator, before anyone can sign in. Refused once an owner is active. */
    readonly inviteOwner: (input: {
      readonly email: string;
      readonly displayName: string;
    }) => Effect.Effect<IssuedLink, ControlAccountError>;
    readonly invite: (input: {
      readonly email: string;
      readonly displayName: string;
      readonly role: "admin" | "member";
    }) => Effect.Effect<IssuedLink, ControlAccountError>;
    readonly listPeople: Effect.Effect<ReadonlyArray<ControlPerson>>;
    /** Everyone deactivated, and since when. */
    readonly listDeactivated: Effect.Effect<
      ReadonlyArray<{ readonly personId: string; readonly deactivatedAt: string }>
    >;
    readonly deactivate: (personId: string) => Effect.Effect<void, ControlAccountError>;
    readonly reactivate: (personId: string) => Effect.Effect<ControlPerson, ControlAccountError>;
    /** Removes the person's password, authenticator and passkeys; they set new ones from the link. */
    readonly issueReset: (personId: string) => Effect.Effect<IssuedLink, ControlAccountError>;
    readonly unlock: (personId: string) => Effect.Effect<void, ControlAccountError>;
    /**
     * Emails a link to choose a new password if the address belongs to someone
     * who can sign in. It answers the same either way, so it reveals no accounts.
     */
    readonly requestPasswordReset: (email: string) => Effect.Effect<void, ControlAccountError>;
    readonly startEnrolment: (
      token: string,
    ) => Effect.Effect<ControlEnrolment, ControlAccountError>;
    /**
     * Sets the password and a new second factor from an invitation or reset:
     * the authenticator's `code` or a `newPasskey`. A forgotten-password link
     * changes only the password, after a `code`, recovery code or `passkey`.
     */
    readonly finishEnrolment: (
      input: SecondFactorProof & {
        readonly token: string;
        readonly password: string;
        readonly newPasskey?: PasskeyRegistration;
      },
    ) => Effect.Effect<
      { readonly personId: string; readonly recoveryCodes: ReadonlyArray<string> },
      ControlAccountError
    >;
    /** Checks the password and returns a ticket for the second step. */
    readonly signIn: (input: {
      readonly email: string;
      readonly password: string;
    }) => Effect.Effect<
      {
        readonly ticket: string;
        readonly authenticator: boolean;
        readonly passkey?: PasskeyRequestOptions;
      },
      ControlSignInError
    >;
    /** Accepts an authenticator code, an unused recovery code or a passkey. */
    readonly completeSignIn: (
      input: SecondFactorProof & { readonly ticket: string },
    ) => Effect.Effect<{ readonly personId: string }, ControlSignInError>;
    readonly signInMethods: (personId: string) => Effect.Effect<ControlSignInMethods>;
    /** A code a signed-in browser shows, which signs the desktop app in once within minutes. */
    readonly issueDesktopCode: (personId: string) => Effect.Effect<ControlDesktopCode>;
    /** Takes a desktop code once; the person it was issued to gets a new session. */
    readonly redeemDesktopCode: (
      code: string,
    ) => Effect.Effect<{ readonly personId: string }, ControlSignInError>;
    /** Options for a new passkey, and the ticket that holds their challenge. */
    readonly startPasskey: (personId: string) => Effect.Effect<{
      readonly ticket: string;
      readonly options: PasskeyCreationOptions;
    }>;
    readonly addPasskey: (input: {
      readonly personId: string;
      readonly ticket: string;
      readonly name: string;
      readonly passkey: PasskeyRegistration;
    }) => Effect.Effect<ControlPasskey, ControlAccountError>;
    /** Refused for the last passkey of someone without an authenticator app. */
    readonly removePasskey: (input: {
      readonly personId: string;
      readonly passkeyId: string;
    }) => Effect.Effect<void, ControlAccountError>;
  }
>()("@codenine/control/accounts/Accounts") {}

/** Database failures are not something a caller can act on; they become defects. */
const dieOnDatabaseError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.catchTags({ EffectDrizzleQueryError: Effect.die, SqlError: Effect.die }));

const encoder = new TextEncoder();
const isEmail = (email: string) => email.length <= 320 && /^[^\s@]+@[^\s@]+$/u.test(email);
const normalizeRecoveryCode = (code: string) => code.toUpperCase().replace(/[^A-Z2-7]/gu, "");
const totpContext = (personId: string) => `totp:${personId}`;

export const make = Effect.gen(function* () {
  const db = yield* ControlDb;
  const box = yield* SecretBox;
  const sessions = yield* Sessions;
  const licence = yield* LicenceService;
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;
  const crypto = yield* Effect.context<Kdf.Kdf | Mac.Mac | SecureRandom.SecureRandom>();
  const mailer = yield* Mailer;
  const webauthn = yield* WebAuthn;
  const { origin } = yield* ControlPublicUrl;
  const scope = yield* Effect.scope;

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const later = (parts: Partial<DateTime.DateTime.PartsForMath>) =>
    DateTime.now.pipe(Effect.map((now) => DateTime.formatIso(now.pipe(DateTime.add(parts)))));
  const hashToken = (token: string) => digest.digestHex(Digest.sha256, encoder.encode(token));
  const sameEmail = (email: string) =>
    eq(sql`lower(${controlPeople.email})`, email.trim().toLowerCase());

  const peopleQuery = () =>
    db
      .select({
        id: controlPeople.id,
        email: controlPeople.email,
        displayName: controlPeople.displayName,
        role: controlPeople.role,
        status: controlPeople.status,
        canSignIn: sql<boolean>`${controlCredentials.personId} is not null`,
        lockedUntil: controlCredentials.lockedUntil,
        createdAt: controlPeople.createdAt,
      })
      .from(controlPeople)
      .leftJoin(controlCredentials, eq(controlCredentials.personId, controlPeople.id));

  const toPerson = (row: ControlPerson, now: string): ControlPerson => ({
    ...row,
    canSignIn: Boolean(row.canSignIn),
    lockedUntil: row.lockedUntil !== null && row.lockedUntil > now ? row.lockedUntil : null,
  });

  const findPerson = Effect.fn("Accounts.findPerson")(function* (personId: string) {
    const [row] = yield* peopleQuery().where(eq(controlPeople.id, personId));
    if (row === undefined) {
      return yield* new ControlAccountError({ reason: "not-found" });
    }
    return toPerson(row, yield* nowIso);
  });

  const requireFreeSeat = Effect.gen(function* () {
    const { licence: applied } = yield* licence.overview;
    if (
      applied._tag !== "installed" ||
      !licenceAllowsWork(applied.status) ||
      applied.seatsUsed >= applied.seats
    ) {
      return yield* new ControlAccountError({ reason: "no-free-seat" });
    }
  });

  /** Retires a person's open links, so only the newest one works. */
  const retireTickets = Effect.fn("Accounts.retireTickets")(function* (
    personId: string,
    purposes: ReadonlyArray<TicketPurpose>,
  ) {
    yield* db
      .update(controlTickets)
      .set({ usedAt: yield* nowIso })
      .where(
        and(
          eq(controlTickets.personId, personId),
          inArray(controlTickets.purpose, [...purposes]),
          isNull(controlTickets.usedAt),
        ),
      );
  });

  const issueTicket = Effect.fn("Accounts.issueTicket")(function* (
    personId: string,
    purpose: TicketPurpose,
    expiresAt: string,
    pendingChallenge?: string,
  ) {
    const token = Base64Url.encode(yield* random.randomBytes(32));
    yield* db.insert(controlTickets).values({
      tokenHash: yield* hashToken(token),
      purpose,
      personId,
      createdAt: yield* nowIso,
      expiresAt,
      pendingChallenge: pendingChallenge ?? null,
    });
    return token;
  });

  const passkeyRows = (personId: string) =>
    db
      .select()
      .from(controlPasskeys)
      .where(eq(controlPasskeys.personId, personId))
      .orderBy(asc(controlPasskeys.createdAt), asc(controlPasskeys.id));

  const toStored = (row: typeof controlPasskeys.$inferSelect): StoredPasskey => ({
    id: row.id,
    publicKey: new Uint8Array(Result.getOrElse(Base64Url.decode(row.publicKey), () => [])),
    counter: row.counter,
    transports: row.transports === null || row.transports === "" ? [] : row.transports.split(","),
  });

  const toPasskey = (row: typeof controlPasskeys.$inferSelect): ControlPasskey => ({
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  });

  const passkeyValues = (personId: string, passkey: StoredPasskey, name: string, now: string) => ({
    id: passkey.id,
    personId,
    name,
    publicKey: Base64Url.encode(passkey.publicKey),
    counter: passkey.counter,
    transports: passkey.transports.join(","),
    createdAt: now,
  });

  const openTicket = Effect.fn("Accounts.openTicket")(function* (
    token: string,
    purposes: ReadonlyArray<TicketPurpose>,
  ) {
    const [ticket] = yield* db
      .select()
      .from(controlTickets)
      .where(
        and(
          eq(controlTickets.tokenHash, yield* hashToken(token.trim())),
          inArray(controlTickets.purpose, [...purposes]),
          isNull(controlTickets.usedAt),
          gt(controlTickets.expiresAt, yield* nowIso),
        ),
      );
    return Option.fromNullishOr(ticket);
  });

  /** Marks a ticket used, unless another request already did. */
  const claimTicket = Effect.fn("Accounts.claimTicket")(function* (tokenHash: string) {
    const claimed = yield* db
      .update(controlTickets)
      .set({ usedAt: yield* nowIso })
      .where(and(eq(controlTickets.tokenHash, tokenHash), isNull(controlTickets.usedAt)))
      .returning({ tokenHash: controlTickets.tokenHash });
    return claimed.length > 0;
  });

  const newPersonId = random.randomBytes(8).pipe(Effect.map((bytes) => `per_${Hex.encode(bytes)}`));

  /** Emails a link when a mail server is set; if sending fails, the admin still has the link. */
  const deliver = (message: MailMessage) =>
    mailer.enabled
      ? mailer.send(message).pipe(
          Effect.as(true),
          Effect.catchTags({
            MailDeliveryError: (error) =>
              Effect.logWarning("Could not email a link", error).pipe(Effect.as(false)),
          }),
        )
      : Effect.succeed(false);

  const linkMail = (
    person: ControlPerson,
    token: string,
    purpose: "invitation" | "reset" | "password",
  ) => {
    const mail = {
      to: person.email,
      displayName: person.displayName,
      origin,
      link: enrolmentLink(origin, token),
    };
    switch (purpose) {
      case "invitation":
        return invitationMail({ ...mail, validFor: `${INVITATION_DAYS} days` });
      case "reset":
        return resetMail({ ...mail, validFor: `${RESET_DAYS * 24} hours` });
      case "password":
        return passwordResetMail({ ...mail, validFor: `${PASSWORD_LINK_MINUTES} minutes` });
    }
  };

  const issueLink = Effect.fn("Accounts.issueLink")(function* (
    personId: string,
    purpose: "invitation" | "reset",
  ) {
    const token = yield* issueTicket(
      personId,
      purpose,
      yield* later({ days: purpose === "invitation" ? INVITATION_DAYS : RESET_DAYS }),
    );
    const person = yield* findPerson(personId);
    return { person, token, emailed: yield* deliver(linkMail(person, token, purpose)) };
  });

  const inviteOwner = Effect.fn("Accounts.inviteOwner")(function* (input: {
    readonly email: string;
    readonly displayName: string;
  }) {
    const email = input.email.trim();
    if (!isEmail(email)) {
      return yield* new ControlAccountError({ reason: "invalid-email" });
    }
    const [activeOwner] = yield* db
      .select({ id: controlPeople.id })
      .from(controlPeople)
      .where(and(eq(controlPeople.role, "owner"), eq(controlPeople.status, "active")))
      .limit(1);
    if (activeOwner !== undefined) {
      return yield* new ControlAccountError({ reason: "owner-exists" });
    }
    const now = yield* nowIso;
    const displayName = input.displayName.trim() || email;
    const [existing] = yield* db
      .select({ id: controlPeople.id })
      .from(controlPeople)
      .where(sameEmail(email));
    const personId = existing?.id ?? (yield* newPersonId);
    if (existing === undefined) {
      yield* db.insert(controlPeople).values({
        id: personId,
        email,
        displayName,
        role: "owner",
        status: "invited",
        createdAt: now,
        updatedAt: now,
      });
    } else {
      yield* db
        .update(controlPeople)
        .set({ displayName, role: "owner", status: "invited", updatedAt: now })
        .where(eq(controlPeople.id, personId));
    }
    yield* retireTickets(personId, ["invitation", "reset", "password"]);
    return yield* issueLink(personId, "invitation");
  }, dieOnDatabaseError);

  const invite = Effect.fn("Accounts.invite")(function* (input: {
    readonly email: string;
    readonly displayName: string;
    readonly role: "admin" | "member";
  }) {
    const email = input.email.trim();
    if (!isEmail(email)) {
      return yield* new ControlAccountError({ reason: "invalid-email" });
    }
    const [taken] = yield* db
      .select({ id: controlPeople.id })
      .from(controlPeople)
      .where(sameEmail(email));
    if (taken !== undefined) {
      return yield* new ControlAccountError({ reason: "email-taken" });
    }
    yield* requireFreeSeat;
    const now = yield* nowIso;
    const personId = yield* newPersonId;
    yield* db.insert(controlPeople).values({
      id: personId,
      email,
      displayName: input.displayName.trim() || email,
      role: input.role,
      status: "invited",
      createdAt: now,
      updatedAt: now,
    });
    return yield* issueLink(personId, "invitation");
  }, dieOnDatabaseError);

  const listPeople = Effect.gen(function* () {
    const now = yield* nowIso;
    const rows = yield* peopleQuery().orderBy(asc(controlPeople.createdAt), asc(controlPeople.id));
    return rows.map((row) => toPerson(row, now));
  }).pipe(Effect.orDie, Effect.withSpan("Accounts.listPeople"));

  const listDeactivated = Effect.gen(function* () {
    const rows = yield* db
      .select({ personId: controlPeople.id, deactivatedAt: controlPeople.deactivatedAt })
      .from(controlPeople)
      .where(eq(controlPeople.status, "deactivated"));
    // Rows from before the column existed were given one by its migration.
    return rows.flatMap(({ personId, deactivatedAt }) =>
      deactivatedAt === null ? [] : [{ personId, deactivatedAt }],
    );
  }).pipe(Effect.orDie, Effect.withSpan("Accounts.listDeactivated"));

  const deactivate = Effect.fn("Accounts.deactivate")(function* (personId: string) {
    const person = yield* findPerson(personId);
    if (person.status === "deactivated") {
      return;
    }
    if (person.role === "owner" && person.status === "active") {
      const owners = yield* db
        .select({ id: controlPeople.id })
        .from(controlPeople)
        .where(and(eq(controlPeople.role, "owner"), eq(controlPeople.status, "active")));
      if (owners.length <= 1) {
        return yield* new ControlAccountError({ reason: "last-owner" });
      }
    }
    const now = yield* nowIso;
    yield* db
      .update(controlPeople)
      .set({ status: "deactivated", deactivatedAt: now, updatedAt: now })
      .where(eq(controlPeople.id, personId));
    yield* retireTickets(personId, ["invitation", "reset", "password", "sign-in", "desktop"]);
    yield* sessions.revokeAll(personId);
  }, dieOnDatabaseError);

  const reactivate = Effect.fn("Accounts.reactivate")(function* (personId: string) {
    const person = yield* findPerson(personId);
    if (person.status !== "deactivated") {
      return person;
    }
    yield* requireFreeSeat;
    yield* db
      .update(controlPeople)
      .set({
        status: person.canSignIn ? "active" : "invited",
        deactivatedAt: null,
        updatedAt: yield* nowIso,
      })
      .where(eq(controlPeople.id, personId));
    return yield* findPerson(personId);
  }, dieOnDatabaseError);

  const issueReset = Effect.fn("Accounts.issueReset")(function* (personId: string) {
    const person = yield* findPerson(personId);
    if (person.status === "deactivated") {
      return yield* new ControlAccountError({ reason: "not-found" });
    }
    yield* db.delete(controlCredentials).where(eq(controlCredentials.personId, personId));
    yield* db.delete(controlRecoveryCodes).where(eq(controlRecoveryCodes.personId, personId));
    yield* db.delete(controlPasskeys).where(eq(controlPasskeys.personId, personId));
    yield* retireTickets(personId, [
      "invitation",
      "reset",
      "password",
      "sign-in",
      "passkey",
      "desktop",
    ]);
    yield* sessions.revokeAll(personId);
    return yield* issueLink(personId, person.status === "invited" ? "invitation" : "reset");
  }, dieOnDatabaseError);

  const unlock = Effect.fn("Accounts.unlock")(function* (personId: string) {
    yield* findPerson(personId);
    yield* db
      .update(controlCredentials)
      .set({ failedAttempts: 0, lockedUntil: null })
      .where(eq(controlCredentials.personId, personId));
  }, dieOnDatabaseError);

  const requestPasswordReset = Effect.fn("Accounts.requestPasswordReset")(function* (
    email: string,
  ) {
    if (!mailer.enabled) {
      return yield* new ControlAccountError({ reason: "email-off" });
    }
    const [row] = yield* peopleQuery().where(
      and(sameEmail(email), eq(controlPeople.status, "active")),
    );
    if (row === undefined || !row.canSignIn) {
      return;
    }
    const [recent] = yield* db
      .select({ tokenHash: controlTickets.tokenHash })
      .from(controlTickets)
      .where(
        and(
          eq(controlTickets.personId, row.id),
          eq(controlTickets.purpose, "password"),
          gt(controlTickets.createdAt, yield* later({ minutes: -PASSWORD_LINK_COOLDOWN_MINUTES })),
        ),
      )
      .limit(1);
    if (recent !== undefined) {
      return;
    }
    yield* retireTickets(row.id, ["password"]);
    const token = yield* issueTicket(
      row.id,
      "password",
      yield* later({ minutes: PASSWORD_LINK_MINUTES }),
    );
    const person = toPerson(row, yield* nowIso);
    // Sent in the background, so the answer comes as fast whether or not the address has an account.
    yield* deliver(linkMail(person, token, "password")).pipe(Effect.forkIn(scope));
  }, dieOnDatabaseError);

  const enrolmentTicket = Effect.fn("Accounts.enrolmentTicket")(function* (token: string) {
    const ticket = yield* openTicket(token, ["invitation", "reset", "password"]);
    const person = Option.isSome(ticket)
      ? yield* findPerson(ticket.value.personId).pipe(Effect.option)
      : Option.none();
    if (Option.isNone(ticket) || Option.isNone(person) || person.value.status === "deactivated") {
      return yield* new ControlAccountError({ reason: "invalid-link" });
    }
    return { ticket: ticket.value, person: person.value };
  });

  /** Options to prove one of the person's passkeys, or none when they have none. */
  const passkeyCheckFor = Effect.fn("Accounts.passkeyCheckFor")(function* (personId: string) {
    const rows = yield* passkeyRows(personId);
    return rows.length === 0
      ? Option.none<PasskeyRequestOptions>()
      : Option.some(yield* webauthn.requestOptions(rows.map(toStored)));
  });

  const startEnrolment = Effect.fn("Accounts.startEnrolment")(function* (token: string) {
    const { ticket, person } = yield* enrolmentTicket(token);
    if (ticket.purpose === "password") {
      const passkeyCheck = yield* passkeyCheckFor(person.id);
      if (Option.isSome(passkeyCheck)) {
        yield* db
          .update(controlTickets)
          .set({ pendingChallenge: passkeyCheck.value.challenge })
          .where(eq(controlTickets.tokenHash, ticket.tokenHash));
      }
      return {
        purpose: "password",
        email: person.email,
        displayName: person.displayName,
        ...(Option.isSome(passkeyCheck) ? { passkeyCheck: passkeyCheck.value } : {}),
      } satisfies ControlEnrolment;
    }
    const secret = yield* random.randomBytes(20);
    // A reset removed any passkeys, so there are none to exclude.
    const passkeySetup = yield* webauthn.creationOptions({
      personId: person.id,
      email: person.email,
      displayName: person.displayName,
      existing: [],
    });
    yield* db
      .update(controlTickets)
      .set({
        pendingTotpSecret: yield* box.seal(secret, totpContext(person.id)),
        pendingChallenge: passkeySetup.challenge,
      })
      .where(eq(controlTickets.tokenHash, ticket.tokenHash));
    return {
      purpose: ticket.purpose === "reset" ? "reset" : "invitation",
      email: person.email,
      displayName: person.displayName,
      authenticator: {
        uri: authenticatorUri({ issuer: AUTHENTICATOR_ISSUER, account: person.email, secret }),
        secret: base32(secret),
      },
      passkeySetup,
    } satisfies ControlEnrolment;
  }, dieOnDatabaseError);

  const registerFailure = Effect.fn("Accounts.registerFailure")(function* (personId: string) {
    const failures = sql`${controlCredentials.failedAttempts} + 1`;
    const lockUntil = yield* later({ minutes: LOCKOUT_MINUTES });
    yield* db
      .update(controlCredentials)
      .set({
        failedAttempts: sql`case when ${failures} >= ${MAX_FAILED_ATTEMPTS} then 0 else ${failures} end`,
        lockedUntil: sql`case when ${failures} >= ${MAX_FAILED_ATTEMPTS} then ${lockUntil} else ${controlCredentials.lockedUntil} end`,
      })
      .where(eq(controlCredentials.personId, personId));
  });

  /** The second factor of someone who can sign in, unless they are deactivated. */
  const secondFactorOf = Effect.fn("Accounts.secondFactorOf")(function* (personId: string) {
    const [credentials] = yield* db
      .select({
        totpSecret: controlCredentials.totpSecret,
        totpLastStep: controlCredentials.totpLastStep,
        lockedUntil: controlCredentials.lockedUntil,
      })
      .from(controlCredentials)
      .innerJoin(controlPeople, eq(controlPeople.id, controlCredentials.personId))
      .where(and(eq(controlCredentials.personId, personId), eq(controlPeople.status, "active")));
    return Option.fromNullishOr(credentials);
  });

  /**
   * Accepts one of the person's passkeys answering `challenge`, an
   * authenticator code (each step once) or an unused recovery code.
   */
  const acceptSecondFactor = Effect.fn("Accounts.acceptSecondFactor")(function* (
    personId: string,
    credentials: { readonly totpSecret: string | null; readonly totpLastStep: number },
    proof: SecondFactorProof,
    challenge: string | null,
  ) {
    if (proof.passkey !== undefined) {
      const [row] = yield* db
        .select()
        .from(controlPasskeys)
        .where(
          and(eq(controlPasskeys.id, proof.passkey.id), eq(controlPasskeys.personId, personId)),
        );
      if (row === undefined || challenge === null) {
        return false;
      }
      const counter = yield* webauthn
        .checkAssertion({ assertion: proof.passkey, challenge, passkey: toStored(row) })
        .pipe(Effect.option);
      if (Option.isNone(counter)) {
        return false;
      }
      yield* db
        .update(controlPasskeys)
        .set({ counter: counter.value, lastUsedAt: yield* nowIso })
        .where(eq(controlPasskeys.id, row.id));
      return true;
    }
    const code = (proof.code ?? "").replace(/\s/gu, "");
    if (/^\d{6}$/u.test(code)) {
      if (credentials.totpSecret === null) {
        return false;
      }
      const secret = yield* box
        .open(credentials.totpSecret, totpContext(personId))
        .pipe(Effect.orDie);
      const step = yield* matchTotp({
        secret,
        code,
        nowMs: yield* Clock.currentTimeMillis,
        lastStep: credentials.totpLastStep,
      }).pipe(Effect.provide(crypto));
      // Claiming the step in the update stops two requests using one code.
      return (
        Option.isSome(step) &&
        (yield* db
          .update(controlCredentials)
          .set({ totpLastStep: step.value })
          .where(
            and(
              eq(controlCredentials.personId, personId),
              sql`${controlCredentials.totpLastStep} < ${step.value}`,
            ),
          )
          .returning({ personId: controlCredentials.personId })).length > 0
      );
    }
    if (code === "") {
      return false;
    }
    const used = yield* db
      .update(controlRecoveryCodes)
      .set({ usedAt: yield* nowIso })
      .where(
        and(
          eq(controlRecoveryCodes.personId, personId),
          eq(controlRecoveryCodes.codeHash, yield* hashToken(normalizeRecoveryCode(code))),
          isNull(controlRecoveryCodes.usedAt),
        ),
      )
      .returning({ personId: controlRecoveryCodes.personId });
    return used.length > 0;
  });

  const checkPassword = (password: string) =>
    password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH
      ? Effect.fail(new ControlAccountError({ reason: "weak-password" }))
      : Effect.void;

  /** A forgotten-password link changes only the password, after the second factor. */
  const finishPasswordChange = Effect.fn("Accounts.finishPasswordChange")(function* (
    ticket: typeof controlTickets.$inferSelect,
    input: SecondFactorProof & { readonly password: string },
  ) {
    const { personId } = ticket;
    const credentials = yield* secondFactorOf(personId);
    if (Option.isNone(credentials)) {
      return yield* new ControlAccountError({ reason: "invalid-link" });
    }
    const { lockedUntil } = credentials.value;
    if (lockedUntil !== null && lockedUntil > (yield* nowIso)) {
      return yield* new ControlAccountError({ reason: "locked" });
    }
    if (!(yield* acceptSecondFactor(personId, credentials.value, input, ticket.pendingChallenge))) {
      yield* registerFailure(personId);
      return yield* new ControlAccountError({
        reason: input.passkey === undefined ? "wrong-code" : "passkey-failed",
      });
    }
    const passwordHash = yield* hashPassword(input.password).pipe(Effect.provide(crypto));
    const now = yield* nowIso;
    yield* db.transaction(() =>
      Effect.gen(function* () {
        if (!(yield* claimTicket(ticket.tokenHash))) {
          return yield* new ControlAccountError({ reason: "invalid-link" });
        }
        yield* db
          .update(controlCredentials)
          .set({ passwordHash, failedAttempts: 0, lockedUntil: null, updatedAt: now })
          .where(eq(controlCredentials.personId, personId));
        yield* retireTickets(personId, ["password", "sign-in"]);
      }),
    );
    yield* sessions.revokeAll(personId);
    return { personId, recoveryCodes: [] };
  });

  /** The second factor a set-up link confirms: a new passkey, or the offered authenticator. */
  const newSecondFactor = Effect.fn("Accounts.newSecondFactor")(function* (
    ticket: typeof controlTickets.$inferSelect,
    personId: string,
    input: { readonly code?: string; readonly newPasskey?: PasskeyRegistration },
  ) {
    if (input.newPasskey !== undefined) {
      if (ticket.pendingChallenge === null) {
        return yield* new ControlAccountError({ reason: "invalid-link" });
      }
      const passkey = yield* webauthn
        .checkRegistration({ registration: input.newPasskey, challenge: ticket.pendingChallenge })
        .pipe(Effect.mapError(() => new ControlAccountError({ reason: "passkey-failed" })));
      return { totpSecret: null, totpLastStep: 0, passkey: Option.some(passkey) };
    }
    const sealedSecret = ticket.pendingTotpSecret;
    const secret =
      sealedSecret === null
        ? undefined
        : yield* box
            .open(sealedSecret, totpContext(personId))
            .pipe(Effect.option, Effect.map(Option.getOrUndefined));
    if (sealedSecret === null || secret === undefined) {
      return yield* new ControlAccountError({ reason: "invalid-link" });
    }
    const step = yield* matchTotp({
      secret,
      code: (input.code ?? "").replace(/\s/gu, ""),
      nowMs: yield* Clock.currentTimeMillis,
      lastStep: 0,
    }).pipe(Effect.provide(crypto));
    if (Option.isNone(step)) {
      return yield* new ControlAccountError({ reason: "wrong-code" });
    }
    return {
      totpSecret: sealedSecret,
      totpLastStep: step.value,
      passkey: Option.none<StoredPasskey>(),
    };
  });

  const finishEnrolment = Effect.fn("Accounts.finishEnrolment")(function* (
    input: SecondFactorProof & {
      readonly token: string;
      readonly password: string;
      readonly newPasskey?: PasskeyRegistration;
    },
  ) {
    yield* checkPassword(input.password);
    const { ticket, person } = yield* enrolmentTicket(input.token);
    if (ticket.purpose === "password") {
      return yield* finishPasswordChange(ticket, input);
    }
    const factor = yield* newSecondFactor(ticket, person.id, input);
    const passwordHash = yield* hashPassword(input.password).pipe(Effect.provide(crypto));
    const recoveryCodes: Array<string> = [];
    for (let index = 0; index < RECOVERY_CODE_COUNT; index++) {
      const code = base32(yield* random.randomBytes(7)).slice(0, 10);
      recoveryCodes.push(`${code.slice(0, 5)}-${code.slice(5)}`);
    }
    const recoveryHashes = yield* Effect.forEach(recoveryCodes, (code) =>
      hashToken(normalizeRecoveryCode(code)),
    );
    const now = yield* nowIso;
    yield* db.transaction(() =>
      Effect.gen(function* () {
        if (!(yield* claimTicket(ticket.tokenHash))) {
          return yield* new ControlAccountError({ reason: "invalid-link" });
        }
        const credentials = {
          passwordHash,
          totpSecret: factor.totpSecret,
          totpLastStep: factor.totpLastStep,
          failedAttempts: 0,
          lockedUntil: null,
          updatedAt: now,
        };
        yield* db
          .insert(controlCredentials)
          .values({ personId: person.id, ...credentials })
          .onConflictDoUpdate({ target: controlCredentials.personId, set: credentials });
        if (Option.isSome(factor.passkey)) {
          yield* db
            .insert(controlPasskeys)
            .values(passkeyValues(person.id, factor.passkey.value, "Passkey", now));
        }
        yield* db.delete(controlRecoveryCodes).where(eq(controlRecoveryCodes.personId, person.id));
        yield* db
          .insert(controlRecoveryCodes)
          .values(recoveryHashes.map((codeHash) => ({ personId: person.id, codeHash })));
        yield* retireTickets(person.id, ["invitation", "reset", "password"]);
        yield* db
          .update(controlPeople)
          .set({ status: "active", updatedAt: now })
          .where(and(eq(controlPeople.id, person.id), eq(controlPeople.status, "invited")));
      }),
    );
    return { personId: person.id, recoveryCodes };
  }, dieOnDatabaseError);

  const signIn = Effect.fn("Accounts.signIn")(function* (input: {
    readonly email: string;
    readonly password: string;
  }) {
    const [row] = yield* db
      .select({
        personId: controlPeople.id,
        passwordHash: controlCredentials.passwordHash,
        totpSecret: controlCredentials.totpSecret,
        lockedUntil: controlCredentials.lockedUntil,
      })
      .from(controlPeople)
      .innerJoin(controlCredentials, eq(controlCredentials.personId, controlPeople.id))
      .where(and(sameEmail(input.email), eq(controlPeople.status, "active")));
    if (row === undefined) {
      yield* verifyPassword(input.password, UNKNOWN_PERSON_HASH).pipe(Effect.provide(crypto));
      return yield* new ControlSignInError({ reason: "wrong-credentials" });
    }
    if (row.lockedUntil !== null && row.lockedUntil > (yield* nowIso)) {
      return yield* new ControlSignInError({ reason: "locked", lockedUntil: row.lockedUntil });
    }
    if (!(yield* verifyPassword(input.password, row.passwordHash).pipe(Effect.provide(crypto)))) {
      yield* registerFailure(row.personId);
      return yield* new ControlSignInError({ reason: "wrong-credentials" });
    }
    const passkey = yield* passkeyCheckFor(row.personId);
    const ticket = yield* issueTicket(
      row.personId,
      "sign-in",
      yield* later({ minutes: SIGN_IN_TICKET_MINUTES }),
      Option.isSome(passkey) ? passkey.value.challenge : undefined,
    );
    return {
      ticket,
      authenticator: row.totpSecret !== null,
      ...(Option.isSome(passkey) ? { passkey: passkey.value } : {}),
    };
  }, dieOnDatabaseError);

  const completeSignIn = Effect.fn("Accounts.completeSignIn")(function* (
    input: SecondFactorProof & { readonly ticket: string },
  ) {
    const ticket = yield* openTicket(input.ticket, ["sign-in"]);
    const credentials = Option.isSome(ticket)
      ? yield* secondFactorOf(ticket.value.personId)
      : Option.none();
    if (Option.isNone(ticket) || Option.isNone(credentials)) {
      return yield* new ControlSignInError({ reason: "invalid-ticket" });
    }
    const { personId, pendingChallenge } = ticket.value;
    const { lockedUntil } = credentials.value;
    if (lockedUntil !== null && lockedUntil > (yield* nowIso)) {
      return yield* new ControlSignInError({ reason: "locked", lockedUntil });
    }
    if (!(yield* acceptSecondFactor(personId, credentials.value, input, pendingChallenge))) {
      yield* registerFailure(personId);
      return yield* new ControlSignInError({
        reason: input.passkey === undefined ? "wrong-code" : "passkey-failed",
      });
    }
    if (!(yield* claimTicket(ticket.value.tokenHash))) {
      return yield* new ControlSignInError({ reason: "invalid-ticket" });
    }
    yield* db
      .update(controlCredentials)
      .set({ failedAttempts: 0, lockedUntil: null })
      .where(eq(controlCredentials.personId, personId));
    return { personId };
  }, dieOnDatabaseError);

  const issueDesktopCode = Effect.fn("Accounts.issueDesktopCode")(function* (personId: string) {
    const code = Array.from(
      yield* random.randomBytes(10),
      (byte) => DESKTOP_CODE_ALPHABET[byte % DESKTOP_CODE_ALPHABET.length],
    ).join("");
    const expiresAt = yield* later({ minutes: DESKTOP_CODE_MINUTES });
    yield* db.insert(controlTickets).values({
      tokenHash: yield* hashToken(code),
      purpose: "desktop",
      personId,
      createdAt: yield* nowIso,
      expiresAt,
      pendingChallenge: null,
    });
    return { code: `${code.slice(0, 5)}-${code.slice(5)}`, expiresAt };
  }, Effect.orDie);

  const redeemDesktopCode = Effect.fn("Accounts.redeemDesktopCode")(function* (code: string) {
    const ticket = yield* openTicket(normalizeDesktopCode(code), ["desktop"]);
    if (Option.isNone(ticket) || !(yield* claimTicket(ticket.value.tokenHash))) {
      return yield* new ControlSignInError({ reason: "desktop-code" });
    }
    return { personId: ticket.value.personId };
  }, dieOnDatabaseError);

  const signInMethods = Effect.fn("Accounts.signInMethods")(function* (personId: string) {
    const [credentials] = yield* db
      .select({ totpSecret: controlCredentials.totpSecret })
      .from(controlCredentials)
      .where(eq(controlCredentials.personId, personId));
    const recoveryCodes = yield* db
      .select({ codeHash: controlRecoveryCodes.codeHash })
      .from(controlRecoveryCodes)
      .where(and(eq(controlRecoveryCodes.personId, personId), isNull(controlRecoveryCodes.usedAt)));
    return {
      authenticator: credentials !== undefined && credentials.totpSecret !== null,
      passkeys: (yield* passkeyRows(personId)).map(toPasskey),
      recoveryCodesLeft: recoveryCodes.length,
    };
  }, Effect.orDie);

  const startPasskey = Effect.fn("Accounts.startPasskey")(function* (personId: string) {
    const person = yield* findPerson(personId);
    const options = yield* webauthn.creationOptions({
      personId,
      email: person.email,
      displayName: person.displayName,
      existing: (yield* passkeyRows(personId)).map(toStored),
    });
    yield* retireTickets(personId, ["passkey"]);
    const ticket = yield* issueTicket(
      personId,
      "passkey",
      yield* later({ minutes: PASSKEY_TICKET_MINUTES }),
      options.challenge,
    );
    return { ticket, options };
  }, Effect.orDie);

  const addPasskey = Effect.fn("Accounts.addPasskey")(function* (input: {
    readonly personId: string;
    readonly ticket: string;
    readonly name: string;
    readonly passkey: PasskeyRegistration;
  }) {
    const ticket = yield* openTicket(input.ticket, ["passkey"]);
    if (
      Option.isNone(ticket) ||
      ticket.value.personId !== input.personId ||
      ticket.value.pendingChallenge === null
    ) {
      return yield* new ControlAccountError({ reason: "invalid-link" });
    }
    const passkey = yield* webauthn
      .checkRegistration({
        registration: input.passkey,
        challenge: ticket.value.pendingChallenge,
      })
      .pipe(Effect.mapError(() => new ControlAccountError({ reason: "passkey-failed" })));
    if (!(yield* claimTicket(ticket.value.tokenHash))) {
      return yield* new ControlAccountError({ reason: "invalid-link" });
    }
    const name = input.name.trim().slice(0, MAX_PASSKEY_NAME_LENGTH) || "Passkey";
    const [row] = yield* db
      .insert(controlPasskeys)
      .values(passkeyValues(input.personId, passkey, name, yield* nowIso))
      .returning();
    if (row === undefined) {
      return yield* Effect.die("The new passkey was not stored.");
    }
    return toPasskey(row);
  }, dieOnDatabaseError);

  const removePasskey = Effect.fn("Accounts.removePasskey")(function* (input: {
    readonly personId: string;
    readonly passkeyId: string;
  }) {
    const methods = yield* signInMethods(input.personId);
    if (!methods.passkeys.some((passkey) => passkey.id === input.passkeyId)) {
      return yield* new ControlAccountError({ reason: "not-found" });
    }
    if (!methods.authenticator && methods.passkeys.length <= 1) {
      return yield* new ControlAccountError({ reason: "last-second-factor" });
    }
    yield* db
      .delete(controlPasskeys)
      .where(
        and(eq(controlPasskeys.id, input.passkeyId), eq(controlPasskeys.personId, input.personId)),
      );
  }, dieOnDatabaseError);

  return Accounts.of({
    inviteOwner,
    invite,
    listPeople,
    listDeactivated,
    deactivate,
    reactivate,
    issueDesktopCode,
    redeemDesktopCode,
    issueReset,
    unlock,
    requestPasswordReset,
    startEnrolment,
    finishEnrolment,
    signIn,
    completeSignIn,
    signInMethods,
    startPasskey,
    addPasskey,
    removePasskey,
  });
});

export const layer = Layer.effect(Accounts, make);
