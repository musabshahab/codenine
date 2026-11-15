import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ControlRole } from "@codenine/contracts/control";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { ControlDb } from "../db.ts";
import { Departments } from "../departments/Departments.ts";
import { type MailMessage, Mailer } from "../mail/Mailer.ts";
import { controlAiUsage, controlPeople } from "../persistence/schema.ts";
import { layerTestServices } from "../testing/layerTestServices.ts";
import { testKeyPair } from "../testing/testLicence.ts";
import { BudgetAlerts } from "./BudgetAlerts.ts";

const DOLLAR = 1_000_000;

const withAlerts = <A, E, R>(body: (mail: ReadonlyArray<MailMessage>) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const keys = yield* testKeyPair;
    yield* TestClock.setTime(Date.parse("2026-11-20T15:30:00Z"));
    const mail: Array<MailMessage> = [];
    const mailer = Mailer.of({
      enabled: true,
      send: Effect.fn("test.send")((message: MailMessage) =>
        Effect.sync(() => void mail.push(message)),
      ),
    });
    return yield* body(mail).pipe(
      Effect.provide(layerTestServices(keys.publicKey, Layer.succeed(Mailer, mailer))),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

/** Ada in Design with Dee as its admin, and Olga and Ola who run the company. */
const company = Effect.gen(function* () {
  const db = yield* ControlDb;
  const now = DateTime.formatIso(yield* DateTime.now);
  const people: ReadonlyArray<readonly [string, ControlRole]> = [
    ["Ada", "member"],
    ["Dee", "department-admin"],
    ["Olga", "owner"],
    ["Ola", "admin"],
  ];
  for (const [name, role] of people) {
    yield* db.insert(controlPeople).values({
      id: name.toLowerCase(),
      email: `${name.toLowerCase()}@acme.test`,
      displayName: name,
      role,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
  }
  const design = yield* (yield* Departments).create("Design");
  yield* (yield* Departments).addMember(design.id, "ada");
  yield* (yield* Departments).addMember(design.id, "dee");
  return { personId: "ada", departmentId: design.id };
});

const spent = (who: { readonly personId: string; readonly departmentId: string }) =>
  Effect.fn("test.spent")(function* (at: string, dollars: number) {
    yield* (yield* ControlDb).insert(controlAiUsage).values({
      at,
      ...who,
      accountId: null,
      provider: "claude",
      model: "claude-opus-5-5",
      inputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      webSearches: 0,
      costMicros: dollars * DOLLAR,
      priced: true,
      priceVersion: "test",
      outcome: "ok",
      status: 200,
      durationMs: 0,
      sessionId: null,
      requestId: null,
    });
  });

describe("BudgetAlerts", () => {
  it.effect("warns once a period, the person and those who decide their budgets", () =>
    withAlerts((mail) =>
      Effect.gen(function* () {
        const alerts = yield* BudgetAlerts;
        const ada = yield* company;
        const nearly = {
          level: "person-month",
          who: ada,
          period: "2026-11",
          percent: 80,
          spent: 240 * DOLLAR,
          limit: 300 * DOLLAR,
        } as const;
        yield* alerts.crossed(nearly);
        yield* alerts.crossed(nearly);
        expect(mail.map(({ to, subject }) => [to, subject])).toEqual([
          ["ada@acme.test", "You have used 80% of your AI budget for this month"],
          ["dee@acme.test", "Ada has used 80% of their AI budget for this month"],
        ]);
        expect(mail[0]?.text).toContain(
          "You have used $240.00 of $300.00 of your AI budget in Design for November 2026.",
        );

        // The company's budget running out goes to whoever can raise it.
        yield* alerts.crossed({ ...nearly, level: "company-month", percent: 100 });
        expect(
          mail
            .slice(2)
            .map(({ to, subject }) => [to, subject])
            .toSorted(),
        ).toEqual([
          ["ola@acme.test", "Your company's AI budget for this month has run out"],
          ["olga@acme.test", "Your company's AI budget for this month has run out"],
        ]);
      }),
    ),
  );

  it.effect("warns about an hour that cost far more than the person's usual hour", () =>
    withAlerts((mail) =>
      Effect.gen(function* () {
        const alerts = yield* BudgetAlerts;
        const ada = yield* company;
        const atAda = spent(ada);
        // Three hours earlier in the week at $2 each, then $12 in the last hour.
        yield* atAda("2026-11-17T09:10:00.000Z", 2);
        yield* atAda("2026-11-18T10:10:00.000Z", 1);
        yield* atAda("2026-11-18T10:40:00.000Z", 1);
        yield* atAda("2026-11-19T11:10:00.000Z", 2);
        yield* atAda("2026-11-20T15:00:00.000Z", 12);

        yield* alerts.checkSpikes;
        yield* alerts.checkSpikes;
        expect(mail.map(({ to, subject }) => [to, subject])).toEqual([
          ["ada@acme.test", "Your AI spend in the last hour was far above usual"],
          ["dee@acme.test", "Ada's AI spend in the last hour was far above usual"],
        ]);
        expect(mail[0]?.text).toContain(
          "Your agents made $12.00 of AI calls in the last hour, against $2.00 in a usual hour.",
        );

        // With that hour in the week, another $12 is less than four usual hours.
        yield* TestClock.adjust("1 hour");
        yield* atAda("2026-11-20T16:00:00.000Z", 12);
        yield* atAda("2026-11-20T14:50:00.000Z", 3);
        yield* alerts.checkSpikes;
        expect(mail).toHaveLength(2);
      }),
    ),
  );
});
