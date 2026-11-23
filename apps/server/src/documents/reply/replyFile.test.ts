import { expect, it } from "@effect/vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import { XlsxWorkbook } from "../spreadsheet/xlsxWorkbook.ts";
import { markdownPdf, markdownTables, tableWorkbook } from "./replyFile.ts";

const LIMITS = {
  maxFileBytes: 1024 * 1024,
  maxUnpackedBytes: 8 * 1024 * 1024,
  maxCells: 10_000,
  maxFormatCells: 10_000,
  maxRecalculationSteps: 10_000,
};

const REPLY = `# Quarterly figures

Revenue grew in **every** region. See [the plan](https://example.com/plan).

| Region | Revenue | Note |
| :-- | --: | --- |
| North | 1,200 | \`steady\` |
| South \\| East | 300.5 | =SUM(A1) |
| West | n/a | |

- First point
  1. Nested point

\`\`\`sh
echo "done"
\`\`\`
`;

it("reads a reply's tables as rows of plain cell text", () => {
  expect(markdownTables(REPLY)).toEqual([
    [
      ["Region", "Revenue", "Note"],
      ["North", "1,200", "steady"],
      ["South | East", "300.5", "=SUM(A1)"],
      ["West", "n/a", ""],
    ],
  ]);
  expect(markdownTables("No table here.\n\n```\n| a | b |\n|---|---|\n```")).toEqual([]);
});

it("turns a table into a workbook: a bold header, numbers as numbers, formulas as text", async () => {
  const bytes = await tableWorkbook(markdownTables(REPLY)[0]!, LIMITS);
  const workbook = await XlsxWorkbook.open(bytes, LIMITS);
  expect(workbook.sheets()).toEqual([{ name: "Table" }]);
  const range = await workbook.readRange({
    sheet: "Table",
    row: 0,
    column: 0,
    rowCount: 10,
    columnCount: 10,
  });
  expect(range.rowCount).toBe(4);
  const cell = (row: number, column: number) =>
    range.cells.find((entry) => entry.row === row && entry.column === column);
  expect(cell(0, 1)?.value).toBe("Revenue");
  expect(range.formats[cell(0, 1)?.format ?? ""]).toMatchObject({ bold: true });
  expect(cell(1, 1)?.value).toBe(1200);
  expect(cell(2, 1)?.value).toBe(300.5);
  expect(cell(2, 0)?.value).toBe("South | East");
  expect(cell(2, 2)).toMatchObject({ value: "=SUM(A1)" });
  expect(cell(2, 2)?.formula).toBeUndefined();
  expect(cell(3, 1)?.value).toBe("n/a");
  expect(cell(3, 2)).toBeUndefined();
});

it("turns a reply into a PDF that holds its text, across pages when it is long", async () => {
  const long = `${REPLY}\n${Array.from({ length: 120 }, (_, index) => `Paragraph ${index} with café and 日本.`).join("\n\n")}`;
  const document = await getDocument({ data: await markdownPdf(long), verbosity: 0 }).promise;
  expect(document.numPages).toBeGreaterThan(1);
  let text = "";
  for (let page = 1; page <= document.numPages; page++) {
    const content = await (await document.getPage(page)).getTextContent();
    text += content.items.map((item) => ("str" in item ? item.str : "")).join(" ") + " ";
  }
  text = text.replace(/\s+/g, " ");
  for (const expected of [
    "Quarterly figures",
    "Revenue grew in every region. See the plan (https://example.com/plan).",
    "South | East",
    "300.5",
    "First point",
    "Nested point",
    'echo "done"',
    "Paragraph 119 with café and ??.",
  ]) {
    expect(text).toContain(expected);
  }
  expect(text).not.toContain("**");
});
