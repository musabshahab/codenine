import { describe, expect, it } from "vite-plus/test";

import {
  areaLabel,
  areaToClipboardText,
  type CellChange,
  type CellData,
  changedCellKeys,
  cellKey,
  cellDisplayText,
  cellEditText,
  cellFromInput,
  cellToInput,
  changeOperations,
  clipboardTextToRows,
  columnLabel,
  columnLayout,
  DEFAULT_COLUMN_WIDTH,
  fittedColumnWidth,
  MAX_FITTED_COLUMN_WIDTH,
  EMPTY_HISTORY,
  MAX_GRID_COLUMNS,
  MAX_GRID_ROWS,
  moveSelection,
  parseCellInput,
  parseNameBoxInput,
  pasteTargets,
  recordChanges,
  redoChanges,
  selectionArea,
  selectionSummary,
  spreadsheetDocumentSelection,
  SUMMARY_MAX_CELLS,
  summaryNumber,
  undoChanges,
} from "./spreadsheetModel";

const at = (row: number, column: number) => ({ row, column });
const BOUNDS = { rowCount: 10, columnCount: 5 };

describe("selection", () => {
  it.each([
    ["moves the cell", at(2, 2), at(2, 2), { rows: 1, columns: 0 }, false, at(3, 2), at(3, 2)],
    [
      "collapses a range to its anchor's neighbour",
      at(2, 2),
      at(4, 4),
      { rows: 0, columns: 1 },
      false,
      at(2, 3),
      at(2, 3),
    ],
    [
      "extends from the far corner",
      at(2, 2),
      at(3, 2),
      { rows: 1, columns: 1 },
      true,
      at(2, 2),
      at(4, 3),
    ],
    [
      "stops at the first row and column",
      at(0, 0),
      at(0, 0),
      { rows: -1, columns: -1 },
      false,
      at(0, 0),
      at(0, 0),
    ],
    [
      "stops at the last row and column",
      at(9, 4),
      at(9, 4),
      { rows: 5, columns: 5 },
      true,
      at(9, 4),
      at(9, 4),
    ],
  ])("%s", (_name, anchor, focus, move, extend, nextAnchor, nextFocus) => {
    expect(moveSelection({ anchor, focus }, move, extend, BOUNDS)).toEqual({
      anchor: nextAnchor,
      focus: nextFocus,
    });
  });

  it("names columns and orders a selection made backwards", () => {
    expect([0, 25, 26, 701, 702].map(columnLabel)).toEqual(["A", "Z", "AA", "ZZ", "AAA"]);
    expect(selectionArea({ anchor: at(4, 3), focus: at(1, 0) })).toEqual({
      top: 1,
      left: 0,
      bottom: 4,
      right: 3,
    });
    // What the chat's context chip is told: the range, and the values of a small one.
    const text = (row: number, column: number) => `${row}.${column}`;
    expect(
      spreadsheetDocumentSelection("Budget", { top: 1, left: 1, bottom: 2, right: 2 }, text),
    ).toEqual({
      kind: "spreadsheet",
      sheet: "Budget",
      range: "B2:C3",
      values: "1.1\t1.2\n2.1\t2.2",
    });
    expect(
      spreadsheetDocumentSelection("Budget", { top: 15, left: 1, bottom: 15, right: 1 }, () => ""),
    ).toEqual({ kind: "spreadsheet", sheet: "Budget", range: "B16" });
    expect(
      spreadsheetDocumentSelection("Budget", { top: 0, left: 0, bottom: 99, right: 9 }, text),
    ).toEqual({ kind: "spreadsheet", sheet: "Budget", range: "A1:J100" });
  });
  it.each([
    ["a cell", "B16", at(15, 1), at(15, 1)],
    ["a range, in any case and with spaces around it", " a1:c4 ", at(0, 0), at(3, 2)],
    ["a range written backwards, which keeps its ends", "C4:A1", at(3, 2), at(0, 0)],
    ["fixed references", "$B$2:$C$3", at(1, 1), at(2, 2)],
    ["whole columns", "B:C", at(0, 1), at(19, 2)],
    ["whole rows", "2:3", at(1, 0), at(2, 4)],
  ])("goes to %s typed into the name box", (_, text, anchor, focus) => {
    expect(parseNameBoxInput(text, { rowCount: 20, columnCount: 5 })).toEqual({ anchor, focus });
  });

  it.each(["", "B", "16", "B0", "B21", "F1", "A1:", "A1:B", "Totals", "A1;B2", "=A1"])(
    "does not go anywhere for %j",
    (text) => {
      expect(parseNameBoxInput(text, { rowCount: 20, columnCount: 5 })).toBeNull();
    },
  );

  it("adds up the numbers in a selection and counts what it holds", () => {
    const cells = new Map<number, CellData>([
      [cellKey(0, 0), { value: "Qty" }],
      [cellKey(1, 0), { value: 0.1 }],
      [cellKey(2, 0), { value: 0.2, formula: "A2*2" }],
      [cellKey(3, 0), { value: "#DIV/0!", error: true }],
      [cellKey(4, 0), { format: { bold: true } }],
      [cellKey(5, 0), { value: true }],
      [cellKey(6, 0), { formula: "NOW()" }],
    ]);
    const cellAt = (row: number, column: number) => cells.get(cellKey(row, column));
    const summary = selectionSummary({ top: 0, left: 0, bottom: 9, right: 1 }, cellAt);
    // Text, an error and a boolean are counted and not added; a format alone is not counted.
    expect(summary).toEqual({ count: 5, numbers: 2, sum: expect.closeTo(0.3, 12) });
    expect(summaryNumber(summary!.sum)).toBe("0.3");
    expect(summaryNumber(1234567.891)).toBe("1,234,567.891");
    expect(areaLabel({ top: 0, left: 0, bottom: 9, right: 1 })).toBe("A1:B10");
    // One cell has nothing to add up, nor does an empty range, nor one too large to walk.
    expect(selectionSummary({ top: 1, left: 0, bottom: 1, right: 0 }, cellAt)).toBeNull();
    expect(selectionSummary({ top: 7, left: 0, bottom: 9, right: 1 }, cellAt)).toBeNull();
    expect(
      selectionSummary({ top: 0, left: 0, bottom: SUMMARY_MAX_CELLS, right: 0 }, cellAt),
    ).toBeNull();
  });

  it("finds the cells of a page that differ between two reads", () => {
    const before = new Map<number, CellData>([
      [1, { value: 1 }],
      [2, { value: 2, formula: "A1+1" }],
      [3, { value: "gone" }],
      [4, { value: 4, format: { bold: true } }],
      [5, { format: { bold: true } }],
    ]);
    const after = new Map<number, CellData>([
      [1, { value: 1 }],
      [2, { value: 2, formula: "A1+2" }],
      [4, { value: 4 }],
      [6, { value: "new" }],
    ]);
    // A format alone is not a change of contents.
    expect(changedCellKeys(before, after).toSorted()).toEqual([2, 3, 6]);
  });
});

describe("cell input", () => {
  it.each([
    ["", { kind: "blank" }],
    ["12.50", { kind: "number", number: 12.5 }],
    ["-1e3", { kind: "number", number: -1000 }],
    ["25%", { kind: "number", number: 0.25 }],
    ["true", { kind: "boolean", boolean: true }],
    ["=SUM(A1:A3)", { kind: "formula", formula: "SUM(A1:A3)" }],
    ["=", { kind: "text", text: "=" }],
    ["'0012", { kind: "text", text: "0012" }],
    ["12 apples", { kind: "text", text: "12 apples" }],
  ] as const)("reads %j in a workbook", (text, input) => {
    expect(parseCellInput(text, "xlsx")).toEqual(input);
  });

  it("keeps everything as text in a delimited file", () => {
    expect(parseCellInput("=1+1", "delimited")).toEqual({ kind: "text", text: "=1+1" });
    expect(parseCellInput("007", "delimited")).toEqual({ kind: "text", text: "007" });
    expect(cellEditText({ value: "007" }, "delimited")).toBe("007");
  });

  it.each([
    [{ value: 3.5 }, "3.5", "3.5"],
    [{ value: 0.5, format: { numberFormat: "0%" } }, "0.5", "50%"],
    [{ value: "0012" }, "'0012", "0012"],
    [{ formula: "A1*2", value: 8 }, "=A1*2", "8"],
    [{ formula: "VLOOKUP(1,A:B,2)" }, "=VLOOKUP(1,A:B,2)", "=VLOOKUP(1,A:B,2)"],
    [{ formula: "1/0", value: "#DIV/0!", error: true }, "=1/0", "#DIV/0!"],
    [{ value: false }, "FALSE", "FALSE"],
    [undefined, "", ""],
  ])("shows %j as %s in the formula bar and %s in the grid", (cell, edit, display) => {
    expect(cellEditText(cell, "xlsx")).toBe(edit);
    expect(cellDisplayText(cell, false)).toBe(display);
    // Typing the formula bar's text back gives the same cell.
    expect(parseCellInput(edit, "xlsx")).toEqual(cellToInput(cell));
  });

  it("keeps a cell's format when its contents change or are cleared", () => {
    const formatted = { value: 1, format: { bold: true } };
    expect(cellFromInput({ kind: "text", text: "x" }, formatted)).toEqual({
      value: "x",
      format: { bold: true },
    });
    expect(cellFromInput({ kind: "blank" }, formatted)).toEqual({ format: { bold: true } });
    expect(cellFromInput({ kind: "blank" }, { value: 1 })).toBeUndefined();
  });
});

describe("undo and redo", () => {
  const change = (row: number, before: number, after: number): CellChange => ({
    sheet: "Data",
    row,
    column: 0,
    before: { kind: "number", number: before },
    after: { kind: "number", number: after },
  });

  it("takes actions back and replays them in order, a whole action at a time", () => {
    const typed = recordChanges(EMPTY_HISTORY, [change(0, 1, 2)]);
    // A paste changes two cells; the one it leaves as it was is not part of the action.
    const pasted = recordChanges(typed.history, [
      change(1, 5, 6),
      change(2, 7, 7),
      change(3, 8, 9),
    ]);
    expect(pasted.changes.map((item) => item.row)).toEqual([1, 3]);

    const undone = undoChanges(pasted.history)!;
    expect(changeOperations(undone.changes)).toEqual([
      { type: "setCell", sheet: "Data", row: 1, column: 0, input: { kind: "number", number: 5 } },
      { type: "setCell", sheet: "Data", row: 3, column: 0, input: { kind: "number", number: 8 } },
    ]);
    const undoneTwice = undoChanges(undone.history)!;
    expect(undoneTwice.changes).toEqual([change(0, 2, 1)]);
    expect(undoChanges(undoneTwice.history)).toBeNull();

    const redone = redoChanges(undoneTwice.history)!;
    expect(redone.changes).toEqual([change(0, 1, 2)]);
    // A new edit after an undo drops what could have been redone.
    const edited = recordChanges(redone.history, [change(0, 2, 3)]);
    expect(redoChanges(edited.history)).toBeNull();
    expect(recordChanges(edited.history, [change(4, 1, 1)]).history).toBe(edited.history);
  });
});

describe("clipboard", () => {
  it("copies an area as tab-separated text and reads it back", () => {
    const cells = [
      ["a", 'say "hi"'],
      ["two\nlines", "tab\there"],
    ];
    const text = areaToClipboardText(
      { top: 0, left: 0, bottom: 1, right: 1 },
      (row, column) => cells[row]![column]!,
    );
    expect(text).toBe('a\t"say ""hi"""\n"two\nlines"\t"tab\there"');
    expect(clipboardTextToRows(text)).toEqual(cells);
    // Other apps end the last row with a line break and use CRLF.
    expect(clipboardTextToRows('1\t2\r\n3\t"4"\r\n')).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
    expect(clipboardTextToRows('5" pipe\tx')).toEqual([['5" pipe', "x"]]);
  });

  it("pastes from the selection's corner, fills a selection with one cell, and stops only at the sheet's edge", () => {
    const area = { top: 8, left: 3, bottom: 9, right: 4 };
    expect(pasteTargets([["x"]], area).targets.map(({ row, column }) => [row, column])).toEqual([
      [8, 3],
      [8, 4],
      [9, 3],
      [9, 4],
    ]);
    // Rows and columns the grid has not laid out yet still take what is pasted.
    const tall = pasteTargets(
      Array.from({ length: 300 }, (_, row) => [`r${row}`, "b"]),
      { top: 0, left: 30, bottom: 0, right: 30 },
    );
    expect(tall.targets).toHaveLength(600);
    expect(tall.targets.at(-1)).toEqual({ row: 299, column: 31, text: "b" });
    expect(tall.dropped).toBe(0);
    const last = { top: MAX_GRID_ROWS - 1, left: MAX_GRID_COLUMNS - 2, bottom: 0, right: 0 };
    expect(
      pasteTargets(
        [
          ["a", "b", "c"],
          ["d", "e", "f"],
        ],
        last,
      ),
    ).toEqual({
      targets: [
        { row: MAX_GRID_ROWS - 1, column: MAX_GRID_COLUMNS - 2, text: "a" },
        { row: MAX_GRID_ROWS - 1, column: MAX_GRID_COLUMNS - 1, text: "b" },
      ],
      dropped: 4,
    });
  });
});

describe("column widths", () => {
  it("places every column after the ones with a width of their own, and finds it again", () => {
    const D = DEFAULT_COLUMN_WIDTH;
    const layout = columnLayout(
      new Map([
        [1, 200],
        [4, 40],
      ]),
    );
    expect([0, 1, 2, 4, 5, 9].map(layout.offsetOf)).toEqual([
      0,
      D,
      D + 200,
      3 * D + 200,
      3 * D + 240,
      7 * D + 240,
    ]);
    for (const column of [0, 1, 2, 3, 4, 5, 9, 400]) {
      const left = layout.offsetOf(column);
      expect(layout.columnAt(left)).toBe(column);
      expect(layout.columnAt(left + layout.widthOf(column) - 1)).toBe(column);
    }
    expect(columnLayout(new Map()).columnAt(D * 3 + 1)).toBe(3);
  });

  it("fits a column to its widest text, between the default and the most a fit gives", () => {
    expect(fittedColumnWidth([30, 150, 80], 14)).toBe(164);
    expect(fittedColumnWidth([10], 14)).toBe(DEFAULT_COLUMN_WIDTH);
    expect(fittedColumnWidth([900], 14)).toBe(MAX_FITTED_COLUMN_WIDTH);
  });
});
