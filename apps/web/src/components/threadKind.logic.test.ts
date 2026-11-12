import { describe, expect, it } from "vite-plus/test";

import { resolveAgentThreadKind, resolveThreadKind } from "./threadKind.logic";

type KindInput = Parameters<typeof resolveThreadKind>[0];

const idle: KindInput = {
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  pendingSubagentRequest: null,
  runtime: null,
  blockedOnThreadWait: false,
  pullRequests: [],
  source: {},
};
const team = (status: "proposed" | "running" | "completed" | "failed" | "cancelled") =>
  ({ status }) as NonNullable<KindInput["source"]["teamSummary"]>;
const openPullRequest = {
  snapshot: { state: "open" },
} as unknown as KindInput["pullRequests"][number];

describe("resolveThreadKind", () => {
  it.each([
    ["a quiet chat", idle, "chat"],
    ["a chat at work", { ...idle, runtime: { status: "running" } }, "running"],
    ["a chat that failed", { ...idle, runtime: { status: "failed" } }, "failed"],
    ["a thread asking for approval", { ...idle, hasPendingApprovals: true }, "approval"],
    ["a thread asking a question", { ...idle, hasPendingUserInput: true }, "question"],
    ["a proposed team", { ...idle, source: { teamSummary: team("proposed") } }, "approval"],
    ["a running team", { ...idle, source: { teamSummary: team("running") } }, "running"],
    ["a failed team", { ...idle, source: { teamSummary: team("failed") } }, "failed"],
    ["a finished team", { ...idle, source: { teamSummary: team("completed") } }, "done"],
    [
      "a finished team with an open pull request",
      { ...idle, source: { teamSummary: team("completed") }, pullRequests: [openPullRequest] },
      "pr",
    ],
    [
      "a finished team whose open pull request was dismissed from its stack",
      {
        ...idle,
        source: { teamSummary: team("completed") },
        pullRequests: [{ ...openPullRequest, source: "stack-dismissed" }],
      },
      "done",
    ],
    [
      "a team waiting on an approval its lead asks for",
      { ...idle, hasPendingApprovals: true, source: { teamSummary: team("running") } },
      "approval",
    ],
  ] as const)("shows %s as %s", (_name, thread, kind) => {
    expect(resolveThreadKind(thread as KindInput)).toBe(kind);
  });
});

describe("resolveAgentThreadKind", () => {
  it.each([
    ["a finished agent", idle, "completed", "done"],
    ["a cancelled agent", idle, "cancelled", "failed"],
    ["an agent at work", { ...idle, runtime: { status: "running" } }, "running", "running"],
    ["an agent asking for approval", { ...idle, hasPendingApprovals: true }, "failed", "approval"],
    ["a replaced attempt", idle, null, "chat"],
  ] as const)("shows %s as %s", (_name, thread, taskStatus, kind) => {
    expect(resolveAgentThreadKind(thread as KindInput, { taskStatus })).toBe(kind);
  });
});
