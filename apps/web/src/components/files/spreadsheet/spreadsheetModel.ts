import type { DocumentSelection } from "~/documentContext";
import type {
  SpreadsheetCellFormat,
  SpreadsheetCellInput,
  SpreadsheetOperation,
} from "@codenine/contracts";

import { formatNumber } from "./cellFormat";

/** The most rows the grid lays out, which keeps its height inside what browsers can scroll. */
export const MAX_GRID_ROWS = 500_000;
export const MAX_GRID_COLUMNS = 16_384;
const MAX_HISTORY_STEPS = 200;

export interface CellData {
  readonly value?: string | number | boolean;
  /** Without the leading `=`. */
  readonly formula?: string;
  readonly error?: boolean;
  readonly format?: SpreadsheetCellFormat;
}

export interface CellPosition {
  readonly row: number;
  readonly column: number;
}

export interface GridSelection {
  /** Where the selection started, which is the cell that takes input. */
  readonly anchor: CellPosition;
  readonly focus: CellPosition;
}

export interface GridArea {
  readonly top: number;
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
}

export const cellKey = (row: number, column: number) => row * MAX_GRID_COLUMNS + column;

/** A zero-based column as letters: 0 is A, 26 is AA. */
export function columnLabel(column: number): string {
  let label = "";
  for (let rest = column + 1; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    label = String.fromCharCode(65 + ((rest - 1) % 26)) + label;
  }
  return label;
}

export const cellLabel = ({ row, column }: CellPosition) => `${columnLabel(column)}${row + 1}`;

export const selectionArea = ({ anchor, focus }: GridSelection): GridArea => ({
  top: Math.min(anchor.row, focus.row),
  left: Math.min(anchor.column, focus.column),
  bottom: Math.max(anchor.row, focus.row),
  right: Math.max(anchor.column, focus.column),
});

export const areaCellCount = (area: GridArea) =>
  (area.bottom - area.top + 1) * (area.right - area.left + 1);

const clamp = (value: number, limit: number) => Math.max(0, Math.min(limit - 1, value));

/**
 * The selection after a key moves it. Extending keeps the anchor and moves the other corner;
 * otherwise the selection collapses to one cell next to the anchor.
 */
export function moveSelection(
  selection: GridSelection,
  move: { readonly rows: number; readonly columns: number },
  extend: boolean,
  bounds: { readonly rowCount: number; readonly columnCount: number },
): GridSelection {
  const from = extend ? selection.focus : selection.anchor;
  const focus = {
    row: clamp(from.row + move.rows, bounds.rowCount),
    column: clamp(from.column + move.columns, bounds.columnCount),
  };
  return { anchor: extend ? selection.anchor : focus, focus };
}

const NUMBER_PATTERN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const PERCENT_PATTERN = /^[+-]?(?:\d+\.?\d*|\.\d+)%$/;

/** What typed text becomes. A delimited file holds text only, so nothing is interpreted there. */
export function parseCellInput(text: string, format: "xlsx" | "delimited"): SpreadsheetCellInput {
  if (text === "") return { kind: "blank" };
  if (format === "delimited") return { kind: "text", text };
  if (text.startsWith("=") && text.length > 1) return { kind: "formula", formula: text.slice(1) };
  // A leading apostrophe keeps what follows as text, as spreadsheet apps do.
  if (text.startsWith("'"))
    return text.length === 1 ? { kind: "blank" } : { kind: "text", text: text.slice(1) };
  const trimmed = text.trim();
  if (NUMBER_PATTERN.test(trimmed)) {
    const number = Number(trimmed);
    if (Number.isFinite(number)) return { kind: "number", number };
  }
  if (PERCENT_PATTERN.test(trimmed)) {
    return { kind: "number", number: Number((Number(trimmed.slice(0, -1)) / 100).toPrecision(15)) };
  }
  if (/^true$/i.test(trimmed)) return { kind: "boolean", boolean: true };
  if (/^false$/i.test(trimmed)) return { kind: "boolean", boolean: false };
  return { kind: "text", text };
}

/** The input that would put a cell back as it is, for undo and for comparing edits. */
export function cellToInput(cell: CellData | undefined): SpreadsheetCellInput {
  if (cell === undefined) return { kind: "blank" };
  if (cell.formula !== undefined) return { kind: "formula", formula: cell.formula };
  switch (typeof cell.value) {
    case "number":
      return { kind: "number", number: cell.value };
    case "boolean":
      return { kind: "boolean", boolean: cell.value };
    case "string":
      return cell.value === "" ? { kind: "blank" } : { kind: "text", text: cell.value };
    default:
      return { kind: "blank" };
  }
}

/** What an edited cell shows before the server answers. A new formula has no result yet. */
export function cellFromInput(
  input: SpreadsheetCellInput,
  previous: CellData | undefined,
): CellData | undefined {
  const format = previous?.format === undefined ? {} : { format: previous.format };
  switch (input.kind) {
    case "blank":
      return previous?.format === undefined ? undefined : format;
    case "text":
      return { ...format, value: input.text };
    case "number":
      return { ...format, value: input.number };
    case "boolean":
      return { ...format, value: input.boolean };
    case "formula":
      return { ...format, formula: input.formula };
  }
}

/** The text that typing it again would reproduce the cell from: what the formula bar holds. */
export function cellEditText(cell: CellData | undefined, format: "xlsx" | "delimited"): string {
  const input = cellToInput(cell);
  switch (input.kind) {
    case "blank":
      return "";
    case "formula":
      return `=${input.formula}`;
    case "number":
      return String(input.number);
    case "boolean":
      return input.boolean ? "TRUE" : "FALSE";
    case "text":
      return parseCellInput(input.text, format).kind === "text" ? input.text : `'${input.text}`;
  }
}

/** What the grid shows in a cell. A formula without a result shows itself. */
export function cellDisplayText(cell: CellData | undefined, date1904: boolean): string {
  if (cell === undefined) return "";
  if (cell.value === undefined) return cell.formula === undefined ? "" : `=${cell.formula}`;
  if (typeof cell.value === "number") {
    return cell.error
      ? String(cell.value)
      : formatNumber(cell.value, cell.format?.numberFormat, date1904);
  }
  if (typeof cell.value === "boolean") return cell.value ? "TRUE" : "FALSE";
  return cell.value;
}

/** A cell as copied text: its formula, or its value without the format applied. */
export function cellCopyText(cell: CellData | undefined): string {
  if (cell?.formula !== undefined) return `=${cell.formula}`;
  if (typeof cell?.value === "boolean") return cell.value ? "TRUE" : "FALSE";
  return cell?.value === undefined ? "" : String(cell.value);
}

const sameInput = (left: SpreadsheetCellInput, right: SpreadsheetCellInput) =>
  JSON.stringify(left) === JSON.stringify(right);

export interface CellChange extends CellPosition {
  readonly sheet: string;
  readonly before: SpreadsheetCellInput;
  readonly after: SpreadsheetCellInput;
}

/** One entry per user action, so a paste undoes as a whole. */
export interface EditHistory {
  readonly undo: ReadonlyArray<ReadonlyArray<CellChange>>;
  readonly redo: ReadonlyArray<ReadonlyArray<CellChange>>;
}

export const EMPTY_HISTORY: EditHistory = { undo: [], redo: [] };

/** Records an action. Changes that leave a cell as it was are dropped; an empty action is not kept. */
export function recordChanges(
  history: EditHistory,
  changes: ReadonlyArray<CellChange>,
): { readonly history: EditHistory; readonly changes: ReadonlyArray<CellChange> } {
  const real = changes.filter((change) => !sameInput(change.before, change.after));
  if (real.length === 0) return { history, changes: real };
  return {
    history: { undo: [...history.undo, real].slice(-MAX_HISTORY_STEPS), redo: [] },
    changes: real,
  };
}

/** Takes the last action back. The returned changes are the ones to apply: each sets `after`. */
export function undoChanges(
  history: EditHistory,
): { readonly history: EditHistory; readonly changes: ReadonlyArray<CellChange> } | null {
  const step = history.undo.at(-1);
  if (step === undefined) return null;
  return {
    history: { undo: history.undo.slice(0, -1), redo: [...history.redo, step] },
    changes: step.map((change) => ({ ...change, before: change.after, after: change.before })),
  };
}

export function redoChanges(
  history: EditHistory,
): { readonly history: EditHistory; readonly changes: ReadonlyArray<CellChange> } | null {
  const step = history.redo.at(-1);
  if (step === undefined) return null;
  return {
    history: { undo: [...history.undo, step], redo: history.redo.slice(0, -1) },
    changes: step,
  };
}

export const changeOperations = (
  changes: ReadonlyArray<CellChange>,
): ReadonlyArray<SpreadsheetOperation> =>
  changes.map((change) => ({
    type: "setCell",
    sheet: change.sheet,
    row: change.row,
    column: change.column,
    input: change.after,
  }));

/** An area as tab-separated text, the form other spreadsheet apps paste. */
export function areaToClipboardText(
  area: GridArea,
  text: (row: number, column: number) => string,
): string {
  const lines: Array<string> = [];
  for (let row = area.top; row <= area.bottom; row++) {
    const cells: Array<string> = [];
    for (let column = area.left; column <= area.right; column++) {
      const value = text(row, column);
      cells.push(/["\t\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
    }
    lines.push(cells.join("\t"));
  }
  return lines.join("\n");
}

/** Clipboard text as rows of cells. A cell in quotes may hold tabs and line breaks. */
export function clipboardTextToRows(text: string): Array<Array<string>> {
  const rows: Array<Array<string>> = [];
  let row: Array<string> = [];
  let cell = "";
  const source = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!;
    if (character === '"' && cell === "") {
      let end = index + 1;
      while (end < source.length && !(source[end] === '"' && source[end + 1] !== '"')) {
        end += source[end] === '"' ? 2 : 1;
      }
      const next = source[end + 1];
      // A quote that is not closed before the next cell is a plain character.
      if (end < source.length && (next === undefined || next === "\t" || next === "\n")) {
        cell = source.slice(index + 1, end).replaceAll('""', '"');
        index = end;
        continue;
      }
    }
    if (character === "\t") {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += character;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

/**
 * Where pasted rows land. One copied cell fills the whole selection; anything larger is pasted
 * once from the selection's top-left corner. Only the sheet's own limits stop a paste, not the
 * part of it the grid has laid out; `dropped` counts the cells past them.
 */
export function pasteTargets(
  rows: ReadonlyArray<ReadonlyArray<string>>,
  area: GridArea,
): {
  readonly targets: Array<CellPosition & { readonly text: string }>;
  readonly dropped: number;
} {
  const targets: Array<CellPosition & { readonly text: string }> = [];
  let dropped = 0;
  const single = rows.length === 1 && rows[0]!.length === 1;
  const height = single ? area.bottom - area.top + 1 : rows.length;
  for (let rowOffset = 0; rowOffset < height; rowOffset++) {
    const source = single ? rows[0]! : rows[rowOffset]!;
    const width = single ? area.right - area.left + 1 : source.length;
    for (let columnOffset = 0; columnOffset < width; columnOffset++) {
      const row = area.top + rowOffset;
      const column = area.left + columnOffset;
      if (row >= MAX_GRID_ROWS || column >= MAX_GRID_COLUMNS) dropped += 1;
      else targets.push({ row, column, text: single ? source[0]! : source[columnOffset]! });
    }
  }
  return { targets, dropped };
}

/** The most selected cells whose values travel with a message; a larger selection sends its range only. */
const SELECTION_VALUES_MAX_CELLS = 100;

/** The selection as the chat's context chip reports it: the sheet, the range, and a small range's values. */
export function spreadsheetDocumentSelection(
  sheet: string,
  area: GridArea,
  text: (row: number, column: number) => string,
): DocumentSelection {
  const first = cellLabel({ row: area.top, column: area.left });
  const last = cellLabel({ row: area.bottom, column: area.right });
  const values =
    areaCellCount(area) <= SELECTION_VALUES_MAX_CELLS ? areaToClipboardText(area, text) : "";
  return {
    kind: "spreadsheet",
    sheet,
    range: first === last ? first : `${first}:${last}`,
    ...(values.trim() === "" ? {} : { values }),
  };
}

export const DEFAULT_COLUMN_WIDTH = 96;
const MIN_COLUMN_WIDTH = 40;
/** The widest a column grows to fit its text; a longer value is cut off until the user widens it. */
export const MAX_FITTED_COLUMN_WIDTH = 320;
const MAX_COLUMN_WIDTH = 800;

export function clampColumnWidth(width: number): number {
  return Math.round(Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, width)));
}

/** Where each column sits when some have a width of their own. Lookups cost a search of those few. */
export interface ColumnLayout {
  readonly widthOf: (column: number) => number;
  /** The left edge of a column, from the left edge of column A. */
  readonly offsetOf: (column: number) => number;
  /** The column under a distance from the left edge of column A. */
  readonly columnAt: (offset: number) => number;
}

export function columnLayout(widths: ReadonlyMap<number, number>): ColumnLayout {
  const columns = [...widths.keys()].sort((a, b) => a - b);
  // lefts[i] is the left edge of the i-th sized column.
  const lefts: Array<number> = [];
  let extra = 0;
  for (const column of columns) {
    lefts.push(column * DEFAULT_COLUMN_WIDTH + extra);
    extra += widths.get(column)! - DEFAULT_COLUMN_WIDTH;
  }
  /** How many sized columns satisfy `before`, which holds for a prefix of them. */
  const count = (before: (index: number) => boolean) => {
    let low = 0;
    let high = columns.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (before(middle)) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const widthOf = (column: number) => widths.get(column) ?? DEFAULT_COLUMN_WIDTH;
  return {
    widthOf,
    offsetOf: (column) => {
      const index = count((i) => columns[i]! < column);
      if (index === 0) return column * DEFAULT_COLUMN_WIDTH;
      const last = columns[index - 1]!;
      return lefts[index - 1]! + widthOf(last) + (column - last - 1) * DEFAULT_COLUMN_WIDTH;
    },
    columnAt: (offset) => {
      const index = count((i) => lefts[i]! <= offset);
      if (index === 0) return Math.floor(offset / DEFAULT_COLUMN_WIDTH);
      const last = columns[index - 1]!;
      const past = offset - lefts[index - 1]! - widthOf(last);
      return past < 0 ? last : last + 1 + Math.floor(past / DEFAULT_COLUMN_WIDTH);
    },
  };
}

/** The width that shows the widest of a column's texts, within the limits a fitted column keeps. */
export function fittedColumnWidth(textWidths: Iterable<number>, padding: number): number {
  let widest = 0;
  for (const width of textWidths) widest = Math.max(widest, width);
  return Math.round(
    Math.max(DEFAULT_COLUMN_WIDTH, Math.min(MAX_FITTED_COLUMN_WIDTH, widest + padding)),
  );
}

const NAME_BOX_CELL = String.raw`\$?([A-Za-z]{1,3})\$?(\d{1,7})`;
const NAME_BOX_PATTERN = new RegExp(`^${NAME_BOX_CELL}(?::${NAME_BOX_CELL})?$`);
const NAME_BOX_COLUMNS = /^\$?([A-Za-z]{1,3}):\$?([A-Za-z]{1,3})$/;
const NAME_BOX_ROWS = /^\$?(\d{1,7}):\$?(\d{1,7})$/;

function columnIndex(letters: string): number {
  let column = 0;
  for (const letter of letters.toUpperCase()) column = column * 26 + letter.charCodeAt(0) - 64;
  return column - 1;
}

/**
 * The selection a typed address names: a cell (`B16`), a range (`a1:c4`), whole columns (`C:D`)
 * or whole rows (`2:5`). Null for anything else, or for a place the grid does not lay out.
 */
export function parseNameBoxInput(
  text: string,
  bounds: { readonly rowCount: number; readonly columnCount: number },
): GridSelection | null {
  const typed = text.trim();
  const within = (selection: GridSelection) =>
    [selection.anchor, selection.focus].every(
      (cell) =>
        cell.row >= 0 &&
        cell.column >= 0 &&
        cell.row < bounds.rowCount &&
        cell.column < bounds.columnCount,
    )
      ? selection
      : null;
  const cells = NAME_BOX_PATTERN.exec(typed);
  if (cells) {
    const anchor = { row: Number(cells[2]) - 1, column: columnIndex(cells[1]!) };
    const focus =
      cells[3] === undefined
        ? anchor
        : { row: Number(cells[4]) - 1, column: columnIndex(cells[3]) };
    return within({ anchor, focus });
  }
  const columns = NAME_BOX_COLUMNS.exec(typed);
  if (columns) {
    return within({
      anchor: { row: 0, column: columnIndex(columns[1]!) },
      focus: { row: bounds.rowCount - 1, column: columnIndex(columns[2]!) },
    });
  }
  const rows = NAME_BOX_ROWS.exec(typed);
  if (rows) {
    return within({
      anchor: { row: Number(rows[1]) - 1, column: 0 },
      focus: { row: Number(rows[2]) - 1, column: bounds.columnCount - 1 },
    });
  }
  return null;
}

/** An area as the name box shows it: `B3`, or `B3:D9`. */
export function areaLabel(area: GridArea): string {
  const first = cellLabel({ row: area.top, column: area.left });
  const last = cellLabel({ row: area.bottom, column: area.right });
  return first === last ? first : `${first}:${last}`;
}

export interface SelectionSummary {
  /** Cells that hold something. */
  readonly count: number;
  /** Cells that hold a number, which the sum and the average are over. */
  readonly numbers: number;
  readonly sum: number;
}

/** The most cells a selection is added up over, so that selecting a whole sheet costs nothing. */
export const SUMMARY_MAX_CELLS = 20_000;

/**
 * What a selection of several cells adds up to, from the cells read so far. Null for one cell,
 * for a selection over the limit and for one that holds nothing.
 */
export function selectionSummary(
  area: GridArea,
  cellAt: (row: number, column: number) => CellData | undefined,
): SelectionSummary | null {
  const cells = areaCellCount(area);
  if (cells < 2 || cells > SUMMARY_MAX_CELLS) return null;
  let count = 0;
  let numbers = 0;
  let sum = 0;
  for (let row = area.top; row <= area.bottom; row++) {
    for (let column = area.left; column <= area.right; column++) {
      const cell = cellAt(row, column);
      if (cell?.value === undefined || cell.value === "") continue;
      count += 1;
      if (typeof cell.value === "number" && !cell.error) {
        numbers += 1;
        sum += cell.value;
      }
    }
  }
  return count === 0 ? null : { count, numbers, sum };
}

/** A sum or an average as the status bar shows it: without the noise of binary fractions. */
export const summaryNumber = (value: number) =>
  Number(value.toPrecision(12)).toLocaleString("en-GB", { maximumFractionDigits: 4 });

/** The cells of two reads of one page that differ, as keys, by value or by formula. */
export function changedCellKeys(
  before: ReadonlyMap<number, CellData>,
  after: ReadonlyMap<number, CellData>,
): Array<number> {
  const changed: Array<number> = [];
  const differs = (left: CellData | undefined, right: CellData | undefined) =>
    left?.value !== right?.value || left?.formula !== right?.formula;
  for (const [key, cell] of after) if (differs(before.get(key), cell)) changed.push(key);
  for (const [key, cell] of before)
    if (!after.has(key) && differs(cell, undefined)) changed.push(key);
  return changed;
}
