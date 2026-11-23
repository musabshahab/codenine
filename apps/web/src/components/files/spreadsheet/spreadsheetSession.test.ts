import type { SpreadsheetOperation } from "@codenine/contracts";
import { expect, it } from "vite-plus/test";

import {
  acquireSpreadsheetSession,
  SpreadsheetSession,
  type SpreadsheetSnapshot,
  type SpreadsheetTransport,
} from "./spreadsheetSession";

type EditResult = Awaited<ReturnType<SpreadsheetTransport["edit"]>>;
const SAVED: EditResult = { ok: true, value: { version: "v1", sheets: [{ name: "Data" }] } };
const FAILED: EditResult = { ok: false, failure: { kind: "failed", message: "Offline." } };
const refused = (operationIndex?: number): EditResult => ({
  ok: false,
  failure: {
    kind: "refused",
    message: "Not here.",
    fallback: false,
    ...(operationIndex === undefined ? {} : { operationIndex }),
  },
});

/** `answers` are given to the edits in order; an edit past the last of them is saved. */
function setup(answers: ReadonlyArray<EditResult | Promise<EditResult>> = []) {
  const edits: Array<ReadonlyArray<SpreadsheetOperation>> = [];
  const reads: Array<string> = [];
  const pendingReports: Array<boolean> = [];
  const transport: SpreadsheetTransport = {
    open: async () => ({
      ok: true,
      value: {
        version: "v1",
        format: "xlsx",
        sheets: [{ name: "Data" }, { name: "Huge" }],
        date1904: false,
      },
    }),
    readRange: async (range) => {
      reads.push(`${range.sheet}:${range.row}`);
      if (range.sheet === "Huge") {
        return {
          ok: false,
          failure: { kind: "refused", message: "Too many cells.", fallback: true },
        };
      }
      return {
        ok: true,
        value: {
          version: "v1",
          rowCount: 600,
          columnCount: 1,
          cells: range.row === 0 ? [{ row: 0, column: 0, value: 5 }] : [],
          formats: {},
        },
      };
    },
    edit: async (operations) => {
      edits.push(operations);
      return answers[edits.length - 1] ?? SAVED;
    },
  };
  // A save delay no test reaches: saves happen when the test flushes.
  const input = {
    transport,
    saveDelayMs: 3_600_000,
    onPendingChange: (pending: boolean) => {
      pendingReports.push(pending);
    },
  };
  const session = new SpreadsheetSession({ ...input, key: "book" });
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
  const ready = async () => {
    await session.open();
    session.showArea({ top: 0, left: 0, bottom: 20, right: 5 });
    await until((snapshot) => snapshot.cellAt(0, 0)?.value === 5);
  };
  return { session, input, edits, reads, pendingReports, until, ready };
}

const number = (row: number, value: number) => ({
  row,
  column: 0,
  input: { kind: "number", number: value } as const,
});

it("does not offer to undo an edit to a cell it has not read", async () => {
  const { session, edits, ready } = setup();
  await ready();

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
  session.release();
});

const cell = (row: number, value: number): SpreadsheetOperation => ({
  type: "setCell",
  sheet: "Data",
  row,
  column: 0,
  input: { kind: "number", number: value },
});
const insertRow: SpreadsheetOperation = { type: "insertRows", sheet: "Data", index: 2, count: 1 };

it("saves the other edits when one is refused, and sends a move on its own", async () => {
  // The second cell of the first batch is refused, and later the move is.
  const { session, edits, ready, until } = setup([refused(1), SAVED, SAVED, refused(0)]);
  await ready();
  session.setCells([number(0, 7), number(1, 8), number(2, 9)]);
  await session.flush();
  await until((snapshot) => snapshot.saveState === "saved");
  expect(edits).toEqual([
    [cell(0, 7), cell(1, 8), cell(2, 9)],
    [cell(0, 7), cell(2, 9)],
  ]);
  expect(session.getSnapshot().notice).toBe("Not here.");
  expect(session.getSnapshot().status).toBe("ready");

  session.setCells([number(3, 4)]);
  session.restructure(insertRow);
  await until((snapshot) => !snapshot.busy && snapshot.saveState === "saved");
  // The typed cell was saved before the refused move, in a request of its own.
  expect(edits.slice(2)).toEqual([[cell(3, 4)], [insertRow]]);
  session.release();
});

it("does not keep a move whose save failed, so later edits land where they were typed", async () => {
  const { session, edits, ready, until } = setup([FAILED]);
  await ready();
  session.restructure(insertRow);
  await until((snapshot) => !snapshot.busy);
  expect(session.getSnapshot().notice).toMatch(/left as they were/);
  // The grid still shows the old layout: an edit made now names the row the user sees.
  session.setCells([number(5, 1)]);
  await session.flush();
  expect(edits).toEqual([[insertRow], [cell(5, 1)]]);
  session.release();
});

it("sends edits made during a save when its grid goes, and keeps failed ones for the next", async () => {
  let finishFirst = (_: EditResult) => {};
  const first = new Promise<EditResult>((resolve) => {
    finishFirst = resolve;
  });
  const { session, input, edits, pendingReports, ready, until } = setup([first, FAILED, FAILED]);
  await ready();
  session.setCells([number(0, 1)]);
  void session.flush();
  session.setCells([number(1, 2)]);
  const parked = until((snapshot) => snapshot.saveState === "failed");
  session.release();
  finishFirst(SAVED);
  await parked;
  // The second edit went out after the grid was gone, failed, and is still held.
  expect(edits).toEqual([[cell(0, 1)], [cell(1, 2)]]);
  expect(pendingReports.at(-1)).toBe(true);

  const resumed = acquireSpreadsheetSession("book", input);
  expect(resumed).toBe(session);
  expect(resumed.getSnapshot().cellAt(1, 0)?.value).toBe(2);
  await until((snapshot) => snapshot.saveState === "failed");
  resumed.retry();
  await until((snapshot) => snapshot.saveState === "saved");
  expect(edits).toEqual([[cell(0, 1)], [cell(1, 2)], [cell(1, 2)], [cell(1, 2)]]);
  resumed.release();
  expect(pendingReports.at(-1)).toBe(false);
  // Nothing is unsaved now, so the next grid starts from the file.
  const fresh = acquireSpreadsheetSession("book", input);
  expect(fresh).not.toBe(session);
  // It still returns to the cell the user left, as when another document was shown meanwhile.
  const place = { anchor: { row: 4, column: 2 }, focus: { row: 6, column: 3 } };
  await new Promise<void>((resolve) => {
    const stop = fresh.subscribe(() => {
      if (fresh.getSnapshot().status !== "ready") return;
      stop();
      resolve();
    });
  });
  fresh.select(place);
  fresh.release();
  const back = acquireSpreadsheetSession("book", input);
  await new Promise<void>((resolve) => {
    const stop = back.subscribe(() => {
      if (back.getSnapshot().status !== "ready") return;
      stop();
      resolve();
    });
  });
  expect(back.getSnapshot().selection).toEqual(place);
  back.release();
});

it("says so when a sheet cannot be read, and formats a whole column only where it is used", async () => {
  const { session, edits, reads, ready, until } = setup();
  await ready();
  // A click on a column header selects to the bottom of the grid, far below the 600 used rows.
  session.select({
    anchor: { row: 0, column: 0 },
    focus: { row: session.getSnapshot().rowCount - 1, column: 0 },
  });
  session.setFormat({ bold: true });
  await session.flush();
  expect(edits).toEqual([
    [
      {
        type: "setFormat",
        sheet: "Data",
        row: 0,
        column: 0,
        rowCount: 600,
        columnCount: 1,
        format: { bold: true },
      },
    ],
  ]);

  session.selectSheet("Huge");
  session.showArea({ top: 0, left: 0, bottom: 20, right: 5 });
  await until((snapshot) => snapshot.sheetProblem !== null);
  expect(session.getSnapshot().sheetProblem).toBe("Too many cells.");
  session.showArea({ top: 0, left: 0, bottom: 20, right: 5 });
  expect(reads.filter((read) => read.startsWith("Huge"))).toEqual(["Huge:0"]);
  session.setCells([number(0, 1)]);
  await session.flush();
  expect(edits).toHaveLength(1);
  session.release();
});
