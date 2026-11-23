import { describe, expect, it } from "@effect/vitest";

import { evaluateFormula, FormulaErrorValue, FormulaNotCalculated } from "./formulaEvaluation.ts";
import {
  formulaReferences,
  mapFormulaReferences,
  offsetReference,
  shiftReference,
} from "./references.ts";

const shifted = (formula: string, axis: "row" | "column", at: number, count: number) =>
  mapFormulaReferences(formula, (reference) => shiftReference(reference, axis, at, count)).formula;

describe("formula references", () => {
  it.each([
    // Inserting two rows before row 3.
    ["A1+A3", "row", 3, 2, "A1+A5"],
    ["SUM($B$2:B4)", "row", 3, 2, "SUM($B$2:B6)"],
    ["SUM(B4:B2)", "row", 3, 2, "SUM(B6:B2)"],
    ["A:A+3:4", "row", 3, 2, "A:A+5:6"],
    // Deleting rows 3 and 4.
    ["A3+A5", "row", 3, -2, "#REF!+A3"],
    ["SUM(A1:A3)", "row", 3, -2, "SUM(A1:A2)"],
    ["SUM(A3:A9)", "row", 3, -2, "SUM(A3:A7)"],
    // Deleting column B.
    ["B1+C1+SUM(A1:C1)", "column", 2, -1, "#REF!+B1+SUM(A1:B1)"],
    // Text, function names, names and other sheets' cells are not cell references here.
    ['"A3"&LOG10(A3)&Tax2024x', "row", 3, 1, '"A3"&LOG10(A4)&Tax2024x'],
    ["'It''s'!A3+Other!A3+[1]Book!A3", "row", 3, 1, "'It''s'!A4+Other!A4+[1]Book!A3"],
    ["Table1[Total]+#REF!+TRUE", "row", 1, 1, "Table1[Total]+#REF!+TRUE"],
  ] as const)(
    "%s after a shift on the %s axis at %i by %i",
    (formula, axis, at, count, expected) => {
      expect(shifted(formula, axis, at, count)).toBe(expected);
    },
  );

  it("copies a formula as a spreadsheet app fills it, and names the sheet a rewrite moves to", () => {
    expect(
      mapFormulaReferences("A1+$A1+A$1+$A$1", (reference) => offsetReference(reference, 2, 1))
        .formula,
    ).toBe("B3+$A3+B$1+$A$1");
    expect(
      mapFormulaReferences("Data!A1+A1", (reference) =>
        reference.sheet === null ? null : { ...reference, sheet: "Raw data" },
      ).formula,
    ).toBe("'Raw data'!A1+A1");
  });

  it("reports what it cannot follow", () => {
    expect(formulaReferences("SUM(A1:B2)*2").opaque).toBe(false);
    for (const formula of ["Rate*2", "Table1[Total]", "[1]Book!A1", "First:Last!A1"]) {
      expect(formulaReferences(formula).opaque, formula).toBe(true);
    }
  });
});

describe("formula evaluation", () => {
  const cells: Record<string, number | string | boolean> = { A1: 2, A2: 3.5, A3: "text", B1: true };
  const scope = {
    values: (reference: Parameters<Parameters<typeof mapFormulaReferences>[1]>[0]) => {
      const end = reference.end ?? reference.start;
      const found = [];
      for (let row = reference.start.row!; row <= end.row!; row++) {
        for (let column = reference.start.column!; column <= end.column!; column++) {
          const value = cells[`${String.fromCharCode(64 + column)}${row}`];
          if (value !== undefined) found.push(value);
        }
      }
      return found;
    },
  };

  it.each([
    ["1+2*3^2", 19],
    ["-2^2", 4],
    ["0.1+0.2", 0.3],
    ["50%*A1", 1],
    ["SUM(A1:A3,B1,10)", 15.5],
    ["AVERAGE(A1:A3)", 2.75],
    ['COUNT(A1:B3)&"/"&COUNTA(A1:B3)', "2/4"],
    ['IF(A1>1,"big","small")', "big"],
    ["ROUND(2.5,0)+ROUND(-2.5,0)+ROUND(1.005,2)", 1.01],
    ["A1/0", new FormulaErrorValue("#DIV/0!")],
    ["IFERROR(A3*2,-1)", -1],
    ['"a"<"B"', true],
    ["C9+1", 1],
  ])("%s", (formula, expected) => {
    expect(evaluateFormula(formula, scope)).toEqual(expected);
  });

  it.each(["VLOOKUP(1,A1:B2,2)", "Rate*2", "A1:A2+1", "SUM(A1", "{1,2}"])(
    "leaves %s to a spreadsheet app",
    (formula) => {
      expect(() => evaluateFormula(formula, scope)).toThrow(FormulaNotCalculated);
    },
  );
});
