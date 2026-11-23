import { describe, expect, it } from "vite-plus/test";

import { chatSourcesCount, deriveChatSources } from "./chatSources.logic";

const ROOT = "/home/user/acme";

// A recorded thread: the user attaches a file, then the agent reads, searches and uses a connector.
const ITEMS = [
  {
    type: "user_message",
    text: "Summarise the contract",
    attachments: [
      {
        type: "file",
        id: "att-1",
        name: "contract.pdf",
        mimeType: "application/pdf",
        sizeBytes: 9,
      },
    ],
  },
  { type: "dynamic_tool", toolName: "Read", input: { file_path: `${ROOT}/notes/brief.md` } },
  { type: "dynamic_tool", toolName: "Read", input: { file_path: `${ROOT}/notes/brief.md` } },
  { type: "dynamic_tool", toolName: "Read", input: { file_path: "/etc/hosts" } },
  {
    type: "dynamic_tool",
    toolName: "mcp__codenine__codenine_spreadsheet_read",
    input: { path: "budget.xlsx", sheet: "Q1" },
  },
  { type: "dynamic_tool", toolName: "codenine.codenine_pdf_read", input: { path: "contract.pdf" } },
  // An edit is a change, not a source.
  {
    type: "dynamic_tool",
    toolName: "mcp__codenine__codenine_deck_edit",
    input: { path: "deck.pptx", operations: [] },
  },
  { type: "dynamic_tool", toolName: "Write", input: { file_path: `${ROOT}/out.md`, content: "x" } },
  {
    type: "web_search",
    patterns: ["acme contract law"],
    results: [{ url: "https://example.com/law", title: "Contract law" }, { title: "No address" }],
  },
  { type: "web_search", patterns: ["notice periods"], results: [] },
  { type: "dynamic_tool", toolName: "WebFetch", input: { url: "https://example.com/law" } },
  { type: "dynamic_tool", toolName: "WebFetch", input: { url: "https://example.com/terms" } },
  { type: "dynamic_tool", toolName: "mcp__gmail__search_threads", input: { query: "contract" } },
  { type: "dynamic_tool", toolName: "gmail.read_thread", input: { id: "1" } },
  { type: "dynamic_tool", toolName: "mcp__gmail__search_threads", input: { query: "renewal" } },
  { type: "dynamic_tool", toolName: null, input: {} },
  { type: "assistant_message", text: "Done" },
];

describe("deriveChatSources", () => {
  it("lists each file, attachment, page, search and connector once, in the order first used", () => {
    const sources = deriveChatSources(ITEMS, ROOT);
    expect(sources.files).toEqual([
      { path: "notes/brief.md", inWorkspace: true },
      { path: "/etc/hosts", inWorkspace: false },
      { path: "budget.xlsx", inWorkspace: true },
      { path: "contract.pdf", inWorkspace: true },
    ]);
    expect(sources.attachments).toMatchObject([{ id: "att-1", name: "contract.pdf" }]);
    expect(sources.pages).toEqual([
      { url: "https://example.com/law", title: "Contract law" },
      { url: "https://example.com/terms", title: null },
    ]);
    expect(sources.searches).toEqual(["notice periods"]);
    expect(sources.connectors).toEqual([
      { name: "gmail", tools: ["search_threads", "read_thread"] },
    ]);
    expect(chatSourcesCount(sources)).toBe(9);
  });

  it("has nothing for a chat that read nothing", () => {
    const sources = deriveChatSources([{ type: "assistant_message", text: "Hello" }], ROOT);
    expect(chatSourcesCount(sources)).toBe(0);
  });
});
