// @effect-diagnostics nodeBuiltinImport:off - annotation ids are random, images arrive as base64, and a parse carries its own budget.
import * as NodeAsyncHooks from "node:async_hooks";
import * as NodeCrypto from "node:crypto";

import {
  decodePDFRawStream,
  degrees,
  EncryptedPDFError,
  PDFArray,
  PDFBool,
  PDFCheckBox,
  PDFContext,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  type PDFField,
  type PDFFont,
  type PDFForm,
  PDFHexString,
  type PDFImage,
  PDFName,
  PDFNumber,
  PDFOptionList,
  type PDFPage,
  PDFRadioGroup,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  PDFTextField,
  rgb,
  StandardFonts,
} from "@cantoo/pdf-lib";
import {
  PDF_SIGNATURE_IMAGE_MAX_BYTES,
  PDF_SIGNATURE_IMAGE_MAX_PIXELS,
  type PdfAnnotation,
  type PdfFieldValue,
  type PdfFormField,
  type PdfOperation,
  type PdfOperationError,
  type PdfRect,
  type PdfRefusalReason,
  type PdfSignaturePlacement,
} from "@codenine/contracts";
import {
  fitPdfImage,
  normalizePdfRotation,
  type PdfPageGeometry,
  pdfSignatureLayout,
  viewToPdfPoint,
} from "@codenine/shared/pdfGeometry";

export type PdfProblemDetail =
  | { readonly kind: "refused"; readonly reason: PdfRefusalReason }
  | { readonly kind: "operation"; readonly reason: PdfOperationError["reason"] };

/** Thrown by the PDF code; the service turns it into the matching typed error. */
// @effect-diagnostics-next-line extendsNativeError:off - thrown by pure code and mapped to a typed error at the service.
export class PdfProblem extends Error {
  readonly detail: PdfProblemDetail;
  /** The operation or signature that could not be applied. */
  index: number | undefined = undefined;
  constructor(detail: PdfProblemDetail) {
    super(detail.kind === "refused" ? detail.reason : detail.reason);
    this.detail = detail;
  }
}

const refused = (reason: PdfRefusalReason) => new PdfProblem({ kind: "refused", reason });
const invalid = (reason: PdfOperationError["reason"]) =>
  new PdfProblem({ kind: "operation", reason });

export interface PdfContents {
  readonly annotations: ReadonlyArray<PdfAnnotation>;
  readonly fields: ReadonlyArray<PdfFormField>;
}

/** Marks the annotations made here, which are the ones that can be removed here. */
const OWN_ANNOTATION_PREFIX = "codenine-";
const NOTE_SIZE = 20;
const NOTE_COLOUR = "FFD54A";

const name = (value: string) => PDFName.of(value);

const text = (value: unknown): string | undefined =>
  value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : undefined;

const numbers = (value: unknown): ReadonlyArray<number> | undefined => {
  if (!(value instanceof PDFArray)) return undefined;
  const out: number[] = [];
  for (let index = 0; index < value.size(); index++) {
    const item = value.lookup(index);
    if (!(item instanceof PDFNumber)) return undefined;
    out.push(item.asNumber());
  }
  return out;
};

const boxOf = (points: ReadonlyArray<number>): PdfRect | undefined => {
  const xs = points.filter((_, index) => index % 2 === 0);
  const ys = points.filter((_, index) => index % 2 === 1);
  if (xs.length === 0 || xs.length !== ys.length) return undefined;
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  // The wire refuses an empty rectangle, and one that thin could not be seen anyway.
  return {
    x,
    y,
    width: Math.max(0.5, Math.max(...xs) - x),
    height: Math.max(0.5, Math.max(...ys) - y),
  };
};

const colourOf = (value: unknown): string | undefined => {
  const parts = numbers(value);
  if (parts === undefined) return undefined;
  const channels =
    parts.length === 3 ? parts : parts.length === 1 ? [parts[0]!, parts[0]!, parts[0]!] : null;
  if (channels === null) return undefined;
  return channels
    .map((channel) =>
      Math.round(Math.min(1, Math.max(0, channel)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")
    .toUpperCase();
};

const channelsOf = (colour: string): readonly [number, number, number] => [
  Number.parseInt(colour.slice(0, 2), 16) / 255,
  Number.parseInt(colour.slice(2, 4), 16) / 255,
  Number.parseInt(colour.slice(4, 6), 16) / 255,
];

const number = (value: number) => String(Math.round(value * 1000) / 1000);

/** How much a PDF's packed streams may unpack to while it is read and changed. */
export interface PdfUnpackLimits {
  readonly maxUnpackedBytes: number;
}

export const DEFAULT_PDF_UNPACK_LIMITS: PdfUnpackLimits = { maxUnpackedBytes: 64 * 1024 * 1024 };

interface UnpackBudget {
  remaining: number;
  exceeded: boolean;
}

const unpackBudget = new NodeAsyncHooks.AsyncLocalStorage<UnpackBudget>();

interface GrowingStream {
  readonly buffer: Uint8Array;
  readonly minBufferLength: number;
  ensureBuffer(requested: number): Uint8Array;
}

/**
 * pdf-lib unpacks object streams whole as it loads and has no limit of its own, so a small file
 * could ask for gigabytes. Its decoders all grow their output through one method, which is made
 * to count that growth against the budget of the parse it runs in.
 */
const unpackLimitInstalled = (() => {
  let prototype: unknown = decodePDFRawStream(
    PDFRawStream.of(PDFContext.create().obj({ Filter: "FlateDecode" }), Uint8Array.of(0x78, 0x9c)),
  );
  while (prototype !== null && !Object.hasOwn(prototype as object, "ensureBuffer")) {
    prototype = Object.getPrototypeOf(prototype);
  }
  if (prototype === null) return false;
  const decoder = prototype as GrowingStream;
  const grow = decoder.ensureBuffer;
  decoder.ensureBuffer = function (this: GrowingStream, requested: number) {
    const budget = unpackBudget.getStore();
    const held = this.buffer.byteLength;
    if (budget !== undefined && requested > held) {
      let size = this.minBufferLength;
      while (size < requested) size *= 2;
      budget.remaining -= size - held;
      if (budget.remaining < 0) budget.exceeded = true;
      // The parser skips an object it cannot read, so every later stream is refused as well.
      if (budget.exceeded) throw refused("too-large");
    }
    return grow.call(this, requested);
  };
  return true;
})();

/** Runs PDF work with a budget for what its streams unpack to. */
async function bounded<A>(limits: PdfUnpackLimits, run: (budget: UnpackBudget) => Promise<A>) {
  // Without the counter a file's unpacked size is unknown, so nothing is read.
  if (!unpackLimitInstalled) throw refused("damaged");
  const budget = { remaining: limits.maxUnpackedBytes, exceeded: false };
  return unpackBudget.run(budget, () => run(budget));
}

const signatureKeys = [name("ByteRange")] as const;

/** True when the object, or anything stored directly inside it, is a signature dictionary. */
function holdsSignature(object: unknown): boolean {
  if (object instanceof PDFStream) return holdsSignature(object.dict);
  if (object instanceof PDFArray) return object.asArray().some(holdsSignature);
  if (!(object instanceof PDFDict)) return false;
  if (signatureKeys.some((key) => object.has(key))) return true;
  return object.values().some(holdsSignature);
}

/** A signature dictionary anywhere in the file: its byte range covers the bytes a save rewrites. */
function hasCertificateSignature(document: PDFDocument): boolean {
  for (const [, object] of document.context.enumerateIndirectObjects()) {
    if (holdsSignature(object)) return true;
  }
  const perms = document.catalog.lookup(name("Perms"));
  return perms instanceof PDFDict && perms.keys().length > 0;
}

async function load(bytes: Uint8Array, budget: UnpackBudget): Promise<PDFDocument> {
  let document: PDFDocument;
  try {
    // The file's own dates and producer are kept: this is the user's document, not a new one.
    document = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (cause) {
    if (budget.exceeded) throw refused("too-large");
    throw refused(cause instanceof EncryptedPDFError ? "encrypted" : "damaged");
  }
  if (budget.exceeded) throw refused("too-large");
  if (document.isEncrypted) throw refused("encrypted");
  let signed: boolean;
  try {
    document.getPages();
    signed = hasCertificateSignature(document);
  } catch {
    throw refused("damaged");
  }
  if (signed) throw refused("certificate-signed");
  return document;
}

interface PageAnnotation {
  readonly page: number;
  readonly dict: PDFDict;
  readonly ref: PDFRef | null;
}

function pageAnnotations(document: PDFDocument): ReadonlyArray<PageAnnotation> {
  const found: PageAnnotation[] = [];
  document.getPages().forEach((page, pageIndex) => {
    const annotations = page.node.Annots();
    if (annotations === undefined) return;
    for (let index = 0; index < annotations.size(); index++) {
      const raw = annotations.get(index);
      const dict = annotations.lookup(index);
      if (!(dict instanceof PDFDict)) continue;
      found.push({ page: pageIndex, dict, ref: raw instanceof PDFRef ? raw : null });
    }
  });
  return found;
}

function readAnnotations(all: ReadonlyArray<PageAnnotation>): ReadonlyArray<PdfAnnotation> {
  const out: PdfAnnotation[] = [];
  all.forEach(({ page, dict, ref }, index) => {
    const subtype = dict.lookup(name("Subtype"));
    const kind =
      subtype === name("Highlight") ? "highlight" : subtype === name("Text") ? "note" : null;
    // A reply to another annotation is part of that one's thread, not a note of its own.
    if (kind === null || dict.has(name("IRT"))) return;
    const rect = boxOf(numbers(dict.lookup(name("Rect"))) ?? []);
    if (rect === undefined) return;
    const stored = text(dict.lookup(name("NM")));
    const own = stored?.startsWith(OWN_ANNOTATION_PREFIX) === true;
    const quads = (kind === "highlight" && numbers(dict.lookup(name("QuadPoints")))) || [];
    const rects: PdfRect[] = [];
    for (let at = 0; at + 8 <= quads.length; at += 8) {
      const quad = boxOf(quads.slice(at, at + 8));
      if (quad !== undefined) rects.push(quad);
    }
    const colour = colourOf(dict.lookup(name("C")));
    const contents = text(dict.lookup(name("Contents")));
    const author = text(dict.lookup(name("T")));
    out.push({
      id: own ? stored : ref === null ? `page-${page}-${index}` : `object-${ref.objectNumber}`,
      page,
      kind,
      rect,
      ...(kind === "highlight" ? { rects: rects.length > 0 ? rects : [rect] } : {}),
      ...(colour === undefined ? {} : { colour }),
      ...(contents === undefined || contents === "" ? {} : { contents }),
      ...(author === undefined || author === "" ? {} : { author }),
      removable: own,
    });
  });
  return out;
}

function fieldValue(field: PDFField): Omit<PdfFormField, "name" | "readOnly" | "widgets"> | null {
  if (field instanceof PDFTextField) {
    const maxLength = field.getMaxLength();
    return {
      value: { kind: "text", text: field.getText() ?? "" },
      ...(field.isMultiline() ? { multiline: true } : {}),
      ...(maxLength === undefined || maxLength < 1 ? {} : { maxLength }),
    };
  }
  if (field instanceof PDFCheckBox) {
    return { value: { kind: "checkbox", checked: field.isChecked() } };
  }
  if (field instanceof PDFRadioGroup) {
    return {
      value: { kind: "radio", option: field.getSelected() ?? null },
      options: field.getOptions(),
    };
  }
  if (field instanceof PDFDropdown) {
    return {
      value: { kind: "choice", options: field.getSelected() },
      options: field.getOptions(),
      multiple: field.isMultiselect(),
      list: false,
    };
  }
  if (field instanceof PDFOptionList) {
    return {
      value: { kind: "choice", options: field.getSelected() },
      options: field.getOptions(),
      multiple: field.isMultiselect(),
      list: true,
    };
  }
  return null;
}

function readFields(
  document: PDFDocument,
  all: ReadonlyArray<PageAnnotation>,
): ReadonlyArray<PdfFormField> {
  if (document.catalog.getAcroForm() === undefined) return [];
  const pageOf = new Map(all.map((annotation) => [annotation.dict, annotation.page]));
  const out: PdfFormField[] = [];
  for (const field of document.getForm().getFields()) {
    try {
      const read = fieldValue(field);
      if (read === null) continue;
      const options = field instanceof PDFRadioGroup ? field.getOptions() : [];
      const widgets: Array<PdfFormField["widgets"][number]> = [];
      field.acroField.getWidgets().forEach((widget, index) => {
        const page = pageOf.get(widget.dict);
        const rect = boxOf(numbers(widget.dict.lookup(name("Rect"))) ?? []);
        if (page === undefined || rect === undefined) return;
        const option = options[index];
        widgets.push({ page, rect, ...(option === undefined ? {} : { option }) });
      });
      if (widgets.length === 0) continue;
      out.push({ name: field.getName(), readOnly: field.isReadOnly(), widgets, ...read });
    } catch {
      // A field the library cannot read, such as one holding rich text, is left as it is.
    }
  }
  return out;
}

function contentsOf(document: PDFDocument): PdfContents {
  const all = pageAnnotations(document);
  return { annotations: readAnnotations(all), fields: readFields(document, all) };
}

/** What a PDF holds that can be changed here, or why it cannot be changed. */
export async function inspectPdf(
  bytes: Uint8Array,
  limits: PdfUnpackLimits = DEFAULT_PDF_UNPACK_LIMITS,
): Promise<PdfContents & { readonly refusal?: PdfRefusalReason }> {
  try {
    return await bounded(limits, async (budget) => contentsOf(await load(bytes, budget)));
  } catch (cause) {
    const reason =
      cause instanceof PdfProblem && cause.detail.kind === "refused"
        ? cause.detail.reason
        : "damaged";
    return { refusal: reason, annotations: [], fields: [] };
  }
}

const pageAt = (document: PDFDocument, index: number): PDFPage => {
  const page = document.getPages()[index];
  if (page === undefined) throw invalid("unknown-page");
  return page;
};

/** The dictionary every annotation made here shares. */
const annotationBase = (id: string, page: PDFPage, now: Date, contents: string | undefined) => ({
  Type: "Annot",
  // Print, so the annotation is on paper as it is on screen.
  F: 4,
  NM: PDFString.of(id),
  M: PDFString.fromDate(now),
  CreationDate: PDFString.fromDate(now),
  P: page.ref,
  ...(contents === undefined || contents === ""
    ? {}
    : { Contents: PDFHexString.fromText(contents) }),
});

function addHighlight(
  document: PDFDocument,
  operation: Extract<PdfOperation, { type: "addHighlight" }>,
  now: Date,
) {
  const page = pageAt(document, operation.page);
  const { context } = document;
  const [red, green, blue] = channelsOf(operation.colour);
  const left = Math.min(...operation.rects.map((rect) => rect.x));
  const bottom = Math.min(...operation.rects.map((rect) => rect.y));
  const right = Math.max(...operation.rects.map((rect) => rect.x + rect.width));
  const top = Math.max(...operation.rects.map((rect) => rect.y + rect.height));
  const fill = operation.rects
    .map(
      (rect) =>
        `${number(rect.x)} ${number(rect.y)} ${number(rect.width)} ${number(rect.height)} re`,
    )
    .join("\n");
  // Multiply keeps the text under the colour readable, as a highlighter pen does.
  const appearance = context.register(
    context.stream(`/GS0 gs\n${number(red)} ${number(green)} ${number(blue)} rg\n${fill}\nf`, {
      Type: "XObject",
      Subtype: "Form",
      BBox: [left, bottom, right, top],
      Resources: { ExtGState: { GS0: { Type: "ExtGState", BM: "Multiply" } } },
    }),
  );
  const annotation = context.register(
    context.obj({
      ...annotationBase(
        `${OWN_ANNOTATION_PREFIX}${NodeCrypto.randomUUID()}`,
        page,
        now,
        operation.contents,
      ),
      Subtype: "Highlight",
      Rect: [left, bottom, right, top],
      // Upper left, upper right, lower left, lower right: the order readers expect in practice.
      QuadPoints: operation.rects.flatMap((rect) => [
        rect.x,
        rect.y + rect.height,
        rect.x + rect.width,
        rect.y + rect.height,
        rect.x,
        rect.y,
        rect.x + rect.width,
        rect.y,
      ]),
      C: [red, green, blue],
      AP: { N: appearance },
    }),
  );
  page.node.addAnnot(annotation);
}

function addNote(
  document: PDFDocument,
  operation: Extract<PdfOperation, { type: "addNote" }>,
  now: Date,
) {
  const page = pageAt(document, operation.page);
  const { context } = document;
  const [red, green, blue] = channelsOf(NOTE_COLOUR);
  const size = NOTE_SIZE;
  const lines = [13, 10, 7].map((y) => `4.5 ${y} m ${size - 4.5} ${y} l S`).join("\n");
  const appearance = context.register(
    context.stream(
      `${number(red)} ${number(green)} ${number(blue)} rg\n0.35 0.3 0.1 RG\n0.8 w\n1 1 ${size - 2} ${size - 2} re\nB\n${lines}`,
      { Type: "XObject", Subtype: "Form", BBox: [0, 0, size, size] },
    ),
  );
  const annotation = context.register(
    context.obj({
      ...annotationBase(
        `${OWN_ANNOTATION_PREFIX}${NodeCrypto.randomUUID()}`,
        page,
        now,
        operation.contents,
      ),
      Subtype: "Text",
      Name: "Comment",
      Rect: [operation.x, operation.y - size, operation.x + size, operation.y],
      C: [red, green, blue],
      AP: { N: appearance },
    }),
  );
  page.node.addAnnot(annotation);
}

function removeAnnotation(document: PDFDocument, id: string) {
  const all = pageAnnotations(document);
  const listed = readAnnotations(all);
  const known = listed.find((annotation) => annotation.id === id);
  if (known === undefined) throw invalid("unknown-annotation");
  if (!known.removable) throw invalid("annotation-not-removable");
  const found = all.find((annotation) => text(annotation.dict.lookup(name("NM"))) === id);
  if (found === undefined || found.ref === null) throw invalid("unknown-annotation");
  document.getPages()[found.page]!.node.removeAnnot(found.ref);
  const appearances = found.dict.lookup(name("AP"));
  const normal = appearances instanceof PDFDict ? appearances.get(name("N")) : undefined;
  if (normal instanceof PDFRef) document.context.delete(normal);
  document.context.delete(found.ref);
}

const printable = (font: PDFFont, value: string) => {
  const known = new Set(font.getCharacterSet());
  for (const character of value) {
    if (character === "\n" || character === "\r") continue;
    if (!known.has(character.codePointAt(0)!)) return false;
  }
  return true;
};

/** The built-in font cannot draw the field's value, so each reader draws it with its own. */
function leaveAppearanceToReaders(form: PDFForm, field: PDFField) {
  for (const widget of field.acroField.getWidgets()) widget.dict.delete(name("AP"));
  form.markFieldAsClean(field.ref);
  form.acroForm.dict.set(name("NeedAppearances"), PDFBool.True);
}

function setField(
  document: PDFDocument,
  operation: Extract<PdfOperation, { type: "setField" }>,
  helvetica: () => PDFFont,
) {
  const form = document.getForm();
  const field = form.getFieldMaybe(operation.name);
  if (field === undefined) throw invalid("unknown-field");
  if (field.isReadOnly()) throw invalid("field-read-only");
  const value: PdfFieldValue = operation.value;
  try {
    if (field instanceof PDFTextField && value.kind === "text") {
      const maxLength = field.getMaxLength();
      if (maxLength !== undefined && value.text.length > maxLength) {
        throw invalid("field-value-invalid");
      }
      if (value.text === "" || printable(helvetica(), value.text)) {
        field.setText(value.text === "" ? undefined : value.text);
        return;
      }
      field.acroField.setValue(PDFHexString.fromText(value.text));
      leaveAppearanceToReaders(form, field);
      return;
    }
    if (field instanceof PDFCheckBox && value.kind === "checkbox") {
      if (value.checked) field.check();
      else field.uncheck();
      return;
    }
    if (field instanceof PDFRadioGroup && value.kind === "radio") {
      if (value.option === null) field.clear();
      else if (field.getOptions().includes(value.option)) field.select(value.option);
      else throw invalid("field-value-invalid");
      return;
    }
    if (
      (field instanceof PDFDropdown || field instanceof PDFOptionList) &&
      value.kind === "choice"
    ) {
      const offered = new Set(field.getOptions());
      const custom =
        field instanceof PDFDropdown && field.isEditable() && value.options.length === 1;
      if (!custom && value.options.some((option) => !offered.has(option))) {
        throw invalid("field-value-invalid");
      }
      if (value.options.length > 1 && !field.isMultiselect()) throw invalid("field-value-invalid");
      if (value.options.length === 0) field.clear();
      else field.select([...value.options]);
      // A list draws every option and a drop-down the chosen one.
      const shown = field instanceof PDFOptionList ? field.getOptions() : value.options;
      if (shown.every((option) => printable(helvetica(), option))) return;
      leaveAppearanceToReaders(form, field);
      return;
    }
  } catch (cause) {
    if (cause instanceof PdfProblem) throw cause;
    throw invalid("field-value-invalid");
  }
  throw invalid("field-value-invalid");
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const startsWith = (bytes: Uint8Array, magic: ReadonlyArray<number>) =>
  magic.every((byte, index) => bytes[index] === byte);

async function embedSignatureImage(
  document: PDFDocument,
  dataBase64: string,
  mediaType: "image/png" | "image/jpeg",
): Promise<PDFImage> {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64)) throw invalid("signature-image-invalid");
  const bytes = Buffer.from(dataBase64, "base64");
  if (bytes.byteLength > PDF_SIGNATURE_IMAGE_MAX_BYTES) throw invalid("signature-image-too-large");
  const png = mediaType === "image/png";
  if (!startsWith(bytes, png ? PNG_MAGIC : JPEG_MAGIC)) throw invalid("signature-image-invalid");
  // A PNG is unpacked to its pixels to be embedded, so a small file must not claim a huge image.
  if (png && bytes.byteLength >= 24) {
    if (bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > PDF_SIGNATURE_IMAGE_MAX_PIXELS) {
      throw invalid("signature-image-too-large");
    }
  }
  try {
    const image = await (png ? document.embedPng(bytes) : document.embedJpg(bytes));
    if (image.width < 1 || image.height < 1) throw invalid("signature-image-invalid");
    return image;
  } catch (cause) {
    throw cause instanceof PdfProblem ? cause : invalid("signature-image-invalid");
  }
}

/** Draws the signature into the page's own content, upright as the page is shown. */
async function placeSignature(
  document: PDFDocument,
  signature: PdfSignaturePlacement,
  helvetica: () => PDFFont,
) {
  const page = pageAt(document, signature.page);
  const image = await embedSignatureImage(
    document,
    signature.image.dataBase64,
    signature.image.mediaType,
  );
  const { rect } = signature;
  const rotation = normalizePdfRotation(page.getRotation().angle);
  // The block as the reader sees it, with its upper left corner at the origin.
  const block: PdfPageGeometry = {
    box: [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height],
    rotation,
    scale: 1,
  };
  const width = rotation % 180 === 0 ? rect.width : rect.height;
  const height = rotation % 180 === 0 ? rect.height : rect.width;
  const layout = pdfSignatureLayout(width, height);
  const rotate = degrees(rotation);

  const drawn = fitPdfImage({ width, height: layout.imageHeight }, image);
  page.drawImage(image, {
    ...viewToPdfPoint(block, { x: 0, y: layout.imageHeight }),
    width: drawn.width,
    height: drawn.height,
    rotate,
  });

  const lines = [signature.name, signature.date];
  const font = helvetica();
  if (lines.every((line) => printable(font, line))) {
    lines.forEach((line, index) => {
      const fitted = Math.min(
        layout.fontSize,
        (layout.fontSize * width) / Math.max(1, font.widthOfTextAtSize(line, layout.fontSize)),
      );
      page.drawText(line, {
        ...viewToPdfPoint(block, {
          x: 0,
          y: layout.imageHeight + layout.lineHeight * (index + 1) - layout.fontSize * 0.25,
        }),
        size: fitted,
        font,
        color: rgb(0.1, 0.1, 0.1),
        rotate,
      });
    });
    return;
  }
  if (signature.captionImageBase64 === undefined) throw invalid("signature-text-unprintable");
  const caption = await embedSignatureImage(document, signature.captionImageBase64, "image/png");
  const fitted = fitPdfImage({ width, height: layout.captionHeight }, caption);
  page.drawImage(caption, {
    ...viewToPdfPoint(block, { x: 0, y: layout.imageHeight + fitted.height }),
    width: fitted.width,
    height: fitted.height,
    rotate,
  });
}

interface PdfEdit {
  readonly operations: ReadonlyArray<PdfOperation>;
  readonly signatures: ReadonlyArray<PdfSignaturePlacement>;
  readonly now: Date;
  readonly limits?: PdfUnpackLimits;
}

/**
 * The PDF with the operations and then the signatures applied, and what it then holds, or a
 * `PdfProblem` with nothing changed. Highlights, notes and form values stay standard annotations
 * and fields; a signature is drawn into its page.
 */
export async function editPdf(
  bytes: Uint8Array,
  edit: PdfEdit,
): Promise<PdfContents & { readonly bytes: Uint8Array }> {
  if (edit.operations.length === 0 && edit.signatures.length === 0) {
    throw invalid("nothing-to-save");
  }
  return bounded(edit.limits ?? DEFAULT_PDF_UNPACK_LIMITS, (budget) =>
    applyEdit(bytes, edit, budget),
  );
}

async function applyEdit(bytes: Uint8Array, edit: PdfEdit, budget: UnpackBudget) {
  const document = await load(bytes, budget);
  let font: PDFFont | undefined;
  // Embedded only when something is printed with it, so other edits add no font to the file.
  const helvetica = () => (font ??= document.embedStandardFont(StandardFonts.Helvetica));
  const each = async <A>(items: ReadonlyArray<A>, apply: (item: A) => Promise<void> | void) => {
    for (const [index, item] of items.entries()) {
      try {
        await apply(item);
      } catch (cause) {
        if (cause instanceof PdfProblem) cause.index ??= index;
        throw cause;
      }
    }
  };
  await each(edit.operations, (operation) => {
    switch (operation.type) {
      case "addHighlight":
        return addHighlight(document, operation, edit.now);
      case "addNote":
        return addNote(document, operation, edit.now);
      case "removeAnnotation":
        return removeAnnotation(document, operation.id);
      case "setField":
        return setField(document, operation, helvetica);
    }
  });
  await each(edit.signatures, (signature) => placeSignature(document, signature, helvetica));
  // Only the fields changed here are redrawn. The library would also redraw every field that
  // has no appearance, with "?" for each character its built-in font lacks.
  if (edit.operations.some((operation) => operation.type === "setField")) {
    const form = document.getForm();
    for (const field of form.getFields()) {
      if (form.fieldIsDirty(field.ref)) field.defaultUpdateAppearances(helvetica());
    }
  }
  const saved = await document.save({ updateFieldAppearances: false });
  // Read from the document just written, which spares parsing the result a second time.
  return { bytes: saved, ...contentsOf(document) };
}
