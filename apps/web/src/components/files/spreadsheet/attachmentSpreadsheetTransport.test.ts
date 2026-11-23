import { expect, it } from "vite-plus/test";

import { attachmentSpreadsheetTransport } from "./attachmentSpreadsheetTransport";

it("reads an attached workbook's shown cells for the grid and refuses every edit", async () => {
  const sheets = [
    [
      ["Idea", "Category"],
      ["Sell prints", ""],
    ],
    [["Total", "42"]],
  ];
  const shown: Array<number> = [];
  const transport = attachmentSpreadsheetTransport({
    open: async () => ({
      tabs: [
        { index: 0, name: "Ideas" },
        { index: 1, name: "Totals" },
      ],
      layout: { used: undefined },
    }),
    show: async (sheet) => {
      shown.push(sheet);
      const rows = sheets[sheet]!;
      return { used: { top: 0, left: 0, bottom: rows.length - 1, right: rows[0]!.length - 1 } };
    },
    cells: async (sheet, range) =>
      sheets[sheet]!.slice(range.top, range.bottom + 1).map((row) =>
        row.slice(range.left, range.right + 1),
      ),
  });

  expect(await transport.open()).toMatchObject({
    ok: true,
    value: { format: "xlsx", sheets: [{ name: "Ideas" }, { name: "Totals" }] },
  });
  // The grid asks for a page far larger than the sheet; only what the sheet holds is read.
  const page = { row: 0, column: 0, rowCount: 200, columnCount: 50 };
  expect(await transport.readRange({ sheet: "Ideas", ...page })).toEqual({
    ok: true,
    value: {
      version: "attachment",
      rowCount: 2,
      columnCount: 2,
      cells: [
        { row: 0, column: 0, value: "Idea" },
        { row: 0, column: 1, value: "Category" },
        { row: 1, column: 0, value: "Sell prints" },
      ],
      formats: {},
    },
  });
  expect(await transport.readRange({ sheet: "Totals", ...page, row: 5 })).toMatchObject({
    ok: true,
    value: { rowCount: 1, cells: [] },
  });
  await transport.readRange({ sheet: "Ideas", ...page });
  // A sheet's size is asked for once.
  expect(shown).toEqual([0, 1]);
  expect(await transport.readRange({ sheet: "Missing", ...page })).toMatchObject({ ok: false });
  expect(await transport.edit([], undefined)).toMatchObject({
    ok: false,
    failure: { kind: "refused" },
  });
});
