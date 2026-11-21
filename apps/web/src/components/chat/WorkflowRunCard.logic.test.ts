import { describe, expect, it } from "vite-plus/test";

import { workflowResultExcerpt } from "./WorkflowRunCard.logic";

describe("workflowResultExcerpt", () => {
  it("drops Markdown syntax and blank lines", () => {
    const result = [
      "# Morning briefing",
      "",
      "- **Sales** are up, see [the report](https://example.com/r).",
      "> Ship `v2` _today_",
      "",
      "```",
      "pnpm build",
      "```",
    ].join("\n");
    expect(workflowResultExcerpt(result)).toEqual({
      text: "Morning briefing\nSales are up, see the report.\nShip v2 today\npnpm build",
      more: false,
    });
  });

  it("keeps snake_case and lone asterisks as written", () => {
    expect(workflowResultExcerpt("Set max_retries to 2 * 3").text).toBe("Set max_retries to 2 * 3");
  });

  it.each([
    ["a one-line result", "All checks passed.", false],
    ["more than four lines", "a\nb\nc\nd\ne", true],
    ["a long paragraph", "word ".repeat(80), true],
  ])("offers the rest for %s", (_name, result, more) => {
    const excerpt = workflowResultExcerpt(result);
    expect(excerpt.more).toBe(more);
    expect(excerpt.text.length).toBeLessThanOrEqual(300);
  });
});
