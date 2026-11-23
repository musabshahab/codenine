import { describe, expect, it } from "@effect/vitest";

import { hasHeaderRow, type HeaderProbeCell, sortedOrder } from "./sortRows.ts";

const row = (...cells: ReadonlyArray<"text" | "other" | "bold" | null>): Array<HeaderProbeCell> =>
  cells.flatMap((cell, column) =>
    cell === null
      ? []
      : [{ column, text: cell !== "other", style: cell === "bold" ? "1" : undefined }],
  );

describe("sortRows", () => {
  it.each([
    { name: "text over a column of numbers", rows: [row("text", "text"), row("text", "other")] },
    { name: "a bold row over plain text", rows: [row("bold"), row("text")] },
    { name: "several columns of text", rows: [row("text", "text"), row("text", "text")] },
  ])("takes $name as headings", ({ rows }) => {
    expect(hasHeaderRow(rows)).toBe(true);
  });

  it.each([
    { name: "one column of plain text", rows: [row("text"), row("text"), row("text")] },
    { name: "a first row that holds a number", rows: [row("text", "other"), row("text", "other")] },
    { name: "a number under no heading", rows: [row("text", null), row("text", "other")] },
    { name: "a single row", rows: [row("text", "text")] },
  ])("sorts $name with the rest", ({ rows }) => {
    expect(hasHeaderRow(rows)).toBe(false);
  });

  it("orders numbers before text, ignores case, and keeps blanks last and ties in place", () => {
    const keys = ["pear", 10, null, "Apple", 2, true, { error: "#N/A" }, "apple"];
    const sorted = (descending: boolean) => sortedOrder(keys, descending).map((at) => keys[at]);
    expect(sorted(false)).toEqual([2, 10, "Apple", "apple", "pear", true, { error: "#N/A" }, null]);
    expect(sorted(true)).toEqual([{ error: "#N/A" }, true, "pear", "Apple", "apple", 10, 2, null]);
  });
});
