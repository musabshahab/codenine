import { projectComposerContextForProvider } from "@codenine/shared/composerContextReferences";
import { describe, expect, it } from "vite-plus/test";

import {
  appendDocumentReference,
  DOCUMENT_CONTEXT_MAX_CHARS,
  DOCUMENT_SUGGESTIONS,
  documentContextForSend,
  documentContextLabel,
  documentKindForPath,
  documentSuggestions,
  type DocumentSelection,
  messageTakesDocumentContext,
  publishDocumentSelection,
  readDocumentSelection,
  readDocumentSelectionForSend,
  setDocumentTextSource,
  textDocumentSelection,
} from "./documentContext";

describe("the document context chip", () => {
  it.each<[string, DocumentSelection | null, string]>([
    ["docs/budget.xlsx", null, "budget.xlsx"],
    [
      "docs/budget.xlsx",
      { kind: "spreadsheet", sheet: "Budget", range: "B2:D5" },
      "budget.xlsx, Budget!B2:D5",
    ],
    [
      "budget.xlsx",
      { kind: "spreadsheet", sheet: "Budget", range: "B16" },
      "budget.xlsx, Budget!B16",
    ],
    ["agreement.pdf", { kind: "pdf", page: 2 }, "agreement.pdf, page 2"],
    [
      "agreement.pdf",
      { kind: "pdf", page: 2, text: "within  30 days\nof delivery" },
      'agreement.pdf, "within 30 days of delivery"',
    ],
    [
      "agreement.pdf",
      { kind: "pdf", page: 1, text: "a".repeat(60) },
      `agreement.pdf, "${"a".repeat(40)}..."`,
    ],
    ["notes.md", { kind: "text", lineStart: 10, lineEnd: 24 }, "notes.md, lines 10 to 24"],
    ["notes.md", { kind: "text", lineStart: 3, lineEnd: 3 }, "notes.md, line 3"],
  ])("names %s with %o as %s", (path, selection, label) => {
    expect(documentContextLabel(path, selection)).toBe(label);
  });

  it("reads a text selection's lines in either direction", () => {
    expect(textDocumentSelection("one\ntwo\nthree\nfour", 3, 2)).toEqual({
      kind: "text",
      lineStart: 2,
      lineEnd: 3,
      text: "two\nthree",
    });
    // An editor publishes the lines alone, and their text is read when a message is sent.
    publishDocumentSelection("notes", textDocumentSelection(null, 2, 3));
    expect(readDocumentSelection("notes")).toEqual({ kind: "text", lineStart: 2, lineEnd: 3 });
    let contents = "one\ntwo\nthree";
    setDocumentTextSource("notes", () => contents);
    contents = "one\nTWO\nthree";
    expect(readDocumentSelectionForSend("notes")).toEqual({
      kind: "text",
      lineStart: 2,
      lineEnd: 3,
      text: "TWO\nthree",
    });
    setDocumentTextSource("notes", null);
    publishDocumentSelection("notes", null);
  });

  it("sends the path, the selection and a small selection's contents, and reaches a provider", () => {
    const context = documentContextForSend({
      relativePath: "docs/budget.xlsx",
      selection: { kind: "spreadsheet", sheet: "Budget", range: "B2:C3", values: "1\t2\n3\t4" },
      messageKey: "message-1",
    });
    expect(context.record).toMatchObject({
      kind: "document",
      label: "budget.xlsx, Budget!B2:C3",
      payload: {
        path: "docs/budget.xlsx",
        selection: { sheet: "Budget", range: "B2:C3", values: "1\t2\n3\t4" },
      },
    });
    const text = appendDocumentReference("Add a totals row", context);
    expect(text.startsWith("Add a totals row\n\n[budget.xlsx, Budget!B2:C3](")).toBe(true);
    // What both provider adapters are handed: a marker in the text and the record's payload.
    const projected = projectComposerContextForProvider({ text, records: [context.record] });
    expect(projected).toContain("[Document: budget.xlsx, Budget!B2:C3; ref=");
    expect(projected).toContain('"path":"docs/budget.xlsx"');
    expect(projected).toContain('"range":"B2:C3"');
    expect(appendDocumentReference("Hello", null)).toBe("Hello");
  });

  it("leaves a large selection's contents out and keeps its place", () => {
    const { record } = documentContextForSend({
      relativePath: "notes.md",
      selection: {
        kind: "text",
        lineStart: 1,
        lineEnd: 900,
        text: "x".repeat(DOCUMENT_CONTEXT_MAX_CHARS + 1),
      },
      messageKey: "message-2",
    });
    expect(record).toMatchObject({
      payload: { path: "notes.md", selection: { lineStart: 1, lineEnd: 900 } },
    });
    expect(JSON.stringify(record)).not.toContain("xxxx");
  });

  it("goes with a message about the file, not with a command or nothing", () => {
    expect(messageTakesDocumentContext("Summarise this sheet")).toBe(true);
    expect(messageTakesDocumentContext("  /compact")).toBe(false);
    expect(messageTakesDocumentContext("   ")).toBe(false);
  });
});

describe("document suggestions", () => {
  it.each([
    ["budget.xlsx", "spreadsheet", "Summarise this sheet"],
    ["data.csv", "spreadsheet", "Add a totals row"],
    ["agreement.pdf", "pdf", "What do I need to fill in or sign?"],
    ["Q4 review.pptx", "deck", "Add speaker notes"],
    ["src/main.ts", "text", "Explain this file"],
    ["Makefile", "text", "Suggest improvements"],
  ] as const)("%s is a %s", (path, kind, suggestion) => {
    expect(documentKindForPath(path)).toBe(kind);
    expect(DOCUMENT_SUGGESTIONS[kind]).toContain(suggestion);
  });

  it("offers a read-only file, such as an attachment, only what reads it", () => {
    expect(documentSuggestions("budget.xlsx", true)).toEqual([
      "Summarise this sheet",
      "Find anything that looks wrong",
    ]);
    expect(documentSuggestions("Q4 review.pptx", true)).toEqual(["Summarise this deck"]);
    expect(documentSuggestions("budget.xlsx", false)).toContain("Add a totals row");
  });

  it("offers two or three per kind", () => {
    for (const suggestions of Object.values(DOCUMENT_SUGGESTIONS)) {
      expect(suggestions.length).toBeGreaterThanOrEqual(2);
      expect(suggestions.length).toBeLessThanOrEqual(3);
    }
  });
});
