import type { ClaudeTokens } from "./claudePricing.ts";

/** One attempt's tokens and the model that ran it. */
export interface ClaudeAttempt {
  readonly model: string;
  readonly tokens: ClaudeTokens;
}

/** What a reply used, as far as it got. */
export interface ClaudeMeter {
  /** The model that answered, or the one asked for until the reply names it. */
  readonly model: string;
  readonly attempts: ReadonlyArray<ClaudeAttempt>;
  /** Whether the reply said it failed, such as a stream that ended in an error event. */
  readonly failed: boolean;
  /** Whether the stream got to its end, so a client closing it then lost nothing. */
  readonly ended: boolean;
}

type Json = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

const tokensOf = (usage: Json): ClaudeTokens => {
  const breakdown = isRecord(usage["cache_creation"]) ? usage["cache_creation"] : null;
  const written = count(usage["cache_creation_input_tokens"]);
  const oneHour = breakdown === null ? 0 : count(breakdown["ephemeral_1h_input_tokens"]);
  const tools = isRecord(usage["server_tool_use"]) ? usage["server_tool_use"] : null;
  return {
    inputTokens: count(usage["input_tokens"]),
    // Without the breakdown, every write counts as the cheaper five-minute kind.
    cacheWrite5mTokens:
      breakdown === null ? written : count(breakdown["ephemeral_5m_input_tokens"]),
    cacheWrite1hTokens: oneHour,
    cacheReadTokens: count(usage["cache_read_input_tokens"]),
    outputTokens: count(usage["output_tokens"]),
    webSearches: tools === null ? 0 : count(tools["web_search_requests"]),
    fast: usage["speed"] === "fast",
    usOnly: usage["inference_geo"] === "us",
  };
};

/**
 * The attempts a usage object bills. With `iterations`, each attempt is listed
 * there, including compaction and a fallback model's, and the top level covers
 * only the attempt that produced the reply.
 */
const attemptsOf = (usage: Json, asked: string, answered: string): Array<ClaudeAttempt> => {
  const iterations = Array.isArray(usage["iterations"]) ? usage["iterations"].filter(isRecord) : [];
  if (iterations.length === 0) {
    return [{ model: answered, tokens: tokensOf(usage) }];
  }
  const shared = { fast: usage["speed"] === "fast", usOnly: usage["inference_geo"] === "us" };
  return iterations.map((iteration) => {
    const named = typeof iteration["model"] === "string" ? iteration["model"] : null;
    const model = named ?? (iteration["type"] === "fallback_message" ? answered : asked);
    const tokens = tokensOf(iteration);
    return {
      model,
      tokens: {
        ...tokens,
        fast: tokens.fast || (iteration["speed"] === undefined && shared.fast),
        usOnly: tokens.usOnly || (iteration["inference_geo"] === undefined && shared.usOnly),
      },
    };
  });
};

/** The usage in a whole JSON reply from `/v1/messages`. */
export const meterClaudeJson = (body: Uint8Array, asked: string): ClaudeMeter => {
  let reply: unknown;
  try {
    reply = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return { model: asked, attempts: [], failed: true, ended: true };
  }
  if (!isRecord(reply) || !isRecord(reply["usage"])) {
    return {
      model: asked,
      attempts: [],
      failed: isRecord(reply) && reply["type"] === "error",
      ended: true,
    };
  }
  const answered = typeof reply["model"] === "string" ? reply["model"] : asked;
  return {
    model: answered,
    attempts: attemptsOf(reply["usage"], asked, answered),
    failed: false,
    ended: true,
  };
};

const EVENT_PREFIX = "event:";
const DATA_PREFIX = "data:";
/** How far into a data line its type is looked for when no event line named it. */
const TYPE_WINDOW = 80;

/**
 * Reads usage from a `/v1/messages` stream as it passes, chunk by chunk. Only
 * `message_start`, `message_delta` and `error` events are parsed; their usage
 * counts are running totals, so later values replace earlier ones.
 */
export const makeClaudeStreamMeter = (asked: string) => {
  const decoder = new TextDecoder();
  let pending = "";
  let event = "";
  let answered = asked;
  let usage: Record<string, unknown> = {};
  let seen = false;
  let failed = false;
  let ended = false;

  const take = (payload: string) => {
    let data: unknown;
    try {
      data = JSON.parse(payload);
    } catch {
      return;
    }
    if (!isRecord(data)) return;
    if (data["type"] === "error") {
      failed = true;
      return;
    }
    const message = isRecord(data["message"]) ? data["message"] : null;
    if (message !== null && typeof message["model"] === "string") {
      answered = message["model"];
    }
    const update = isRecord(data["usage"])
      ? data["usage"]
      : message !== null && isRecord(message["usage"])
        ? message["usage"]
        : null;
    if (update === null) return;
    seen = true;
    usage = { ...usage, ...update };
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
    if (event === "message_stop" || (event === "" && /"type"\s*:\s*"message_stop"/u.test(head))) {
      ended = true;
      return;
    }
    const wanted =
      event === "message_start" ||
      event === "message_delta" ||
      event === "error" ||
      (event === "" && /"type"\s*:\s*"(?:message_start|message_delta|error)"/u.test(head));
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
    result: (): ClaudeMeter => ({
      model: answered,
      attempts: seen ? attemptsOf(usage, asked, answered) : [],
      failed,
      ended: ended || failed,
    }),
  };
};
