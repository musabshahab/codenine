import type { ControlRole, ControlSession } from "@codenine/contracts/control";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { Base64Url, Hex } from "effect/encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";

import { AuditLog, type RequestSource } from "../audit/AuditLog.ts";
import { ControlDb } from "../db.ts";
import { controlPeople, controlSessions } from "../persistence/schema.ts";

const SESSION_DAYS = 30;
/** `last_seen_at` is written at most this often, to spare the database a write per request. */
const TOUCH_AFTER_MINUTES = 5;

export interface Viewing {
  readonly personId: string;
  readonly departmentId: string | null;
  readonly until: string;
}

export interface AuthenticatedSession {
  readonly sessionId: string;
  readonly expiresAt: string;
  /** The department chosen in this session, which may no longer be the person's. */
  readonly departmentId: string | null;
  /** Someone else's workspace an owner is looking at in this session, until it ends. */
  readonly viewing: Viewing | null;
  readonly person: {
    readonly id: string;
    readonly email: string;
    readonly displayName: string;
    readonly role: ControlRole;
  };
}

/** How someone proved who they are, as the audit log records each sign-in. */
export type SignInMethod = "password" | "desktop-code" | "set-up-link" | "single-sign-on";

export class Sessions extends Context.Service<
  Sessions,
  {
    /** Returns the cookie token. Only its SHA-256 hash is stored. */
    readonly create: (input: {
      readonly personId: string;
      readonly source: RequestSource;
      readonly method: SignInMethod;
    }) => Effect.Effect<{ readonly token: string; readonly session: ControlSession }>;
    readonly authenticate: (token: string) => Effect.Effect<Option.Option<AuthenticatedSession>>;
    readonly list: (personId: string) => Effect.Effect<ReadonlyArray<ControlSession>>;
    readonly revoke: (input: {
      readonly personId: string;
      readonly sessionId: string;
    }) => Effect.Effect<void>;
    readonly revokeAll: (personId: string) => Effect.Effect<void>;
    /** Ends the person's open connections, which reconnect with what they may do now. */
    readonly reconnect: (personId: string) => Effect.Effect<void>;
    /** Opens someone else's workspace in this session; its open connections reconnect there. */
    readonly view: (input: {
      readonly personId: string;
      readonly sessionId: string;
      readonly viewing: Viewing;
    }) => Effect.Effect<void>;
    /** Back to the session's own workspace; returns whose it was looking at. */
    readonly stopViewing: (input: {
      readonly personId: string;
      readonly sessionId: string;
    }) => Effect.Effect<Viewing | null>;
    /** Works in another department from this session on; its open connections reconnect there. */
    readonly chooseDepartment: (input: {
      readonly personId: string;
      readonly sessionId: string;
      readonly departmentId: string | null;
    }) => Effect.Effect<void>;
    /**
     * Completes when the session is revoked or expires, or its person must
     * reconnect, for connections it keeps open.
     */
    readonly awaitEnd: (session: AuthenticatedSession) => Effect.Effect<void>;
  }
>()("@codenine/control/accounts/Sessions") {}

const encoder = new TextEncoder();

export const make = Effect.gen(function* () {
  const db = yield* ControlDb;
  const audit = yield* AuditLog;
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;

  const hashToken = (token: string) => digest.digestHex(Digest.sha256, encoder.encode(token));
  // Within this server; a forwarded socket ends as soon as its session does.
  const connectionEnds = yield* PubSub.unbounded<{
    readonly personId: string;
    readonly sessionId?: string;
  }>();
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const create = Effect.fn("Sessions.create")(function* (input: {
    readonly personId: string;
    readonly source: RequestSource;
    readonly method: SignInMethod;
  }) {
    const token = Base64Url.encode(yield* random.randomBytes(32));
    const now = yield* DateTime.now;
    const session: ControlSession = {
      id: `ses_${Hex.encode(yield* random.randomBytes(8))}`,
      userAgent: input.source.userAgent?.slice(0, 512) ?? null,
      createdAt: DateTime.formatIso(now),
      lastSeenAt: DateTime.formatIso(now),
      expiresAt: DateTime.formatIso(now.pipe(DateTime.add({ days: SESSION_DAYS }))),
    };
    yield* db
      .insert(controlSessions)
      .values({ ...session, tokenHash: yield* hashToken(token), personId: input.personId });
    const [person] = yield* db
      .select({ email: controlPeople.email })
      .from(controlPeople)
      .where(eq(controlPeople.id, input.personId));
    yield* audit.record({
      actor: { kind: "person", id: input.personId, label: person?.email ?? input.personId },
      source: input.source,
      action: "person.sign-in",
      target: null,
      before: null,
      after: { method: input.method, session: session.id },
    });
    return { token, session };
  }, Effect.orDie);

  const authenticate = Effect.fn("Sessions.authenticate")(function* (token: string) {
    const now = yield* DateTime.now;
    const [row] = yield* db
      .select({
        sessionId: controlSessions.id,
        expiresAt: controlSessions.expiresAt,
        lastSeenAt: controlSessions.lastSeenAt,
        departmentId: controlSessions.departmentId,
        viewingPersonId: controlSessions.viewingPersonId,
        viewingDepartmentId: controlSessions.viewingDepartmentId,
        viewingUntil: controlSessions.viewingUntil,
        id: controlPeople.id,
        email: controlPeople.email,
        displayName: controlPeople.displayName,
        role: controlPeople.role,
      })
      .from(controlSessions)
      .innerJoin(controlPeople, eq(controlPeople.id, controlSessions.personId))
      .where(
        and(
          eq(controlSessions.tokenHash, yield* hashToken(token)),
          isNull(controlSessions.revokedAt),
          gt(controlSessions.expiresAt, DateTime.formatIso(now)),
          eq(controlPeople.status, "active"),
        ),
      );
    if (row === undefined) {
      return Option.none<AuthenticatedSession>();
    }
    const touchBefore = DateTime.formatIso(
      now.pipe(DateTime.subtract({ minutes: TOUCH_AFTER_MINUTES })),
    );
    if (row.lastSeenAt < touchBefore) {
      yield* db
        .update(controlSessions)
        .set({ lastSeenAt: DateTime.formatIso(now) })
        .where(eq(controlSessions.id, row.sessionId));
    }
    const {
      sessionId,
      expiresAt,
      departmentId,
      viewingPersonId,
      viewingDepartmentId,
      viewingUntil,
      lastSeenAt: _lastSeenAt,
      ...person
    } = row;
    const viewing =
      viewingPersonId === null || viewingUntil === null || viewingUntil <= DateTime.formatIso(now)
        ? null
        : { personId: viewingPersonId, departmentId: viewingDepartmentId, until: viewingUntil };
    return Option.some({ sessionId, expiresAt, departmentId, viewing, person });
  }, Effect.orDie);

  const list = Effect.fn("Sessions.list")(function* (personId: string) {
    return yield* db
      .select({
        id: controlSessions.id,
        userAgent: controlSessions.userAgent,
        createdAt: controlSessions.createdAt,
        lastSeenAt: controlSessions.lastSeenAt,
        expiresAt: controlSessions.expiresAt,
      })
      .from(controlSessions)
      .where(
        and(
          eq(controlSessions.personId, personId),
          isNull(controlSessions.revokedAt),
          gt(controlSessions.expiresAt, yield* nowIso),
        ),
      )
      .orderBy(desc(controlSessions.lastSeenAt));
  }, Effect.orDie);

  const revoke = Effect.fn("Sessions.revoke")(function* (input: {
    readonly personId: string;
    readonly sessionId: string;
  }) {
    yield* db
      .update(controlSessions)
      .set({ revokedAt: yield* nowIso })
      .where(
        and(
          eq(controlSessions.id, input.sessionId),
          eq(controlSessions.personId, input.personId),
          isNull(controlSessions.revokedAt),
        ),
      );
    yield* PubSub.publish(connectionEnds, input);
  }, Effect.orDie);

  const revokeAll = Effect.fn("Sessions.revokeAll")(function* (personId: string) {
    yield* db
      .update(controlSessions)
      .set({ revokedAt: yield* nowIso })
      .where(and(eq(controlSessions.personId, personId), isNull(controlSessions.revokedAt)));
    yield* PubSub.publish(connectionEnds, { personId });
  }, Effect.orDie);

  const reconnect = Effect.fn("Sessions.reconnect")(function* (personId: string) {
    yield* PubSub.publish(connectionEnds, { personId });
  });

  const chooseDepartment = Effect.fn("Sessions.chooseDepartment")(function* (input: {
    readonly personId: string;
    readonly sessionId: string;
    readonly departmentId: string | null;
  }) {
    yield* db
      .update(controlSessions)
      .set({ departmentId: input.departmentId })
      .where(
        and(eq(controlSessions.id, input.sessionId), eq(controlSessions.personId, input.personId)),
      );
    yield* PubSub.publish(connectionEnds, { personId: input.personId, sessionId: input.sessionId });
  }, Effect.orDie);

  const view = Effect.fn("Sessions.view")(function* (input: {
    readonly personId: string;
    readonly sessionId: string;
    readonly viewing: Viewing;
  }) {
    yield* db
      .update(controlSessions)
      .set({
        viewingPersonId: input.viewing.personId,
        viewingDepartmentId: input.viewing.departmentId,
        viewingUntil: input.viewing.until,
      })
      .where(
        and(eq(controlSessions.id, input.sessionId), eq(controlSessions.personId, input.personId)),
      );
    yield* PubSub.publish(connectionEnds, { personId: input.personId, sessionId: input.sessionId });
  }, Effect.orDie);

  const stopViewing = Effect.fn("Sessions.stopViewing")(function* (input: {
    readonly personId: string;
    readonly sessionId: string;
  }) {
    const [before] = yield* db
      .select({
        personId: controlSessions.viewingPersonId,
        departmentId: controlSessions.viewingDepartmentId,
        until: controlSessions.viewingUntil,
      })
      .from(controlSessions)
      .where(
        and(eq(controlSessions.id, input.sessionId), eq(controlSessions.personId, input.personId)),
      );
    if (before?.personId == null || before.until === null) {
      return null;
    }
    yield* db
      .update(controlSessions)
      .set({ viewingPersonId: null, viewingDepartmentId: null, viewingUntil: null })
      .where(eq(controlSessions.id, input.sessionId));
    yield* PubSub.publish(connectionEnds, { personId: input.personId, sessionId: input.sessionId });
    return { personId: before.personId, departmentId: before.departmentId, until: before.until };
  }, Effect.orDie);

  const awaitEnd = Effect.fn("Sessions.awaitEnd")(
    function* (session: AuthenticatedSession) {
      const subscription = yield* PubSub.subscribe(connectionEnds);
      // Checked after subscribing, so a revocation in between is not missed.
      const [current] = yield* db
        .select({ id: controlSessions.id })
        .from(controlSessions)
        .where(and(eq(controlSessions.id, session.sessionId), isNull(controlSessions.revokedAt)));
      if (current === undefined) {
        return;
      }
      const ended = Effect.gen(function* () {
        while (true) {
          const event = yield* PubSub.take(subscription);
          if (
            event.personId === session.person.id &&
            (event.sessionId === undefined || event.sessionId === session.sessionId)
          ) {
            return;
          }
        }
      });
      const untilExpiry = DateTime.now.pipe(
        Effect.flatMap((now) =>
          Effect.sleep(
            Math.max(
              0,
              DateTime.toEpochMillis(DateTime.makeUnsafe(session.expiresAt)) -
                DateTime.toEpochMillis(now),
            ),
          ),
        ),
      );
      yield* Effect.raceFirst(ended, untilExpiry);
    },
    Effect.scoped,
    Effect.orDie,
  );

  return Sessions.of({
    create,
    authenticate,
    list,
    revoke,
    revokeAll,
    reconnect,
    chooseDepartment,
    view,
    stopViewing,
    awaitEnd,
  });
});

export const layer = Layer.effect(Sessions, make);
