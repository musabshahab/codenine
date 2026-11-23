import { describe, expect, it } from "vite-plus/test";

import { defaultReplyFileName, replyFilePath, replyHasTable } from "./saveReply.logic";

describe("replyHasTable", () => {
  it.each([
    ["a table", "Totals:\n\n| A | B |\n| --- | --: |\n| 1 | 2 |", true],
    ["a table without outer pipes", "A | B\n--- | ---\n1 | 2", true],
    ["prose with a pipe", "Use a | b to pipe.\n\nNext line.", false],
    ["a table inside a code block", "```\n| A | B |\n| --- | --- |\n```", false],
    ["a rule under text without pipes", "Title\n---\nBody", false],
  ])("%s", (_name, markdown, expected) => {
    expect(replyHasTable(markdown)).toBe(expected);
  });
});

describe("defaultReplyFileName", () => {
  it.each([
    ["Intro line\n\n## Q3 plan: **draft**\n\nBody", "Q3 plan draft"],
    ["Here is the summary you asked for, in three short parts.", "Here is the summary you asked"],
    ["`a/b` and <c>?", "a b and c"],
    ["\n\n---\n", "Reply"],
  ])("%j", (markdown, expected) => {
    expect(defaultReplyFileName(markdown)).toBe(expected);
  });
});

describe("replyFilePath", () => {
  it.each([
    ["", "Plan", "markdown", "Plan.md"],
    ["notes/2026", " Plan ", "pdf", "notes/2026/Plan.pdf"],
    ["/notes\\drafts/", "plan.md", "xlsx", "notes/drafts/plan.xlsx"],
    ["", "sub/plan.v2", "markdown", "sub/plan.v2.md"],
  ] as const)("%j %j as %s", (folder, name, format, relativePath) => {
    expect(replyFilePath(folder, name, format)).toEqual({ ok: true, relativePath });
  });

  it.each([
    ["", "  "],
    ["", ".md"],
    ["../other", "plan"],
    ["notes", "../../plan"],
    ["C:\\Users", "plan"],
    ["", "what?"],
  ])("refuses %j %j", (folder, name) => {
    expect(replyFilePath(folder, name, "markdown").ok).toBe(false);
  });
});
