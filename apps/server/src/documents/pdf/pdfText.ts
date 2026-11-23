import type { PdfReadTextResult, PdfRect } from "@codenine/contracts";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
// @ts-expect-error -- pdfjs-dist ships no types for its worker module.
import * as pdfWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs";

import { PdfProblem } from "./pdfEdits.ts";

// The reader otherwise imports its worker from a file beside itself, which a bundled server
// does not have. Handing it the worker here keeps the worker inside the bundle.
(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker ??= pdfWorker;

/** The most text one page answers with, so a page of dense tables stays small on the wire. */
const PAGE_TEXT_MAX_LENGTH = 20_000;

interface TextItem {
  readonly str: string;
  readonly transform: ReadonlyArray<number>;
  readonly width: number;
  readonly height: number;
  readonly hasEOL: boolean;
}

async function withDocument<A>(
  bytes: Uint8Array,
  use: (document: Awaited<ReturnType<typeof getDocument>["promise"]>) => Promise<A>,
): Promise<A> {
  // The reader takes ownership of the bytes it is given, so it gets a copy. A Buffer's `slice`
  // shares its memory, so the copy is made as a plain array.
  const task = getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  try {
    const document = await task.promise.catch(() => {
      throw new PdfProblem({ kind: "refused", reason: "damaged" });
    });
    return await use(document);
  } finally {
    await task.destroy();
  }
}

async function textItems(
  document: Awaited<ReturnType<typeof getDocument>["promise"]>,
  page: number,
): Promise<ReadonlyArray<TextItem>> {
  if (page >= document.numPages)
    throw new PdfProblem({ kind: "operation", reason: "unknown-page" });
  const proxy = await document.getPage(page + 1);
  const content = await proxy.getTextContent();
  return content.items.flatMap((item) => ("str" in item ? [item as TextItem] : []));
}

/** The text of a run of pages, in the order the file draws it. */
export async function readPdfText(
  bytes: Uint8Array,
  range: { readonly page: number; readonly pageCount: number },
): Promise<Omit<PdfReadTextResult, "version">> {
  return withDocument(bytes, async (document) => {
    const pages: Array<PdfReadTextResult["pages"][number]> = [];
    const end = Math.min(document.numPages, range.page + range.pageCount);
    for (let page = range.page; page < end; page++) {
      const text = (await textItems(document, page))
        .map((item) => item.str + (item.hasEOL ? "\n" : ""))
        .join("")
        .replace(/[ \t]+\n/g, "\n")
        .trim();
      pages.push(
        text.length > PAGE_TEXT_MAX_LENGTH
          ? { page, text: text.slice(0, PAGE_TEXT_MAX_LENGTH), truncated: true }
          : { page, text },
      );
    }
    return { pageCount: document.numPages, pages };
  });
}

const fold = (text: string) => text.replace(/\s+/g, "").toLowerCase();

/**
 * Where each quoted text first appears on its page, as one rectangle per run of text it covers.
 * A rectangle is the part of the run's box the quoted characters take up, by their share of the
 * run's characters, so its edges are close but not exact.
 */
export async function locatePdfText(
  bytes: Uint8Array,
  quotes: ReadonlyArray<{ readonly page: number; readonly text: string }>,
): Promise<ReadonlyArray<ReadonlyArray<PdfRect>>> {
  return withDocument(bytes, async (document) => {
    const located: Array<ReadonlyArray<PdfRect>> = [];
    for (const [index, quote] of quotes.entries()) {
      try {
        located.push(locate(await textItems(document, quote.page), quote.text));
      } catch (cause) {
        if (cause instanceof PdfProblem) cause.index ??= index;
        throw cause;
      }
    }
    return located;
  });
}

function locate(items: ReadonlyArray<TextItem>, quote: string): ReadonlyArray<PdfRect> {
  // Each character that is not white space, with the run it belongs to and its place in it.
  const characters: Array<{ readonly item: number; readonly offset: number }> = [];
  let folded = "";
  for (const [item, run] of items.entries()) {
    for (let offset = 0; offset < run.str.length; offset++) {
      const character = fold(run.str[offset]!);
      if (character === "") continue;
      // A character can fold to several, such as a ligature in some fonts.
      for (const part of character) {
        folded += part;
        characters.push({ item, offset });
      }
    }
  }
  const wanted = fold(quote);
  const start = wanted === "" ? -1 : folded.indexOf(wanted);
  if (start === -1) throw new PdfProblem({ kind: "operation", reason: "text-not-found" });
  const spans = new Map<number, { from: number; to: number }>();
  for (const { item, offset } of characters.slice(start, start + wanted.length)) {
    const span = spans.get(item);
    if (span === undefined) spans.set(item, { from: offset, to: offset + 1 });
    else span.to = offset + 1;
  }
  const rects: Array<PdfRect> = [];
  for (const [index, span] of spans) {
    const run = items[index]!;
    const [a = 1, b = 0, , , x = 0, y = 0] = run.transform;
    const length = Math.max(1, run.str.length);
    const size = run.height > 0 ? run.height : Math.hypot(a, b);
    if (run.width <= 0 || size <= 0) continue;
    const from = (span.from / length) * run.width;
    const width = Math.max(0.5, ((span.to - span.from) / length) * run.width);
    // Text that runs up or down the page gets a box turned the same way.
    const vertical = Math.abs(b) > Math.abs(a);
    const forwards = vertical ? b >= 0 : a >= 0;
    const along = forwards ? from : -from - width;
    const descent = size * 0.22;
    rects.push(
      vertical
        ? { x: x - (forwards ? size - descent : descent), y: y + along, width: size, height: width }
        : { x: x + along, y: y - (forwards ? descent : size - descent), width, height: size },
    );
  }
  if (rects.length === 0) throw new PdfProblem({ kind: "operation", reason: "text-not-found" });
  return rects;
}
