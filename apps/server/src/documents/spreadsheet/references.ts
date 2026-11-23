export const MAX_ROWS = 1_048_576;
export const MAX_COLUMNS = 16_384;

/** A zero-based column as letters: 0 is A, 26 is AA. */
function columnLabel(column: number): string {
  let label = "";
  for (let rest = column + 1; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    label = String.fromCharCode(65 + ((rest - 1) % 26)) + label;
  }
  return label;
}

/** Letters as a one-based column number. */
function columnNumber(letters: string): number {
  let value = 0;
  for (const letter of letters.toUpperCase()) value = value * 26 + (letter.charCodeAt(0) - 64);
  return value;
}

export const cellName = (row: number, column: number) => `${columnLabel(column)}${row + 1}`;

/** Zero-based position of an A1 name such as `B7`. Null for anything else. */
export function parseCellName(name: string): { row: number; column: number } | null {
  const match = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(name);
  if (!match) return null;
  const column = columnNumber(match[1]!);
  const row = Number(match[2]);
  if (column > MAX_COLUMNS || row < 1 || row > MAX_ROWS) return null;
  return { row: row - 1, column: column - 1 };
}

export interface CellArea {
  readonly top: number;
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
}

/** Zero-based area of `A1` or `A1:C4`. */
export function parseArea(reference: string): CellArea | null {
  const [first, second] = reference.split(":");
  const start = parseCellName(first ?? "");
  const end = second === undefined ? start : parseCellName(second);
  if (!start || !end) return null;
  return {
    top: Math.min(start.row, end.row),
    left: Math.min(start.column, end.column),
    bottom: Math.max(start.row, end.row),
    right: Math.max(start.column, end.column),
  };
}

export const areaName = (area: CellArea) =>
  area.top === area.bottom && area.left === area.right
    ? cellName(area.top, area.left)
    : `${cellName(area.top, area.left)}:${cellName(area.bottom, area.right)}`;

/** One end of a reference, one-based. A whole-column end has no row and the reverse. */
export interface ReferencePoint {
  readonly column: number | null;
  readonly row: number | null;
  readonly columnFixed: boolean;
  readonly rowFixed: boolean;
}

export interface FormulaReference {
  /** The sheet the reference names. Null when it names none, so it means the formula's own. */
  readonly sheet: string | null;
  readonly start: ReferencePoint;
  readonly end: ReferencePoint | null;
}

export const REFERENCE_ERROR = "#REF!";

/** What a reference becomes: itself, moved, or `#REF!` when what it named is gone. */
export type ReferenceRewrite =
  | { readonly start: ReferencePoint; readonly end: ReferencePoint | null; readonly sheet?: string }
  | typeof REFERENCE_ERROR
  | null;

const CELL = String.raw`(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})`;
const REFERENCE_PATTERN = new RegExp(
  String.raw`(?:${CELL}(?::${CELL})?|(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})|(\$?)(\d{1,7}):(\$?)(\d{1,7}))(?![\w.(\[!:])`,
  "y",
);
// A sheet prefix without quotes. `[1]Book` names another workbook and `A:B!` several sheets.
const SHEET_PREFIX_PATTERN = /(\[\d+\])?([\p{L}_][\p{L}\p{N}_.]*)(:[\p{L}_][\p{L}\p{N}_.]*)?!/uy;
const WORD_PATTERN = /[\p{L}\p{N}_.$\\]+/uy;
const WORD_START = /[\p{L}\p{N}_$]/u;

const pointName = (point: ReferencePoint) =>
  `${point.column === null ? "" : `${point.columnFixed ? "$" : ""}${columnLabel(point.column - 1)}`}${
    point.row === null ? "" : `${point.rowFixed ? "$" : ""}${point.row}`
  }`;

const validPoint = (point: ReferencePoint) =>
  (point.column === null || (point.column >= 1 && point.column <= MAX_COLUMNS)) &&
  (point.row === null || (point.row >= 1 && point.row <= MAX_ROWS));

/** How a sheet name is written before `!`: quoted unless it is a plain word. */
const sheetPrefix = (name: string) =>
  /^[\p{L}_][\p{L}\p{N}_.]*$/u.test(name) && parseCellName(name) === null
    ? `${name}!`
    : `'${name.replaceAll("'", "''")}'!`;

function readReference(
  formula: string,
  at: number,
): { length: number; start: ReferencePoint; end: ReferencePoint | null } | null {
  REFERENCE_PATTERN.lastIndex = at;
  const match = REFERENCE_PATTERN.exec(formula);
  if (!match) return null;
  let start: ReferencePoint;
  let end: ReferencePoint | null = null;
  if (match[2] !== undefined) {
    start = {
      column: columnNumber(match[2]),
      row: Number(match[4]),
      columnFixed: match[1] === "$",
      rowFixed: match[3] === "$",
    };
    if (match[6] !== undefined) {
      end = {
        column: columnNumber(match[6]),
        row: Number(match[8]),
        columnFixed: match[5] === "$",
        rowFixed: match[7] === "$",
      };
    }
  } else if (match[10] !== undefined) {
    start = {
      column: columnNumber(match[10]),
      row: null,
      columnFixed: match[9] === "$",
      rowFixed: false,
    };
    end = {
      column: columnNumber(match[12]!),
      row: null,
      columnFixed: match[11] === "$",
      rowFixed: false,
    };
  } else {
    start = {
      column: null,
      row: Number(match[14]),
      columnFixed: false,
      rowFixed: match[13] === "$",
    };
    end = { column: null, row: Number(match[16]), columnFixed: false, rowFixed: match[15] === "$" };
  }
  if (!validPoint(start) || (end !== null && !validPoint(end))) return null;
  return { length: match[0].length, start, end };
}

/** A sheet of this workbook that a formula names in a way that is not followed. */
export interface UnfollowedSheet {
  readonly sheet: string;
  /** The last sheet of a reference across several sheets; null for a name such as `Data!Rate`. */
  readonly through: string | null;
}

interface ReplacedFormula {
  readonly formula: string;
  readonly opaque: boolean;
  readonly unfollowed: ReadonlyArray<UnfollowedSheet>;
}

/**
 * Replaces each cell reference in a formula with what `replace` returns and leaves the rest as
 * written. References into another workbook or across several sheets are reported as `opaque`
 * and never replaced, as are names and table references, which the caller cannot follow.
 */
export function replaceFormulaReferences(
  formula: string,
  replace: (reference: FormulaReference, written: string) => string,
): ReplacedFormula {
  let output = "";
  let opaque = false;
  const unfollowed: Array<UnfollowedSheet> = [];
  let index = 0;
  const emit = (sheet: string | null, prefixText: string, foreign: boolean) => {
    const reference = readReference(formula, index);
    if (reference === null) return false;
    index += reference.length;
    const written = prefixText + formula.slice(index - reference.length, index);
    if (foreign) {
      opaque = true;
      output += written;
    } else output += replace({ sheet, start: reference.start, end: reference.end }, written);
    return true;
  };
  while (index < formula.length) {
    const character = formula[index]!;
    if (character === '"') {
      let end = index + 1;
      while (end < formula.length) {
        if (formula[end] === '"') {
          if (formula[end + 1] === '"') end += 2;
          else break;
        } else end += 1;
      }
      output += formula.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (character === "'") {
      let end = index + 1;
      while (end < formula.length) {
        if (formula[end] === "'") {
          if (formula[end + 1] === "'") end += 2;
          else break;
        } else end += 1;
      }
      const quoted = formula.slice(index + 1, end).replaceAll("''", "'");
      const prefixText = formula.slice(index, end + 2);
      if (formula[end + 1] === "!") {
        index = end + 2;
        const external = quoted.startsWith("[");
        const [first = "", last] = quoted.split(":");
        const emitted = emit(quoted, prefixText, external || last !== undefined);
        if (!emitted) {
          opaque = true;
          output += prefixText;
        }
        if (!external && (!emitted || last !== undefined)) {
          unfollowed.push({ sheet: first, through: last ?? null });
        }
      } else {
        output += formula.slice(index, end + 1);
        index = end + 1;
      }
      continue;
    }
    if (character === "#") {
      const error = /#[A-Z0-9/]+[!?]?/y;
      error.lastIndex = index;
      const literal = error.exec(formula)?.[0] ?? character;
      output += literal;
      index += literal.length;
      continue;
    }
    if (character === "[") {
      // A table reference such as `Table1[Total]`, which may nest brackets.
      let depth = 0;
      let end = index;
      for (; end < formula.length; end++) {
        if (formula[end] === "[") depth += 1;
        else if (formula[end] === "]" && --depth === 0) break;
      }
      SHEET_PREFIX_PATTERN.lastIndex = index;
      if (SHEET_PREFIX_PATTERN.exec(formula) === null) {
        opaque = true;
        output += formula.slice(index, end + 1);
        index = end + 1;
        continue;
      }
    }
    if (character === "[" || WORD_START.test(character)) {
      SHEET_PREFIX_PATTERN.lastIndex = index;
      const prefix = SHEET_PREFIX_PATTERN.exec(formula);
      if (prefix) {
        index += prefix[0].length;
        const foreign = prefix[1] !== undefined || prefix[3] !== undefined;
        const emitted = emit(prefix[2]!, prefix[0], foreign);
        if (!emitted) {
          opaque = true;
          output += prefix[0];
        }
        if (prefix[1] === undefined && (!emitted || prefix[3] !== undefined)) {
          unfollowed.push({ sheet: prefix[2]!, through: prefix[3]?.slice(1) ?? null });
        }
        continue;
      }
      if (emit(null, "", false)) continue;
      WORD_PATTERN.lastIndex = index;
      const word = WORD_PATTERN.exec(formula)?.[0] ?? character;
      const next = formula[index + word.length];
      // A word that is not a function call, a number or a boolean is a name defined elsewhere.
      if (next !== "(" && !/^(?:\d|\.\d)/.test(word) && !/^(?:TRUE|FALSE)$/i.test(word)) {
        opaque = true;
      }
      output += word;
      index += word.length;
      continue;
    }
    output += character;
    index += 1;
  }
  return { formula: output, opaque, unfollowed };
}

/** `replaceFormulaReferences` for a reference that moves, keeps its place or loses its cells. */
export function mapFormulaReferences(
  formula: string,
  rewrite: (reference: FormulaReference) => ReferenceRewrite,
): ReplacedFormula {
  return replaceFormulaReferences(formula, (reference, written) => {
    const result = rewrite(reference);
    if (result === null) return written;
    if (result === REFERENCE_ERROR) return REFERENCE_ERROR;
    const prefix =
      result.sheet !== undefined
        ? sheetPrefix(result.sheet)
        : reference.sheet === null
          ? ""
          : written.slice(0, written.lastIndexOf("!") + 1);
    return `${prefix}${pointName(result.start)}${result.end === null ? "" : `:${pointName(result.end)}`}`;
  });
}

/**
 * Whether a formula is whole enough to store: its quotes and brackets close, and it neither
 * starts nor ends with an operator that needs another value. It may still use anything a
 * spreadsheet app knows that this code does not.
 */
export function formulaIsComplete(formula: string): boolean {
  const closers: Array<string> = [];
  let first = "";
  let last = "";
  for (let index = 0; index < formula.length; index++) {
    const character = formula[index]!;
    if (closers.at(-1) === "]") {
      // Inside a table reference an apostrophe keeps the next character as it is.
      if (character === "'") index += 1;
      else if (character === "[") closers.push("]");
      else if (character === "]") closers.pop();
      continue;
    }
    if (character === '"' || character === "'") {
      let end = index + 1;
      while (
        end < formula.length &&
        (formula[end] !== character || formula[end + 1] === character)
      ) {
        end += formula[end] === character ? 2 : 1;
      }
      if (end >= formula.length) return false;
      index = end;
    } else if (character === "(") closers.push(")");
    else if (character === "{") closers.push("}");
    else if (character === "[") closers.push("]");
    else if (character === ")" || character === "}" || character === "]") {
      if (closers.pop() !== character) return false;
    }
    if (/\s/.test(character)) continue;
    if (first === "") first = character;
    last = character;
  }
  return closers.length === 0 && !/[*/^&=<>,)%]/.test(first) && !/[-+*/^&=<>,(]/.test(last);
}

/** The references a formula makes, with whether it also reads something that cannot be followed. */
export function formulaReferences(formula: string): {
  readonly references: ReadonlyArray<FormulaReference>;
  readonly opaque: boolean;
} {
  const references: Array<FormulaReference> = [];
  const { opaque } = mapFormulaReferences(formula, (reference) => {
    references.push(reference);
    return null;
  });
  return { references, opaque };
}

export type Axis = "row" | "column";

const coordinate = (point: ReferencePoint, axis: Axis) =>
  axis === "row" ? point.row : point.column;
const withCoordinate = (point: ReferencePoint, axis: Axis, value: number): ReferencePoint =>
  axis === "row" ? { ...point, row: value } : { ...point, column: value };
const axisLimit = (axis: Axis) => (axis === "row" ? MAX_ROWS : MAX_COLUMNS);

/**
 * A reference after rows or columns were inserted (`count` above zero) or deleted at the
 * one-based position `at`. A reference whose cells were all deleted becomes `#REF!`.
 */
export function shiftReference(
  reference: { readonly start: ReferencePoint; readonly end: ReferencePoint | null },
  axis: Axis,
  at: number,
  count: number,
): ReferenceRewrite {
  const first = coordinate(reference.start, axis);
  if (first === null) return null;
  const last = reference.end === null ? first : coordinate(reference.end, axis);
  if (last === null) return null;
  // A range written backwards keeps its ends; only their order is read here.
  const low = Math.min(first, last);
  const high = Math.max(first, last);
  let nextLow = low;
  let nextHigh = high;
  if (count > 0) {
    if (low >= at) nextLow += count;
    if (high >= at) nextHigh += count;
    if (nextHigh > axisLimit(axis)) return REFERENCE_ERROR;
  } else {
    const removed = -count;
    const end = at + removed - 1;
    if (low >= at && high <= end) return REFERENCE_ERROR;
    nextLow = low > end ? low - removed : Math.min(low, at);
    nextHigh = high > end ? high - removed : high >= at ? at - 1 : high;
  }
  if (nextLow === low && nextHigh === high) return null;
  const start = withCoordinate(reference.start, axis, first <= last ? nextLow : nextHigh);
  const end =
    reference.end === null
      ? null
      : withCoordinate(reference.end, axis, first <= last ? nextHigh : nextLow);
  return { start, end };
}

/** A reference as a copied formula makes it: every end that is not fixed moves with the copy. */
export function offsetReference(
  reference: { readonly start: ReferencePoint; readonly end: ReferencePoint | null },
  rows: number,
  columns: number,
): ReferenceRewrite {
  const move = (point: ReferencePoint): ReferencePoint => ({
    ...point,
    row: point.row === null || point.rowFixed ? point.row : point.row + rows,
    column: point.column === null || point.columnFixed ? point.column : point.column + columns,
  });
  const start = move(reference.start);
  const end = reference.end === null ? null : move(reference.end);
  return validPoint(start) && (end === null || validPoint(end)) ? { start, end } : REFERENCE_ERROR;
}
