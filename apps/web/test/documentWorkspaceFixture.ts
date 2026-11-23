import type { SpreadsheetCell, SpreadsheetOperation } from "@codenine/contracts";
import { WS_METHODS } from "@codenine/contracts";
import * as Effect from "effect/Effect";

import {
  assistantItem,
  type FakeThread,
  installFakeRpc,
  threadWithHistory,
  userItem,
} from "./fakeEnvironment";

const HEADERS = ["Customer", "About", "Waiting (days)", "Refund ($)", "Priority", "Owner"];
const ROWS: ReadonlyArray<ReadonlyArray<string | number>> = [
  ["D. Okafor", "Charged twice, order 88417", 9, 64, "urgent", "Priya"],
  ["J. Lindqvist", "Refund not received", 6, 110, "urgent", "Priya"],
  ["M. Castillo", "Wrong size delivered", 5, 38, "routine", "Tom"],
  ["Lin & Partners", "Delivery 9 days late", 4, 0, "urgent", "Tom"],
  ["Bright Dental", "Invoice address change", 3, 0, "routine", "Sam"],
  ["Oak & Ash Ltd", "Bulk order discount", 2, 0, "routine", "Sam"],
  ["R. Haddad", "Renewal quote expires Friday", 1, 0, "urgent", "Priya"],
  ["Harbour Cafe", "Change delivery day", 1, 0, "routine", "Sam"],
];

/** A chat about a workbook, as the document view shows one: two questions and their replies. */
export function documentThread(name: string): FakeThread {
  const thread = threadWithHistory(name, 2);
  const [first, second] = thread.runs;
  return {
    ...thread,
    title: "Customer emails, week 47",
    items: [
      userItem(thread.id, first!.id, `${name}-user-0`, 0, "Flag everyone waiting more than 3 days"),
      assistantItem(
        thread.id,
        first!.id,
        `${name}-assistant-0`,
        1,
        "Flagged 4 customers who have waited more than 3 days.",
      ),
      userItem(thread.id, second!.id, `${name}-user-1`, 2, "Sort by waiting time, longest first"),
      assistantItem(
        thread.id,
        second!.id,
        `${name}-assistant-1`,
        3,
        "Sorted the customers by waiting time, longest first.",
      ),
    ],
  };
}

/** Serves one workbook and the workspace's file list, and records the edits sent to it. */
export function installDocumentWorkspace(options?: {
  /** Edits are recorded and never answered, so the grid keeps them as unsaved. */
  readonly holdEdits?: boolean;
}) {
  const edits: Array<ReadonlyArray<SpreadsheetOperation>> = [];
  const values = new Map<string, string | number>();
  HEADERS.forEach((header, column) => values.set(`0:${column}`, header));
  ROWS.forEach((row, index) =>
    row.forEach((value, column) => values.set(`${index + 1}:${column}`, value)),
  );
  let version = 1;
  const rpc = installFakeRpc({
    [WS_METHODS.projectsListEntries]: () =>
      Effect.succeed({
        entries: [
          { path: "budget.xlsx", kind: "file" },
          { path: "Q4 ops review.pptx", kind: "file" },
          { path: "Refund policy 2026.pdf", kind: "file" },
          { path: "notes.md", kind: "file" },
        ],
        truncated: false,
      }),
    [WS_METHODS.projectsReadFile]: (input: { readonly relativePath: string }) =>
      Effect.succeed({
        relativePath: input.relativePath,
        contents: "# Notes\n\nCall Priya about the refunds.\nCheck the delivery dates.\n",
        byteLength: 62,
        truncated: false,
        version: "text-v1",
      }),
    [WS_METHODS.documentsOpenSpreadsheet]: () =>
      Effect.succeed({
        version: `v${version}`,
        format: "xlsx",
        sheets: [{ name: "Emails" }, { name: "Totals" }],
        date1904: false,
      }),
    [WS_METHODS.documentsReadSpreadsheetRange]: (input: {
      readonly row: number;
      readonly column: number;
      readonly rowCount: number;
      readonly columnCount: number;
    }) => {
      const cells: Array<SpreadsheetCell> = [];
      for (const [key, value] of values) {
        const [row, column] = key.split(":").map(Number) as [number, number];
        if (
          row < input.row ||
          row >= input.row + input.rowCount ||
          column < input.column ||
          column >= input.column + input.columnCount
        ) {
          continue;
        }
        cells.push({ row, column, value, ...(row === 0 ? { format: "bold" } : {}) });
      }
      return Effect.succeed({
        version: `v${version}`,
        rowCount: ROWS.length + 1,
        columnCount: HEADERS.length,
        cells,
        formats: { bold: { bold: true } },
      });
    },
    [WS_METHODS.documentsEditSpreadsheet]: (input: {
      readonly operations: ReadonlyArray<SpreadsheetOperation>;
    }) => {
      edits.push(input.operations);
      if (options?.holdEdits === true) return Effect.never;
      for (const operation of input.operations) {
        if (operation.type !== "setCell") continue;
        const key = `${operation.row}:${operation.column}`;
        if (operation.input.kind === "text") values.set(key, operation.input.text);
        else if (operation.input.kind === "number") values.set(key, operation.input.number);
      }
      version += 1;
      return Effect.succeed({
        version: `v${version}`,
        sheets: [{ name: "Emails" }, { name: "Totals" }],
      });
    },
  });
  return { edits, [Symbol.dispose]: () => rpc[Symbol.dispose]() };
}
