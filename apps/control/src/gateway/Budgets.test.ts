import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { ControlDb } from "../db.ts";
import { controlAiUsage } from "../persistence/schema.ts";
import { layerTestServices } from "../testing/layerTestServices.ts";
import { testKeyPair } from "../testing/testLicence.ts";
import { type BudgetLimits, Budgets } from "./Budgets.ts";

const NONE: BudgetLimits = {
  personMonth: null,
  personDay: null,
  departmentMonth: null,
  companyMonth: null,
};
const ada = { personId: "ada", departmentId: "design" };
const bea = { personId: "bea", departmentId: "design" };
const DOLLAR = 1_000_000;

const withBudgets = <A, E, R>(body: Effect.Effect<A, E, R>, timeZone = "UTC") =>
  Effect.gen(function* () {
    const keys = yield* testKeyPair;
    // 23:00 on 30 November in Tokyo.
    yield* TestClock.setTime(Date.parse("2026-11-30T14:00:00Z"));
    return yield* body.pipe(
      Effect.provide(
        layerTestServices(keys.publicKey).pipe(
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({ env: { CODENINE_CONTROL_TIME_ZONE: timeZone } }),
            ),
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

/** A call already in the usage record. */
const spent = (who: typeof ada, at: string, dollars: number) =>
  Effect.gen(function* () {
    yield* (yield* ControlDb).insert(controlAiUsage).values({
      at,
      personId: who.personId,
      departmentId: who.departmentId,
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

describe("Budgets", () => {
  it.effect("counts this month's spend, holds estimates, and settles each call once", () =>
    withBudgets(
      Effect.gen(function* () {
        const budgets = yield* Budgets;
        yield* spent(ada, "2026-11-02T09:00:00.000Z", 70);
        yield* spent(ada, "2026-10-31T23:00:00.000Z", 500);
        yield* spent(bea, "2026-11-05T09:00:00.000Z", 10);
        const limits = { ...NONE, personMonth: 100 * DOLLAR };

        const first = yield* budgets.hold(ada, limits, 20 * DOLLAR);
        expect(yield* budgets.hold(ada, limits, 20 * DOLLAR)).toEqual({
          _tag: "Full",
          level: "person-month",
          limit: 100 * DOLLAR,
        });
        if (first._tag !== "Held") return expect.unreachable();
        yield* budgets.settle(first.hold, 5 * DOLLAR);
        yield* budgets.settle(first.hold, 5 * DOLLAR);

        // $75 spent: room for $25 more, and not a cent beyond.
        expect((yield* budgets.hold(ada, limits, 25 * DOLLAR))._tag).toBe("Held");
        expect((yield* budgets.hold(ada, limits, 1))._tag).toBe("Full");
      }),
    ),
  );

  it.effect("stops a team of parallel calls at the department's budget", () =>
    withBudgets(
      Effect.gen(function* () {
        const budgets = yield* Budgets;
        const limits = { ...NONE, departmentMonth: DOLLAR };
        const calls = yield* Effect.forEach(
          Array.from({ length: 10 }, (_, index) => (index % 2 === 0 ? ada : bea)),
          (who) => budgets.hold(who, limits, 150_000),
          { concurrency: "unbounded" },
        );
        const held = calls.flatMap((call) => (call._tag === "Held" ? [call.hold] : []));
        expect(held).toHaveLength(6);
        expect(calls.filter((call) => call._tag === "Full")).toHaveLength(4);

        // Each cost more than its estimate: the budget is passed by those calls' difference only.
        yield* Effect.forEach(held, (hold) => budgets.settle(hold, 200_000));
        expect(yield* budgets.hold(ada, limits, 1)).toMatchObject({
          _tag: "Full",
          level: "department-month",
        });
      }),
    ),
  );

  it.effect("starts a new day and month at midnight in the company's time zone", () =>
    withBudgets(
      Effect.gen(function* () {
        const budgets = yield* Budgets;
        yield* spent(ada, "2026-11-30T10:00:00.000Z", 9);
        const limits = { ...NONE, personDay: 10 * DOLLAR, personMonth: 100 * DOLLAR };

        expect((yield* budgets.hold(ada, limits, 500_000))._tag).toBe("Held");
        expect(yield* budgets.hold(ada, limits, 600_000)).toMatchObject({
          _tag: "Full",
          level: "person-day",
        });

        yield* TestClock.adjust("1 hour");
        expect((yield* budgets.hold(ada, limits, 2 * DOLLAR))._tag).toBe("Held");
      }),
      "Asia/Tokyo",
    ),
  );
});
