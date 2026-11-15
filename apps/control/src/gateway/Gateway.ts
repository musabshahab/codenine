import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
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
import type { WorkspaceKey } from "../workspaces/WorkspaceManager.ts";
import { WorkspaceTokens } from "../workspaces/WorkspaceTokens.ts";
import { AiAccounts, type AiUpstream } from "./AiAccounts.ts";
import { AiUsage } from "./AiUsage.ts";
import { CLAUDE_PRICES_VERSION, claudeCostMicros } from "./claudePricing.ts";
import { type ClaudeMeter, makeClaudeStreamMeter, meterClaudeJson } from "./claudeUsage.ts";
import { OPENAI_PRICES_VERSION, openAiCostMicros } from "./openaiPricing.ts";
import { type OpenAiMeter, makeOpenAiStreamMeter, meterOpenAiJson } from "./openaiUsage.ts";

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
     * and records what it used. Refusals come back in Anthropic's error shape.
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

const json = (status: number, body: unknown): GatewayReply => ({
  status,
  headers: { "content-type": "application/json" },
  body: encoder.encode(JSON.stringify(body)),
});

/** The gateway's own answers, in each provider's error shape. */
interface Refusals {
  readonly notRecognised: GatewayReply;
  readonly noAccount: GatewayReply;
  readonly noLicence: GatewayReply;
  readonly notPassedOn: GatewayReply;
  readonly unreachable: GatewayReply;
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

// Statuses the providers' clients do not retry, so a refusal is final; 502 is meant to be retried.
const anthropicError = (status: number, type: string, message: string) =>
  json(status, { type: "error", error: { type, message } });
const CLAUDE_REFUSALS: Refusals = {
  notRecognised: anthropicError(401, "authentication_error", MESSAGES.notRecognised),
  noAccount: anthropicError(403, "permission_error", MESSAGES.noAccount("Claude")),
  noLicence: anthropicError(403, "permission_error", MESSAGES.noLicence),
  notPassedOn: anthropicError(404, "not_found_error", MESSAGES.notPassedOn),
  unreachable: anthropicError(502, "api_error", MESSAGES.unreachable),
};

const openAiError = (status: number, code: string, message: string) =>
  json(status, {
    error: { message, type: status >= 500 ? "server_error" : "invalid_request_error", code },
  });
const CODEX_REFUSALS: Refusals = {
  notRecognised: openAiError(401, "invalid_api_key", MESSAGES.notRecognised),
  noAccount: openAiError(403, "no_company_account", MESSAGES.noAccount("Codex")),
  noLicence: openAiError(403, "licence", MESSAGES.noLicence),
  notPassedOn: openAiError(404, "not_found", MESSAGES.notPassedOn),
  unreachable: openAiError(502, "upstream_unreachable", MESSAGES.unreachable),
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

/** How one agent's API passes through the gateway. */
interface Provider {
  readonly agent: "claude" | "codex";
  readonly meteredPaths: ReadonlySet<string>;
  /** Free calls passed on unmetered, such as counting tokens and listing models. */
  readonly isFree: (method: string, path: string) => boolean;
  readonly priceVersion: string;
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
  meteredPaths: new Set(["/v1/messages"]),
  isFree: (method, path) =>
    (method === "POST" && path === "/v1/messages/count_tokens") ||
    (method === "GET" && LIST_MODELS.test(path)),
  priceVersion: CLAUDE_PRICES_VERSION,
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
  meteredPaths: new Set(["/v1/responses", "/v1/responses/compact"]),
  isFree: (method, path) => method === "GET" && LIST_MODELS.test(path),
  priceVersion: OPENAI_PRICES_VERSION,
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

/** The model a request asks for, which prices it until the reply names one. */
const askedModel = (body: Uint8Array | null) => {
  if (body === null) return "unknown";
  try {
    const parsed: unknown = JSON.parse(decoder.decode(body));
    return typeof parsed === "object" &&
      parsed !== null &&
      "model" in parsed &&
      typeof parsed.model === "string"
      ? parsed.model
      : "unknown";
  } catch {
    return "unknown";
  }
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

export const make = Effect.gen(function* () {
  const tokens = yield* WorkspaceTokens;
  const accounts = yield* Accounts;
  const departments = yield* Departments;
  const aiAccounts = yield* AiAccounts;
  const usage = yield* AiUsage;
  const client = yield* HttpClient.HttpClient;
  const licence = yield* LicenceService;
  // As for the workspaces themselves: licence standing changes daily at most.
  const allowsWork = yield* Effect.cachedWithTTL(
    licence.overview.pipe(Effect.map(({ licence: applied }) => workspaceAccess(applied).canWork)),
    Duration.minutes(1),
  );
  // Usage is written after a reply ends, without holding the reply up.
  const writes = yield* FiberSet.make();

  /** Whose workspace a token is from, while that person may still work there. */
  const identify = Effect.fn("Gateway.identify")(function* (token: string) {
    const key = yield* tokens.verifyGatewayToken(token);
    if (Option.isNone(key)) return Option.none<WorkspaceKey>();
    const person = yield* accounts.findPerson(key.value.personId).pipe(Effect.option);
    if (Option.isNone(person) || person.value.status !== "active") {
      return Option.none<WorkspaceKey>();
    }
    const memberOf = yield* departments.ofPerson(key.value.personId);
    const stillThere =
      key.value.departmentId === null
        ? memberOf.length === 0
        : memberOf.includes(key.value.departmentId);
    return stillThere ? key : Option.none<WorkspaceKey>();
  });
  // Checked on every call, so a short wait is all a removal takes to apply.
  const identities = yield* Cache.make({
    lookup: identify,
    capacity: 10_000,
    timeToLive: "30 seconds",
  });

  const record = Effect.fn("Gateway.record")(function* (input: {
    readonly provider: Provider;
    readonly who: WorkspaceKey;
    readonly upstream: AiUpstream;
    readonly metered: Metered;
    readonly outcome: "ok" | "failed" | "cancelled";
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
      accountId: input.upstream.account.id,
      provider: input.provider.agent,
      model: metered.model.slice(0, 255),
      inputTokens: metered.inputTokens,
      cacheWriteTokens: metered.cacheWriteTokens,
      cacheReadTokens: metered.cacheReadTokens,
      outputTokens: metered.outputTokens,
      webSearches: metered.webSearches,
      costMicros: Math.round(
        (metered.costMicros * (100 + input.upstream.account.priceAdjustment)) / 100,
      ),
      priced: metered.priced,
      priceVersion: input.provider.priceVersion,
      outcome: input.outcome === "ok" && metered.failed ? "failed" : input.outcome,
      status: input.status,
      durationMs: Math.max(0, (yield* Clock.currentTimeMillis) - input.startedAt),
      sessionId: input.headers[input.provider.sessionHeader]?.slice(0, 128) ?? null,
      requestId: input.requestId?.slice(0, 128) ?? null,
    });
  });

  const forward = (provider: Provider) =>
    Effect.fn(`Gateway.${provider.agent}`)(function* (call: GatewayCall) {
      const { refusals } = provider;
      const startedAt = yield* Clock.currentTimeMillis;
      const token = tokenOf(call.headers);
      const who =
        token === null ? Option.none<WorkspaceKey>() : yield* Cache.get(identities, token);
      if (Option.isNone(who)) return refusals.notRecognised;
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
      const response = yield* client.execute(request).pipe(Effect.option);
      if (Option.isNone(response)) return refusals.unreachable;
      const { status } = response.value;
      const headers = keep(response.value.headers, RESPONSE_HEADERS_DROPPED);
      if (!metered) {
        return { status, headers, body: response.value.stream } satisfies GatewayReply;
      }

      const asked = askedModel(call.body);
      const requestId = response.value.headers[provider.requestIdHeader] ?? null;
      const settle = (measured: Metered, outcome: "ok" | "failed" | "cancelled") =>
        FiberSet.run(
          writes,
          record({
            provider,
            who: who.value,
            upstream,
            metered: measured,
            outcome,
            status,
            startedAt,
            headers: call.headers,
            requestId,
          }),
        );

      const streamed = response.value.headers["content-type"]?.startsWith("text/event-stream");
      if (status >= 400 || streamed !== true) {
        const body = yield* response.value.arrayBuffer.pipe(
          Effect.map((buffer) => new Uint8Array(buffer)),
          Effect.option,
        );
        // A failed reply bills nothing; its body is passed on as it came.
        const nothing = provider.json(new Uint8Array(), asked);
        if (Option.isNone(body)) {
          yield* settle(nothing, "failed");
          return refusals.unreachable;
        }
        yield* settle(
          status >= 400 ? nothing : provider.json(body.value, asked),
          status >= 400 ? "failed" : "ok",
        );
        return { status, headers, body: body.value } satisfies GatewayReply;
      }

      const meter = provider.stream(asked);
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
    });

  return Gateway.of({ claude: forward(CLAUDE), codex: forward(CODEX) });
});

export const layer = Layer.effect(Gateway, make);
