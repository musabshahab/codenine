import { describe, expect, it } from "@effect/vitest";

import { makeClaudeStreamMeter, meterClaudeJson } from "./claudeUsage.ts";

const encoder = new TextEncoder();

/** A stream as Anthropic sends it, cut into pieces that split lines and a character. */
const stream = [
  "event: message_start",
  `data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-5-5","content":[],"usage":{"input_tokens":12,"cache_creation_input_tokens":300,"cache_read_input_tokens":4000,"cache_creation":{"ephemeral_5m_input_tokens":100,"ephemeral_1h_input_tokens":200},"output_tokens":1}}}`,
  "",
  "event: content_block_delta",
  `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Grüße"}}`,
  "",
  "event: message_delta",
  `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":57,"server_tool_use":{"web_search_requests":2}}}`,
  "",
  "event: message_stop",
  `data: {"type":"message_stop"}`,
  "",
  "",
].join("\n");

const meterInPieces = (text: string, size: number, asked = "claude-opus-5-5") => {
  const meter = makeClaudeStreamMeter(asked);
  const bytes = encoder.encode(text);
  for (let start = 0; start < bytes.length; start += size) {
    meter.push(bytes.slice(start, start + size));
  }
  return meter.result();
};

describe("makeClaudeStreamMeter", () => {
  it("adds the start's input counts to the final output count, however the bytes arrive", () => {
    for (const size of [1, 7, 64, 100_000]) {
      expect(meterInPieces(stream, size)).toEqual({
        model: "claude-opus-5-5",
        failed: false,
        ended: true,
        attempts: [
          {
            model: "claude-opus-5-5",
            tokens: {
              inputTokens: 12,
              cacheWrite5mTokens: 100,
              cacheWrite1hTokens: 200,
              cacheReadTokens: 4000,
              outputTokens: 57,
              webSearches: 2,
              fast: false,
              usOnly: false,
            },
          },
        ],
      });
    }
  });

  it("reads a gateway's stream that has data lines only", () => {
    const dataOnly = stream
      .split("\n")
      .filter((line) => !line.startsWith("event:"))
      .join("\n");
    expect(meterInPieces(dataOnly, 13).attempts[0]?.tokens.outputTokens).toBe(57);
  });

  it("names the fallback model the stream started with, and notes an error event", () => {
    const meter = makeClaudeStreamMeter("claude-fable-5-2");
    meter.push(
      encoder.encode(
        [
          "event: message_start",
          `data: {"type":"message_start","message":{"model":"claude-opus-4-8","usage":{"input_tokens":5,"output_tokens":1}}}`,
          "",
          "event: error",
          `data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`,
          "",
        ].join("\n"),
      ),
    );
    const result = meter.result();
    expect(result.model).toBe("claude-opus-4-8");
    expect(result.failed).toBe(true);
    expect(result.attempts.map((attempt) => attempt.tokens.inputTokens)).toEqual([5]);
  });

  it("has no attempts for a stream cut off before any usage, and knows it did not end", () => {
    expect(meterInPieces("event: ping\ndata: {}\n\n", 4)).toMatchObject({
      attempts: [],
      ended: false,
    });
  });
});

describe("meterClaudeJson", () => {
  it("bills each attempt in usage.iterations at its own model", () => {
    const reply = {
      model: "claude-opus-4-8",
      usage: {
        input_tokens: 40,
        output_tokens: 90,
        speed: "fast",
        iterations: [
          { type: "message", input_tokens: 40, output_tokens: 10 },
          { type: "fallback_message", input_tokens: 40, output_tokens: 90 },
        ],
      },
    };
    const result = meterClaudeJson(encoder.encode(JSON.stringify(reply)), "claude-fable-5-2");
    expect(
      result.attempts.map(({ model, tokens }) => [model, tokens.outputTokens, tokens.fast]),
    ).toEqual([
      ["claude-fable-5-2", 10, true],
      ["claude-opus-4-8", 90, true],
    ]);
  });

  it("treats an error body as failed with nothing to bill", () => {
    const body = { type: "error", error: { type: "invalid_request_error", message: "bad" } };
    expect(meterClaudeJson(encoder.encode(JSON.stringify(body)), "claude-opus-5-5")).toEqual({
      model: "claude-opus-5-5",
      attempts: [],
      failed: true,
      ended: true,
    });
  });
});
