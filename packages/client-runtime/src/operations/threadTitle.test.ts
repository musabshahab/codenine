import { describe, expect, it } from "vite-plus/test";

import { threadTitleTextFromPrompt } from "./threadTitle.ts";

describe("threadTitleTextFromPrompt", () => {
  it("names a mentioned model by its slug, without the reference syntax", () => {
    expect(threadTitleTextFromPrompt("Delegate to model:codex/gpt-6.1-sol and report back")).toBe(
      "Delegate to gpt-6.1-sol and report back",
    );
    expect(
      threadTitleTextFromPrompt("model:opencode/anthropic/opus, then model:codex/gpt-5.4."),
    ).toBe("anthropic/opus, then gpt-5.4.");
  });

  it("leaves out the agent a message hands the chat to", () => {
    expect(threadTitleTextFromPrompt("agent:gmail Clean up my inbox")).toBe("Clean up my inbox");
  });

  it("leaves skill mentions out, but keeps prices", () => {
    expect(threadTitleTextFromPrompt("$our-email-tone Reply to Sam about Friday")).toBe(
      "Reply to Sam about Friday",
    );
    expect(threadTitleTextFromPrompt("Plan a $500 offsite with $plan-a-project")).toBe(
      "Plan a $500 offsite with",
    );
  });
});
