import type { SpreadsheetCell, SpreadsheetOperation } from "@codenine/contracts";
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
