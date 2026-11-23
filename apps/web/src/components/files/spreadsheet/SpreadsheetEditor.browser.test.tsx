import type { SpreadsheetCell, SpreadsheetOperation } from "@codenine/contracts";
import { Profiler } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { shouldTypeToFocusComposer } from "~/components/chat/composerFocusRedirect";
import { shouldRefocusComposerOnWindowFocus } from "~/components/ChatView.logic";
import { isEditableFocused, isInKeyboardGrid } from "~/lib/editableFocus";

import { render } from "../../../../test/render";
import SpreadsheetEditor from "./SpreadsheetEditor";
import type { SpreadsheetResult, SpreadsheetTransport } from "./spreadsheetSession";

const ok = <A,>(value: A): SpreadsheetResult<A> => ({ ok: true, value });

/** A one-sheet workbook held in memory: A1 is a number and B1 doubles it. */
function fakeWorkbook() {
  const state = {
    a1: 5,
    version: 1,
    conflictNext: false,
    opens: 0,
    edits: [] as Array<{
      operations: ReadonlyArray<SpreadsheetOperation>;
      expectedVersion: string | undefined;
    }>,
  };
  const transport: SpreadsheetTransport = {
    open: async () => {
      state.opens += 1;
      return ok({
        version: `v${state.version}`,
        format: "xlsx" as const,
        sheets: [{ name: "Data" }],
        date1904: false,
      });
    },
    readRange: async (range) => {
      const cells: Array<SpreadsheetCell> =
        range.row === 0 && range.column === 0
          ? [
              { row: 0, column: 0, value: state.a1 },
              { row: 0, column: 1, value: state.a1 * 2, formula: "A1*2" },
            ]
          : [];
      return ok({ version: `v${state.version}`, rowCount: 1, columnCount: 2, cells, formats: {} });
    },
    edit: async (operations, expectedVersion) => {
      state.edits.push({ operations, expectedVersion });
      if (state.conflictNext) {
        // Something else wrote the file: it now holds 100 at a version this grid never read.
        state.conflictNext = false;
        state.a1 = 100;
        state.version += 1;
        return { ok: false, failure: { kind: "conflict" } };
      }
      for (const operation of operations) {
        if (operation.type === "setCell" && operation.input.kind === "number") {
          state.a1 = operation.input.number;
        }
      }
      state.version += 1;
      return ok({ version: `v${state.version}`, sheets: [{ name: "Data" }] });
    },
  };
  return { state, transport };
}

it("saves a typed cell as an operation, undoes it, and stops at a file that changed on disk", async () => {
  const { state, transport } = fakeWorkbook();
  const onPendingChange = vi.fn();
  await using screen = await render(
    <div style={{ display: "flex", flexDirection: "column", height: 420, width: 640 }}>
      <SpreadsheetEditor
        transport={transport}
        sessionKey="book.xlsx"
        name="book.xlsx"
        readOnly={false}
        refreshKey={null}
        saveDelayMs={0}
        onPendingChange={onPendingChange}
        fallback={null}
      />
    </div>,
  );
  const cell = (name: string) => screen.container.querySelector(`[data-cell="${name}"]`);
  await vi.waitFor(() => expect(cell("B1")?.textContent).toBe("10"));

  // What the chat's window listeners ask before taking a key, a paste or the focus for the composer.
  const takenForComposer: Array<boolean> = [];
  const onKey = (event: KeyboardEvent) => takenForComposer.push(shouldTypeToFocusComposer(event));
  window.addEventListener("keydown", onKey, true);
  using _keys = { [Symbol.dispose]: () => window.removeEventListener("keydown", onKey, true) };

  await userEvent.click(cell("A1")!);
  // The selected grid keeps typing, undo, save and the focus on return to the window.
  expect(isEditableFocused()).toBe(true);
  expect(isInKeyboardGrid(document.activeElement)).toBe(true);
  expect(shouldRefocusComposerOnWindowFocus(document.activeElement)).toBe(false);
  await userEvent.keyboard("7{Enter}");
  expect(takenForComposer).toEqual([false, false]);
  // The edit shows at once, travels as one operation against the version that was read, and
  // the formula's new result comes back from the server.
  await vi.waitFor(() =>
    expect(state.edits).toEqual([
      {
        operations: [
          {
            type: "setCell",
            sheet: "Data",
            row: 0,
            column: 0,
            input: { kind: "number", number: 7 },
          },
        ],
        expectedVersion: "v1",
      },
    ]),
  );
  await vi.waitFor(() => expect(cell("B1")?.textContent).toBe("14"));
  await expect.element(screen.getByText("Saved", { exact: true })).toBeInTheDocument();
  expect(onPendingChange.mock.calls.map(([pending]) => pending)).toEqual([true, false]);
  // Enter moved the selection down, as in a spreadsheet app.
  expect(
    screen.container.querySelector("[data-active-cell]")?.getAttribute("data-active-cell"),
  ).toBe("A2");

  await userEvent.keyboard("{Control>}z{/Control}");
  await vi.waitFor(() => expect(cell("B1")?.textContent).toBe("10"));
  expect(state.edits[1]).toEqual({
    operations: [
      { type: "setCell", sheet: "Data", row: 0, column: 0, input: { kind: "number", number: 5 } },
    ],
    expectedVersion: "v2",
  });

  state.conflictNext = true;
  await userEvent.keyboard("{Control>}{Shift>}z{/Shift}{/Control}");
  await expect.element(screen.getByText(/changed on disk while you were editing/)).toBeVisible();
  // The redone edit is kept on screen and not sent again until the user decides.
  expect(cell("A1")?.textContent).toBe("7");
  expect(state.edits).toHaveLength(3);
  await userEvent.click(screen.getByRole("button", { name: "Reload from disk" }));
  await vi.waitFor(() => expect(cell("A1")?.textContent).toBe("100"));
  expect(state.edits).toHaveLength(3);
  await expect.element(screen.getByText("Saved", { exact: true })).toBeInTheDocument();
  expect(onPendingChange).toHaveBeenLastCalledWith(false);
});

const ROWS = 100_000;

/** A sheet of 100,000 rows: column A counts them and column B doubles the count. */
function longWorkbook() {
  const operations: Array<SpreadsheetOperation> = [];
  const reads: Array<number> = [];
  const searches: Array<string> = [];
  const transport: SpreadsheetTransport = {
    tools: true,
    open: async () =>
      ok({ version: "v1", format: "xlsx" as const, sheets: [{ name: "Data" }], date1904: false }),
    readRange: async (range) => {
      reads.push(range.row);
      const cells: Array<SpreadsheetCell> = [];
      if (range.column === 0) {
        for (let row = range.row; row < Math.min(ROWS, range.row + range.rowCount); row++) {
          cells.push({ row, column: 0, value: row + 1 }, { row, column: 1, value: (row + 1) * 2 });
        }
      }
      return ok({
        version: "v1",
        rowCount: ROWS,
        columnCount: 2,
        cells,
        formats: {},
        columnWidths: [{ column: 1, width: 150 }],
      });
    },
    find: async (_sheet, query) => {
      searches.push(query);
      return ok({
        version: "v1",
        matches: [
          { row: 41, column: 0 },
          { row: 419, column: 0 },
        ],
        truncated: false,
      });
    },
    edit: async (sent) => {
      operations.push(...sent);
      return ok({ version: "v1", sheets: [{ name: "Data" }] });
    },
  };
  return { operations, reads, searches, transport };
}

it("sends the tools as operations, goes where the name box and find say, and renders only what is on screen", async () => {
  const { operations, reads, searches, transport } = longWorkbook();
  let commits = 0;
  await using screen = await render(
    <div style={{ display: "flex", flexDirection: "column", height: 420, width: 720 }}>
      <Profiler id="grid" onRender={() => (commits += 1)}>
        <SpreadsheetEditor
          transport={transport}
          sessionKey="long.xlsx"
          name="long.xlsx"
          readOnly={false}
          refreshKey={null}
          saveDelayMs={0}
          onPendingChange={() => {}}
          fallback={null}
        />
      </Profiler>
    </div>,
  );
  const query = <T extends Element = HTMLElement>(selector: string) =>
    screen.container.querySelector<T>(selector);
  const cell = (name: string) => query(`[data-cell="${name}"]`);
  const active = () => query("[data-active-cell]")?.getAttribute("data-active-cell");
  const grid = () => query("[role=grid]")!;
  await vi.waitFor(() => expect(cell("B2")?.textContent).toBe("4"));
  // The file's own width for column B is the one the grid lays out.
  expect(cell("B2")!.getBoundingClientRect().width).toBe(149);

  // Three cells: the status bar adds them up, and the tools act on all three.
  await userEvent.click(cell("A2")!);
  await userEvent.keyboard("{Shift>}{ArrowDown}{ArrowDown}{/Shift}");
  await expect.element(screen.getByText("Sum 9 · Average 3 · Count 3")).toBeVisible();
  const area = { sheet: "Data", row: 1, column: 0, rowCount: 3, columnCount: 1 };
  await screen.getByRole("button", { name: "Bold" }).click();
  await screen.getByRole("button", { name: "Currency" }).click();
  await screen.getByRole("button", { name: "Amber fill" }).click();
  await screen.getByRole("button", { name: "Sort" }).click();
  await screen.getByRole("menuitem", { name: "Column A descending" }).click();
  await screen.getByRole("button", { name: "Row", exact: true }).click();
  await vi.waitFor(() =>
    expect(operations).toEqual([
      { type: "setFormat", ...area, format: { bold: true } },
      { type: "setFormat", ...area, format: { numberFormat: "$#,##0.00" } },
      { type: "setFormat", ...area, format: { fill: "FDEFC8" } },
      { type: "sortRows", sheet: "Data", row: 1, column: 0, descending: true },
      { type: "insertRows", sheet: "Data", index: 4, count: 1 },
    ]),
  );

  // A dragged column edge is saved with the file, once, at the width it was left at.
  const edge = query('[data-column-resize="0"]')!;
  const { x, y } = edge.getBoundingClientRect();
  const pointer = (type: string, clientX: number) =>
    edge.dispatchEvent(
      new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX, clientY: y + 2 }),
    );
  pointer("pointerdown", x);
  pointer("pointermove", x + 20);
  pointer("pointermove", x + 34);
  pointer("pointerup", x + 34);
  await vi.waitFor(() =>
    expect(operations.at(-1)).toEqual({
      type: "setColumnWidth",
      sheet: "Data",
      column: 0,
      count: 1,
      width: 130,
    }),
  );
  expect(operations).toHaveLength(6);

  // The name box takes an address. Only the rows on screen there are read and rendered.
  const nameBox = screen.getByRole("textbox", { name: "Name box" });
  await nameBox.fill("b90000");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(cell("B90000")?.textContent).toBe("180000"));
  expect(active()).toBe("B90000");
  expect(document.activeElement).toBe(grid());
  expect(screen.container.querySelectorAll("[role=gridcell]").length).toBeLessThan(60);
  // The first page, and the two the destination's rows straddle: none of those between.
  expect([...new Set(reads)].toSorted((a, b) => a - b)).toEqual([0, 89_900, 90_000]);
  await nameBox.fill("nowhere");
  await userEvent.keyboard("{Enter}");
  await expect.element(nameBox).toHaveAttribute("aria-invalid", "true");
  await userEvent.keyboard("{Escape}");
  await expect.element(nameBox).toHaveValue("B90000");

  // Scrolling within a row draws nothing again, and a row further draws once.
  await vi.waitFor(() => expect(cell("B90000")).not.toBeNull());
  const settled = commits;
  const top = grid().scrollTop;
  for (let step = 1; step <= 10; step++) {
    grid().scrollTop = top + step;
    grid().dispatchEvent(new Event("scroll"));
  }
  expect(commits).toBe(settled);
  grid().scrollTop = top + 28;
  grid().dispatchEvent(new Event("scroll"));
  await vi.waitFor(() => expect(commits).toBeGreaterThan(settled));
  expect(commits - settled).toBeLessThanOrEqual(2);

  // Find asks the server, starts from the selection and steps through what it found.
  await userEvent.click(cell("A90001")!);
  const find = screen.getByRole("searchbox", { name: "Find in sheet" });
  await find.fill("42");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(active()).toBe("A42"));
  await expect.element(screen.getByText("1 of 2")).toBeVisible();
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(active()).toBe("A420"));
  await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
  await vi.waitFor(() => expect(active()).toBe("A42"));
  expect(searches).toEqual(["42"]);
});

it("marks the cells an outside change touched while it is reviewed, and not after", async () => {
  const { state, transport } = fakeWorkbook();
  const view = (reviewing: boolean, refreshKey: string) => (
    <div style={{ display: "flex", flexDirection: "column", height: 300, width: 640 }}>
      <SpreadsheetEditor
        transport={transport}
        sessionKey="reviewed.xlsx"
        name="reviewed.xlsx"
        readOnly={false}
        refreshKey={refreshKey}
        reviewing={reviewing}
        onPendingChange={() => {}}
        fallback={null}
      />
    </div>
  );
  await using screen = await render(view(false, "turn-1"));
  const changed = () =>
    Array.from(screen.container.querySelectorAll("[data-changed]"), (node) =>
      node.getAttribute("data-cell"),
    );
  await vi.waitFor(() =>
    expect(screen.container.querySelector('[data-cell="B1"]')?.textContent).toBe("10"),
  );
  // An agent's turn writes the file; the workspace says so, and then the turn is up for review.
  state.a1 = 6;
  state.version += 1;
  await screen.rerender(view(false, "turn-2"));
  await vi.waitFor(() =>
    expect(screen.container.querySelector('[data-cell="B1"]')?.textContent).toBe("12"),
  );
  expect(changed()).toEqual([]);
  await screen.rerender(view(true, "turn-2"));
  await vi.waitFor(() => expect(changed()).toEqual(["A1", "B1"]));
  await screen.rerender(view(false, "turn-2"));
  await vi.waitFor(() => expect(changed()).toEqual([]));
});
