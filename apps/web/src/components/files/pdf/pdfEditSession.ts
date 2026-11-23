import type {
  PdfAnnotation,
  PdfFieldValue,
  PdfFormField,
  PdfOperation,
  PdfRect,
  PdfSignaturePlacement,
} from "@codenine/contracts";

export const PDF_HIGHLIGHT_COLOUR = "FFE066";
/** The side of a note's icon in PDF points, as the server draws it. */
const PDF_NOTE_SIZE = 20;

/** A change the user has made that the file does not hold yet. `key` names it until it is saved. */
export type PdfPendingEdit =
  | {
      readonly kind: "highlight";
      readonly key: string;
      readonly page: number;
      readonly rects: ReadonlyArray<PdfRect>;
      readonly colour: string;
      readonly contents: string;
    }
  | {
      readonly kind: "note";
      readonly key: string;
      readonly page: number;
      readonly x: number;
      readonly y: number;
      readonly contents: string;
    }
  | { readonly kind: "remove"; readonly key: string; readonly id: string }
  | {
      readonly kind: "field";
      readonly key: string;
      readonly name: string;
      readonly value: PdfFieldValue;
    }
  | ({ readonly kind: "signature"; readonly key: string } & PdfSignaturePlacement);

export type PdfPendingEdits = ReadonlyArray<PdfPendingEdit>;

/**
 * Adds an edit as the newest. Typing in one field is one edit, so one undo takes the field back
 * to what it held before the typing began.
 */
export function addPdfEdit(edits: PdfPendingEdits, edit: PdfPendingEdit): PdfPendingEdits {
  const last = edits.at(-1);
  if (edit.kind === "field" && last?.kind === "field" && last.name === edit.name) {
    return [...edits.slice(0, -1), { ...edit, key: last.key }];
  }
  return [...edits, edit];
}

/** Changes an edit in place, as moving a signature or rewording a note does. */
export function changePdfEdit<K extends PdfPendingEdit["kind"]>(
  edits: PdfPendingEdits,
  key: string,
  kind: K,
  change: Partial<Omit<Extract<PdfPendingEdit, { kind: K }>, "kind" | "key">>,
): PdfPendingEdits {
  return edits.map((edit) =>
    edit.key === key && edit.kind === kind ? ({ ...edit, ...change } as PdfPendingEdit) : edit,
  );
}

export function dropPdfEdit(edits: PdfPendingEdits, key: string): PdfPendingEdits {
  return edits.filter((edit) => edit.key !== key);
}

export function undoPdfEdit(edits: PdfPendingEdits): PdfPendingEdits {
  return edits.slice(0, -1);
}

/** What one save sends: the operations in the order they were made, and the signatures. */
export function pdfEditRequest(edits: PdfPendingEdits): {
  readonly operations: ReadonlyArray<PdfOperation>;
  readonly signatures: ReadonlyArray<PdfSignaturePlacement>;
} {
  const operations: PdfOperation[] = [];
  const signatures: PdfSignaturePlacement[] = [];
  for (const edit of edits) {
    switch (edit.kind) {
      case "highlight":
        operations.push({
          type: "addHighlight",
          page: edit.page,
          rects: edit.rects,
          colour: edit.colour,
          ...(edit.contents.trim() === "" ? {} : { contents: edit.contents }),
        });
        break;
      case "note":
        operations.push({
          type: "addNote",
          page: edit.page,
          x: edit.x,
          y: edit.y,
          contents: edit.contents,
        });
        break;
      case "remove":
        operations.push({ type: "removeAnnotation", id: edit.id });
        break;
      case "field":
        operations.push({ type: "setField", name: edit.name, value: edit.value });
        break;
      case "signature": {
        const { kind: _kind, key: _key, ...placement } = edit;
        signatures.push(placement);
        break;
      }
    }
  }
  return { operations, signatures };
}

/** Each field's value as the user now sees it: the latest unsaved one, or the file's. */
export function pdfFieldValues(
  fields: ReadonlyArray<PdfFormField>,
  edits: PdfPendingEdits,
): ReadonlyMap<string, PdfFieldValue> {
  const values = new Map(fields.map((field) => [field.name, field.value]));
  for (const edit of edits) {
    if (edit.kind === "field" && values.has(edit.name)) values.set(edit.name, edit.value);
  }
  return values;
}

/** A highlight or note as the list and the page show it, saved or not. */
export interface PdfListedAnnotation {
  /** A saved annotation's id, or an unsaved one's edit key. */
  readonly key: string;
  readonly saved: boolean;
  readonly kind: "highlight" | "note";
  readonly page: number;
  readonly rect: PdfRect;
  readonly rects: ReadonlyArray<PdfRect>;
  readonly contents: string;
  readonly removable: boolean;
  /** A saved annotation the next save takes out; the key of the edit that does. */
  readonly removal: string | null;
}

const boundsOf = (rects: ReadonlyArray<PdfRect>): PdfRect => {
  const x = Math.min(...rects.map((rect) => rect.x));
  const y = Math.min(...rects.map((rect) => rect.y));
  return {
    x,
    y,
    width: Math.max(...rects.map((rect) => rect.x + rect.width)) - x,
    height: Math.max(...rects.map((rect) => rect.y + rect.height)) - y,
  };
};

/** The file's highlights and notes with the unsaved ones, in reading order. */
export function listPdfAnnotations(
  saved: ReadonlyArray<PdfAnnotation>,
  edits: PdfPendingEdits,
): ReadonlyArray<PdfListedAnnotation> {
  const removals = new Map(
    edits.flatMap((edit) => (edit.kind === "remove" ? [[edit.id, edit.key] as const] : [])),
  );
  const listed: PdfListedAnnotation[] = saved.map((annotation) => ({
    key: annotation.id,
    saved: true,
    kind: annotation.kind,
    page: annotation.page,
    rect: annotation.rect,
    rects: annotation.rects ?? [annotation.rect],
    contents: annotation.contents ?? "",
    removable: annotation.removable,
    removal: removals.get(annotation.id) ?? null,
  }));
  for (const edit of edits) {
    if (edit.kind === "highlight") {
      listed.push({
        key: edit.key,
        saved: false,
        kind: "highlight",
        page: edit.page,
        rect: boundsOf(edit.rects),
        rects: edit.rects,
        contents: edit.contents,
        removable: true,
        removal: null,
      });
    } else if (edit.kind === "note") {
      const rect = {
        x: edit.x,
        y: edit.y - PDF_NOTE_SIZE,
        width: PDF_NOTE_SIZE,
        height: PDF_NOTE_SIZE,
      };
      listed.push({
        key: edit.key,
        saved: false,
        kind: "note",
        page: edit.page,
        rect,
        rects: [rect],
        contents: edit.contents,
        removable: true,
        removal: null,
      });
    }
  }
  // Top of the page first: a stored rectangle's upper edge is its largest y.
  return listed.toSorted(
    (a, b) => a.page - b.page || b.rect.y + b.rect.height - (a.rect.y + a.rect.height),
  );
}

/**
 * The edits that still apply to a file that changed underneath them: a removal of an annotation
 * the file no longer holds, or a value for a field it no longer has, is dropped.
 */
export function rebasePdfEdits(
  edits: PdfPendingEdits,
  file: {
    readonly annotations: ReadonlyArray<PdfAnnotation>;
    readonly fields: ReadonlyArray<PdfFormField>;
  },
): PdfPendingEdits {
  const ids = new Set(file.annotations.map((annotation) => annotation.id));
  const names = new Set(file.fields.map((field) => field.name));
  return edits.filter((edit) =>
    edit.kind === "remove" ? ids.has(edit.id) : edit.kind === "field" ? names.has(edit.name) : true,
  );
}
