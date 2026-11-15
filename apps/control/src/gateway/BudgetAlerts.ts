import type { ControlPerson } from "@codenine/contracts/control";
import { and, countDistinct, eq, gte, isNull, lt, sql, sum } from "drizzle-orm";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import { Accounts } from "../accounts/Accounts.ts";
import { ControlPublicUrl } from "../config.ts";
import { ControlDb } from "../db.ts";
import { Departments } from "../departments/Departments.ts";
import { Mailer } from "../mail/Mailer.ts";
import { budgetAlertMail } from "../mail/messages.ts";
import { controlAiUsage, controlBudgetAlerts } from "../persistence/schema.ts";
import type { WorkspaceKey } from "../workspaces/WorkspaceManager.ts";
import type { BudgetCrossing } from "./Budgets.ts";

// An hour is a spike when it costs this many times the person's usual hour of
// use over the past week, and at least the floor, so small sums never alert.
const SPIKE_FACTOR = 4;
const SPIKE_FLOOR_MICROS = 10_000_000;

/**
 * Tells people about AI spend by email: when a budget passes 80% or runs out,
 * and when someone's last hour cost far more than usual, as a stuck agent
 * would. Each warning goes out once; without a mail server, none do.
 */
export class BudgetAlerts extends Context.Service<
  BudgetAlerts,
  {
    readonly crossed: (crossing: BudgetCrossing) => Effect.Effect<void>;
    /** Looks at everyone's last hour of AI calls against their usual hour. */
    readonly checkSpikes: Effect.Effect<void>;
  }
>()("@codenine/control/gateway/BudgetAlerts") {}

const dieOnDatabaseError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.catchTags({ EffectDrizzleQueryError: Effect.die, SqlError: Effect.die }));

const dollars = (micros: number) =>
  (micros / 1_000_000).toLocaleString("en-US", { style: "currency", currency: "USD" });

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** `2026-11` as "November 2026", `2026-11-15` as "15 November 2026". */
const periodName = (period: string) => {
  const [year, month, day] = period.split("-");
  const named = `${MONTHS[Number(month) - 1] ?? month} ${year}`;
  return day === undefined ? named : `${Number(day)} ${named}`;
};

interface Notice {
  readonly to: ControlPerson;
  readonly subject: string;
  readonly what: string;
  readonly next: string;
}

export const make = Effect.gen(function* () {
  const db = yield* ControlDb;
  const accounts = yield* Accounts;
  const departments = yield* Departments;
  const mailer = yield* Mailer;
  const { origin } = yield* ControlPublicUrl;

  /** Records a warning as sent; false when it already was. */
  const firstTime = Effect.fn("BudgetAlerts.firstTime")(function* (key: string) {
    const added = yield* db
      .insert(controlBudgetAlerts)
      .values({ key: key.slice(0, 255), sentAt: DateTime.formatIso(yield* DateTime.now) })
      .onConflictDoNothing()
      .returning({ key: controlBudgetAlerts.key });
    return added.length > 0;
  }, dieOnDatabaseError);

  /** Who hears about someone's spend: the admins of their department, or owners and admins. */
  const overseers = Effect.fn("BudgetAlerts.overseers")(function* (
    departmentId: string | null,
    owners: boolean,
  ) {
    const people = (yield* accounts.listPeople).filter(({ status }) => status === "active");
    const members =
      departmentId === null
        ? []
        : yield* departments.find(departmentId).pipe(
            Effect.map((department) => department.members),
            Effect.orElseSucceed((): ReadonlyArray<string> => []),
          );
    return people.filter(
      (person) =>
        (person.role === "department-admin" && members.includes(person.id)) ||
        (owners && (person.role === "owner" || person.role === "admin")),
    );
  });

  const departmentName = (departmentId: string | null) =>
    departmentId === null
      ? Effect.succeed(null)
      : departments.find(departmentId).pipe(
          Effect.map((department) => department.name),
          Effect.orElseSucceed(() => null),
        );

  const personOf = (personId: string) => accounts.findPerson(personId).pipe(Effect.option);

  const send = Effect.fn("BudgetAlerts.send")(function* (notices: ReadonlyArray<Notice>) {
    const seen = new Set<string>();
    for (const notice of notices) {
      if (seen.has(notice.to.id)) continue;
      seen.add(notice.to.id);
      yield* mailer
        .send(
          budgetAlertMail({
            to: notice.to.email,
            displayName: notice.to.displayName,
            origin,
            subject: notice.subject,
            what: notice.what,
            next: notice.next,
          }),
        )
        .pipe(
          Effect.catchTags({
            MailDeliveryError: (error) =>
              Effect.logWarning("A budget warning was not sent.", error),
          }),
        );
    }
  });

  const noticesFor = Effect.fn("BudgetAlerts.noticesFor")(function* (crossing: BudgetCrossing) {
    const { level, who, percent } = crossing;
    const when = level === "person-day" ? "today" : "this month";
    const period = periodName(crossing.period);
    const amounts = `${dollars(crossing.spent)} of ${dollars(crossing.limit)}`;
    const place = yield* departmentName(who.departmentId);
    const where = place === null ? "" : ` in ${place}`;
    const notices: Array<Notice> = [];
    if (level === "person-month" || level === "person-day") {
      const person = yield* personOf(who.personId);
      if (person._tag === "None") return notices;
      const name = person.value.displayName;
      notices.push({
        to: person.value,
        subject:
          percent === 100
            ? `Your AI budget for ${when} has run out`
            : `You have used ${percent}% of your AI budget for ${when}`,
        what: `You have used ${amounts} of your AI budget${where} for ${period}.`,
        next:
          percent === 100
            ? "Your agents stop until the budget starts again or you get more. You can ask for more in Codenine."
            : "When it runs out, your agents stop until it starts again or you get more. You can ask for more in Codenine.",
      });
      for (const overseer of yield* overseers(who.departmentId, who.departmentId === null)) {
        notices.push({
          to: overseer,
          subject:
            percent === 100
              ? `${name}'s AI budget for ${when} has run out`
              : `${name} has used ${percent}% of their AI budget for ${when}`,
          what: `${name} (${person.value.email}) has used ${amounts} of their AI budget${where} for ${period}.`,
          next: "If they ask for more, you can decide under Admin in Codenine.",
        });
      }
      return notices;
    }
    const subjectOf = (whose: string, its: string) =>
      percent === 100
        ? `${its} AI budget for ${when} has run out`
        : `${whose} has used ${percent}% of its AI budget for ${when}`;
    if (level === "department-month") {
      const name = place ?? "A department";
      for (const overseer of yield* overseers(who.departmentId, true)) {
        notices.push({
          to: overseer,
          subject: subjectOf(name, `${name}'s`),
          what: `${name} has used ${amounts} of its AI budget for ${period}.`,
          next: "Owners and admins can raise it on the company's profile in Codenine.",
        });
      }
      return notices;
    }
    for (const overseer of yield* overseers(null, true)) {
      notices.push({
        to: overseer,
        subject: subjectOf("Your company", "Your company's"),
        what: `Your company has used ${amounts} of its AI budget for ${period}.`,
        next: "Owners and admins can raise it on the company's profile in Codenine.",
      });
    }
    return notices;
  });

  const scope = (who: WorkspaceKey) => `${who.personId}/${who.departmentId ?? ""}`;

  return BudgetAlerts.of({
    crossed: Effect.fn("BudgetAlerts.crossed")(function* (crossing: BudgetCrossing) {
      const about =
        crossing.level === "company-month"
          ? "company"
          : crossing.level === "department-month"
            ? (crossing.who.departmentId ?? "")
            : scope(crossing.who);
      if (
        !(yield* firstTime(`${crossing.level}:${about}:${crossing.period}:${crossing.percent}`))
      ) {
        return;
      }
      if (mailer.enabled) yield* send(yield* noticesFor(crossing));
    }),
    checkSpikes: Effect.gen(function* () {
      const now = yield* DateTime.now;
      const hourAgo = DateTime.formatIso(DateTime.subtract(now, { hours: 1 }));
      const weekAgo = DateTime.formatIso(DateTime.subtract(now, { days: 7 }));
      const recent = yield* db
        .select({
          personId: controlAiUsage.personId,
          departmentId: controlAiUsage.departmentId,
          spent: sum(controlAiUsage.costMicros).mapWith(Number),
        })
        .from(controlAiUsage)
        .where(gte(controlAiUsage.at, hourAgo))
        .groupBy(controlAiUsage.personId, controlAiUsage.departmentId);
      for (const row of recent) {
        const spent = row.spent ?? 0;
        if (spent < SPIKE_FLOOR_MICROS) continue;
        const [usual] = yield* db
          .select({
            spent: sum(controlAiUsage.costMicros).mapWith(Number),
            hours: countDistinct(sql`substr(${controlAiUsage.at}, 1, 13)`),
          })
          .from(controlAiUsage)
          .where(
            and(
              eq(controlAiUsage.personId, row.personId),
              row.departmentId === null
                ? isNull(controlAiUsage.departmentId)
                : eq(controlAiUsage.departmentId, row.departmentId),
              gte(controlAiUsage.at, weekAgo),
              lt(controlAiUsage.at, hourAgo),
            ),
          );
        const typical =
          usual === undefined || usual.hours === 0 ? 0 : (usual.spent ?? 0) / usual.hours;
        if (spent < SPIKE_FACTOR * typical) continue;
        const who = { personId: row.personId, departmentId: row.departmentId };
        const hour = DateTime.formatIso(now).slice(0, 13);
        if (!(yield* firstTime(`spike:${scope(who)}:${hour}`)) || !mailer.enabled) continue;
        const person = yield* personOf(who.personId);
        if (person._tag === "None") continue;
        const name = person.value.displayName;
        const usualHour =
          typical === 0
            ? "with little use before it"
            : `against ${dollars(typical)} in a usual hour`;
        const what = `${dollars(spent)} of AI calls in the last hour, ${usualHour}.`;
        yield* send([
          {
            to: person.value,
            subject: "Your AI spend in the last hour was far above usual",
            what: `Your agents made ${what}`,
            next: "If an agent is stuck in a loop, stop it in Codenine; your budget stops it otherwise.",
          },
          ...(yield* overseers(who.departmentId, who.departmentId === null)).map((overseer) => ({
            to: overseer,
            subject: `${name}'s AI spend in the last hour was far above usual`,
            what: `${name}'s agents made ${what}`,
            next: "If an agent is stuck in a loop, they can stop it in Codenine; their budget stops it otherwise.",
          })),
        ]);
      }
    }).pipe(dieOnDatabaseError, Effect.withSpan("BudgetAlerts.checkSpikes")),
  });
});

export const layer = Layer.effect(BudgetAlerts, make);

/** Looks for spikes every hour while the control server runs. */
export const layerHourlySpikeCheck = Layer.effectDiscard(
  Effect.gen(function* () {
    const alerts = yield* BudgetAlerts;
    yield* alerts.checkSpikes.pipe(
      Effect.catchCause((cause) => Effect.logError("The AI spend spike check failed.", cause)),
      Effect.repeat(Schedule.spaced(Duration.hours(1))),
      Effect.forkScoped,
    );
  }),
);
