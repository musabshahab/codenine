import {
  type ControlBudgetAsk,
  ControlBudgetError,
  type ControlBudgetRequest,
  type ControlBudgetRequestLevel,
  type ControlMyBudget,
} from "@codenine/contracts/control";
import { and, desc, eq, gte, inArray, isNull, or, type SQL } from "drizzle-orm";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { Hex } from "effect/encoding";
import * as Layer from "effect/Layer";

import { Accounts } from "../accounts/Accounts.ts";
import { ControlDb } from "../db.ts";
import { Departments } from "../departments/Departments.ts";
import { controlBudgetRequests } from "../persistence/schema.ts";
import { Profiles } from "../profiles/Profiles.ts";
import type { WorkspaceKey } from "../workspaces/WorkspaceManager.ts";
import { type BudgetPeriod, Budgets, limitsOf } from "./Budgets.ts";

/** How long decided requests stay in the list. */
const DECIDED_DAYS = 30;

/**
 * Requests to spend more than a budget allows. One stays pending until
 * someone decides it; approved, its amount adds to that budget for the month
 * or day it was made in. Who may decide is `Administration`'s job.
 */
export class BudgetRequests extends Context.Service<
  BudgetRequests,
  {
    /** A person's budgets in one of their workspaces, and this month's requests. */
    readonly mine: (who: WorkspaceKey) => Effect.Effect<ControlMyBudget>;
    readonly ask: (
      who: WorkspaceKey,
      ask: ControlBudgetAsk,
    ) => Effect.Effect<ControlBudgetRequest, ControlBudgetError>;
    /** Pending requests, and those decided lately, newest first. */
    readonly list: (filter: {
      /** Null for every department. */
      readonly departments: ReadonlyArray<string> | null;
      readonly levels: ReadonlyArray<ControlBudgetRequestLevel>;
      /** Someone whose own requests are left out. */
      readonly exceptPersonId: string | null;
    }) => Effect.Effect<ReadonlyArray<ControlBudgetRequest>>;
    readonly find: (requestId: string) => Effect.Effect<ControlBudgetRequest, ControlBudgetError>;
    /** Decides a pending request; approving one raises its budget at once. */
    readonly decide: (input: {
      readonly requestId: string;
      readonly approve: boolean;
      readonly by: string;
    }) => Effect.Effect<ControlBudgetRequest, ControlBudgetError>;
  }
>()("@codenine/control/gateway/BudgetRequests") {}

type Row = typeof controlBudgetRequests.$inferSelect;

const dieOnDatabaseError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.catchTags({ EffectDrizzleQueryError: Effect.die, SqlError: Effect.die }));

const periodOf = (level: ControlBudgetRequestLevel, period: BudgetPeriod) =>
  level === "person-day" ? period.day : period.month;

const sameDepartment = (departmentId: string | null) =>
  departmentId === null
    ? isNull(controlBudgetRequests.departmentId)
    : eq(controlBudgetRequests.departmentId, departmentId);

export const make = Effect.gen(function* () {
  const db = yield* ControlDb;
  const budgets = yield* Budgets;
  const profiles = yield* Profiles;
  const accounts = yield* Accounts;
  const departments = yield* Departments;
  const random = yield* SecureRandom.SecureRandom;

  const usesOf = Effect.fn("BudgetRequests.usesOf")(function* (who: WorkspaceKey) {
    const rules = yield* profiles.effective(who.personId, who.departmentId);
    return yield* budgets.use(who, limitsOf(rules));
  });

  const toRequest = Effect.fn("BudgetRequests.toRequest")(function* (row: Row) {
    const who = { personId: row.personId, departmentId: row.departmentId };
    const uses = yield* usesOf(who);
    return {
      id: row.id,
      personId: row.personId,
      personName: yield* accounts.findPerson(row.personId).pipe(
        Effect.map((person) => person.displayName),
        Effect.orElseSucceed(() => row.personId),
      ),
      departmentId: row.departmentId,
      departmentName:
        row.departmentId === null
          ? null
          : yield* departments.find(row.departmentId).pipe(
              Effect.map((department) => department.name),
              Effect.orElseSucceed(() => row.departmentId),
            ),
      level: row.level,
      period: row.period,
      amountUsd: row.amountMicros / 1_000_000,
      reason: row.reason,
      status: row.status,
      createdAt: row.createdAt,
      decidedBy: row.decidedBy,
      decidedAt: row.decidedAt,
      use: (({ level, spent, limit }) => ({
        level,
        spentUsd: spent / 1_000_000,
        limitUsd: limit === null ? null : limit / 1_000_000,
      }))(
        uses.find((use) => use.level === row.level) ?? {
          level: row.level,
          spent: 0,
          limit: null,
        },
      ),
    } satisfies ControlBudgetRequest;
  });

  const rowOf = Effect.fn("BudgetRequests.rowOf")(function* (requestId: string) {
    const [row] = yield* db
      .select()
      .from(controlBudgetRequests)
      .where(eq(controlBudgetRequests.id, requestId));
    if (row === undefined) return yield* new ControlBudgetError({ reason: "not-found" });
    return row;
  });

  return BudgetRequests.of({
    mine: Effect.fn("BudgetRequests.mine")(function* (who: WorkspaceKey) {
      const period = yield* budgets.period;
      const uses = yield* usesOf(who);
      const rows = yield* db
        .select()
        .from(controlBudgetRequests)
        .where(
          and(
            eq(controlBudgetRequests.personId, who.personId),
            sameDepartment(who.departmentId),
            or(
              eq(controlBudgetRequests.period, period.month),
              eq(controlBudgetRequests.period, period.day),
            ),
          ),
        )
        .orderBy(desc(controlBudgetRequests.createdAt));
      return {
        departmentId: who.departmentId,
        budgets: uses.map(({ level, spent, limit }) => ({
          level,
          spentUsd: spent / 1_000_000,
          limitUsd: limit === null ? null : limit / 1_000_000,
        })),
        requests: yield* Effect.forEach(rows, toRequest),
      } satisfies ControlMyBudget;
    }, dieOnDatabaseError),
    ask: Effect.fn("BudgetRequests.ask")(function* (who: WorkspaceKey, ask: ControlBudgetAsk) {
      const asked = (yield* usesOf(who)).find((use) => use.level === ask.level);
      if (asked === undefined || asked.limit === null) {
        return yield* new ControlBudgetError({ reason: "no-limit" });
      }
      const period = periodOf(ask.level, yield* budgets.period);
      const [pending] = yield* db
        .select({ id: controlBudgetRequests.id })
        .from(controlBudgetRequests)
        .where(
          and(
            eq(controlBudgetRequests.personId, who.personId),
            sameDepartment(who.departmentId),
            eq(controlBudgetRequests.level, ask.level),
            eq(controlBudgetRequests.period, period),
            eq(controlBudgetRequests.status, "pending"),
          ),
        );
      if (pending !== undefined) return yield* new ControlBudgetError({ reason: "already-asked" });
      const row: Row = {
        id: `bud_${Hex.encode(yield* random.randomBytes(8))}`,
        personId: who.personId,
        departmentId: who.departmentId,
        level: ask.level,
        period,
        amountMicros: Math.round(ask.amountUsd * 1_000_000),
        reason: ask.reason.trim().slice(0, 500),
        status: "pending",
        createdAt: DateTime.formatIso(yield* DateTime.now),
        decidedBy: null,
        decidedAt: null,
      };
      yield* db.insert(controlBudgetRequests).values(row);
      return yield* toRequest(row);
    }, dieOnDatabaseError),
    list: Effect.fn("BudgetRequests.list")(function* (filter) {
      if (filter.levels.length === 0 || filter.departments?.length === 0) return [];
      const since = DateTime.formatIso(
        DateTime.subtract(yield* DateTime.now, { days: DECIDED_DAYS }),
      );
      const conditions: Array<SQL | undefined> = [
        inArray(controlBudgetRequests.level, [...filter.levels]),
        or(
          eq(controlBudgetRequests.status, "pending"),
          gte(controlBudgetRequests.decidedAt, since),
        ),
        filter.departments === null
          ? undefined
          : inArray(controlBudgetRequests.departmentId, [...filter.departments]),
      ];
      const rows = yield* db
        .select()
        .from(controlBudgetRequests)
        .where(and(...conditions))
        .orderBy(desc(controlBudgetRequests.createdAt));
      return yield* Effect.forEach(
        rows.filter((row) => row.personId !== filter.exceptPersonId),
        toRequest,
      );
    }, dieOnDatabaseError),
    find: Effect.fn("BudgetRequests.find")(function* (requestId: string) {
      return yield* toRequest(yield* rowOf(requestId));
    }, dieOnDatabaseError),
    decide: Effect.fn("BudgetRequests.decide")(function* (input) {
      const row = yield* rowOf(input.requestId);
      if (row.status !== "pending") {
        return yield* new ControlBudgetError({ reason: "already-decided" });
      }
      if (input.approve && row.period !== periodOf(row.level, yield* budgets.period)) {
        return yield* new ControlBudgetError({ reason: "period-ended" });
      }
      const decided = {
        status: input.approve ? ("approved" as const) : ("declined" as const),
        decidedBy: input.by.slice(0, 512),
        decidedAt: DateTime.formatIso(yield* DateTime.now),
      };
      // Only the first decision counts, however many are made at once.
      const updated = yield* db
        .update(controlBudgetRequests)
        .set(decided)
        .where(
          and(eq(controlBudgetRequests.id, row.id), eq(controlBudgetRequests.status, "pending")),
        )
        .returning({ id: controlBudgetRequests.id });
      if (updated.length === 0) {
        return yield* new ControlBudgetError({ reason: "already-decided" });
      }
      if (input.approve) {
        yield* budgets.grant({
          level: row.level,
          personId: row.personId,
          departmentId: row.departmentId,
          period: row.period,
          amount: row.amountMicros,
        });
      }
      return yield* toRequest({ ...row, ...decided });
    }, dieOnDatabaseError),
  });
});

export const layer = Layer.effect(BudgetRequests, make);
