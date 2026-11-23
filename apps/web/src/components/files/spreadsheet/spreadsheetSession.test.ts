import type { SpreadsheetOperation } from "@codenine/contracts";
import { expect, it } from "vite-plus/test";

import {
  SpreadsheetSession,
  type SpreadsheetSnapshot,
  type SpreadsheetTransport,
} from "./spreadsheetSession";

function setup() {
  const edits: Array<ReadonlyArray<SpreadsheetOperation>> = [];
  const transport: SpreadsheetTransport = {
    open: async () => ({
      ok: true,
      value: { version: "v1", format: "xlsx", sheets: [{ name: "Data" }], date1904: false },
    }),
    readRange: async (range) => ({
      ok: true,
      value: {
        version: "v1",
        rowCount: 600,
        columnCount: 1,
        cells: range.row === 0 ? [{ row: 0, column: 0, value: 5 }] : [],
        formats: {},
      },
    }),
    edit: async (operations) => {
      edits.push(operations);
      return { ok: true, value: { version: "v1", sheets: [{ name: "Data" }] } };
    },
  };
  // A save delay no test reaches: saves happen when the test flushes.
  const session = new SpreadsheetSession({
    transport,
    saveDelayMs: 3_600_000,
    onPendingChange: () => {},
  });
  /** Settles on the first snapshot that matches, without polling. */
  const until = (matches: (snapshot: SpreadsheetSnapshot) => boolean) =>
    new Promise<void>((resolve) => {
      if (matches(session.getSnapshot())) return resolve();
      const stop = session.subscribe(() => {
        if (!matches(session.getSnapshot())) return;
        stop();
        resolve();
      });
    });
  return { session, edits, until };
}

const number = (row: number, value: number) => ({
  row,
  column: 0,
  input: { kind: "number", number: value } as const,
});

it("does not offer to undo an edit to a cell it has not read", async () => {
  const { session, edits, until } = setup();
  await session.open();
  session.showArea({ top: 0, left: 0, bottom: 20, right: 5 });
  await until((snapshot) => snapshot.cellAt(0, 0)?.value === 5);

  session.setCells([number(0, 7)]);
  expect(session.getSnapshot().cellAt(0, 0)?.value).toBe(7);
  expect(session.getSnapshot().canUndo).toBe(true);

  // Row 500 is on a page that was never on screen, so what it held is unknown. Undoing would
  // blank it, and undoing the earlier step across it would be out of order.
  session.setCells([number(500, 1)]);
  expect(session.getSnapshot().canUndo).toBe(false);
  await session.flush();
  session.undo();
  await session.flush();
  expect(edits).toEqual([
    [
      { type: "setCell", sheet: "Data", row: 0, column: 0, input: { kind: "number", number: 7 } },
      { type: "setCell", sheet: "Data", row: 500, column: 0, input: { kind: "number", number: 1 } },
    ],
  ]);
  session.dispose();
});
