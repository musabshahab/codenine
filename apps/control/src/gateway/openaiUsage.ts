import type { OpenAiTokens } from "./openaiPricing.ts";

/** What a Codex reply used, as far as it got. */
export interface OpenAiMeter {
  /** The model that answered, or the one asked for until the reply names it. */
  readonly model: string;
  /** Null until the reply reports usage. */
  readonly tokens: OpenAiTokens | null;
  /** Whether the reply said it failed. */
  readonly failed: boolean;
  /** Whether the response got to its end, so a client closing the stream then lost nothing. */
  readonly ended: boolean;
}

type Json = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/** The usage in a Responses API response object, which a final stream event carries whole. */
const meterOf = (response: Json, asked: string, failed: boolean): OpenAiMeter => {
  const model = typeof response["model"] === "string" ? response["model"] : asked;
  const usage = isRecord(response["usage"]) ? response["usage"] : null;
  if (usage === null) return { model, tokens: null, failed, ended: true };
  const inputDetails = isRecord(usage["input_tokens_details"])
    ? usage["input_tokens_details"]
    : null;
  const output = Array.isArray(response["output"]) ? response["output"] : [];
  return {
    model,
    tokens: {
      inputTokens: count(usage["input_tokens"]),
      cachedInputTokens: inputDetails === null ? 0 : count(inputDetails["cached_tokens"]),
      outputTokens: count(usage["output_tokens"]),
      webSearches: output.filter((item) => isRecord(item) && item["type"] === "web_search_call")
        .length,
      serviceTier: typeof response["service_tier"] === "string" ? response["service_tier"] : null,
    },
    failed,
    ended: true,
  };
};

/** The usage in a whole JSON reply from `/v1/responses`. */
export const meterOpenAiJson = (body: Uint8Array, asked: string): OpenAiMeter => {
  let reply: unknown;
  try {
    reply = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return { model: asked, tokens: null, failed: true, ended: true };
  }
  if (!isRecord(reply)) return { model: asked, tokens: null, failed: true, ended: true };
  return meterOf(reply, asked, reply["status"] === "failed" || isRecord(reply["error"]));
};

const ENDINGS = new Set(["response.completed", "response.incomplete", "response.failed", "error"]);
const EVENT_PREFIX = "event:";
const DATA_PREFIX = "data:";
/** How far into a data line its type is looked for when no event line named it. */
const TYPE_WINDOW = 80;

/**
 * Reads usage from a `/v1/responses` stream as it passes. Only the events
 * that end a response are parsed; they carry the whole response with its
 * usage, so the deltas before them are skipped unread.
 */
export const makeOpenAiStreamMeter = (asked: string) => {
  const decoder = new TextDecoder();
  let pending = "";
  let event = "";
  let result: OpenAiMeter = { model: asked, tokens: null, failed: false, ended: false };

  const take = (payload: string) => {
    let data: unknown;
    try {
      data = JSON.parse(payload);
    } catch {
      return;
    }
    if (!isRecord(data)) return;
    if (data["type"] === "error") {
      result = { ...result, failed: true, ended: true };
      return;
    }
    if (isRecord(data["response"])) {
      result = meterOf(data["response"], asked, data["type"] === "response.failed");
    }
  };

  const line = (text: string) => {
    if (text.startsWith(EVENT_PREFIX)) {
      event = text.slice(EVENT_PREFIX.length).trim();
      return;
    }
    if (text === "") {
      event = "";
      return;
    }
    if (!text.startsWith(DATA_PREFIX)) return;
    const payload = text.slice(DATA_PREFIX.length).trim();
    const head = payload.slice(0, TYPE_WINDOW);
    const wanted =
      ENDINGS.has(event) ||
      (event === "" &&
        /"type"\s*:\s*"(?:response\.completed|response\.incomplete|response\.failed|error)"/u.test(
          head,
        ));
    if (wanted) take(payload);
  };

  return {
    push: (chunk: Uint8Array) => {
      pending += decoder.decode(chunk, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        line(pending.slice(0, newline).replace(/\r$/u, ""));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    },
    result: (): OpenAiMeter => result,
  };
};
