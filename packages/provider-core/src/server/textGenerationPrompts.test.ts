import { describe, expect, it } from "vite-plus/test";

import { type ReviewedAction, reviewedActionJson } from "./textGenerationPrompts.ts";
import { normalizeCliError } from "./textGenerationUtils.ts";

describe("reviewedActionJson", () => {
  const action = (args: ReviewedAction["arguments"]): ReviewedAction => ({
    service: "Gmail",
    tool: "send_email",
    group: "irreversible",
    summary: "send email",
    details: [],
    arguments: args,
  });

  it("shortens long values in place, so a field after them stays in sight", () => {
    const padding = "x".repeat(30_000);
    const json = reviewedActionJson(
      action({ body: padding, nested: { note: padding, to: ["stranger@example.net"] } }),
    );
    expect(json?.length).toBeLessThanOrEqual(16_000);
    const shown = JSON.parse(json ?? "{}") as {
      arguments: { body: string; nested: { note: string; to: ReadonlyArray<string> } };
    };
    expect(shown.arguments.nested.to).toEqual(["stranger@example.net"]);
    expect(shown.arguments.body).toContain("[… 26000 characters not shown …]");
    expect(shown.arguments.nested.note).toContain("[… 26000 characters not shown …]");
  });

  it("shows nothing rather than part of an action whose fields cannot all fit", () => {
    const crowded = Object.fromEntries(
      Array.from({ length: 2_000 }, (_, index) => [`field${index}`, "x"]),
    );
    expect(reviewedActionJson(action({ ...crowded, to: "stranger@example.net" }))).toBeUndefined();
  });
});

describe("normalizeCliError", () => {
  it("does not expose CLI failure details in the public error message", () => {
    const result = normalizeCliError(
      "codex",
      "generateCommitMessage",
      new Error("request failed with access_token=secret-token"),
      "Failed to generate a commit message",
    );

    expect(result.detail).toBe("Failed to generate a commit message");
    expect(result.message).not.toContain("secret-token");
  });
});
