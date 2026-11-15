import type { ControlMyUsage } from "@codenine/contracts/control";
import { and, count, desc, eq, gte, isNotNull, isNull, max, ne, sql, sum } from "drizzle-orm";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ControlDb } from "../db.ts";
import { controlAiUsage } from "../persistence/schema.ts";
import { Profiles } from "../profiles/Profiles.ts";
import type { WorkspaceKey } from "../workspaces/WorkspaceManager.ts";
import { BudgetTimeZoneConfig, Budgets, limitsOf } from "./Budgets.ts";
import { claudeModelKey } from "./claudePricing.ts";
import { openAiModelKey } from "./openaiPricing.ts";

const SESSIONS_SHOWN = 20;

/** What AI calls cost, summed for the pages people and admins read. */
export class UsageReports extends Context.Service<
  UsageReports,
  {
    /** A person's month so far in one of their departments. */
    readonly mine: (who: WorkspaceKey) => Effect.Effect<ControlMyUsage>;
  }
>()("@codenine/control/gateway/UsageReports") {}

const dieOnDatabaseError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.catchTags({ EffectDrizzleQueryError: Effect.die, SqlError: Effect.die }));

const usd = (micros: number | null) => (micros ?? 0) / 1_000_000;

/** The UTC hour a call was made in, such as `2026-11-15T10`, which places it in a local day. */
const hourOf = sql<string>`substr(${controlAiUsage.at}, 1, 13)`;

export const make = Effect.gen(function* () {
  const db = yield* ControlDb;
  const budgets = yield* Budgets;
  const profiles = yield* Profiles;
  const zone = yield* BudgetTimeZoneConfig;

  return UsageReports.of({
    mine: Effect.fn("UsageReports.mine")(function* (who: WorkspaceKey) {
      const now = yield* DateTime.now;
      const monthStart = DateTime.startOf(DateTime.setZone(now, zone), "month");
      const mine = and(
        eq(controlAiUsage.personId, who.personId),
        who.departmentId === null
          ? isNull(controlAiUsage.departmentId)
          : eq(controlAiUsage.departmentId, who.departmentId),
        gte(controlAiUsage.at, DateTime.formatIso(monthStart)),
      );
      const billed = and(mine, ne(controlAiUsage.outcome, "refused"));
      const cost = sum(controlAiUsage.costMicros).mapWith(Number);

      // Hours, not days, come back from the database: a day starts at the company's midnight.
      const hours = yield* db
        .select({ hour: hourOf, spent: cost })
        .from(controlAiUsage)
        .where(billed)
        .groupBy(hourOf);
      const days = new Map<string, number>();
      for (const { hour, spent } of hours) {
        const day = DateTime.formatIsoDate(
          DateTime.setZone(DateTime.makeUnsafe(`${hour}:00:00Z`), zone),
        );
        days.set(day, (days.get(day) ?? 0) + (spent ?? 0));
      }

      const byModel = new Map<
        string,
        { provider: "claude" | "codex"; model: string; spent: number; calls: number }
      >();
      const modelRows = yield* db
        .select({
          provider: controlAiUsage.provider,
          model: controlAiUsage.model,
          spent: cost,
          calls: count(),
        })
        .from(controlAiUsage)
        .where(billed)
        .groupBy(controlAiUsage.provider, controlAiUsage.model);
      for (const row of modelRows) {
        // Gateways name the same model differently, such as anthropic/claude-haiku-5.5.
        const model =
          row.provider === "claude" ? claudeModelKey(row.model) : openAiModelKey(row.model);
        const key = `${row.provider}:${model}`;
        const seen = byModel.get(key) ?? { provider: row.provider, model, spent: 0, calls: 0 };
        byModel.set(key, {
          ...seen,
          spent: seen.spent + (row.spent ?? 0),
          calls: seen.calls + row.calls,
        });
      }

      const sessions = yield* db
        .select({
          provider: controlAiUsage.provider,
          sessionId: controlAiUsage.sessionId,
          spent: cost,
          calls: count(),
          lastAt: max(controlAiUsage.at),
        })
        .from(controlAiUsage)
        .where(and(billed, isNotNull(controlAiUsage.sessionId)))
        .groupBy(controlAiUsage.provider, controlAiUsage.sessionId)
        .orderBy(desc(cost))
        .limit(SESSIONS_SHOWN);
      const [refused] = yield* db
        .select({ calls: count() })
        .from(controlAiUsage)
        .where(and(mine, eq(controlAiUsage.outcome, "refused")));

      const rules = yield* profiles.effective(who.personId, who.departmentId);
      const uses = yield* budgets.use(who, limitsOf(rules));
      const spent = [...days.values()].reduce((total, day) => total + day, 0);
      const elapsed = DateTime.distance(monthStart, now);
      const length = DateTime.distance(monthStart, DateTime.add(monthStart, { months: 1 }));
      return {
        departmentId: who.departmentId,
        month: DateTime.formatIsoDate(monthStart).slice(0, 7),
        budgets: uses.map(({ level, spent: used, limit }) => ({
          level,
          spentUsd: usd(used),
          limitUsd: limit === null ? null : usd(limit),
        })),
        forecastUsd:
          Duration.toMillis(elapsed) < Duration.toMillis(Duration.days(1))
            ? null
            : usd((spent * Duration.toMillis(length)) / Duration.toMillis(elapsed)),
        days: [...days.entries()]
          .toSorted(([a], [b]) => a.localeCompare(b))
          .map(([day, micros]) => ({ day, spentUsd: usd(micros) })),
        models: [...byModel.values()]
          .toSorted((a, b) => b.spent - a.spent)
          .map(({ provider, model, spent: micros, calls }) => ({
            provider,
            model,
            spentUsd: usd(micros),
            calls,
          })),
        sessions: sessions.flatMap(({ provider, sessionId, spent: micros, calls, lastAt }) =>
          sessionId === null || lastAt === null
            ? []
            : [{ provider, sessionId, spentUsd: usd(micros), calls, lastAt }],
        ),
        refusedCalls: refused?.calls ?? 0,
      } satisfies ControlMyUsage;
    }, dieOnDatabaseError),
  });
});

export const layer = Layer.effect(UsageReports, make);
