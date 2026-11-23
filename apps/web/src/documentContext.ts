import type { ComposerContextRecord } from "@codenine/contracts";
import {
  formatComposerContextReference,
  sanitizeComposerContextLabel,
  toKindScopedComposerContextId,
} from "@codenine/shared/composerContextReferences";
import { useSyncExternalStore } from "react";

export type DocumentKind = "spreadsheet" | "pdf" | "deck" | "text";

/** What the user has selected in the open document, as its editor reports it. */
export type DocumentSelection =
  | {
      readonly kind: "spreadsheet";
      readonly sheet: string;
      /** In A1 notation: `B2` or `B2:D5`. */
      readonly range: string;
      /** Tab-separated rows. Left out for a large selection. */
      readonly values?: string;
    }
  | {
      readonly kind: "pdf";
      readonly page: number;
      /** Text the user selected on the page. */
      readonly text?: string;
    }
  | {
      readonly kind: "text";
      readonly lineStart: number;
      readonly lineEnd: number;
      readonly text?: string;
    };

/** The most selected text or cell values a message carries; a larger selection sends its place only. */
export const DOCUMENT_CONTEXT_MAX_CHARS = 4_000;
/** The record kind a server need not know: it travels as an open payload. */
const DOCUMENT_CONTEXT_KIND = "document";
const QUOTED_TEXT_LABEL_CHARS = 40;

const SPREADSHEET_EXTENSIONS = new Set(["xlsx", "xlsm", "xls", "ods", "csv", "tsv"]);
const DECK_EXTENSIONS = new Set(["pptx", "ppt", "odp", "key"]);

function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).at(-1) ?? path;
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function documentKindForPath(path: string): DocumentKind {
  const extension = extensionOf(path);
  if (SPREADSHEET_EXTENSIONS.has(extension)) return "spreadsheet";
  if (extension === "pdf") return "pdf";
  if (DECK_EXTENSIONS.has(extension)) return "deck";
  return "text";
}

/** Offered above the composer for the open document. Choosing one fills the composer; it never sends. */
export const DOCUMENT_SUGGESTIONS: Readonly<Record<DocumentKind, ReadonlyArray<string>>> = {
  spreadsheet: ["Summarise this sheet", "Add a totals row", "Find anything that looks wrong"],
  pdf: [
    "Summarise this document",
    "List the dates and amounts",
    "What do I need to fill in or sign?",
  ],
  deck: ["Summarise this deck", "Tighten the wording", "Add speaker notes"],
  text: ["Explain this file", "Suggest improvements"],
};

const CHANGES_THE_FILE = new Set(["Add a totals row", "Tighten the wording", "Add speaker notes"]);

/** A file that opens read only, such as one attached to the chat, is offered only what reads it. */
export function documentSuggestions(path: string, readOnly: boolean): ReadonlyArray<string> {
  const suggestions = DOCUMENT_SUGGESTIONS[documentKindForPath(path)];
  return readOnly ? suggestions.filter((entry) => !CHANGES_THE_FILE.has(entry)) : suggestions;
}

function clampText(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const trimmed = text.replace(/\r\n/g, "\n").trim();
  return trimmed.length === 0 || trimmed.length > DOCUMENT_CONTEXT_MAX_CHARS ? undefined : trimmed;
}

/** The selection as the chip names it, or null when it names nothing beyond the file. */
function documentSelectionLabel(selection: DocumentSelection | null): string | null {
  if (selection === null) return null;
  switch (selection.kind) {
    case "spreadsheet":
      return `${selection.sheet}!${selection.range}`;
    case "pdf": {
      const text = selection.text?.replace(/\s+/g, " ").trim() ?? "";
      if (text.length === 0) return `page ${selection.page}`;
      return text.length > QUOTED_TEXT_LABEL_CHARS
        ? `"${text.slice(0, QUOTED_TEXT_LABEL_CHARS).trimEnd()}..."`
        : `"${text}"`;
    }
    case "text":
      return selection.lineStart === selection.lineEnd
        ? `line ${selection.lineStart}`
        : `lines ${selection.lineStart} to ${selection.lineEnd}`;
  }
}

/**
 * Lines `start` to `end` of a text file, in either order. Their text is added only where
 * `contents` is given: an editor publishes the lines alone, so typing never cuts the file up.
 */
export function textDocumentSelection(
  contents: string | null,
  start: number,
  end: number,
): DocumentSelection {
  const lineStart = Math.max(1, Math.min(start, end));
  const lineEnd = Math.max(start, end);
  if (contents === null) return { kind: "text", lineStart, lineEnd };
  const text = contents
    .split("\n")
    .slice(lineStart - 1, lineEnd)
    .join("\n");
  return { kind: "text", lineStart, lineEnd, ...(text.trim() === "" ? {} : { text }) };
}

export function documentContextLabel(
  relativePath: string,
  selection: DocumentSelection | null,
): string {
  const name = relativePath.split(/[\\/]/).at(-1) ?? relativePath;
  const selected = documentSelectionLabel(selection);
  return selected === null ? name : `${name}, ${selected}`;
}

function selectionPayload(selection: DocumentSelection): Record<string, string | number> {
  switch (selection.kind) {
    case "spreadsheet": {
      const values = clampText(selection.values);
      return {
        sheet: selection.sheet,
        range: selection.range,
        ...(values === undefined ? {} : { values }),
      };
    }
    case "pdf": {
      const text = clampText(selection.text);
      return { page: selection.page, ...(text === undefined ? {} : { text }) };
    }
    case "text": {
      const text = clampText(selection.text);
      return {
        lineStart: selection.lineStart,
        lineEnd: selection.lineEnd,
        ...(text === undefined ? {} : { text }),
      };
    }
  }
}

export interface DocumentContextForSend {
  /** The inline link that ties the record to the message text. */
  readonly reference: string;
  readonly record: ComposerContextRecord;
}

/**
 * The open document and its selection as a message carries them: a record of a kind the server
 * passes through untouched, so both providers read it in the message's context envelope.
 */
export function documentContextForSend(input: {
  /** Relative to the workspace folder. */
  readonly relativePath: string;
  readonly selection: DocumentSelection | null;
  /** Distinguishes two messages about the same file. */
  readonly messageKey: string;
}): DocumentContextForSend {
  const label = sanitizeComposerContextLabel(
    documentContextLabel(input.relativePath, input.selection),
    DOCUMENT_CONTEXT_KIND,
  );
  const contextId = toKindScopedComposerContextId(DOCUMENT_CONTEXT_KIND, input.messageKey);
  return {
    reference: formatComposerContextReference({ kind: DOCUMENT_CONTEXT_KIND, contextId, label }),
    record: {
      version: 1,
      kind: DOCUMENT_CONTEXT_KIND,
      contextId,
      label,
      payload: {
        path: input.relativePath,
        ...(input.selection === null ? {} : { selection: selectionPayload(input.selection) }),
      },
    },
  };
}

/** The message as it is sent: the user's text, then the reference on its own line. */
export function appendDocumentReference(
  text: string,
  context: DocumentContextForSend | null,
): string {
  return context === null ? text : `${text}\n\n${context.reference}`;
}

/** A command such as `/compact` is not about the file, and an empty message sends nothing. */
export function messageTakesDocumentContext(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && !trimmed.startsWith("/");
}

export function documentSelectionKey(cwd: string, relativePath: string): string {
  return `${cwd}\u0000${relativePath}`;
}

// Selections change on every click and arrow key, so they live outside React: only the chip
// subscribes, and neither the editor nor the timeline renders again when one is published.
const selections = new Map<string, DocumentSelection>();
const selectionListeners = new Map<string, Set<() => void>>();
const dismissed = new Set<string>();
const dismissedListeners = new Set<() => void>();

function sameSelection(left: DocumentSelection | undefined, right: DocumentSelection | null) {
  if (left === undefined || right === null) return left === undefined && right === null;
  return JSON.stringify(left) === JSON.stringify(right);
}

export function publishDocumentSelection(key: string, selection: DocumentSelection | null): void {
  if (sameSelection(selections.get(key), selection)) return;
  if (selection === null) selections.delete(key);
  else selections.set(key, selection);
  for (const listener of selectionListeners.get(key) ?? []) listener();
}

export function readDocumentSelection(key: string): DocumentSelection | null {
  return selections.get(key) ?? null;
}

const textSources = new Map<string, () => string>();

/** How to read an open text file's contents when a message is sent. Null when its editor goes. */
export function setDocumentTextSource(key: string, source: (() => string) | null): void {
  if (source === null) textSources.delete(key);
  else textSources.set(key, source);
}

/** The selection a message carries: selected lines of a text file come with their text. */
export function readDocumentSelectionForSend(key: string): DocumentSelection | null {
  const selection = readDocumentSelection(key);
  const source = textSources.get(key);
  return selection?.kind === "text" && source !== undefined
    ? textDocumentSelection(source(), selection.lineStart, selection.lineEnd)
    : selection;
}

const noSubscription = () => () => {};

export function useDocumentSelection(key: string | null): DocumentSelection | null {
  return useSyncExternalStore(
    key === null
      ? noSubscription
      : (listener) => {
          const listeners = selectionListeners.get(key) ?? new Set();
          selectionListeners.set(key, listeners);
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
            if (listeners.size === 0) selectionListeners.delete(key);
          };
        },
    () => (key === null ? null : readDocumentSelection(key)),
  );
}

/** The user took the chip off the next message of this chat. Sending puts it back. */
export function setDocumentContextDismissed(threadKey: string, value: boolean): void {
  if (dismissed.has(threadKey) === value) return;
  if (value) dismissed.add(threadKey);
  else dismissed.delete(threadKey);
  for (const listener of dismissedListeners) listener();
}

export function isDocumentContextDismissed(threadKey: string): boolean {
  return dismissed.has(threadKey);
}

export function useDocumentContextDismissed(threadKey: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      dismissedListeners.add(listener);
      return () => dismissedListeners.delete(listener);
    },
    () => dismissed.has(threadKey),
  );
}
