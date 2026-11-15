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

/** A budget's spend passing a share of its limit: 80% to warn, 100% when it runs out. */
export interface BudgetCrossing {
  readonly level: BudgetLevel;
  readonly who: WorkspaceKey;
  /** The month or day it is for. */
  readonly period: string;
  readonly percent: 80 | 100;
  readonly spent: number;
  readonly limit: number;
}

export type HoldResult =
  | { readonly _tag: "Held"; readonly hold: BudgetHold }
  | { readonly _tag: "Full"; readonly crossing: BudgetCrossing };

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
    /**
     * Replaces a hold with what its call cost, once, and says which budgets
     * that cost took past 80% or 100% of their limit.
     */
    readonly settle: (
      hold: BudgetHold,
      cost: number,
    ) => Effect.Effect<ReadonlyArray<BudgetCrossing>>;
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
  /** The limit last checked against, before what was granted. */
  limit: number | null;
}

// Daily budgets catch runaway agents; a warning on each of them would be noise.
const WARN_AT: Record<BudgetLevel, ReadonlyArray<80 | 100>> = {
  "person-month": [80, 100],
  "person-day": [100],
  "department-month": [80, 100],
  "company-month": [80, 100],
};

const EMPTY: Bucket = { spent: 0, held: 0, extra: 0, limit: null };

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

  /** Keeps each loaded budget's limit as last checked, to warn when calls settle. */
  const remember = (all: ReadonlyArray<Check>) => {
    for (const check of all) {
      const bucket = buckets.get(check.key);
      if (bucket !== undefined) bucket.limit = check.limit;
    }
  };

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
    if (!buckets.has(check.key)) {
      buckets.set(check.key, { spent, held: 0, extra, limit: check.limit });
    }
  }, dieOnDatabaseError);

  return Budgets.of({
    hold: Effect.fn("Budgets.hold")(function* (who, limits, amount) {
      const period = yield* periodNow;
      prune(period);
      const all = checks(who, limits, period);
      const limited = all.filter((check) => check.limit !== null);
      yield* Effect.forEach(limited, load, { discard: true });
      remember(all);
      for (const check of limited) {
        const bucket = buckets.get(check.key) ?? EMPTY;
        if (
          check.limit !== null &&
          bucket.spent + bucket.held + amount > check.limit + bucket.extra
        ) {
          const crossing: BudgetCrossing = {
            level: check.level,
            who,
            period: check.level === "person-day" ? period.day : period.month,
            percent: 100,
            spent: bucket.spent,
            limit: check.limit + bucket.extra,
          };
          return { _tag: "Full", crossing } as const;
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
      if (settled.has(hold)) return [];
      settled.add(hold);
      for (const key of hold.keys) {
        const bucket = buckets.get(key);
        if (bucket !== undefined) bucket.held = Math.max(0, bucket.held - hold.amount);
      }
      // The cost counts in the period the call ended in; totals not loaded yet read it later.
      const period = yield* periodNow;
      prune(period);
      const crossings: Array<BudgetCrossing> = [];
      for (const check of checks(hold.who, NO_LIMITS, period)) {
        const bucket = buckets.get(check.key);
        if (bucket === undefined) continue;
        const before = bucket.spent;
        bucket.spent += cost;
        if (bucket.limit === null) continue;
        const limit = bucket.limit + bucket.extra;
        for (const percent of WARN_AT[check.level]) {
          const line = (limit * percent) / 100;
          if (before < line && bucket.spent >= line) {
            crossings.push({
              level: check.level,
              who: hold.who,
              period: check.level === "person-day" ? period.day : period.month,
              percent,
              spent: bucket.spent,
              limit,
            });
          }
        }
      }
      return crossings;
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
      remember(all);
      return all.map((check): BudgetUse => {
        const bucket = buckets.get(check.key) ?? EMPTY;
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
