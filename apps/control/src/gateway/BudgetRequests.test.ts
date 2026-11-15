import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { ControlDb } from "../db.ts";
import { Departments } from "../departments/Departments.ts";
import { controlAiUsage, controlPeople } from "../persistence/schema.ts";
import { Profiles } from "../profiles/Profiles.ts";
import { layerTestServices } from "../testing/layerTestServices.ts";
import { testKeyPair } from "../testing/testLicence.ts";
import { BudgetRequests } from "./BudgetRequests.ts";
import { Budgets, limitsOf } from "./Budgets.ts";

const withRequests = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const keys = yield* testKeyPair;
    yield* TestClock.setTime(Date.parse("2026-11-20T12:00:00Z"));
    return yield* body.pipe(Effect.provide(layerTestServices(keys.publicKey)));
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

/** Ada in Design, $10 a month each, with $9.95 of it spent. */
const adaNearHerBudget = Effect.gen(function* () {
  const db = yield* ControlDb;
  const now = DateTime.formatIso(yield* DateTime.now);
  yield* db.insert(controlPeople).values({
    id: "ada",
    email: "ada@acme.test",
    displayName: "Ada",
    role: "member",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  const design = yield* (yield* Departments).create("Design");
  yield* (yield* Departments).addMember(design.id, "ada");
  yield* (yield* Profiles).save({
    id: "company",
    settings: { monthlyUsd: 10 },
    note: "",
    testWith: null,
    by: "test",
  });
  yield* db.insert(controlAiUsage).values({
    at: now,
    personId: "ada",
    departmentId: design.id,
    accountId: null,
    provider: "claude",
    model: "claude-opus-5-5",
    inputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    webSearches: 0,
    costMicros: 9_950_000,
    priced: true,
    priceVersion: "test",
    outcome: "ok",
    status: 200,
    durationMs: 0,
    sessionId: null,
    requestId: null,
  });
  return { personId: "ada", departmentId: design.id };
});

/** Whether a call with an estimate of ten cents may start for her now. */
const roomForACall = (who: { readonly personId: string; readonly departmentId: string }) =>
  Effect.gen(function* () {
    const rules = yield* (yield* Profiles).effective(who.personId, who.departmentId);
    const held = yield* (yield* Budgets).hold(who, limitsOf(rules), 100_000);
    return held._tag === "Held";
  });

describe("BudgetRequests", () => {
  it.effect("adds an approved amount to that month's budget only, deciding each request once", () =>
    withRequests(
      Effect.gen(function* () {
        const requests = yield* BudgetRequests;
        const ada = yield* adaNearHerBudget;
        expect(yield* roomForACall(ada)).toBe(false);

        const ask = { level: "person-month", amountUsd: 20, reason: "Release week" } as const;
        const asked = yield* requests.ask(ada, ask);
        expect(asked).toMatchObject({
          status: "pending",
          period: "2026-11",
          use: { level: "person-month", spentUsd: 9.95, limitUsd: 10 },
        });
        expect(yield* Effect.flip(requests.ask(ada, ask))).toMatchObject({
          reason: "already-asked",
        });
        expect(
          yield* Effect.flip(requests.ask(ada, { ...ask, level: "person-day" })),
        ).toMatchObject({ reason: "no-limit" });

        const approved = yield* requests.decide({ requestId: asked.id, approve: true, by: "bea" });
        expect(approved).toMatchObject({ status: "approved", decidedBy: "bea" });
        expect(approved.use.limitUsd).toBe(30);
        expect(yield* roomForACall(ada)).toBe(true);
        expect(
          yield* Effect.flip(requests.decide({ requestId: asked.id, approve: false, by: "cy" })),
        ).toMatchObject({ reason: "already-decided" });
        expect((yield* requests.mine(ada)).budgets).toContainEqual({
          level: "person-month",
          spentUsd: 9.95,
          limitUsd: 30,
        });

        // December starts with the budget as the profile sets it.
        yield* TestClock.setTime(Date.parse("2026-12-01T00:30:00Z"));
        expect((yield* requests.mine(ada)).budgets).toContainEqual({
          level: "person-month",
          spentUsd: 0,
          limitUsd: 10,
        });
      }),
    ),
  );

  it.effect("approves a request only in the month it is for, but declines it later", () =>
    withRequests(
      Effect.gen(function* () {
        const requests = yield* BudgetRequests;
        const ada = yield* adaNearHerBudget;
        const asked = yield* requests.ask(ada, {
          level: "person-month",
          amountUsd: 5,
          reason: "One more review",
        });
        yield* TestClock.setTime(Date.parse("2026-12-02T09:00:00Z"));
        expect(
          yield* Effect.flip(requests.decide({ requestId: asked.id, approve: true, by: "bea" })),
        ).toMatchObject({ reason: "period-ended" });
        expect(
          yield* requests.decide({ requestId: asked.id, approve: false, by: "bea" }),
        ).toMatchObject({ status: "declined" });
      }),
    ),
  );
});
