import { createContext, use, useEffect } from "react";

import {
  type DocumentSelection,
  publishDocumentSelection,
  setDocumentTextSource,
} from "~/documentContext";

/** Names the open workspace file for the chat's context chip. Null where nothing is published. */
export const DocumentSelectionKeyContext = createContext<string | null>(null);

/** Tells the chat what is selected in the open document. A selection that is unchanged publishes nothing. */
export function usePublishDocumentSelection(selection: DocumentSelection | null): void {
  const key = use(DocumentSelectionKeyContext);
  const serialised = selection === null ? null : JSON.stringify(selection);
  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- hands the editor's selection to a store outside React that only the composer's chip reads
  useEffect(() => {
    if (key === null) return;
    publishDocumentSelection(
      key,
      serialised === null ? null : (JSON.parse(serialised) as DocumentSelection),
    );
  }, [key, serialised]);
  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- clears the published selection when the editor goes away
  useEffect(() => {
    if (key === null) return;
    return () => publishDocumentSelection(key, null);
  }, [key]);
}

/** Lets a sent message read the open text file's contents as they are then. */
export function usePublishDocumentText(contents: string): void {
  const key = use(DocumentSelectionKeyContext);
  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- hands the editor's contents to a store outside React; a keystroke only replaces the reader, and nothing reads the file until a message is sent
  useEffect(() => {
    if (key === null) return;
    setDocumentTextSource(key, () => contents);
    return () => setDocumentTextSource(key, null);
  }, [key, contents]);
}

/**
 * Publishes a PDF's selection from its events, without a render: the page last clicked or
 * selected on, and the selected text.
 */
export function usePublishPdfSelection(root: { readonly current: HTMLElement | null }): void {
  const key = use(DocumentSelectionKeyContext);
  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- listens for selection and pointer events on the PDF's DOM and hands them to a store outside React
  useEffect(() => {
    const host = root.current;
    if (key === null || host === null) return;
    const pageOf = (node: Node | null) => {
      const element = node instanceof Element ? node : (node?.parentElement ?? null);
      const page = element?.closest("[data-pdf-page]")?.getAttribute("data-pdf-page");
      return page == null ? null : Number(page) + 1;
    };
    let page: number | null = null;
    const publish = (text?: string) =>
      publishDocumentSelection(
        key,
        page === null ? null : { kind: "pdf", page, ...(text ? { text } : {}) },
      );
    const onPointerDown = (event: PointerEvent) => {
      page = pageOf(event.target as Node) ?? page;
      publish();
    };
    const onSelectionChange = () => {
      const selection = host.ownerDocument.getSelection();
      if (selection === null || selection.rangeCount === 0) return;
      const anchor = selection.getRangeAt(0).startContainer;
      if (!host.contains(anchor)) return;
      page = pageOf(anchor) ?? page;
      publish(selection.isCollapsed ? undefined : selection.toString().trim());
    };
    host.addEventListener("pointerdown", onPointerDown);
    host.ownerDocument.addEventListener("selectionchange", onSelectionChange);
    return () => {
      host.removeEventListener("pointerdown", onPointerDown);
      host.ownerDocument.removeEventListener("selectionchange", onSelectionChange);
      publishDocumentSelection(key, null);
    };
  }, [key, root]);
}
