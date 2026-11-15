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
import { UsageReports } from "./UsageReports.ts";

const ada = { personId: "ada", departmentId: "design" };

const call = (input: {
  readonly at: string;
  readonly dollars: number;
  readonly model?: string;
  readonly sessionId?: string;
  readonly refused?: boolean;
}) =>
  Effect.gen(function* () {
    yield* (yield* ControlDb).insert(controlAiUsage).values({
      at: input.at,
      ...ada,
      accountId: null,
      provider: "claude",
      model: input.model ?? "claude-opus-5-5",
      inputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      webSearches: 0,
      costMicros: input.dollars * 1_000_000,
      priced: true,
      priceVersion: "test",
      outcome: input.refused === true ? "refused" : "ok",
      refusal: input.refused === true ? "person-month" : null,
      status: input.refused === true ? 402 : 200,
      durationMs: 0,
      sessionId: input.sessionId ?? null,
      requestId: null,
    });
  });

describe("UsageReports", () => {
  it.effect("sums a person's month by the company's days, by model and by session", () =>
    Effect.gen(function* () {
      const keys = yield* testKeyPair;
      // Noon on 20 November in Tokyo.
      yield* TestClock.setTime(Date.parse("2026-11-20T03:00:00Z"));
      return yield* Effect.gen(function* () {
        yield* call({ at: "2026-10-31T14:00:00.000Z", dollars: 8 });
        yield* call({ at: "2026-10-31T16:00:00.000Z", dollars: 4, sessionId: "s1" });
        yield* call({ at: "2026-11-19T14:30:00.000Z", dollars: 2, sessionId: "s2" });
        yield* call({
          at: "2026-11-19T16:30:00.000Z",
          dollars: 1,
          model: "anthropic/claude-opus-5.5",
          sessionId: "s2",
        });
        yield* call({ at: "2026-11-19T17:00:00.000Z", dollars: 0, refused: true });

        const usage = yield* (yield* UsageReports).mine(ada);
        expect(usage).toMatchObject({
          month: "2026-11",
          days: [
            { day: "2026-11-01", spentUsd: 4 },
            { day: "2026-11-19", spentUsd: 2 },
            { day: "2026-11-20", spentUsd: 1 },
          ],
          models: [{ provider: "claude", model: "claude-opus-5-5", spentUsd: 7, calls: 3 }],
          sessions: [
            { sessionId: "s1", spentUsd: 4, calls: 1 },
            { sessionId: "s2", spentUsd: 3, calls: 2, lastAt: "2026-11-19T16:30:00.000Z" },
          ],
          refusedCalls: 1,
        });
        // $7 in 19.5 of November's 30 days.
        expect(usage.forecastUsd).toBeCloseTo((7 * 30) / 19.5, 6);
      }).pipe(
        Effect.provide(
          layerTestServices(keys.publicKey).pipe(
            Layer.provide(
              ConfigProvider.layer(
                ConfigProvider.fromEnv({ env: { CODENINE_CONTROL_TIME_ZONE: "Asia/Tokyo" } }),
              ),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
});
