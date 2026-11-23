import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

const SPREADSHEET_PATH_MAX_LENGTH = 512;
/** The most cells one range read returns, so a page stays small on the wire. */
const SPREADSHEET_RANGE_MAX_ROWS = 500;
const SPREADSHEET_RANGE_MAX_COLUMNS = 200;
const SPREADSHEET_EDIT_MAX_OPERATIONS = 20_000;

const SpreadsheetPath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(SPREADSHEET_PATH_MAX_LENGTH),
);
// The operation of an edit that was refused, so the caller can save the others without it.
const RefusedOperation = { operationIndex: Schema.optionalKey(NonNegativeInt) };
const SheetName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255));
const CellText = Schema.String.check(Schema.isMaxLength(32_767));

export const SpreadsheetSheet = Schema.Struct({
  name: SheetName,
  hidden: Schema.optionalKey(Schema.Boolean),
});
export type SpreadsheetSheet = typeof SpreadsheetSheet.Type;

export const SpreadsheetOpenInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: SpreadsheetPath,
});
export type SpreadsheetOpenInput = typeof SpreadsheetOpenInput.Type;

export const SpreadsheetOpenResult = Schema.Struct({
  // The `version` a read of the file returns, which an edit names as `expectedVersion`.
  version: TrimmedNonEmptyString,
  // A delimited file is one sheet of text, without formulas, formats or more sheets.
  format: Schema.Literals(["xlsx", "delimited"]),
  sheets: Schema.Array(SpreadsheetSheet),
  // True when the workbook counts dates from 1904, as old Mac workbooks do.
  date1904: Schema.Boolean,
});
export type SpreadsheetOpenResult = typeof SpreadsheetOpenResult.Type;

export const SpreadsheetCellFormat = Schema.Struct({
  // An Excel number format code such as `0.00` or `yyyy-mm-dd`. Absent for General.
  numberFormat: Schema.optionalKey(Schema.String),
  bold: Schema.optionalKey(Schema.Boolean),
  // A fill colour as six hex digits, such as `FFF2CC`.
  fill: Schema.optionalKey(Schema.String),
});
export type SpreadsheetCellFormat = typeof SpreadsheetCellFormat.Type;

export const SpreadsheetCell = Schema.Struct({
  row: NonNegativeInt,
  column: NonNegativeInt,
  // Absent for a formula whose result is not known until a spreadsheet app recalculates it.
  value: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number, Schema.Boolean])),
  // Without the leading `=`.
  formula: Schema.optionalKey(Schema.String),
  // True when `value` is an error such as `#DIV/0!`.
  error: Schema.optionalKey(Schema.Boolean),
  // A key of the result's `formats`.
  format: Schema.optionalKey(Schema.String),
});
export type SpreadsheetCell = typeof SpreadsheetCell.Type;

export const SpreadsheetReadRangeInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: SpreadsheetPath,
  sheet: SheetName,
  row: NonNegativeInt,
  column: NonNegativeInt,
  rowCount: PositiveInt.check(Schema.isLessThanOrEqualTo(SPREADSHEET_RANGE_MAX_ROWS)),
  columnCount: PositiveInt.check(Schema.isLessThanOrEqualTo(SPREADSHEET_RANGE_MAX_COLUMNS)),
});
export type SpreadsheetReadRangeInput = typeof SpreadsheetReadRangeInput.Type;

export const SpreadsheetReadRangeResult = Schema.Struct({
  // A version other than the one the caller opened means the file changed since.
  version: TrimmedNonEmptyString,
  // The sheet's used size: one past its last row and column that hold anything.
  rowCount: NonNegativeInt,
  columnCount: NonNegativeInt,
  // Cells that hold a value, a formula or a format. Empty cells are left out.
  cells: Schema.Array(SpreadsheetCell),
  formats: Schema.Record(Schema.String, SpreadsheetCellFormat),
});
export type SpreadsheetReadRangeResult = typeof SpreadsheetReadRangeResult.Type;

export const SpreadsheetCellInput = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("blank") }),
  Schema.Struct({ kind: Schema.Literal("text"), text: CellText }),
  Schema.Struct({ kind: Schema.Literal("number"), number: Schema.Finite }),
  Schema.Struct({ kind: Schema.Literal("boolean"), boolean: Schema.Boolean }),
  // With or without the leading `=`.
  Schema.Struct({ kind: Schema.Literal("formula"), formula: CellText }),
]);
export type SpreadsheetCellInput = typeof SpreadsheetCellInput.Type;

const SpreadsheetSpan = {
  sheet: SheetName,
  // Zero-based index of the first row or column, and how many.
  index: NonNegativeInt,
  count: PositiveInt,
};

/** Operations run in order; a later one sees the sheet names and positions the earlier ones left. */
export const SpreadsheetOperation = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("setCell"),
    sheet: SheetName,
    row: NonNegativeInt,
    column: NonNegativeInt,
    input: SpreadsheetCellInput,
  }),
  Schema.Struct({
    type: Schema.Literal("setFormat"),
    sheet: SheetName,
    row: NonNegativeInt,
    column: NonNegativeInt,
    rowCount: PositiveInt,
    columnCount: PositiveInt,
    // Only the named properties change. A null fill clears it; an empty number format is General.
    format: Schema.Struct({
      numberFormat: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(255))),
      bold: Schema.optionalKey(Schema.Boolean),
      fill: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  }),
  Schema.Struct({ type: Schema.Literal("insertRows"), ...SpreadsheetSpan }),
  Schema.Struct({ type: Schema.Literal("deleteRows"), ...SpreadsheetSpan }),
  Schema.Struct({ type: Schema.Literal("insertColumns"), ...SpreadsheetSpan }),
  Schema.Struct({ type: Schema.Literal("deleteColumns"), ...SpreadsheetSpan }),
  Schema.Struct({ type: Schema.Literal("addSheet"), name: SheetName }),
  Schema.Struct({ type: Schema.Literal("renameSheet"), sheet: SheetName, name: SheetName }),
  Schema.Struct({ type: Schema.Literal("deleteSheet"), sheet: SheetName }),
]);
export type SpreadsheetOperation = typeof SpreadsheetOperation.Type;

export const SpreadsheetEditInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: SpreadsheetPath,
  // The `version` the caller opened. A file that differs is not written. Omit to apply the
  // operations to whatever is on disk.
  expectedVersion: Schema.optional(TrimmedNonEmptyString),
  operations: Schema.Array(SpreadsheetOperation).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(SPREADSHEET_EDIT_MAX_OPERATIONS),
  ),
});
export type SpreadsheetEditInput = typeof SpreadsheetEditInput.Type;

export const SpreadsheetEditResult = Schema.Struct({
  version: TrimmedNonEmptyString,
  sheets: Schema.Array(SpreadsheetSheet),
});
export type SpreadsheetEditResult = typeof SpreadsheetEditResult.Type;

/** The file, or what it unpacks to, is over a limit, so it was not opened or changed. */
export class SpreadsheetTooLargeError extends Schema.TaggedError<SpreadsheetTooLargeError>()(
  "SpreadsheetTooLargeError",
  {
    relativePath: Schema.String,
    limit: Schema.Literals(["file-size", "unpacked-size", "cell-count", "range-size"]),
    ...RefusedOperation,
  },
) {
  override get message(): string {
    switch (this.limit) {
      case "file-size":
        return `'${this.relativePath}' is too large to open as a spreadsheet here.`;
      case "unpacked-size":
        return `'${this.relativePath}' unpacks to more data than a spreadsheet may hold here.`;
      case "cell-count":
        return `'${this.relativePath}' has too many cells to open as a spreadsheet here.`;
      case "range-size":
        return "That range covers too many cells to change at once.";
    }
  }
}

/**
 * The file holds something an edit here would damage, or cannot be read as a spreadsheet. Nothing
 * was written.
 */
export class SpreadsheetUnsupportedError extends Schema.TaggedError<SpreadsheetUnsupportedError>()(
  "SpreadsheetUnsupportedError",
  {
    relativePath: Schema.String,
    feature: Schema.Literals([
      "not-a-workbook",
      "workbook-layout",
      "text-encoding",
      "delimited-formats",
      "delimited-sheets",
      "array-formula",
      "sheet-objects",
      "pivot-tables",
      "sheet-references",
      "last-sheet",
    ]),
    ...RefusedOperation,
  },
) {
  override get message(): string {
    switch (this.feature) {
      case "not-a-workbook":
        return `'${this.relativePath}' is not a workbook that can be opened here. It may be damaged or protected with a password.`;
      case "workbook-layout":
        return `'${this.relativePath}' is stored in a layout that cannot be edited here.`;
      case "text-encoding":
        return `'${this.relativePath}' is not UTF-8 text, so saving it here would damage it.`;
      case "delimited-formats":
        return "A CSV or TSV file cannot hold formats.";
      case "delimited-sheets":
        return "A CSV or TSV file holds one sheet.";
      case "array-formula":
        return "That cell is part of an array formula, which cannot be changed here.";
      case "sheet-objects":
        return "This sheet holds tables, charts, filters, comments or rules that this change would damage. Make the change in a spreadsheet app.";
      case "pivot-tables":
        return "A pivot table reads from this sheet, and this change would break it. Make the change in a spreadsheet app.";
      case "sheet-references":
        return "Formulas or names in this workbook refer to this sheet in a way this change would break. Make the change in a spreadsheet app.";
      case "last-sheet":
        return "A workbook needs at least one visible sheet.";
    }
  }
}

/** An operation names a sheet or position that does not exist, or a name that cannot be used. */
export class SpreadsheetOperationError extends Schema.TaggedError<SpreadsheetOperationError>()(
  "SpreadsheetOperationError",
  {
    relativePath: Schema.String,
    reason: Schema.Literals([
      "unknown-sheet",
      "sheet-name-taken",
      "sheet-name-invalid",
      "out-of-bounds",
      "format-invalid",
      "formula-invalid",
    ]),
    ...RefusedOperation,
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unknown-sheet":
        return "That sheet no longer exists.";
      case "sheet-name-taken":
        return "Another sheet already has that name.";
      case "sheet-name-invalid":
        return "A sheet name has 1 to 31 characters and none of [ ] : * ? / \\.";
      case "out-of-bounds":
        return "That is outside the rows and columns a sheet can hold.";
      case "format-invalid":
        return "That format cannot be used.";
      case "formula-invalid":
        return "That formula is not complete. Check its brackets and quotes.";
    }
  }
}

export class SpreadsheetFileError extends Schema.TaggedError<SpreadsheetFileError>()(
  "SpreadsheetFileError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const PDF_EDIT_MAX_OPERATIONS = 2000;
const PDF_EDIT_MAX_SIGNATURES = 20;
const PDF_HIGHLIGHT_MAX_RECTS = 500;
/** The largest signature image, as bytes before base64. A drawn or typed signature is far smaller. */
export const PDF_SIGNATURE_IMAGE_MAX_BYTES = 512 * 1024;
/** The most pixels a signature image may hold, which bounds the memory used to read it. */
export const PDF_SIGNATURE_IMAGE_MAX_PIXELS = 8_000_000;
const PDF_SIGNATURE_IMAGE_MAX_BASE64 = Math.ceil(PDF_SIGNATURE_IMAGE_MAX_BYTES / 3) * 4;

const PdfPoint = Schema.Finite.check(Schema.isBetween({ minimum: -100_000, maximum: 100_000 }));
const PdfLength = Schema.Finite.check(Schema.isBetween({ minimum: 0.5, maximum: 100_000 }));
const PdfNoteText = Schema.String.check(Schema.isMaxLength(10_000));
const PdfFieldName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024));
const PdfFieldText = Schema.String.check(Schema.isMaxLength(100_000));
// Six hex digits, such as `FFE066`.
const PdfColour = Schema.String.check(Schema.isPattern(/^[0-9A-Fa-f]{6}$/));

/**
 * A rectangle in the page's own PDF units (1/72 inch), with `x` and `y` its lower left corner
 * as the file stores it: before the page's rotation, and not relative to its crop box.
 */
export const PdfRect = Schema.Struct({
  x: PdfPoint,
  y: PdfPoint,
  width: PdfLength,
  height: PdfLength,
});
export type PdfRect = typeof PdfRect.Type;

/** Why a PDF cannot be changed here. It can still be read. */
export const PdfRefusalReason = Schema.Literals([
  "encrypted",
  "certificate-signed",
  "too-large",
  "damaged",
]);
export type PdfRefusalReason = typeof PdfRefusalReason.Type;

export function pdfRefusalMessage(reason: PdfRefusalReason): string {
  switch (reason) {
    case "encrypted":
      return "This PDF is protected with a password or permissions, so it cannot be changed here.";
    case "certificate-signed":
      return "This PDF carries a certificate signature that any change would invalidate, so it cannot be changed here.";
    case "too-large":
      return "This PDF is too large to change here.";
    case "damaged":
      return "This PDF could not be read for editing. It may be damaged.";
  }
}

export const PdfAnnotation = Schema.Struct({
  id: TrimmedNonEmptyString,
  // Zero-based.
  page: NonNegativeInt,
  kind: Schema.Literals(["highlight", "note"]),
  rect: PdfRect,
  // A highlight's marked areas, one per line of text. Absent for a note.
  rects: Schema.optionalKey(Schema.Array(PdfRect)),
  colour: Schema.optionalKey(PdfColour),
  contents: Schema.optionalKey(Schema.String),
  author: Schema.optionalKey(Schema.String),
  // True for an annotation made here, which is the only kind that can be removed here.
  removable: Schema.Boolean,
});
export type PdfAnnotation = typeof PdfAnnotation.Type;

export const PdfFieldValue = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("text"), text: PdfFieldText }),
  Schema.Struct({ kind: Schema.Literal("checkbox"), checked: Schema.Boolean }),
  // Null when no option is selected.
  Schema.Struct({ kind: Schema.Literal("radio"), option: Schema.NullOr(PdfFieldText) }),
  Schema.Struct({ kind: Schema.Literal("choice"), options: Schema.Array(PdfFieldText) }),
]);
export type PdfFieldValue = typeof PdfFieldValue.Type;

export const PdfFormField = Schema.Struct({
  name: PdfFieldName,
  value: PdfFieldValue,
  readOnly: Schema.Boolean,
  multiline: Schema.optionalKey(Schema.Boolean),
  maxLength: Schema.optionalKey(PositiveInt),
  // What a radio group or a choice field offers.
  options: Schema.optionalKey(Schema.Array(Schema.String)),
  // True for a choice field that takes several options at once.
  multiple: Schema.optionalKey(Schema.Boolean),
  // True for a choice field shown as a list, false for one shown as a drop-down.
  list: Schema.optionalKey(Schema.Boolean),
  // Where the field shows on the pages. A radio group has one per option.
  widgets: Schema.Array(
    Schema.Struct({
      page: NonNegativeInt,
      rect: PdfRect,
      option: Schema.optionalKey(Schema.String),
    }),
  ),
});
export type PdfFormField = typeof PdfFormField.Type;

export const PdfOpenInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: SpreadsheetPath,
});
export type PdfOpenInput = typeof PdfOpenInput.Type;

const PdfContents = {
  // Highlights and notes, in page order.
  annotations: Schema.Array(PdfAnnotation),
  // Form fields that can be filled in. Signature fields and buttons are left out.
  fields: Schema.Array(PdfFormField),
};

export const PdfOpenResult = Schema.Struct({
  // The `version` a read of the file returns, which an edit names as `expectedVersion`.
  version: TrimmedNonEmptyString,
  // Present when the PDF cannot be changed here.
  refusal: Schema.optionalKey(PdfRefusalReason),
  ...PdfContents,
});
export type PdfOpenResult = typeof PdfOpenResult.Type;

/** Changes to a PDF that are stored as standard annotations and form values. */
export const PdfOperation = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("addHighlight"),
    page: NonNegativeInt,
    rects: Schema.Array(PdfRect).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(PDF_HIGHLIGHT_MAX_RECTS),
    ),
    colour: PdfColour,
    contents: Schema.optionalKey(PdfNoteText),
  }),
  Schema.Struct({
    type: Schema.Literal("addNote"),
    page: NonNegativeInt,
    // The note icon's upper left corner as the page is stored.
    x: PdfPoint,
    y: PdfPoint,
    contents: PdfNoteText,
  }),
  Schema.Struct({ type: Schema.Literal("removeAnnotation"), id: TrimmedNonEmptyString }),
  Schema.Struct({ type: Schema.Literal("setField"), name: PdfFieldName, value: PdfFieldValue }),
]);
export type PdfOperation = typeof PdfOperation.Type;

/**
 * A signature the user placed: an image they drew, typed or uploaded, with their name and the
 * date printed under it. It becomes part of the page and cannot be moved or removed afterwards.
 */
export const PdfSignaturePlacement = Schema.Struct({
  page: NonNegativeInt,
  // The whole block as the page is stored: the image, and the name and date under it.
  rect: PdfRect,
  image: Schema.Struct({
    mediaType: Schema.Literals(["image/png", "image/jpeg"]),
    dataBase64: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(PDF_SIGNATURE_IMAGE_MAX_BASE64),
    ),
  }),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  // The date as the signer's device writes it, kept as text.
  date: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  // The name and date drawn as a PNG, for text the PDF's built-in font cannot print.
  captionImageBase64: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(PDF_SIGNATURE_IMAGE_MAX_BASE64)),
  ),
});
export type PdfSignaturePlacement = typeof PdfSignaturePlacement.Type;

export const PdfEditInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: SpreadsheetPath,
  // The `version` the caller opened. A file that differs is not written.
  expectedVersion: Schema.optional(TrimmedNonEmptyString),
  operations: Schema.Array(PdfOperation).check(Schema.isMaxLength(PDF_EDIT_MAX_OPERATIONS)),
  // Only a person signs. This is never offered to an agent.
  signatures: Schema.optionalKey(
    Schema.Array(PdfSignaturePlacement).check(Schema.isMaxLength(PDF_EDIT_MAX_SIGNATURES)),
  ),
});
export type PdfEditInput = typeof PdfEditInput.Type;

export const PdfEditResult = Schema.Struct({
  version: TrimmedNonEmptyString,
  ...PdfContents,
});
export type PdfEditResult = typeof PdfEditResult.Type;

/** The PDF cannot be changed here, so nothing was written. */
export class PdfRefusedError extends Schema.TaggedError<PdfRefusedError>()("PdfRefusedError", {
  relativePath: Schema.String,
  reason: PdfRefusalReason,
}) {
  override get message(): string {
    return pdfRefusalMessage(this.reason);
  }
}

/** An operation or signature cannot be applied to this PDF. Nothing was written. */
export class PdfOperationError extends Schema.TaggedError<PdfOperationError>()(
  "PdfOperationError",
  {
    relativePath: Schema.String,
    reason: Schema.Literals([
      "nothing-to-save",
      "unknown-page",
      "unknown-annotation",
      "annotation-not-removable",
      "unknown-field",
      "field-read-only",
      "field-value-invalid",
      "signature-image-invalid",
      "signature-image-too-large",
      "signature-text-unprintable",
    ]),
    // The index among the operations, or among the signatures for a signature reason.
    ...RefusedOperation,
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "nothing-to-save":
        return "There is nothing to save.";
      case "unknown-page":
        return "That page is not in this PDF any more.";
      case "unknown-annotation":
        return "That highlight or note is not in this PDF any more.";
      case "annotation-not-removable":
        return "Only highlights and notes made here can be removed here.";
      case "unknown-field":
        return "That form field is not in this PDF any more.";
      case "field-read-only":
        return "That form field is read-only.";
      case "field-value-invalid":
        return "That value does not fit the form field.";
      case "signature-image-invalid":
        return "The signature image is not a PNG or JPEG that can be read.";
      case "signature-image-too-large":
        return "The signature image is too large. Use one under 512 KB and 8 megapixels.";
      case "signature-text-unprintable":
        return "The name or date uses characters that could not be printed on the page.";
    }
  }
}

export class PdfFileError extends Schema.TaggedError<PdfFileError>()("PdfFileError", {
  message: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {}
