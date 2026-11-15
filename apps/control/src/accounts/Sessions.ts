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

import { ControlDb } from "../db.ts";
import { controlPeople, controlSessions } from "../persistence/schema.ts";

const SESSION_DAYS = 30;
/** `last_seen_at` is written at most this often, to spare the database a write per request. */
const TOUCH_AFTER_MINUTES = 5;

export interface AuthenticatedSession {
  readonly sessionId: string;
  readonly expiresAt: string;
  readonly person: {
    readonly id: string;
    readonly email: string;
    readonly displayName: string;
    readonly role: ControlRole;
  };
}

export class Sessions extends Context.Service<
  Sessions,
  {
    /** Returns the cookie token. Only its SHA-256 hash is stored. */
    readonly create: (input: {
      readonly personId: string;
      readonly userAgent: string | null;
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
    readonly userAgent: string | null;
  }) {
    const token = Base64Url.encode(yield* random.randomBytes(32));
    const now = yield* DateTime.now;
    const session: ControlSession = {
      id: `ses_${Hex.encode(yield* random.randomBytes(8))}`,
      userAgent: input.userAgent?.slice(0, 512) ?? null,
      createdAt: DateTime.formatIso(now),
      lastSeenAt: DateTime.formatIso(now),
      expiresAt: DateTime.formatIso(now.pipe(DateTime.add({ days: SESSION_DAYS }))),
    };
    yield* db
      .insert(controlSessions)
      .values({ ...session, tokenHash: yield* hashToken(token), personId: input.personId });
    return { token, session };
  }, Effect.orDie);

  const authenticate = Effect.fn("Sessions.authenticate")(function* (token: string) {
    const now = yield* DateTime.now;
    const [row] = yield* db
      .select({
        sessionId: controlSessions.id,
        expiresAt: controlSessions.expiresAt,
        lastSeenAt: controlSessions.lastSeenAt,
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
    const { sessionId, expiresAt, lastSeenAt: _lastSeenAt, ...person } = row;
    return Option.some({ sessionId, expiresAt, person });
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

  return Sessions.of({ create, authenticate, list, revoke, revokeAll, reconnect, awaitEnd });
});

export const layer = Layer.effect(Sessions, make);
