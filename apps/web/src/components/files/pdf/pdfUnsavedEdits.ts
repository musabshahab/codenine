import { isElectron } from "~/env";

import type { PdfPendingEdits } from "./pdfEditSession";

export interface PdfFileRef {
  readonly environmentId: string;
  readonly cwd: string;
  readonly relativePath: string;
}

/** Names a workspace PDF, so its unsaved edits are found again after its view was unmounted. */
export const pdfSessionKey = (file: PdfFileRef) =>
  `${file.environmentId}\u0000${file.cwd}\u0000${file.relativePath}`;

// Unsaved edits outlive the tab's view, which is unmounted when the user looks at another thread.
const unsavedEdits = new Map<string, PdfPendingEdits>();

const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
  event.preventDefault();
  // Older browsers ask only when this is set.
  event.returnValue = "";
};

export const unsavedPdfEdits = (sessionKey: string): PdfPendingEdits =>
  unsavedEdits.get(sessionKey) ?? [];

export function rememberPdfEdits(sessionKey: string, edits: PdfPendingEdits): PdfPendingEdits {
  if (edits.length === 0) unsavedEdits.delete(sessionKey);
  else unsavedEdits.set(sessionKey, edits);
  // The desktop shell shows no prompt and would refuse to close, so only a browser asks.
  if (!isElectron) {
    if (unsavedEdits.size > 0) window.addEventListener("beforeunload", warnBeforeLeaving);
    else window.removeEventListener("beforeunload", warnBeforeLeaving);
  }
  return edits;
}

export const hasUnsavedPdfEdits = (file: PdfFileRef): boolean =>
  unsavedEdits.has(pdfSessionKey(file));

export function discardUnsavedPdfEdits(file: PdfFileRef): void {
  rememberPdfEdits(pdfSessionKey(file), []);
}
