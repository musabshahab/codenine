import { and, eq, gte, isNull, sum, type SQL } from "drizzle-orm";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ControlDb } from "../db.ts";
import { controlAiUsage } from "../persistence/schema.ts";
import type { WorkspaceKey } from "../workspaces/WorkspaceManager.ts";

/** Budget months and days follow the company's clock. */
export const BudgetTimeZoneConfig = Config.schema(
  Schema.TimeZoneNamedFromString,
  "CODENINE_CONTROL_TIME_ZONE",
).pipe(Config.withDefault(DateTime.zoneMakeNamedUnsafe("UTC")));

export type BudgetLevel = "person-month" | "person-day" | "department-month" | "company-month";

/** Limits in millionths of a US dollar; null where there is none. */
export interface BudgetLimits {
  readonly personMonth: number | null;
  readonly personDay: number | null;
  readonly departmentMonth: number | null;
  readonly companyMonth: number | null;
}

/** An estimate held back from some budgets until its call ends. */
export interface BudgetHold {
  readonly who: WorkspaceKey;
  readonly keys: ReadonlyArray<string>;
  readonly amount: number;
}

export type HoldResult =
  | { readonly _tag: "Held"; readonly hold: BudgetHold }
  | { readonly _tag: "Full"; readonly level: BudgetLevel; readonly limit: number };

/**
 * Spend this month and today, plus what running calls may still spend, so
 * parallel calls cannot all start on the same last dollars. Totals are read
 * from the usage record once a period and kept in memory: this assumes the
 * control server runs as one process.
 */
export class Budgets extends Context.Service<
  Budgets,
  {
    /** Holds `amount` back from every budget with a limit, or names the first without room. */
    readonly hold: (
      who: WorkspaceKey,
      limits: BudgetLimits,
      amount: number,
    ) => Effect.Effect<HoldResult>;
    /** Replaces a hold with what its call cost; a second settle of the same hold does nothing. */
    readonly settle: (hold: BudgetHold, cost: number) => Effect.Effect<void>;
  }
>()("@codenine/control/gateway/Budgets") {}

interface Bucket {
  spent: number;
  held: number;
}

interface Period {
  readonly month: string;
  readonly day: string;
  readonly monthStart: string;
  readonly dayStart: string;
}

interface Check {
  readonly level: BudgetLevel;
  readonly key: string;
  readonly limit: number | null;
  readonly where: SQL | undefined;
}

const dieOnDatabaseError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.catchTags({ EffectDrizzleQueryError: Effect.die, SqlError: Effect.die }));

export const make = Effect.gen(function* () {
  const db = yield* ControlDb;
  const zone = yield* BudgetTimeZoneConfig;
  const buckets = new Map<string, Bucket>();
  const settled = new WeakSet<BudgetHold>();
  let current = "";

  const periodNow = Effect.map(DateTime.now, (now): Period => {
    const local = DateTime.setZone(now, zone);
    const day = DateTime.formatIsoDate(local);
    return {
      month: day.slice(0, 7),
      day,
      monthStart: DateTime.formatIso(DateTime.startOf(local, "month")),
      dayStart: DateTime.formatIso(DateTime.startOf(local, "day")),
    };
  });

  /** Forgets totals from periods that have ended. */
  const prune = (period: Period) => {
    if (current === period.day) return;
    current = period.day;
    for (const key of buckets.keys()) {
      if (!key.endsWith(`@${period.month}`) && !key.endsWith(`@${period.day}`)) {
        buckets.delete(key);
      }
    }
  };

  const checks = (who: WorkspaceKey, limits: BudgetLimits, period: Period): Array<Check> => {
    const person = and(
      eq(controlAiUsage.personId, who.personId),
      who.departmentId === null
        ? isNull(controlAiUsage.departmentId)
        : eq(controlAiUsage.departmentId, who.departmentId),
    );
    const place = `${who.personId}/${who.departmentId ?? ""}`;
    return [
      {
        level: "person-month",
        key: `person:${place}@${period.month}`,
        limit: limits.personMonth,
        where: and(person, gte(controlAiUsage.at, period.monthStart)),
      },
      {
        level: "person-day",
        key: `person:${place}@${period.day}`,
        limit: limits.personDay,
        where: and(person, gte(controlAiUsage.at, period.dayStart)),
      },
      ...(who.departmentId === null
        ? []
        : [
            {
              level: "department-month" as const,
              key: `department:${who.departmentId}@${period.month}`,
              limit: limits.departmentMonth,
              where: and(
                eq(controlAiUsage.departmentId, who.departmentId),
                gte(controlAiUsage.at, period.monthStart),
              ),
            },
          ]),
      {
        level: "company-month",
        key: `company@${period.month}`,
        limit: limits.companyMonth,
        where: gte(controlAiUsage.at, period.monthStart),
      },
    ];
  };

  const load = Effect.fn("Budgets.load")(function* (check: Check) {
    if (buckets.has(check.key)) return;
    const [row] = yield* db
      .select({ spent: sum(controlAiUsage.costMicros).mapWith(Number) })
      .from(controlAiUsage)
      .where(check.where);
    // Another call may have loaded it meanwhile, and holds may already be on it.
    if (!buckets.has(check.key)) buckets.set(check.key, { spent: row?.spent ?? 0, held: 0 });
  }, dieOnDatabaseError);

  return Budgets.of({
    hold: Effect.fn("Budgets.hold")(function* (who, limits, amount) {
      const period = yield* periodNow;
      prune(period);
      const limited = checks(who, limits, period).filter((check) => check.limit !== null);
      yield* Effect.forEach(limited, load, { discard: true });
      for (const check of limited) {
        const bucket = buckets.get(check.key) ?? { spent: 0, held: 0 };
        if (check.limit !== null && bucket.spent + bucket.held + amount > check.limit) {
          return { _tag: "Full", level: check.level, limit: check.limit } as const;
        }
      }
      for (const check of limited) {
        const bucket = buckets.get(check.key);
        if (bucket !== undefined) bucket.held += amount;
      }
      const hold: BudgetHold = { who, keys: limited.map((check) => check.key), amount };
      return { _tag: "Held", hold } as const;
    }),
    settle: Effect.fn("Budgets.settle")(function* (hold, cost) {
      if (settled.has(hold)) return;
      settled.add(hold);
      for (const key of hold.keys) {
        const bucket = buckets.get(key);
        if (bucket !== undefined) bucket.held = Math.max(0, bucket.held - hold.amount);
      }
      // The cost counts in the period the call ended in; totals not loaded yet read it later.
      const period = yield* periodNow;
      prune(period);
      for (const check of checks(hold.who, BUDGETLESS, period)) {
        const bucket = buckets.get(check.key);
        if (bucket !== undefined) bucket.spent += cost;
      }
    }),
  });
});

const BUDGETLESS: BudgetLimits = {
  personMonth: null,
  personDay: null,
  departmentMonth: null,
  companyMonth: null,
};

export const layer = Layer.effect(Budgets, make);
