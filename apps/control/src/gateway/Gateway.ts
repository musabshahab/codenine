import type { ControlAiRefusal, ControlEffectiveProfile } from "@codenine/contracts/control";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type * as Headers from "effect/http/Headers";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import { Accounts } from "../accounts/Accounts.ts";
import { Departments } from "../departments/Departments.ts";
import { LicenceService, workspaceAccess } from "../licence/LicenceService.ts";
import { Profiles } from "../profiles/Profiles.ts";
import type { WorkspaceKey } from "../workspaces/WorkspaceManager.ts";
import { WorkspaceTokens } from "../workspaces/WorkspaceTokens.ts";
import { AiAccounts, type AiUpstream } from "./AiAccounts.ts";
import { AiUsage } from "./AiUsage.ts";
import { type BudgetHold, type BudgetLevel, Budgets, limitsOf } from "./Budgets.ts";
import { CLAUDE_PRICES_VERSION, claudeCostMicros, claudeModelKey } from "./claudePricing.ts";
import { type ClaudeMeter, makeClaudeStreamMeter, meterClaudeJson } from "./claudeUsage.ts";
import { OPENAI_PRICES_VERSION, openAiCostMicros, openAiModelKey } from "./openaiPricing.ts";
import { type OpenAiMeter, makeOpenAiStreamMeter, meterOpenAiJson } from "./openaiUsage.ts";

/** How many AI calls one person may have running at once, so a team cannot take the company's rate limit. */
export const GatewayParallelCallsConfig = Config.Int(
  "CODENINE_CONTROL_GATEWAY_PARALLEL_CALLS",
).pipe(
  Config.withDefault(16),
  Config.map((calls) => Math.max(1, calls)),
);

/** A call a workspace made to the gateway, for one provider's API. */
export interface GatewayCall {
  readonly method: string;
  /** The path after the provider's prefix, such as `/v1/messages`. */
  readonly path: string;
  /** The query string with its `?`, or empty. */
  readonly search: string;
  readonly headers: Headers.Headers;
  readonly body: Uint8Array | null;
}

export interface GatewayReply {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array | Stream.Stream<Uint8Array, HttpClientError.HttpClientError>;
}

export class Gateway extends Context.Service<
  Gateway,
  {
    /**
     * Passes a workspace's call to Anthropic's API on with the company's key,
     * within the person's AI rules and budgets, and records what it used.
     * Refusals come back in Anthropic's error shape.
     */
    readonly claude: (call: GatewayCall) => Effect.Effect<GatewayReply>;
    /** The same for Codex and OpenAI's Responses API, refusing in OpenAI's error shape. */
    readonly codex: (call: GatewayCall) => Effect.Effect<GatewayReply>;
  }
>()("@codenine/control/gateway/Gateway") {}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// What only concerns the hop to the gateway, the workspace's own token, and the
// encoding: the gateway asks for plain bodies so it can read the usage in them.
const REQUEST_HEADERS_DROPPED = new Set([
  "accept-encoding",
  "api-key",
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "forwarded",
  "host",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
  "x-api-key",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
]);
const RESPONSE_HEADERS_DROPPED = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "set-cookie",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const keep = (headers: Headers.Headers, dropped: ReadonlySet<string>) =>
  Object.fromEntries(Object.entries(headers).filter(([name]) => !dropped.has(name.toLowerCase())));

const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): GatewayReply => ({
  status,
  headers: { "content-type": "application/json", ...headers },
  body: encoder.encode(JSON.stringify(body)),
});

/** The gateway's own answers, in each provider's error shape. */
interface Refusals {
  readonly notRecognised: GatewayReply;
  readonly noAccount: GatewayReply;
  readonly noLicence: GatewayReply;
  readonly notPassedOn: GatewayReply;
  readonly unreachable: GatewayReply;
  /** A budget is used up: final, and never a rate limit, so agents stop instead of retrying. */
  readonly budget: (message: string) => GatewayReply;
  /** A rule the person's profile sets, such as the models they may use. */
  readonly rule: (refusal: ControlAiRefusal, message: string) => GatewayReply;
  /** Too many calls at once: the one refusal agents should retry. */
  readonly busy: (message: string) => GatewayReply;
}

const MESSAGES = {
  notRecognised:
    "Codenine's AI gateway did not accept this workspace's token. Restarting the workspace gets a new one; if that does not help, ask an admin.",
  noAccount: (agent: string) =>
    `Your company has not set up an AI account for ${agent} in Codenine yet. Ask an admin to add one.`,
  noLicence:
    "Codenine's licence does not allow work right now, so agents cannot call AI. Ask an admin.",
  notPassedOn: "Codenine's AI gateway does not pass this request on.",
  unreachable: "Codenine's AI gateway could not reach the provider.",
};

const BUSY_RETRY_SECONDS = "2";

// Statuses the providers' clients do not retry, so a refusal is final; 429 and 502 are meant to be retried.
const anthropicError = (
  status: number,
  type: string,
  message: string,
  headers?: Record<string, string>,
) => json(status, { type: "error", error: { type, message } }, headers);
const CLAUDE_REFUSALS: Refusals = {
  notRecognised: anthropicError(401, "authentication_error", MESSAGES.notRecognised),
  noAccount: anthropicError(403, "permission_error", MESSAGES.noAccount("Claude")),
  noLicence: anthropicError(403, "permission_error", MESSAGES.noLicence),
  notPassedOn: anthropicError(404, "not_found_error", MESSAGES.notPassedOn),
  unreachable: anthropicError(502, "api_error", MESSAGES.unreachable),
  budget: (message) => anthropicError(402, "billing_error", message),
  rule: (_, message) => anthropicError(403, "permission_error", message),
  busy: (message) =>
    anthropicError(429, "rate_limit_error", message, { "retry-after": BUSY_RETRY_SECONDS }),
};

const openAiError = (
  status: number,
  code: string,
  message: string,
  type = status >= 500 ? "server_error" : "invalid_request_error",
  headers?: Record<string, string>,
) => json(status, { error: { message, type, code } }, headers);
const CODEX_REFUSALS: Refusals = {
  notRecognised: openAiError(401, "invalid_api_key", MESSAGES.notRecognised),
  noAccount: openAiError(403, "no_company_account", MESSAGES.noAccount("Codex")),
  noLicence: openAiError(403, "licence", MESSAGES.noLicence),
  notPassedOn: openAiError(404, "not_found", MESSAGES.notPassedOn),
  unreachable: openAiError(502, "upstream_unreachable", MESSAGES.unreachable),
  budget: (message) => openAiError(402, "budget_exceeded", message, "budget_exceeded"),
  rule: (refusal, message) => openAiError(403, `${refusal}_not_allowed`, message),
  busy: (message) =>
    openAiError(429, "rate_limit_exceeded", message, "requests", {
      "retry-after": BUSY_RETRY_SECONDS,
    }),
};

/** What a reply used and cost before the account's adjustment, whichever API it came from. */
interface Metered {
  readonly model: string;
  readonly failed: boolean;
  /** Whether the reply got to its end; a stream closed after that lost nothing. */
  readonly ended: boolean;
  /** Input not read from the cache. */
  readonly inputTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheReadTokens: number;
  readonly outputTokens: number;
  readonly webSearches: number;
  readonly costMicros: number;
  /** False when a model had no price, so its cost is missing. */
  readonly priced: boolean;
}

const claudeMetered = (meter: ClaudeMeter): Metered => {
  let costMicros = 0;
  let priced = true;
  for (const attempt of meter.attempts) {
    const cost = claudeCostMicros(attempt.model, attempt.tokens);
    if (cost === null) priced = false;
    else costMicros += cost;
  }
  const sum = (pick: (attempt: ClaudeMeter["attempts"][number]) => number) =>
    meter.attempts.reduce((total, attempt) => total + pick(attempt), 0);
  return {
    model: meter.model,
    failed: meter.failed,
    ended: meter.ended,
    inputTokens: sum(({ tokens }) => tokens.inputTokens),
    cacheWriteTokens: sum(({ tokens }) => tokens.cacheWrite5mTokens + tokens.cacheWrite1hTokens),
    cacheReadTokens: sum(({ tokens }) => tokens.cacheReadTokens),
    outputTokens: sum(({ tokens }) => tokens.outputTokens),
    webSearches: sum(({ tokens }) => tokens.webSearches),
    costMicros,
    priced,
  };
};

const openAiMetered = (meter: OpenAiMeter): Metered => {
  const tokens = meter.tokens;
  const cost = tokens === null ? 0 : openAiCostMicros(meter.model, tokens);
  const cached = tokens === null ? 0 : Math.min(tokens.cachedInputTokens, tokens.inputTokens);
  return {
    model: meter.model,
    failed: meter.failed,
    ended: meter.ended,
    inputTokens: tokens === null ? 0 : tokens.inputTokens - cached,
    cacheWriteTokens: 0,
    cacheReadTokens: cached,
    outputTokens: tokens?.outputTokens ?? 0,
    webSearches: tokens?.webSearches ?? 0,
    costMicros: cost ?? 0,
    priced: cost !== null,
  };
};

// A call's estimate assumes an agent's usual shape: most of the prompt read
// from the cache, and a reply of moderate length rather than the longest allowed.
const CACHED_SHARE = 0.9;
const REPLY_ALLOWANCE = 8_192;

/** How one agent's API passes through the gateway. */
interface Provider {
  readonly agent: "claude" | "codex";
  readonly label: string;
  readonly meteredPaths: ReadonlySet<string>;
  /** Free calls passed on unmetered, such as counting tokens and listing models. */
  readonly isFree: (method: string, path: string) => boolean;
  readonly priceVersion: string;
  /** The name the price table and the allowed models know a model by. */
  readonly modelKey: (model: string) => string;
  readonly allowedModels: (rules: ControlEffectiveProfile) => ReadonlyArray<string> | null;
  /** What a call probably costs before its reply; null for a model with no price. */
  readonly estimate: (model: string, promptTokens: number, replyTokens: number) => number | null;
  readonly json: (body: Uint8Array, asked: string) => Metered;
  readonly stream: (asked: string) => {
    readonly push: (chunk: Uint8Array) => void;
    readonly result: () => Metered;
  };
  /** The header that names the agent's session, to tell threads apart. */
  readonly sessionHeader: string;
  readonly requestIdHeader: string;
  readonly refusals: Refusals;
}

const LIST_MODELS = /^\/v1\/models(?:\/[\w.@:/-]+)?$/u;

const CLAUDE: Provider = {
  agent: "claude",
  label: "Claude",
  meteredPaths: new Set(["/v1/messages"]),
  isFree: (method, path) =>
    (method === "POST" && path === "/v1/messages/count_tokens") ||
    (method === "GET" && LIST_MODELS.test(path)),
  priceVersion: CLAUDE_PRICES_VERSION,
  modelKey: claudeModelKey,
  allowedModels: (rules) => rules.claudeModels,
  estimate: (model, promptTokens, replyTokens) => {
    const cached = Math.floor(promptTokens * CACHED_SHARE);
    return claudeCostMicros(model, {
      inputTokens: promptTokens - cached,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      cacheReadTokens: cached,
      outputTokens: replyTokens,
      webSearches: 0,
      fast: false,
      usOnly: false,
    });
  },
  json: (body, asked) => claudeMetered(meterClaudeJson(body, asked)),
  stream: (asked) => {
    const meter = makeClaudeStreamMeter(asked);
    return { push: meter.push, result: () => claudeMetered(meter.result()) };
  },
  sessionHeader: "x-claude-code-session-id",
  requestIdHeader: "request-id",
  refusals: CLAUDE_REFUSALS,
};

const CODEX: Provider = {
  agent: "codex",
  label: "Codex",
  meteredPaths: new Set(["/v1/responses", "/v1/responses/compact"]),
  isFree: (method, path) => method === "GET" && LIST_MODELS.test(path),
  priceVersion: OPENAI_PRICES_VERSION,
  modelKey: openAiModelKey,
  allowedModels: (rules) => rules.codexModels,
  estimate: (model, promptTokens, replyTokens) =>
    openAiCostMicros(model, {
      inputTokens: promptTokens,
      cachedInputTokens: Math.floor(promptTokens * CACHED_SHARE),
      outputTokens: replyTokens,
      webSearches: 0,
      serviceTier: null,
    }),
  json: (body, asked) => openAiMetered(meterOpenAiJson(body, asked)),
  stream: (asked) => {
    const meter = makeOpenAiStreamMeter(asked);
    return { push: meter.push, result: () => openAiMetered(meter.result()) };
  },
  sessionHeader: "session-id",
  requestIdHeader: "x-request-id",
  refusals: CODEX_REFUSALS,
};

/** The workspace's token, sent as an API key or a bearer token. */
const tokenOf = (headers: Headers.Headers) => {
  for (const name of ["x-api-key", "api-key"]) {
    const key = headers[name]?.trim();
    if (key !== undefined && key !== "") return key;
  }
  const bearer = /^Bearer\s+(\S+)$/iu.exec(headers["authorization"]?.trim() ?? "");
  return bearer?.[1] ?? null;
};

type Json = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const fieldOf = (value: unknown, key: string) => (isRecord(value) ? value[key] : undefined);

/** What the gateway reads from a call before passing it on. */
export interface AskedFor {
  /** The model asked for, which prices the call until the reply names one. */
  readonly model: string;
  /** Each effort the call names: Claude's for the call and its newest message, or Codex's. */
  readonly efforts: ReadonlyArray<string>;
  /** The longest reply the call allows. */
  readonly maxReply: number | null;
  /** About how many tokens the prompt is. */
  readonly promptTokens: number;
}

// Images and files travel as long base64 runs, which cost far fewer tokens than
// their length; each counts as about what a large image costs.
const BASE64_RUN = /[A-Za-z0-9+/]{4096,}={0,2}/gu;
const TOKENS_PER_ATTACHMENT = 1_600;
const CHARACTERS_PER_TOKEN = 4;

export const readCall = (body: Uint8Array | null): AskedFor => {
  const text = body === null ? "" : decoder.decode(body);
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON: the provider refuses it, and the gateway records what it can.
  }
  const model = fieldOf(parsed, "model");
  const messages = fieldOf(parsed, "messages");
  const newest = Array.isArray(messages) ? messages.at(-1) : undefined;
  const efforts = [
    fieldOf(fieldOf(parsed, "output_config"), "effort"),
    fieldOf(fieldOf(newest, "output_config"), "effort"),
    fieldOf(fieldOf(parsed, "reasoning"), "effort"),
  ].filter((effort) => typeof effort === "string");
  const maxReply = fieldOf(parsed, "max_tokens") ?? fieldOf(parsed, "max_output_tokens");
  let attachments = 0;
  const prose = text.replace(BASE64_RUN, () => {
    attachments += 1;
    return "";
  });
  return {
    model: typeof model === "string" ? model : "unknown",
    efforts,
    maxReply: typeof maxReply === "number" && maxReply > 0 ? Math.floor(maxReply) : null,
    promptTokens:
      Math.ceil(prose.length / CHARACTERS_PER_TOKEN) + attachments * TOKENS_PER_ATTACHMENT,
  };
};

const EFFORT_RANK: Readonly<Record<string, number>> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};

const dollars = (micros: number) =>
  (micros / 1_000_000).toLocaleString("en-US", { style: "currency", currency: "USD" });

const BUDGET_MESSAGES: Record<BudgetLevel, (limit: string) => string> = {
  "person-month": (limit) =>
    `You have used your AI budget for this month (${limit}). Ask your department admin if you need more.`,
  "person-day": (limit) =>
    `You have used your AI budget for today (${limit}). It starts again tomorrow; ask your department admin if you need more now.`,
  "department-month": (limit) =>
    `Your department has used its AI budget for this month (${limit}). Ask your department admin.`,
  "company-month": (limit) =>
    `Your company has used its AI budget for this month (${limit}). Ask an admin.`,
};

const authHeaders = (upstream: AiUpstream): Record<string, string> => {
  switch (upstream.account.kind) {
    case "anthropic":
      return { "x-api-key": upstream.key };
    case "azure-openai":
      return { "api-key": upstream.key };
    default:
      return { authorization: `Bearer ${upstream.key}` };
  }
};

/** Whose workspace a call came from, and the AI rules that bind them there. */
interface Caller {
  readonly key: WorkspaceKey;
  readonly rules: ControlEffectiveProfile;
}

/** A call let through: its place among the person's running calls and its hold on budgets. */
interface Admitted {
  readonly personId: string;
  readonly hold: BudgetHold | null;
  done: boolean;
}

export const make = Effect.gen(function* () {
  const tokens = yield* WorkspaceTokens;
  const accounts = yield* Accounts;
  const departments = yield* Departments;
  const profiles = yield* Profiles;
  const aiAccounts = yield* AiAccounts;
  const usage = yield* AiUsage;
  const budgets = yield* Budgets;
  const client = yield* HttpClient.HttpClient;
  const licence = yield* LicenceService;
  const parallelCalls = yield* GatewayParallelCallsConfig;
  // As for the workspaces themselves: licence standing changes daily at most.
  const allowsWork = yield* Effect.cachedWithTTL(
    licence.overview.pipe(Effect.map(({ licence: applied }) => workspaceAccess(applied).canWork)),
    Duration.minutes(1),
  );
  // Usage is written after a reply ends, without holding the reply up.
  const writes = yield* FiberSet.make();
  const running = new Map<string, number>();

  /** Whose workspace a token is from, while that person may still work there. */
  const identify = Effect.fn("Gateway.identify")(function* (token: string) {
    const key = yield* tokens.verifyGatewayToken(token);
    if (Option.isNone(key)) return Option.none<Caller>();
    const person = yield* accounts.findPerson(key.value.personId).pipe(Effect.option);
    if (Option.isNone(person) || person.value.status !== "active") {
      return Option.none<Caller>();
    }
    const memberOf = yield* departments.ofPerson(key.value.personId);
    const stillThere =
      key.value.departmentId === null
        ? memberOf.length === 0
        : memberOf.includes(key.value.departmentId);
    if (!stillThere) return Option.none<Caller>();
    const rules = yield* profiles.effective(key.value.personId, key.value.departmentId);
    return Option.some<Caller>({ key: key.value, rules });
  });
  // Checked on every call, so a short wait is all a removal or a new rule takes to apply.
  const callers = yield* Cache.make({
    lookup: identify,
    capacity: 10_000,
    timeToLive: "30 seconds",
  });

  const record = Effect.fn("Gateway.record")(function* (input: {
    readonly provider: Provider;
    readonly who: WorkspaceKey;
    readonly upstream: AiUpstream | null;
    readonly model: string;
    readonly metered: Metered | null;
    readonly costMicros: number;
    readonly outcome: "ok" | "failed" | "cancelled" | "refused";
    readonly refusal: ControlAiRefusal | null;
    readonly status: number;
    readonly startedAt: number;
    readonly headers: Headers.Headers;
    readonly requestId: string | null;
  }) {
    const { metered } = input;
    yield* usage.record({
      at: DateTime.formatIso(yield* DateTime.now),
      personId: input.who.personId,
      departmentId: input.who.departmentId,
      accountId: input.upstream?.account.id ?? null,
      provider: input.provider.agent,
      model: input.model.slice(0, 255),
      inputTokens: metered?.inputTokens ?? 0,
      cacheWriteTokens: metered?.cacheWriteTokens ?? 0,
      cacheReadTokens: metered?.cacheReadTokens ?? 0,
      outputTokens: metered?.outputTokens ?? 0,
      webSearches: metered?.webSearches ?? 0,
      costMicros: input.costMicros,
      priced: metered?.priced ?? true,
      priceVersion: input.provider.priceVersion,
      outcome: input.outcome === "ok" && metered?.failed === true ? "failed" : input.outcome,
      refusal: input.refusal,
      status: input.status,
      durationMs: Math.max(0, (yield* Clock.currentTimeMillis) - input.startedAt),
      sessionId: input.headers[input.provider.sessionHeader]?.slice(0, 128) ?? null,
      requestId: input.requestId?.slice(0, 128) ?? null,
    });
  });

  /** Ends an admitted call once: frees its place and settles its hold with what it cost. */
  const release = (admitted: Admitted, costMicros: number) =>
    Effect.suspend(() => {
      if (admitted.done) return Effect.void;
      admitted.done = true;
      const left = (running.get(admitted.personId) ?? 1) - 1;
      if (left > 0) running.set(admitted.personId, left);
      else running.delete(admitted.personId);
      return admitted.hold === null ? Effect.void : budgets.settle(admitted.hold, costMicros);
    });

  /** Lets a call through within the person's rules and budgets, or says why not. */
  const admit = Effect.fn("Gateway.admit")(function* (
    provider: Provider,
    caller: Caller,
    upstream: AiUpstream,
    asked: AskedFor,
  ) {
    const { rules } = caller;
    const refuse = (refusal: ControlAiRefusal, reply: GatewayReply) =>
      ({ _tag: "Refused", refusal, reply }) as const;
    const allowed = provider.allowedModels(rules);
    const key = provider.modelKey(asked.model);
    if (allowed !== null && !allowed.some((model) => provider.modelKey(model) === key)) {
      return refuse(
        "model",
        provider.refusals.rule(
          "model",
          `Your company does not allow ${asked.model} for ${provider.label}. Choose one of: ${allowed.join(", ")}.`,
        ),
      );
    }
    const ceiling = rules.effort;
    const highest = ceiling === null ? Infinity : (EFFORT_RANK[ceiling] ?? Infinity);
    // An effort the gateway does not know could be any height, so a ceiling refuses it.
    if (
      asked.efforts.some(
        (effort) => ceiling !== null && (EFFORT_RANK[effort] ?? Infinity) > highest,
      )
    ) {
      return refuse(
        "effort",
        provider.refusals.rule(
          "effort",
          `Your company allows effort up to ${ceiling}. Choose a lower effort and try again.`,
        ),
      );
    }
    const limits = limitsOf(rules);
    const budgeted = Object.values(limits).some((limit) => limit !== null);
    const estimate = provider.estimate(
      asked.model,
      asked.promptTokens,
      Math.min(asked.maxReply ?? REPLY_ALLOWANCE, REPLY_ALLOWANCE),
    );
    if (budgeted && estimate === null) {
      return refuse(
        "unpriced",
        provider.refusals.rule(
          "unpriced",
          `Codenine has no price for ${asked.model}, so it cannot run within your AI budget. Choose another model, or ask an admin to update Codenine.`,
        ),
      );
    }
    const personId = caller.key.personId;
    if ((running.get(personId) ?? 0) >= parallelCalls) {
      return {
        _tag: "Busy",
        reply: provider.refusals.busy(
          `You have ${parallelCalls} AI calls running at once, the most your company allows. This one is tried again shortly.`,
        ),
      } as const;
    }
    let hold: BudgetHold | null = null;
    if (budgeted) {
      const adjusted = Math.round(
        ((estimate ?? 0) * (100 + upstream.account.priceAdjustment)) / 100,
      );
      const held = yield* budgets.hold(caller.key, limits, adjusted);
      if (held._tag === "Full") {
        return refuse(
          held.level,
          provider.refusals.budget(BUDGET_MESSAGES[held.level](dollars(held.limit))),
        );
      }
      hold = held.hold;
    }
    running.set(personId, (running.get(personId) ?? 0) + 1);
    return {
      _tag: "Admitted",
      admitted: { personId, hold, done: false } satisfies Admitted,
    } as const;
  });

  const forward = (provider: Provider) =>
    Effect.fn(`Gateway.${provider.agent}`)(function* (call: GatewayCall) {
      const { refusals } = provider;
      const startedAt = yield* Clock.currentTimeMillis;
      const token = tokenOf(call.headers);
      const caller = token === null ? Option.none<Caller>() : yield* Cache.get(callers, token);
      if (Option.isNone(caller)) return refusals.notRecognised;
      if (!(yield* allowsWork)) return refusals.noLicence;
      const metered = call.method === "POST" && provider.meteredPaths.has(call.path);
      if (!metered && !provider.isFree(call.method, call.path)) return refusals.notPassedOn;
      const upstream = yield* aiAccounts.upstreamFor(provider.agent);
      if (upstream === null) return refusals.noAccount;

      const request = HttpClientRequest.make(call.method === "GET" ? "GET" : "POST")(
        `${upstream.baseUrl}${call.path}${call.search}`,
      ).pipe(
        HttpClientRequest.setHeaders({
          ...keep(call.headers, REQUEST_HEADERS_DROPPED),
          ...authHeaders(upstream),
          "accept-encoding": "identity",
        }),
        call.body === null
          ? (self) => self
          : HttpClientRequest.bodyUint8Array(
              call.body,
              call.headers["content-type"] ?? "application/json",
            ),
      );
      if (!metered) {
        const response = yield* client.execute(request).pipe(Effect.option);
        if (Option.isNone(response)) return refusals.unreachable;
        return {
          status: response.value.status,
          headers: keep(response.value.headers, RESPONSE_HEADERS_DROPPED),
          body: response.value.stream,
        } satisfies GatewayReply;
      }

      const who = caller.value.key;
      const asked = readCall(call.body);
      const decision = yield* admit(provider, caller.value, upstream, asked);
      if (decision._tag === "Busy") return decision.reply;
      if (decision._tag === "Refused") {
        yield* FiberSet.run(
          writes,
          record({
            provider,
            who,
            upstream,
            model: asked.model,
            metered: null,
            costMicros: 0,
            outcome: "refused",
            refusal: decision.refusal,
            status: decision.reply.status,
            startedAt,
            headers: call.headers,
            requestId: null,
          }),
        );
        return decision.reply;
      }
      const { admitted } = decision;

      return yield* Effect.gen(function* () {
        const response = yield* client.execute(request).pipe(Effect.option);
        if (Option.isNone(response)) {
          yield* release(admitted, 0);
          return refusals.unreachable;
        }
        const { status } = response.value;
        const headers = keep(response.value.headers, RESPONSE_HEADERS_DROPPED);
        const requestId = response.value.headers[provider.requestIdHeader] ?? null;
        const settle = (measured: Metered, outcome: "ok" | "failed" | "cancelled") => {
          const costMicros = Math.round(
            (measured.costMicros * (100 + upstream.account.priceAdjustment)) / 100,
          );
          return release(admitted, costMicros).pipe(
            Effect.andThen(
              FiberSet.run(
                writes,
                record({
                  provider,
                  who,
                  upstream,
                  model: measured.model,
                  metered: measured,
                  costMicros,
                  outcome,
                  refusal: null,
                  status,
                  startedAt,
                  headers: call.headers,
                  requestId,
                }),
              ),
            ),
          );
        };

        const streamed = response.value.headers["content-type"]?.startsWith("text/event-stream");
        if (status >= 400 || streamed !== true) {
          const body = yield* response.value.arrayBuffer.pipe(
            Effect.map((buffer) => new Uint8Array(buffer)),
            Effect.option,
          );
          // A failed reply bills nothing; its body is passed on as it came.
          const nothing = provider.json(new Uint8Array(), asked.model);
          if (Option.isNone(body)) {
            yield* settle(nothing, "failed");
            return refusals.unreachable;
          }
          yield* settle(
            status >= 400 ? nothing : provider.json(body.value, asked.model),
            status >= 400 ? "failed" : "ok",
          );
          return { status, headers, body: body.value } satisfies GatewayReply;
        }

        const meter = provider.stream(asked.model);
        const body = response.value.stream.pipe(
          Stream.tap((chunk) => Effect.sync(() => meter.push(chunk))),
          Stream.onExit((exit) => {
            const measured = meter.result();
            return settle(
              measured,
              Exit.isSuccess(exit) || measured.ended
                ? "ok"
                : Exit.hasInterrupts(exit)
                  ? "cancelled"
                  : "failed",
            );
          }),
        );
        return { status, headers, body } satisfies GatewayReply;
      }).pipe(
        // A stream settles when it ends; anything that stops the call before then frees its place.
        Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : release(admitted, 0))),
      );
    });

  return Gateway.of({ claude: forward(CLAUDE), codex: forward(CODEX) });
});

export const layer = Layer.effect(Gateway, make);
