import type {
  ControlAuditAction,
  ControlAuditActorKind,
  ControlAuditEntry,
  ControlAuditPage,
  ControlAuditTargetKind,
  ControlAuditValues,
} from "@codenine/contracts/control";
import { desc, lt } from "drizzle-orm";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ControlDb } from "../db.ts";
import { controlAuditEvents } from "../persistence/schema.ts";

const PAGE_SIZE = 50;

/** Where a request came from. Changes made on the server itself have neither. */
export interface RequestSource {
  readonly address: string | null;
  readonly userAgent: string | null;
}

export const ON_THE_SERVER: RequestSource = { address: null, userAgent: null };

export interface AuditActor {
  readonly kind: ControlAuditActorKind;
  readonly id: string | null;
  readonly label: string;
}

/** Codenine acting on its own, such as deleting files once their retention ends. */
export const CODENINE: AuditActor = { kind: "system", id: null, label: "Codenine" };

export interface AuditRecord {
  readonly actor: AuditActor;
  readonly source: RequestSource;
  readonly action: ControlAuditAction;
  readonly target: {
    readonly kind: ControlAuditTargetKind;
    readonly id: string;
    readonly label: string;
  } | null;
  readonly before: ControlAuditValues | null;
  readonly after: ControlAuditValues | null;
}

export class AuditLog extends Context.Service<
  AuditLog,
  {
    readonly record: (entry: AuditRecord) => Effect.Effect<void>;
    /** Newest first, a page at a time; `before` is the `next` of the page before. */
    readonly list: (before: number | null) => Effect.Effect<ControlAuditPage>;
  }
>()("@codenine/control/audit/AuditLog") {}

const toEntry = (row: typeof controlAuditEvents.$inferSelect): ControlAuditEntry => ({
  id: row.id,
  at: row.at,
  actor: { kind: row.actorKind, id: row.actorId, label: row.actorLabel },
  action: row.action,
  target:
    row.targetKind === null || row.targetId === null
      ? null
      : { kind: row.targetKind, id: row.targetId, label: row.targetLabel ?? row.targetId },
  source: { address: row.address, userAgent: row.userAgent },
  before: row.before,
  after: row.after,
});

export const make = Effect.gen(function* () {
  const db = yield* ControlDb;

  const record = Effect.fn("AuditLog.record")(function* (entry: AuditRecord) {
    yield* db.insert(controlAuditEvents).values({
      at: DateTime.formatIso(yield* DateTime.now),
      actorKind: entry.actor.kind,
      actorId: entry.actor.id,
      actorLabel: entry.actor.label.slice(0, 512),
      action: entry.action,
      targetKind: entry.target?.kind ?? null,
      targetId: entry.target?.id ?? null,
      targetLabel: entry.target?.label.slice(0, 512) ?? null,
      address: entry.source.address?.slice(0, 64) ?? null,
      userAgent: entry.source.userAgent?.slice(0, 512) ?? null,
      before: entry.before,
      after: entry.after,
    });
  }, Effect.orDie);

  const list = Effect.fn("AuditLog.list")(function* (before: number | null) {
    const rows = yield* db
      .select()
      .from(controlAuditEvents)
      .where(before === null ? undefined : lt(controlAuditEvents.id, before))
      .orderBy(desc(controlAuditEvents.id))
      .limit(PAGE_SIZE + 1);
    const entries = rows.slice(0, PAGE_SIZE).map(toEntry);
    const oldest = entries.at(-1);
    return { entries, next: rows.length > PAGE_SIZE && oldest ? oldest.id : null };
  }, Effect.orDie);

  return AuditLog.of({ record, list });
});

export const layer = Layer.effect(AuditLog, make);
