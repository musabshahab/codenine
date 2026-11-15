import {
  type ControlAiAccount,
  type ControlAiAccountKind,
  ControlAiError,
  type ControlAiAccountSettings,
  aiAccountServes,
} from "@codenine/contracts/control";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { Hex } from "effect/encoding";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { SecretBox } from "../accounts/SecretBox.ts";
import { ControlDb } from "../db.ts";
import { controlAiAccounts } from "../persistence/schema.ts";

/** The providers' own APIs, for an account that names no other address. */
const DEFAULT_URLS: Partial<Record<ControlAiAccountKind, string>> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
};

const KINDS_SERVING = {
  claude: ["anthropic", "anthropic-compatible"],
  codex: ["openai", "azure-openai", "openai-compatible"],
} as const satisfies Record<"claude" | "codex", ReadonlyArray<ControlAiAccountKind>>;

/** An account the gateway can call now: where, and with which key. */
export interface AiUpstream {
  readonly account: ControlAiAccount;
  readonly baseUrl: string;
  readonly key: string;
}

export class AiAccounts extends Context.Service<
  AiAccounts,
  {
    readonly list: Effect.Effect<ReadonlyArray<ControlAiAccount>>;
    readonly create: (
      settings: ControlAiAccountSettings,
    ) => Effect.Effect<ControlAiAccount, ControlAiError>;
    readonly update: (
      id: string,
      settings: ControlAiAccountSettings,
    ) => Effect.Effect<ControlAiAccount, ControlAiError>;
    readonly remove: (id: string) => Effect.Effect<ControlAiAccount, ControlAiError>;
    /** Where an agent's calls go: its default account, else its oldest; null with none. */
    readonly upstreamFor: (agent: "claude" | "codex") => Effect.Effect<AiUpstream | null>;
  }
>()("@codenine/control/gateway/AiAccounts") {}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const keyContext = (id: string) => `ai-account:${id}`;

const dieOnDatabaseError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.catchTags({ EffectDrizzleQueryError: Effect.die, SqlError: Effect.die }));

/** An http or https address with nothing after its path, without a trailing slash. */
const cleanBaseUrl = (raw: string) => {
  const url = URL.parse(raw);
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) return null;
  if (url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") {
    return null;
  }
  return url.href.replace(/\/+$/u, "");
};

export const make = Effect.gen(function* () {
  const db = yield* ControlDb;
  const box = yield* SecretBox;
  const random = yield* SecureRandom.SecureRandom;
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  // Read on every call through the gateway, so kept until an account changes.
  const cached = yield* Ref.make(new Map<"claude" | "codex", AiUpstream | null>());

  const toAccount = (row: typeof controlAiAccounts.$inferSelect): ControlAiAccount => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    baseUrl: row.baseUrl,
    priceAdjustment: row.priceAdjustment,
    isDefault: row.isDefault,
    keyHint: row.keyHint,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

  const rows = db.select().from(controlAiAccounts).orderBy(asc(controlAiAccounts.createdAt));

  const prepare = Effect.fn("AiAccounts.prepare")(function* (settings: ControlAiAccountSettings) {
    if (DEFAULT_URLS[settings.kind] === undefined && settings.baseUrl === null) {
      return yield* new ControlAiError({ reason: "needs-address" });
    }
    const baseUrl = settings.baseUrl === null ? null : cleanBaseUrl(settings.baseUrl);
    if (settings.baseUrl !== null && baseUrl === null) {
      return yield* new ControlAiError({ reason: "bad-address" });
    }
    return {
      name: settings.name,
      kind: settings.kind,
      baseUrl,
      priceAdjustment: settings.priceAdjustment,
      isDefault: settings.isDefault,
      updatedAt: yield* nowIso,
    };
  });

  const sealKey = (id: string, key: string) =>
    box
      .seal(encoder.encode(key), keyContext(id))
      .pipe(Effect.map((sealed) => ({ apiKey: sealed, keyHint: key.slice(-4) })));

  /** A new default takes over from the other accounts serving the same agent. */
  const clearOtherDefaults = (id: string, kind: ControlAiAccountKind) =>
    db
      .update(controlAiAccounts)
      .set({ isDefault: false })
      .where(
        and(
          ne(controlAiAccounts.id, id),
          inArray(controlAiAccounts.kind, [...KINDS_SERVING[aiAccountServes(kind)]]),
        ),
      );

  const changed = Ref.set(cached, new Map());

  const notFound = () => new ControlAiError({ reason: "not-found" });

  const load = Effect.fn("AiAccounts.load")(function* (agent: "claude" | "codex") {
    const found = (yield* rows).filter((row) => aiAccountServes(row.kind) === agent);
    const row = found.find((candidate) => candidate.isDefault) ?? found[0];
    if (row === undefined) return null;
    const key = yield* box.open(row.apiKey, keyContext(row.id)).pipe(Effect.orDie);
    return {
      account: toAccount(row),
      baseUrl: row.baseUrl ?? DEFAULT_URLS[row.kind] ?? "",
      key: decoder.decode(key),
    } satisfies AiUpstream;
  }, dieOnDatabaseError);

  return AiAccounts.of({
    list: rows.pipe(
      Effect.map((found) => found.map(toAccount)),
      Effect.orDie,
      Effect.withSpan("AiAccounts.list"),
    ),
    create: Effect.fn("AiAccounts.create")(function* (settings: ControlAiAccountSettings) {
      const values = yield* prepare(settings);
      if (settings.apiKey === undefined) {
        return yield* new ControlAiError({ reason: "needs-key" });
      }
      const id = `aia_${Hex.encode(yield* random.randomBytes(8))}`;
      const key = yield* sealKey(id, settings.apiKey);
      const row = yield* db.transaction(() =>
        Effect.gen(function* () {
          if (values.isDefault) yield* clearOtherDefaults(id, values.kind);
          const [inserted] = yield* db
            .insert(controlAiAccounts)
            .values({ id, ...values, ...key, createdAt: values.updatedAt })
            .returning();
          return inserted;
        }),
      );
      if (row === undefined) {
        return yield* Effect.die("An inserted AI account did not come back.");
      }
      yield* changed;
      return toAccount(row);
    }, dieOnDatabaseError),
    update: Effect.fn("AiAccounts.update")(function* (
      id: string,
      settings: ControlAiAccountSettings,
    ) {
      const values = yield* prepare(settings);
      const key = settings.apiKey === undefined ? {} : yield* sealKey(id, settings.apiKey);
      const row = yield* db.transaction(() =>
        Effect.gen(function* () {
          if (values.isDefault) yield* clearOtherDefaults(id, values.kind);
          const [updated] = yield* db
            .update(controlAiAccounts)
            .set({ ...values, ...key })
            .where(eq(controlAiAccounts.id, id))
            .returning();
          return updated;
        }),
      );
      if (row === undefined) {
        return yield* notFound();
      }
      yield* changed;
      return toAccount(row);
    }, dieOnDatabaseError),
    remove: Effect.fn("AiAccounts.remove")(function* (id: string) {
      const [row] = yield* db
        .delete(controlAiAccounts)
        .where(eq(controlAiAccounts.id, id))
        .returning();
      if (row === undefined) {
        return yield* notFound();
      }
      yield* changed;
      return toAccount(row);
    }, dieOnDatabaseError),
    upstreamFor: Effect.fn("AiAccounts.upstreamFor")(function* (agent: "claude" | "codex") {
      const known = (yield* Ref.get(cached)).get(agent);
      if (known !== undefined) return known;
      const loaded = yield* load(agent);
      yield* Ref.update(cached, (current) => new Map(current).set(agent, loaded));
      return loaded;
    }),
  });
});

export const layer = Layer.effect(AiAccounts, make);
