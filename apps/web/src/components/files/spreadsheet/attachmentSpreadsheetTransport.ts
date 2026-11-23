import type { SpreadsheetCell } from "@codenine/contracts";

import type { SpreadsheetTransport } from "./spreadsheetSession";

interface CellRange {
  readonly top: number;
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
}

/** What the read-only grid asks of an opened workbook. The preview worker answers it. */
export interface WorkbookEngine {
  readonly open: () => Promise<
    | {
        readonly tabs: ReadonlyArray<{ readonly index: number; readonly name: string }>;
        readonly layout: { readonly used: CellRange | undefined };
      }
    | undefined
  >;
  readonly show: (sheet: number) => Promise<{ readonly used: CellRange | undefined }>;
  /** The cells' text as they show, row by row. */
  readonly cells: (
    sheet: number,
    range: CellRange,
  ) => Promise<ReadonlyArray<ReadonlyArray<string>>>;
}

const READ_ONLY = {
  ok: false,
  failure: {
    kind: "refused",
    message: "This file is attached to a chat, so it opens read only.",
    fallback: false,
  },
} as const;

/**
 * Reads a workbook held in the browser, such as a chat attachment, for the same grid that edits
 * workspace files. Cells arrive as the text they show, and nothing is ever written.
 */
export function attachmentSpreadsheetTransport(engine: WorkbookEngine): SpreadsheetTransport {
  let tabs: ReadonlyArray<{ readonly index: number; readonly name: string }> = [];
  const used = new Map<number, CellRange | undefined>();
  const failed = (cause: unknown) =>
    ({
      ok: false,
      failure: {
        kind: "failed",
        message: cause instanceof Error ? cause.message : "This workbook could not be read.",
      },
    }) as const;
  return {
    open: async () => {
      try {
        const opened = await engine.open();
        if (opened === undefined) {
          return {
            ok: false,
            failure: {
              kind: "refused",
              message: "This workbook has no visible sheets.",
              fallback: false,
            },
          };
        }
        tabs = opened.tabs;
        return {
          ok: true,
          value: {
            version: "attachment",
            format: "xlsx",
            sheets: tabs.map((tab) => ({ name: tab.name })),
            date1904: false,
          },
        };
      } catch (cause) {
        return failed(cause);
      }
    },
    readRange: async (request) => {
      const tab = tabs.find((candidate) => candidate.name === request.sheet);
      if (tab === undefined) return failed(new Error(`There is no sheet named ${request.sheet}.`));
      try {
        if (!used.has(tab.index)) used.set(tab.index, (await engine.show(tab.index)).used);
        const extent = used.get(tab.index);
        const rowCount = extent === undefined ? 0 : extent.bottom + 1;
        const columnCount = extent === undefined ? 0 : extent.right + 1;
        const bottom = Math.min(request.row + request.rowCount, rowCount) - 1;
        const right = Math.min(request.column + request.columnCount, columnCount) - 1;
        const cells: Array<SpreadsheetCell> = [];
        if (bottom >= request.row && right >= request.column) {
          const rows = await engine.cells(tab.index, {
            top: request.row,
            left: request.column,
            bottom,
            right,
          });
          rows.forEach((row, rowOffset) =>
            row.forEach((value, columnOffset) => {
              if (value === "") return;
              cells.push({
                row: request.row + rowOffset,
                column: request.column + columnOffset,
                value,
              });
            }),
          );
        }
        return {
          ok: true,
          value: { version: "attachment", rowCount, columnCount, cells, formats: {} },
        };
      } catch (cause) {
        return failed(cause);
      }
    },
    edit: async () => READ_ONLY,
  };
}
