import type {
  SpreadsheetCell,
  SpreadsheetCellInput,
  SpreadsheetOperation,
} from "@codenine/contracts";

import {
  type SpreadsheetLimits,
  type SpreadsheetModel,
  atOperation,
  invalidOperation,
  tooLarge,
  unsupported,
} from "./problems.ts";
import { MAX_COLUMNS, MAX_ROWS } from "./references.ts";

const SHEET_NAME = "Sheet1";
const BYTE_ORDER_MARK = [0xef, 0xbb, 0xbf];

interface DelimitedRecord {
  fields: Array<string>;
  /** The record as the file had it, which is written back untouched until a field changes. */
  raw: string | null;
  /** The line ending after the record: empty for a last line without one. */
  ending: string;
}

function parseRecords(text: string, delimiter: string): Array<DelimitedRecord> {
  const records: Array<DelimitedRecord> = [];
  let fields: Array<string> = [];
  let field = "";
  let recordStart = 0;
  let index = 0;
  const endRecord = (end: number, ending: string) => {
    fields.push(field);
    records.push({ fields, raw: text.slice(recordStart, end), ending });
    fields = [];
    field = "";
    recordStart = end + ending.length;
  };
  while (index < text.length) {
    const character = text[index]!;
    if (character === '"' && field === "") {
      // A quoted field runs to its closing quote; a doubled quote is one quote inside it.
      let end = index + 1;
      let value = "";
      while (end < text.length) {
        if (text[end] === '"') {
          if (text[end + 1] === '"') {
            value += '"';
            end += 2;
          } else break;
        } else {
          value += text[end];
          end += 1;
        }
      }
      field = value;
      index = end + 1;
      // Text after the closing quote belongs to the field, as lenient readers treat it.
      while (
        index < text.length &&
        !(text[index] === delimiter || text[index] === "\n" || text[index] === "\r")
      ) {
        field += text[index];
        index += 1;
      }
      continue;
    }
    if (character === delimiter) {
      fields.push(field);
      field = "";
      index += 1;
    } else if (character === "\n" || character === "\r") {
      const ending = character === "\r" && text[index + 1] === "\n" ? "\r\n" : character;
      endRecord(index, ending);
      index += ending.length;
    } else {
      field += character;
      index += 1;
    }
  }
  if (recordStart < text.length) endRecord(text.length, "");
  return records;
}

const fieldText = (field: string, delimiter: string) =>
  field.includes(delimiter) || /["\r\n]/.test(field) || /^\s|\s$/.test(field)
    ? `"${field.replaceAll('"', '""')}"`
    : field;

function inputText(input: SpreadsheetCellInput): string {
  switch (input.kind) {
    case "blank":
      return "";
    case "text":
      return input.text;
    case "number":
      return String(input.number);
    case "boolean":
      return input.boolean ? "TRUE" : "FALSE";
    case "formula":
      return input.formula.startsWith("=") ? input.formula : `=${input.formula}`;
  }
}

/**
 * A CSV or TSV file as one sheet of text. Records an edit does not touch are written back byte
 * for byte, with the file's byte order mark and line endings.
 */
export class DelimitedTable implements SpreadsheetModel {
  readonly format = "delimited";
  readonly date1904 = false;
  private readonly limits: SpreadsheetLimits;
  private readonly delimiter: string;
  private readonly byteOrderMark: boolean;
  private readonly ending: string;
  private records: Array<DelimitedRecord>;

  private constructor(input: {
    limits: SpreadsheetLimits;
    delimiter: string;
    byteOrderMark: boolean;
    records: Array<DelimitedRecord>;
  }) {
    this.limits = input.limits;
    this.delimiter = input.delimiter;
    this.byteOrderMark = input.byteOrderMark;
    this.records = input.records;
    this.ending = input.records.find((record) => record.ending !== "")?.ending ?? "\n";
  }

  static open(bytes: Uint8Array, delimiter: string, limits: SpreadsheetLimits): DelimitedTable {
    const byteOrderMark = BYTE_ORDER_MARK.every((byte, index) => bytes[index] === byte);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        byteOrderMark ? bytes.subarray(BYTE_ORDER_MARK.length) : bytes,
      );
    } catch {
      // Another encoding, such as UTF-16 or Windows-1252, would be damaged by a UTF-8 save.
      throw unsupported("text-encoding");
    }
    if (text.includes("\u0000")) throw unsupported("text-encoding");
    const records = parseRecords(text, delimiter);
    let cells = 0;
    for (const record of records) cells += record.fields.length;
    if (cells > limits.maxCells) throw tooLarge("cell-count");
    return new DelimitedTable({ limits, delimiter, byteOrderMark, records });
  }

  sheets() {
    return [{ name: SHEET_NAME }];
  }

  async readRange(input: {
    readonly sheet: string;
    readonly row: number;
    readonly column: number;
    readonly rowCount: number;
    readonly columnCount: number;
  }) {
    this.assertSheet(input.sheet);
    const cells: Array<SpreadsheetCell> = [];
    const lastRow = Math.min(this.records.length, input.row + input.rowCount);
    for (let row = input.row; row < lastRow; row++) {
      const { fields } = this.records[row]!;
      const lastColumn = Math.min(fields.length, input.column + input.columnCount);
      for (let column = input.column; column < lastColumn; column++) {
        const value = fields[column]!;
        if (value !== "") cells.push({ row, column, value });
      }
    }
    let columnCount = 0;
    for (const record of this.records) columnCount = Math.max(columnCount, record.fields.length);
    return { rowCount: this.records.length, columnCount, cells, formats: {} };
  }

  async apply(operations: ReadonlyArray<SpreadsheetOperation>): Promise<void> {
    for (const [index, operation] of operations.entries()) {
      try {
        this.applyOne(operation);
      } catch (cause) {
        throw atOperation(cause, index);
      }
    }
  }

  private applyOne(operation: SpreadsheetOperation) {
    switch (operation.type) {
      case "setCell":
        this.assertSheet(operation.sheet);
        this.setCell(operation.row, operation.column, inputText(operation.input));
        break;
      case "insertRows":
        this.assertSheet(operation.sheet);
        if (Math.max(this.records.length, operation.index) + operation.count > MAX_ROWS) {
          throw invalidOperation("out-of-bounds");
        }
        // Rows below the last record hold nothing, so there is nothing to move down.
        if (operation.index >= this.records.length) break;
        this.records.splice(
          operation.index,
          0,
          ...Array.from({ length: operation.count }, () => this.emptyRecord()),
        );
        break;
      case "deleteRows":
        this.assertSheet(operation.sheet);
        this.records.splice(operation.index, operation.count);
        break;
      case "insertColumns":
      case "deleteColumns":
        this.assertSheet(operation.sheet);
        if (operation.index + operation.count > MAX_COLUMNS) {
          throw invalidOperation("out-of-bounds");
        }
        for (const record of this.records) {
          if (record.fields.length <= operation.index) continue;
          if (operation.type === "insertColumns") {
            record.fields.splice(operation.index, 0, ...Array<string>(operation.count).fill(""));
          } else record.fields.splice(operation.index, operation.count);
          record.raw = null;
        }
        break;
      case "setFormat":
        throw unsupported("delimited-formats");
      case "addSheet":
      case "renameSheet":
      case "deleteSheet":
        throw unsupported("delimited-sheets");
    }
  }

  async save(): Promise<Uint8Array> {
    let text = "";
    this.records.forEach((record, index) => {
      text +=
        record.raw ??
        record.fields.map((field) => fieldText(field, this.delimiter)).join(this.delimiter);
      // Only the last record may go without a line ending.
      text += record.ending === "" && index < this.records.length - 1 ? this.ending : record.ending;
    });
    const body = Buffer.from(text, "utf-8");
    return this.byteOrderMark ? Buffer.concat([Buffer.from(BYTE_ORDER_MARK), body]) : body;
  }

  private assertSheet(name: string) {
    if (name.toLowerCase() !== SHEET_NAME.toLowerCase()) throw invalidOperation("unknown-sheet");
  }

  private emptyRecord(): DelimitedRecord {
    return { fields: [""], raw: null, ending: this.ending };
  }

  private padRows(length: number) {
    while (this.records.length < length) this.records.push(this.emptyRecord());
  }

  private setCell(row: number, column: number, value: string) {
    if (row >= MAX_ROWS || column >= MAX_COLUMNS) throw invalidOperation("out-of-bounds");
    if (value === "" && (this.records[row]?.fields.length ?? 0) <= column) return;
    if (row - this.records.length + column > this.limits.maxCells) throw tooLarge("cell-count");
    this.padRows(row + 1);
    const record = this.records[row]!;
    while (record.fields.length <= column) record.fields.push("");
    if (record.fields[column] === value) return;
    record.fields[column] = value;
    record.raw = null;
  }
}
