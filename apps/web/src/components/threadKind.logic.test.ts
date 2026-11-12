import { describe, expect, it } from "vite-plus/test";

import { resolveThreadKind } from "./threadKind.logic";

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
      "a team waiting on an approval its lead asks for",
      { ...idle, hasPendingApprovals: true, source: { teamSummary: team("running") } },
      "approval",
    ],
  ] as const)("shows %s as %s", (_name, thread, kind) => {
    expect(resolveThreadKind(thread as KindInput)).toBe(kind);
  });
});
