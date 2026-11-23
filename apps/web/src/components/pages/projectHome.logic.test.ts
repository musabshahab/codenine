import { describe, expect, it } from "vite-plus/test";

import {
  fileTypeTag,
  folderChipLabel,
  homeChatState,
  homeFolderFiles,
  recentFilesFromActivity,
  recentFilesFromWorkingTree,
  selectHomeChats,
} from "./projectHome.logic";

const change = (
  relativePath: string,
  createdAt: string,
  change: "created" | "modified" | "deleted" = "modified",
  origin: "user" | "agent" | "restore" | "external" = "agent",
) => ({ relativePath, createdAt, change, origin });

describe("recent files", () => {
  it("lists each file once at its latest change, without removed files, up to the cap", () => {
    const files = recentFilesFromActivity(
      [
        change("reports/q4.xlsx", "2026-03-05T10:00:00.000Z"),
        change("gone.md", "2026-03-04T10:00:00.000Z", "deleted"),
        change("reports/q4.xlsx", "2026-03-03T10:00:00.000Z", "created", "user"),
        change("gone.md", "2026-03-02T10:00:00.000Z", "created"),
        change("notes.md", "2026-03-01T10:00:00.000Z", "modified", "user"),
        change("plan.pdf", "2026-02-28T10:00:00.000Z", "created", "external"),
        change("old.txt", "2026-02-27T10:00:00.000Z", "modified", "external"),
      ],
      3,
    );
    expect(files).toEqual([
      {
        path: "reports/q4.xlsx",
        name: "q4.xlsx",
        folder: "reports",
        at: "2026-03-05T10:00:00.000Z",
        detail: "Changed by an agent",
      },
      {
        path: "notes.md",
        name: "notes.md",
        folder: "",
        at: "2026-03-01T10:00:00.000Z",
        detail: "Saved by you",
      },
      {
        path: "plan.pdf",
        name: "plan.pdf",
        folder: "",
        at: "2026-02-28T10:00:00.000Z",
        detail: "Created",
      },
    ]);
  });

  it("lists a checkout's uncommitted files that can be opened, most changed first, up to the cap", () => {
    const files = [
      { path: "src/a.ts", insertions: 1, deletions: 0 },
      { path: "src/deep/b.ts", insertions: 40, deletions: 2 },
      { path: "README.md", insertions: 3, deletions: 3 },
      { path: "c.ts", insertions: 1, deletions: 0 },
      // The most changed of all, and not there to open.
      { path: "src/removed.ts", insertions: 0, deletions: 900, deleted: true },
    ];
    const list = (rootPath: string | undefined, workspaceRoot: string, limit?: number) =>
      recentFilesFromWorkingTree({ rootPath, files }, workspaceRoot, limit).map((file) => [
        file.path,
        file.detail,
      ]);

    expect(list("/repo", "/repo", 3)).toEqual([
      ["src/deep/b.ts", "+40 −2"],
      ["README.md", "+3 −3"],
      ["c.ts", "+1 −0"],
    ]);
    // A workspace inside the checkout: paths are the workspace's own, and files outside it go.
    expect(list("/repo", "/repo/src/")).toEqual([
      ["deep/b.ts", "+40 −2"],
      ["a.ts", "+1 −0"],
    ]);
    expect(list("C:\\repo", "C:\\repo\\src")).toEqual(list("/repo", "/repo/src"));
    // No root from the server, or one that names the folder another way: paths stay as given.
    expect(list(undefined, "/repo")).toHaveLength(4);
    expect(list("/private/repo", "/repo")).toHaveLength(4);
  });

  it("lists a folder's files after its recent ones, documents first, each once", () => {
    const recent = recentFilesFromActivity([change("reports/q4.xlsx", "2026-03-05T10:00:00.000Z")]);
    const files = homeFolderFiles(
      recent,
      [
        { path: "logo.png", kind: "file" },
        { path: "reports", kind: "directory" },
        { path: "reports/q4.xlsx", kind: "file" },
        { path: ".codenine/state.json", kind: "file" },
        { path: "Customer emails.xlsx", kind: "file" },
        { path: "Q4 review.pptx", kind: "file" },
        { path: "LICENSE", kind: "file" },
      ],
      4,
    );
    expect(files.map((file) => [file.path, file.detail, fileTypeTag(file.name)])).toEqual([
      ["reports/q4.xlsx", "Changed by an agent", "XLSX"],
      ["Customer emails.xlsx", null, "XLSX"],
      ["Q4 review.pptx", null, "PPTX"],
      ["logo.png", null, "PNG"],
    ]);
    expect([".env", "LICENSE", "archive.tar.gz", "odd.name with space"].map(fileTypeTag)).toEqual([
      null,
      null,
      "GZ",
      null,
    ]);
  });
});

const chat = (
  title: string,
  overrides: Partial<Parameters<typeof homeChatState>[0]> & { at?: string } = {},
) => ({
  title,
  at: "2026-03-01T00:00:00.000Z",
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  pendingSubagentRequest: null,
  runtime: null,
  blockedOnThreadWait: false,
  settledOverride: null,
  ...overrides,
});
const runtime = (status: string) => ({ status }) as never;

describe("home chats", () => {
  it.each([
    [chat("a", { hasPendingApprovals: true }), "needs-you"],
    [chat("a", { hasPendingUserInput: true }), "needs-you"],
    [chat("a", { source: { teamSummary: { status: "proposed" } } as never }), "needs-you"],
    [chat("a", { runtime: runtime("failed") }), "needs-you"],
    [chat("a", { runtime: runtime("running") }), "running"],
    [chat("a", { runtime: runtime("running"), blockedOnThreadWait: true }), "running"],
    [chat("a", { runtime: runtime("queued") }), "running"],
    [chat("a", { runtime: runtime("idle") }), "open"],
    [chat("a"), "open"],
    // Marked done by the user: a stale approval or failure no longer asks for them.
    [chat("a", { settledOverride: "settled", runtime: runtime("failed") }), "done"],
  ] as const)("reads a chat's state %#", (thread, state) => {
    expect(homeChatState(thread)).toBe(state);
  });

  const threads = [
    chat("Old idea", { at: "2026-03-01T00:00:00.000Z" }),
    chat("Budget review", { at: "2026-03-04T00:00:00.000Z", settledOverride: "settled" }),
    chat("Weekly report", { at: "2026-03-02T00:00:00.000Z", runtime: runtime("running") }),
    chat("Vendor emails", { at: "2026-03-03T00:00:00.000Z" }),
    chat("Sign the report", { at: "2026-02-01T00:00:00.000Z", hasPendingApprovals: true }),
  ];
  const select = (filter: string, limit?: number) =>
    selectHomeChats({
      threads,
      activeAt: (thread) => thread.at,
      filter,
      ...(limit === undefined ? {} : { limit }),
    });

  it("groups by what needs the user, then running, open and done, newest first in each", () => {
    const selected = select("");
    expect(selected.chats.map(({ thread, state }) => [thread.title, state])).toEqual([
      ["Sign the report", "needs-you"],
      ["Weekly report", "running"],
      ["Vendor emails", "open"],
      ["Old idea", "open"],
      ["Budget review", "done"],
    ]);
    expect(selected.counts).toEqual({ "needs-you": 1, running: 1, open: 2, done: 1 });
  });

  it("filters by title and caps what is drawn, counting the rest", () => {
    expect(select(" REPORT ").chats.map(({ thread }) => thread.title)).toEqual([
      "Sign the report",
      "Weekly report",
    ]);
    const capped = select("", 2);
    expect(capped.chats).toHaveLength(2);
    expect(capped.moreCount).toBe(3);
    // Counts describe the workspace, not the filter or the cap.
    expect(select("report", 1).counts.open).toBe(2);
  });
});

it.each([
  ["/home/me/work/wrk", "/home/me", "~/work/wrk"],
  ["/home/me", "/home/me/", "~"],
  ["/home/melissa/x", "/home/me", "/home/melissa/x"],
  ["C:\\Users\\me\\Docs", "C:\\Users\\me", "~\\Docs"],
  ["/srv/data", null, "/srv/data"],
])("shortens %s under %s to %s", (root, home, label) => {
  expect(folderChipLabel(root, home)).toBe(label);
});
