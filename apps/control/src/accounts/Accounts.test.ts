import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { LicenceClaims } from "@codenine/contracts/licence";
import type { LicenceError, LicenceSigningError } from "@codenine/shared/licence";
import { describe, expect, it } from "@effect/vitest";
import type * as Mac from "effect/crypto/Mac";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import { ON_THE_SERVER } from "../audit/AuditLog.ts";
import * as Licence from "../licence/LicenceService.ts";
import { type MailMessage, Mailer } from "../mail/Mailer.ts";
import { codeNow, fromBase32 } from "../testing/authenticator.ts";
import { layerTestServices, TEST_PUBLIC_URL } from "../testing/layerTestServices.ts";
import { makeSoftwarePasskey } from "../testing/softwarePasskey.ts";
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
  mailer?: Layer.Layer<Mailer>,
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
    return yield* body({ install }).pipe(Effect.provide(layerTestServices(keys.publicKey, mailer)));
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

/** Sets a password and authenticator from a link, as the person would. */
const enrol = (token: string, password = PASSWORD) =>
  Effect.gen(function* () {
    const accounts = yield* Accounts;
    const enrolment = yield* accounts.startEnrolment(token);
    const secret = fromBase32(enrolment.authenticator?.secret ?? "");
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

/** A mail server that keeps what it is sent, in order. */
const recordingMailer = Effect.gen(function* () {
  const sent = yield* Queue.unbounded<MailMessage>();
  const layer = Layer.succeed(
    Mailer,
    Mailer.of({
      enabled: true,
      send: Effect.fn("test.send")(function* (message: MailMessage) {
        yield* Queue.offer(sent, message);
      }),
    }),
  );
  return { sent, layer };
});

const defined = <A>(value: A | undefined) =>
  value === undefined ? Effect.die("Expected a value.") : Effect.succeed(value);

const linkToken = (mail: MailMessage) => /\/admin\/enrol#(\S+)/u.exec(mail.text)?.[1] ?? "";

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
        expect(enrolment.authenticator?.uri).toMatch(
          /^otpauth:\/\/totp\/Codenine%3AAda%40Acme\.test\?secret=[A-Z2-7]{32}&issuer=Codenine&/u,
        );
        const secret = fromBase32(enrolment.authenticator?.secret ?? "");
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
        const first = yield* sessions.create({
          personId,
          source: { address: null, userAgent: "Firefox" },
          method: "password",
        });
        const second = yield* sessions.create({
          personId,
          source: ON_THE_SERVER,
          method: "password",
        });
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
        expect(yield* reasonOf(accounts.requestPasswordReset("ada@acme.test"))).toBe("email-off");
        const { secret } = yield* enrol(token, "a brand new password");
        expect(
          yield* signIn({
            email: "ada@acme.test",
            password: "a brand new password",
            code: codeNow(secret),
          }),
        ).toEqual({ personId });

        const third = yield* sessions.create({
          personId,
          source: ON_THE_SERVER,
          method: "password",
        });
        yield* TestClock.adjust("31 days");
        expect(yield* authenticated(third.token)).toBe(false);
      }),
    ),
  );

  it.effect("emails a link for a forgotten password, which still asks for the second factor", () =>
    Effect.gen(function* () {
      const { sent, layer } = yield* recordingMailer;
      yield* withAccounts(
        () =>
          Effect.gen(function* () {
            const accounts = yield* Accounts;
            const sessions = yield* Sessions;
            const { personId, secret, recoveryCodes } = yield* ownerReady;
            const invitation = yield* Queue.take(sent);
            expect(invitation).toMatchObject({
              to: "ada@acme.test",
              subject: "You are invited to Codenine",
            });
            expect(linkToken(invitation)).not.toBe("");
            const signedIn = yield* sessions.create({
              personId,
              source: ON_THE_SERVER,
              method: "password",
            });

            yield* accounts.requestPasswordReset("nobody@acme.test");
            yield* accounts.requestPasswordReset(" ADA@acme.test ");
            const mail = yield* Queue.take(sent);
            expect(mail).toMatchObject({
              to: "ada@acme.test",
              subject: "Choose a new Codenine password",
            });
            const token = linkToken(mail);
            // Asking again within five minutes sends nothing and leaves the first link working.
            yield* accounts.requestPasswordReset("ada@acme.test");
            expect(yield* accounts.startEnrolment(token)).toEqual({
              purpose: "password",
              email: "ada@acme.test",
              displayName: "Ada",
            });

            const change = (password: string, code: string) =>
              reasonOf(accounts.finishEnrolment({ token, password, code }));
            expect(yield* change("short", recoveryCodes[0] ?? "")).toBe("weak-password");
            expect(yield* change("a brand new password", "000000")).toBe("wrong-code");
            expect(
              yield* accounts.finishEnrolment({
                token,
                password: "a brand new password",
                code: recoveryCodes[0] ?? "",
              }),
            ).toEqual({ personId, recoveryCodes: [] });
            expect(Option.isSome(yield* sessions.authenticate(signedIn.token))).toBe(false);
            expect(yield* change("another new password", recoveryCodes[1] ?? "")).toBe(
              "invalid-link",
            );
            expect(
              yield* reasonOf(accounts.signIn({ email: "ada@acme.test", password: PASSWORD })),
            ).toBe("wrong-credentials");
            expect(
              yield* signIn({
                email: "ada@acme.test",
                password: "a brand new password",
                code: codeNow(secret),
              }),
            ).toEqual({ personId });

            const reset = yield* accounts.issueReset(personId);
            expect(reset.emailed).toBe(true);
            expect(yield* Queue.take(sent)).toMatchObject({
              to: "ada@acme.test",
              subject: "Set up your Codenine sign-in again",
            });
          }),
        layer,
      );
    }),
  );

  it.effect("signs the desktop app in once from a code a signed-in browser shows", () =>
    withAccounts(() =>
      Effect.gen(function* () {
        const accounts = yield* Accounts;
        const { personId } = yield* ownerReady;
        const { code } = yield* accounts.issueDesktopCode(personId);
        expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/u);

        // Typed loosely, it still reads as the code shown; then it is used up.
        const typed = ` ${code.toLowerCase().replace("-", " ").replaceAll("0", "o")} `;
        expect(yield* accounts.redeemDesktopCode(typed)).toEqual({ personId });
        expect(yield* reasonOf(accounts.redeemDesktopCode(code))).toBe("desktop-code");

        const late = yield* accounts.issueDesktopCode(personId);
        yield* TestClock.adjust("6 minutes");
        expect(yield* reasonOf(accounts.redeemDesktopCode(late.code))).toBe("desktop-code");
      }),
    ),
  );

  it.effect("sets up a passkey instead of an authenticator app and signs in with it", () =>
    Effect.gen(function* () {
      const { sent, layer } = yield* recordingMailer;
      yield* withAccounts(
        () =>
          Effect.gen(function* () {
            const accounts = yield* Accounts;
            const passkey = makeSoftwarePasskey({ origin: TEST_PUBLIC_URL });
            const { token, person } = yield* accounts.inviteOwner({
              email: "ada@acme.test",
              displayName: "Ada",
            });
            yield* Queue.take(sent);
            const setup = yield* defined((yield* accounts.startEnrolment(token)).passkeySetup);
            expect(setup.rp).toEqual({ id: "codenine.acme.test", name: "Codenine" });
            expect(
              yield* reasonOf(
                accounts.finishEnrolment({
                  token,
                  password: PASSWORD,
                  newPasskey: passkey.register(setup, "https://elsewhere.test"),
                }),
              ),
            ).toBe("passkey-failed");
            const { recoveryCodes } = yield* accounts.finishEnrolment({
              token,
              password: PASSWORD,
              newPasskey: passkey.register(setup),
            });
            expect(recoveryCodes).toHaveLength(10);
            expect(yield* accounts.signInMethods(person.id)).toMatchObject({
              authenticator: false,
              passkeys: [{ id: passkey.id, name: "Passkey", lastUsedAt: null }],
              recoveryCodesLeft: 10,
            });

            const first = yield* accounts.signIn({ email: "ada@acme.test", password: PASSWORD });
            expect(first.authenticator).toBe(false);
            const request = yield* defined(first.passkey);
            expect(request.allowCredentials?.map((allowed) => allowed.id)).toEqual([passkey.id]);
            const attempt = (proof: Parameters<typeof accounts.completeSignIn>[0]) =>
              reasonOf(accounts.completeSignIn(proof));
            const stranger = makeSoftwarePasskey({ origin: TEST_PUBLIC_URL });
            expect(yield* attempt({ ticket: first.ticket, code: "123456" })).toBe("wrong-code");
            expect(
              yield* attempt({ ticket: first.ticket, passkey: stranger.answer(request) }),
            ).toBe("passkey-failed");
            expect(
              yield* attempt({
                ticket: first.ticket,
                passkey: passkey.answer(request, "https://elsewhere.test"),
              }),
            ).toBe("passkey-failed");
            const answer = passkey.answer(request);
            expect(
              yield* accounts.completeSignIn({ ticket: first.ticket, passkey: answer }),
            ).toEqual({ personId: person.id });
            expect(yield* attempt({ ticket: first.ticket, passkey: answer })).toBe(
              "invalid-ticket",
            );
            const second = yield* accounts.signIn({ email: "ada@acme.test", password: PASSWORD });
            expect(
              yield* attempt({ ticket: second.ticket, passkey: passkey.answer(request) }),
            ).toBe("passkey-failed");
            expect(
              (yield* accounts.signInMethods(person.id)).passkeys[0]?.lastUsedAt,
            ).not.toBeNull();

            expect(
              yield* reasonOf(
                accounts.removePasskey({ personId: person.id, passkeyId: passkey.id }),
              ),
            ).toBe("last-second-factor");
            const laptop = makeSoftwarePasskey({ origin: TEST_PUBLIC_URL });
            const started = yield* accounts.startPasskey(person.id);
            expect(started.options.excludeCredentials?.map((excluded) => excluded.id)).toEqual([
              passkey.id,
            ]);
            const added = yield* accounts.addPasskey({
              personId: person.id,
              ticket: started.ticket,
              name: " Laptop ",
              passkey: laptop.register(started.options),
            });
            expect(added.name).toBe("Laptop");
            yield* accounts.removePasskey({ personId: person.id, passkeyId: passkey.id });
            expect(
              (yield* accounts.signInMethods(person.id)).passkeys.map((kept) => kept.name),
            ).toEqual(["Laptop"]);

            yield* accounts.requestPasswordReset("ada@acme.test");
            const resetToken = linkToken(yield* Queue.take(sent));
            const check = yield* defined((yield* accounts.startEnrolment(resetToken)).passkeyCheck);
            expect(
              yield* accounts.finishEnrolment({
                token: resetToken,
                password: "a brand new password",
                passkey: laptop.answer(check),
              }),
            ).toEqual({ personId: person.id, recoveryCodes: [] });

            yield* accounts.issueReset(person.id);
            expect((yield* accounts.signInMethods(person.id)).passkeys).toEqual([]);
          }),
        layer,
      );
    }),
  );
});
