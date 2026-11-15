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
  }
>()("@codenine/control/gateway/Gateway") {}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// What only concerns the hop to the gateway, the workspace's own token, and the
// encoding: the gateway asks for plain bodies so it can read the usage in them.
const REQUEST_HEADERS_DROPPED = new Set([
  "accept-encoding",
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

/** Statuses and error types that Anthropic's clients do not retry, so a refusal is final. */
const refusal = (status: 401 | 403 | 404, type: string, message: string): GatewayReply => ({
  status,
  headers: { "content-type": "application/json" },
  body: encoder.encode(JSON.stringify({ type: "error", error: { type, message } })),
});

const NOT_RECOGNISED = refusal(
  401,
  "authentication_error",
  "Codenine's AI gateway did not accept this workspace's token. Restarting the workspace gets a new one; if that does not help, ask an admin.",
);
const NO_ACCOUNT = refusal(
  403,
  "permission_error",
  "Your company has not set up an AI account for Claude in Codenine yet. Ask an admin to add one.",
);
const NO_LICENCE = refusal(
  403,
  "permission_error",
  "Codenine's licence does not allow work right now, so agents cannot call AI. Ask an admin.",
);
const NOT_PASSED_ON = refusal(
  404,
  "not_found_error",
  "Codenine's AI gateway does not pass this request on.",
);
const UNREACHABLE: GatewayReply = {
  status: 502,
  headers: { "content-type": "application/json" },
  body: encoder.encode(
    JSON.stringify({
      type: "error",
      error: { type: "api_error", message: "Codenine's AI gateway could not reach the provider." },
    }),
  ),
};

/** The workspace's token, sent as an API key or a bearer token. */
const tokenOf = (headers: Headers.Headers) => {
  const apiKey = headers["x-api-key"]?.trim();
  if (apiKey !== undefined && apiKey !== "") return apiKey;
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

/** Free calls passed on unmetered: counting tokens and listing models. */
const isFreeClaudeCall = (method: string, path: string) =>
  (method === "POST" && path === "/v1/messages/count_tokens") ||
  (method === "GET" && /^\/v1\/models(?:\/[\w.@:-]+)?$/u.test(path));

const authHeaders = (upstream: AiUpstream): Record<string, string> =>
  upstream.account.kind === "anthropic"
    ? { "x-api-key": upstream.key }
    : { authorization: `Bearer ${upstream.key}` };

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

  const costOf = (meter: ClaudeMeter, upstream: AiUpstream) => {
    let micros = 0;
    let priced = true;
    for (const attempt of meter.attempts) {
      const cost = claudeCostMicros(attempt.model, attempt.tokens);
      if (cost === null) priced = false;
      else micros += cost;
    }
    return {
      micros: Math.round((micros * (100 + upstream.account.priceAdjustment)) / 100),
      priced,
    };
  };

  const record = Effect.fn("Gateway.record")(function* (input: {
    readonly who: WorkspaceKey;
    readonly upstream: AiUpstream;
    readonly meter: ClaudeMeter;
    readonly outcome: "ok" | "failed" | "cancelled";
    readonly status: number;
    readonly startedAt: number;
    readonly headers: Headers.Headers;
    readonly requestId: string | null;
  }) {
    const sum = (pick: (attempt: ClaudeMeter["attempts"][number]) => number) =>
      input.meter.attempts.reduce((total, attempt) => total + pick(attempt), 0);
    const cost = costOf(input.meter, input.upstream);
    yield* usage.record({
      at: DateTime.formatIso(yield* DateTime.now),
      personId: input.who.personId,
      departmentId: input.who.departmentId,
      accountId: input.upstream.account.id,
      provider: "claude",
      model: input.meter.model.slice(0, 255),
      inputTokens: sum(({ tokens }) => tokens.inputTokens),
      cacheWriteTokens: sum(({ tokens }) => tokens.cacheWrite5mTokens + tokens.cacheWrite1hTokens),
      cacheReadTokens: sum(({ tokens }) => tokens.cacheReadTokens),
      outputTokens: sum(({ tokens }) => tokens.outputTokens),
      webSearches: sum(({ tokens }) => tokens.webSearches),
      costMicros: cost.micros,
      priced: cost.priced,
      priceVersion: CLAUDE_PRICES_VERSION,
      outcome: input.outcome,
      status: input.status,
      durationMs: Math.max(0, (yield* Clock.currentTimeMillis) - input.startedAt),
      sessionId: input.headers["x-claude-code-session-id"]?.slice(0, 128) ?? null,
      requestId: input.requestId?.slice(0, 128) ?? null,
    });
  });

  const claude = Effect.fn("Gateway.claude")(function* (call: GatewayCall) {
    const startedAt = yield* Clock.currentTimeMillis;
    const token = tokenOf(call.headers);
    const who = token === null ? Option.none<WorkspaceKey>() : yield* Cache.get(identities, token);
    if (Option.isNone(who)) return NOT_RECOGNISED;
    if (!(yield* allowsWork)) return NO_LICENCE;
    const metered = call.method === "POST" && call.path === "/v1/messages";
    if (!metered && !isFreeClaudeCall(call.method, call.path)) return NOT_PASSED_ON;
    const upstream = yield* aiAccounts.claude;
    if (upstream === null) return NO_ACCOUNT;

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
    if (Option.isNone(response)) return UNREACHABLE;
    const { status } = response.value;
    const headers = keep(response.value.headers, RESPONSE_HEADERS_DROPPED);
    if (!metered) {
      return { status, headers, body: response.value.stream } satisfies GatewayReply;
    }

    const asked = askedModel(call.body);
    const requestId = response.value.headers["request-id"] ?? null;
    const settle = (meter: ClaudeMeter, outcome: "ok" | "failed" | "cancelled") =>
      FiberSet.run(
        writes,
        record({
          who: who.value,
          upstream,
          meter,
          outcome: outcome === "ok" && meter.failed ? "failed" : outcome,
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
      if (Option.isNone(body)) {
        yield* settle({ model: asked, attempts: [], failed: true }, "failed");
        return UNREACHABLE;
      }
      const meter =
        status >= 400
          ? { model: asked, attempts: [], failed: true }
          : meterClaudeJson(body.value, asked);
      yield* settle(meter, status >= 400 ? "failed" : "ok");
      return { status, headers, body: body.value } satisfies GatewayReply;
    }

    const meter = makeClaudeStreamMeter(asked);
    const body = response.value.stream.pipe(
      Stream.tap((chunk) => Effect.sync(() => meter.push(chunk))),
      Stream.onExit((exit) =>
        settle(
          meter.result(),
          Exit.isSuccess(exit) ? "ok" : Exit.hasInterrupts(exit) ? "cancelled" : "failed",
        ),
      ),
    );
    return { status, headers, body } satisfies GatewayReply;
  });

  return Gateway.of({ claude });
});

export const layer = Layer.effect(Gateway, make);
