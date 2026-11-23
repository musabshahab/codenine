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
      "last-sheet",
    ]),
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
    ]),
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
