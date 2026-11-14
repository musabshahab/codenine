import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { LicenceClaims } from "@codenine/contracts/licence";
import type { LicenceError, LicenceSigningError } from "@codenine/shared/licence";
import { describe, expect, it } from "@effect/vitest";
import type * as Mac from "effect/crypto/Mac";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as Licence from "../licence/LicenceService.ts";
import { codeNow, fromBase32 } from "../testing/authenticator.ts";
import { layerTestServices } from "../testing/layerTestServices.ts";
import { signTestLicence, testClaims, testKeyPair } from "../testing/testLicence.ts";
import * as AccountsModule from "./Accounts.ts";
import * as SessionsModule from "./Sessions.ts";

const { Accounts } = AccountsModule;
const { Sessions } = SessionsModule;
const PASSWORD = "correct horse battery staple";

const withAccounts = <A, E, R>(
  body: (licence: {
    readonly install: (
      claims: LicenceClaims,
    ) => Effect.Effect<void, LicenceError | LicenceSigningError, Licence.LicenceService>;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const keys = yield* testKeyPair;
    yield* TestClock.setTime(Date.parse("2026-12-10T12:00:00Z"));
    const install = (claims: LicenceClaims) =>
      signTestLicence(claims, keys.privateKey).pipe(
        Effect.flatMap((token) =>
          Licence.LicenceService.pipe(Effect.flatMap((licence) => licence.install(token))),
        ),
        Effect.asVoid,
      );
    return yield* body({ install }).pipe(Effect.provide(layerTestServices(keys.publicKey)));
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

/** Sets a password and authenticator from a link, as the person would. */
const enrol = (token: string, password = PASSWORD) =>
  Effect.gen(function* () {
    const accounts = yield* Accounts;
    const enrolment = yield* accounts.startEnrolment(token);
    const secret = fromBase32(enrolment.authenticatorSecret);
    const finished = yield* accounts.finishEnrolment({
      token,
      password,
      code: yield* codeNow(secret),
    });
    // A code works once, so the next sign-in waits for the next code.
    yield* TestClock.adjust("30 seconds");
    return { secret, ...finished };
  });

const ownerReady = Effect.gen(function* () {
  const { token, person } = yield* (yield* Accounts).inviteOwner({
    email: "ada@acme.test",
    displayName: "Ada",
  });
  const enrolled = yield* enrol(token);
  expect(enrolled.personId).toBe(person.id);
  return enrolled;
});

const signIn = (input: {
  readonly email: string;
  readonly password: string;
  readonly code: Effect.Effect<string, never, Mac.Mac>;
}) =>
  Effect.gen(function* () {
    const accounts = yield* Accounts;
    const { ticket } = yield* accounts.signIn(input);
    return yield* accounts.completeSignIn({ ticket, code: yield* input.code });
  });

const reasonOf = <A, E extends { readonly reason: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );

describe("Accounts", () => {
  it.effect("lets the first owner set up a password and authenticator, then sign in", () =>
    withAccounts(() =>
      Effect.gen(function* () {
        const accounts = yield* Accounts;
        const { token, person } = yield* accounts.inviteOwner({
          email: "Ada@Acme.test",
          displayName: "Ada",
        });
        expect(person).toMatchObject({ role: "owner", status: "invited", canSignIn: false });

        const enrolment = yield* accounts.startEnrolment(token);
        expect(enrolment).toMatchObject({ purpose: "invitation", email: "Ada@Acme.test" });
        expect(enrolment.authenticatorUri).toMatch(
          /^otpauth:\/\/totp\/Codenine%3AAda%40Acme\.test\?secret=[A-Z2-7]{32}&issuer=Codenine&/u,
        );
        const secret = fromBase32(enrolment.authenticatorSecret);
        const code = yield* codeNow(secret);
        expect(
          yield* reasonOf(accounts.finishEnrolment({ token, password: "too short", code })),
        ).toBe("weak-password");
        expect(
          yield* reasonOf(
            accounts.finishEnrolment({
              token,
              password: PASSWORD,
              code: code === "000000" ? "111111" : "000000",
            }),
          ),
        ).toBe("wrong-code");
        const { recoveryCodes } = yield* accounts.finishEnrolment({
          token,
          password: PASSWORD,
          code,
        });
        expect(recoveryCodes).toHaveLength(10);
        expect(recoveryCodes[0]).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/u);
        expect(yield* accounts.listPeople).toMatchObject([{ status: "active", canSignIn: true }]);
        expect(yield* reasonOf(accounts.startEnrolment(token))).toBe("invalid-link");
        expect(
          yield* reasonOf(accounts.inviteOwner({ email: "eve@acme.test", displayName: "Eve" })),
        ).toBe("owner-exists");

        expect(
          yield* reasonOf(
            signIn({ email: "ada@acme.test", password: PASSWORD, code: codeNow(secret) }),
          ),
        ).toBe("wrong-code");
        yield* TestClock.adjust("30 seconds");
        const current = yield* codeNow(secret);
        expect(
          yield* signIn({
            email: "ADA@acme.test",
            password: PASSWORD,
            code: Effect.succeed(current),
          }),
        ).toEqual({ personId: person.id });
        expect(
          yield* reasonOf(
            signIn({ email: "ada@acme.test", password: PASSWORD, code: Effect.succeed(current) }),
          ),
        ).toBe("wrong-code");

        const recovery = Effect.succeed(recoveryCodes[3]?.toLowerCase() ?? "");
        expect(
          yield* signIn({ email: "ada@acme.test", password: PASSWORD, code: recovery }),
        ).toEqual({
          personId: person.id,
        });
        expect(
          yield* reasonOf(signIn({ email: "ada@acme.test", password: PASSWORD, code: recovery })),
        ).toBe("wrong-code");

        expect(
          yield* reasonOf(accounts.signIn({ email: "ada@acme.test", password: "wrong password!" })),
        ).toBe("wrong-credentials");
        expect(
          yield* reasonOf(accounts.signIn({ email: "nobody@acme.test", password: PASSWORD })),
        ).toBe("wrong-credentials");
        expect(yield* reasonOf(accounts.completeSignIn({ ticket: "made-up", code: current }))).toBe(
          "invalid-ticket",
        );
      }),
    ),
  );

  it.effect("locks a person out after ten failures until the lock ends or an admin unlocks", () =>
    withAccounts(() =>
      Effect.gen(function* () {
        const accounts = yield* Accounts;
        const { personId } = yield* ownerReady;
        const failTenTimes = Effect.forEach(Array.from({ length: 10 }), () =>
          reasonOf(accounts.signIn({ email: "ada@acme.test", password: "not the password" })),
        );

        expect(new Set(yield* failTenTimes)).toEqual(new Set(["wrong-credentials"]));
        const locked = yield* accounts
          .signIn({ email: "ada@acme.test", password: PASSWORD })
          .pipe(Effect.flip);
        expect(locked).toMatchObject({ reason: "locked", lockedUntil: "2026-12-10T12:15:30.000Z" });
        expect(yield* accounts.listPeople).toMatchObject([
          { lockedUntil: "2026-12-10T12:15:30.000Z" },
        ]);

        yield* TestClock.adjust("16 minutes");
        yield* accounts.signIn({ email: "ada@acme.test", password: PASSWORD });

        yield* failTenTimes;
        expect(
          yield* reasonOf(accounts.signIn({ email: "ada@acme.test", password: PASSWORD })),
        ).toBe("locked");
        yield* accounts.unlock(personId);
        yield* accounts.signIn({ email: "ada@acme.test", password: PASSWORD });
        expect(yield* accounts.listPeople).toMatchObject([{ lockedUntil: null }]);
      }),
    ),
  );

  it.effect("gives invitations a free seat on a working licence", () =>
    withAccounts(({ install }) =>
      Effect.gen(function* () {
        const accounts = yield* Accounts;
        const { personId: ownerId } = yield* ownerReady;
        const inviteAs = (email: string) =>
          accounts.invite({ email, displayName: email, role: "member" });

        expect(yield* reasonOf(inviteAs("bea@acme.test"))).toBe("no-free-seat");
        yield* install(testClaims({ seats: 2 }));
        const { person: bea } = yield* inviteAs("bea@acme.test");
        expect(yield* reasonOf(inviteAs("cy@acme.test"))).toBe("no-free-seat");
        expect(yield* reasonOf(inviteAs("BEA@acme.test"))).toBe("email-taken");
        expect(yield* reasonOf(inviteAs("not an email"))).toBe("invalid-email");

        yield* accounts.deactivate(bea.id);
        yield* inviteAs("cy@acme.test");
        expect(yield* reasonOf(accounts.reactivate(bea.id))).toBe("no-free-seat");
        expect(yield* reasonOf(accounts.deactivate(ownerId))).toBe("last-owner");
        const people = (yield* accounts.listPeople).toSorted((a, b) =>
          a.email.localeCompare(b.email),
        );
        expect(people.map((person) => [person.email, person.status])).toEqual([
          ["ada@acme.test", "active"],
          ["bea@acme.test", "deactivated"],
          ["cy@acme.test", "invited"],
        ]);
      }),
    ),
  );

  it.effect("signs a person out everywhere and makes them set up again after a reset", () =>
    withAccounts(() =>
      Effect.gen(function* () {
        const accounts = yield* Accounts;
        const sessions = yield* Sessions;
        const { personId } = yield* ownerReady;
        const first = yield* sessions.create({ personId, userAgent: "Firefox" });
        const second = yield* sessions.create({ personId, userAgent: null });
        const authenticated = (token: string) =>
          sessions.authenticate(token).pipe(Effect.map(Option.isSome));

        expect(yield* sessions.authenticate(first.token)).toEqual(
          Option.some({
            sessionId: first.session.id,
            expiresAt: first.session.expiresAt,
            person: { id: personId, email: "ada@acme.test", displayName: "Ada", role: "owner" },
          }),
        );
        expect((yield* sessions.list(personId)).map((session) => session.id).toSorted()).toEqual(
          [first.session.id, second.session.id].toSorted(),
        );
        yield* sessions.revoke({ personId, sessionId: first.session.id });
        expect(yield* authenticated(first.token)).toBe(false);
        expect(yield* authenticated(second.token)).toBe(true);

        const { token, person } = yield* accounts.issueReset(personId);
        expect(person.canSignIn).toBe(false);
        expect(yield* authenticated(second.token)).toBe(false);
        expect(
          yield* reasonOf(accounts.signIn({ email: "ada@acme.test", password: PASSWORD })),
        ).toBe("wrong-credentials");
        expect((yield* accounts.startEnrolment(token)).purpose).toBe("reset");
        const { secret } = yield* enrol(token, "a brand new password");
        expect(
          yield* signIn({
            email: "ada@acme.test",
            password: "a brand new password",
            code: codeNow(secret),
          }),
        ).toEqual({ personId });

        const third = yield* sessions.create({ personId, userAgent: null });
        yield* TestClock.adjust("31 days");
        expect(yield* authenticated(third.token)).toBe(false);
      }),
    ),
  );
});
