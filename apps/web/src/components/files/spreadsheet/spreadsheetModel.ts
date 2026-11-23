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
