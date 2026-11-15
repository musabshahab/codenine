import type { ControlBudgetLevel, ControlEffectiveProfile } from "@codenine/contracts/control";
import { and, eq, gte, isNull, type SQL, sum } from "drizzle-orm";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ControlDb } from "../db.ts";
import { controlAiUsage, controlBudgetRequests } from "../persistence/schema.ts";
import type { WorkspaceKey } from "../workspaces/WorkspaceManager.ts";

/** Budget months and days follow the company's clock. */
export const BudgetTimeZoneConfig = Config.schema(
  Schema.TimeZoneNamedFromString,
  "CODENINE_CONTROL_TIME_ZONE",
).pipe(Config.withDefault(DateTime.zoneMakeNamedUnsafe("UTC")));

export type BudgetLevel = ControlBudgetLevel;

/** Limits in millionths of a US dollar; null where there is none. */
export interface BudgetLimits {
  readonly personMonth: number | null;
  readonly personDay: number | null;
  readonly departmentMonth: number | null;
  readonly companyMonth: number | null;
}

const toMicros = (usd: number | null) => (usd === null ? null : Math.round(usd * 1_000_000));

/** The budgets a person's settings put over their calls. */
export const limitsOf = (rules: ControlEffectiveProfile): BudgetLimits => ({
  personMonth: toMicros(rules.monthlyUsd),
  personDay: toMicros(rules.dailyUsd),
  departmentMonth: toMicros(rules.departmentMonthlyUsd),
  companyMonth: toMicros(rules.companyMonthlyUsd),
});

/** An estimate held back from some budgets until its call ends. */
export interface BudgetHold {
  readonly who: WorkspaceKey;
  readonly keys: ReadonlyArray<string>;
  readonly amount: number;
}

export type HoldResult =
  | { readonly _tag: "Held"; readonly hold: BudgetHold }
  | { readonly _tag: "Full"; readonly level: BudgetLevel; readonly limit: number };

/** How one budget stands, in millionths of a dollar. */
export interface BudgetUse {
  readonly level: BudgetLevel;
  readonly spent: number;
  /** With what was granted for this period; null where there is no limit. */
  readonly limit: number | null;
}

/** The month and day it is in the company's time zone, as `2026-11` and `2026-11-15`. */
export interface BudgetPeriod {
  readonly month: string;
  readonly day: string;
}

/** Extra budget granted for one period, to one person in a department or to a department. */
export interface BudgetGrant {
  readonly level: "person-month" | "person-day" | "department-month";
  readonly personId: string;
  readonly departmentId: string | null;
  readonly period: string;
  readonly amount: number;
}

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
    /** Raises a budget for one period, once a request for more is approved and recorded. */
    readonly grant: (grant: BudgetGrant) => Effect.Effect<void>;
    /** How each budget over someone's calls stands now. */
    readonly use: (
      who: WorkspaceKey,
      limits: BudgetLimits,
    ) => Effect.Effect<ReadonlyArray<BudgetUse>>;
    readonly period: Effect.Effect<BudgetPeriod>;
  }
>()("@codenine/control/gateway/Budgets") {}

interface Bucket {
  spent: number;
  held: number;
  /** Granted on request for this period. */
  extra: number;
}

interface Period extends BudgetPeriod {
  readonly monthStart: string;
  readonly dayStart: string;
}

interface Check {
  readonly level: BudgetLevel;
  readonly key: string;
  readonly limit: number | null;
  readonly spent: SQL | undefined;
  readonly granted: SQL | null;
}

const NO_LIMITS: BudgetLimits = {
  personMonth: null,
  personDay: null,
  departmentMonth: null,
  companyMonth: null,
};

const keyOf = (level: BudgetLevel, who: WorkspaceKey, period: string) => {
  switch (level) {
    case "person-month":
    case "person-day":
      return `person:${who.personId}/${who.departmentId ?? ""}@${period}`;
    case "department-month":
      return `department:${who.departmentId ?? ""}@${period}`;
    case "company-month":
      return `company@${period}`;
  }
};

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
    const department =
      who.departmentId === null
        ? isNull(controlAiUsage.departmentId)
        : eq(controlAiUsage.departmentId, who.departmentId);
    const person = and(eq(controlAiUsage.personId, who.personId), department);
    const granted = (level: BudgetGrant["level"], periodOf: string) =>
      and(
        eq(controlBudgetRequests.status, "approved"),
        eq(controlBudgetRequests.level, level),
        eq(controlBudgetRequests.period, periodOf),
        level === "department-month" ? undefined : eq(controlBudgetRequests.personId, who.personId),
        who.departmentId === null
          ? isNull(controlBudgetRequests.departmentId)
          : eq(controlBudgetRequests.departmentId, who.departmentId),
      ) ?? null;
    return [
      {
        level: "person-month",
        key: keyOf("person-month", who, period.month),
        limit: limits.personMonth,
        spent: and(person, gte(controlAiUsage.at, period.monthStart)),
        granted: granted("person-month", period.month),
      },
      {
        level: "person-day",
        key: keyOf("person-day", who, period.day),
        limit: limits.personDay,
        spent: and(person, gte(controlAiUsage.at, period.dayStart)),
        granted: granted("person-day", period.day),
      },
      ...(who.departmentId === null
        ? []
        : [
            {
              level: "department-month" as const,
              key: keyOf("department-month", who, period.month),
              limit: limits.departmentMonth,
              spent: and(department, gte(controlAiUsage.at, period.monthStart)),
              granted: granted("department-month", period.month),
            },
          ]),
      {
        level: "company-month",
        key: keyOf("company-month", who, period.month),
        limit: limits.companyMonth,
        spent: gte(controlAiUsage.at, period.monthStart),
        granted: null,
      },
    ];
  };

  const total = (rows: ReadonlyArray<{ readonly total: number | null }>) => rows[0]?.total ?? 0;

  const load = Effect.fn("Budgets.load")(function* (check: Check) {
    if (buckets.has(check.key)) return;
    const spent = total(
      yield* db
        .select({ total: sum(controlAiUsage.costMicros).mapWith(Number) })
        .from(controlAiUsage)
        .where(check.spent),
    );
    const extra =
      check.granted === null
        ? 0
        : total(
            yield* db
              .select({ total: sum(controlBudgetRequests.amountMicros).mapWith(Number) })
              .from(controlBudgetRequests)
              .where(check.granted),
          );
    // Another call may have loaded it meanwhile, and holds may already be on it.
    if (!buckets.has(check.key)) buckets.set(check.key, { spent, held: 0, extra });
  }, dieOnDatabaseError);

  return Budgets.of({
    hold: Effect.fn("Budgets.hold")(function* (who, limits, amount) {
      const period = yield* periodNow;
      prune(period);
      const limited = checks(who, limits, period).filter((check) => check.limit !== null);
      yield* Effect.forEach(limited, load, { discard: true });
      for (const check of limited) {
        const bucket = buckets.get(check.key) ?? { spent: 0, held: 0, extra: 0 };
        if (
          check.limit !== null &&
          bucket.spent + bucket.held + amount > check.limit + bucket.extra
        ) {
          return { _tag: "Full", level: check.level, limit: check.limit + bucket.extra } as const;
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
      for (const check of checks(hold.who, NO_LIMITS, period)) {
        const bucket = buckets.get(check.key);
        if (bucket !== undefined) bucket.spent += cost;
      }
    }),
    grant: Effect.fn("Budgets.grant")((grant: BudgetGrant) =>
      Effect.sync(() => {
        const bucket = buckets.get(
          keyOf(
            grant.level,
            { personId: grant.personId, departmentId: grant.departmentId },
            grant.period,
          ),
        );
        if (bucket !== undefined) bucket.extra += grant.amount;
      }),
    ),
    use: Effect.fn("Budgets.use")(function* (who, limits) {
      const period = yield* periodNow;
      prune(period);
      const all = checks(who, limits, period);
      yield* Effect.forEach(all, load, { discard: true });
      return all.map((check): BudgetUse => {
        const bucket = buckets.get(check.key) ?? { spent: 0, held: 0, extra: 0 };
        return {
          level: check.level,
          spent: bucket.spent,
          limit: check.limit === null ? null : check.limit + bucket.extra,
        };
      });
    }),
    period: Effect.map(periodNow, ({ month, day }) => ({ month, day })),
  });
});

export const layer = Layer.effect(Budgets, make);
