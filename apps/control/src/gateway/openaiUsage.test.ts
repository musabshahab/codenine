import { describe, expect, it } from "@effect/vitest";

import { makeOpenAiStreamMeter, meterOpenAiJson } from "./openaiUsage.ts";

const encoder = new TextEncoder();

const completed = {
  id: "resp_1",
  model: "gpt-5.5",
  status: "completed",
  service_tier: "default",
  output: [
    { type: "reasoning", summary: [] },
    { type: "web_search_call", status: "completed" },
    { type: "message", content: [{ type: "output_text", text: "Grüße" }] },
  ],
  usage: {
    input_tokens: 1200,
    input_tokens_details: { cached_tokens: 1000 },
    output_tokens: 80,
    output_tokens_details: { reasoning_tokens: 50 },
    total_tokens: 1280,
  },
};

/** A Responses stream as OpenAI sends it, ending with the whole response. */
const stream = [
  "event: response.created",
  `data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_1","model":"gpt-5.5","status":"in_progress","usage":null}}`,
  "",
  "event: response.output_text.delta",
  `data: {"type":"response.output_text.delta","sequence_number":1,"delta":"Grüße"}`,
  "",
  "event: response.completed",
  `data: ${JSON.stringify({ type: "response.completed", sequence_number: 2, response: completed })}`,
  "",
  "",
].join("\n");

const tokens = {
  inputTokens: 1200,
  cachedInputTokens: 1000,
  outputTokens: 80,
  webSearches: 1,
  serviceTier: "default",
};

describe("makeOpenAiStreamMeter", () => {
  it("reads the usage the completed response carries, however the bytes arrive", () => {
    for (const size of [1, 9, 100_000]) {
      const meter = makeOpenAiStreamMeter("gpt-5.5");
      const bytes = encoder.encode(stream);
      for (let start = 0; start < bytes.length; start += size) {
        meter.push(bytes.slice(start, start + size));
      }
      expect(meter.result()).toEqual({ model: "gpt-5.5", tokens, failed: false, ended: true });
    }
  });

  it("notes a failed response and has no usage before one ends", () => {
    const meter = makeOpenAiStreamMeter("gpt-5.4");
    meter.push(encoder.encode(stream.split("event: response.completed")[0] ?? ""));
    expect(meter.result()).toEqual({
      model: "gpt-5.4",
      tokens: null,
      failed: false,
      ended: false,
    });
    meter.push(
      encoder.encode(
        `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { model: "gpt-5.4", status: "failed", usage: null } })}\n\n`,
      ),
    );
    expect(meter.result()).toMatchObject({ tokens: null, failed: true });
  });
});

describe("meterOpenAiJson", () => {
  it("reads a whole reply's usage", () => {
    expect(meterOpenAiJson(encoder.encode(JSON.stringify(completed)), "gpt-5.5")).toEqual({
      model: "gpt-5.5",
      tokens,
      failed: false,
      ended: true,
    });
  });
});
