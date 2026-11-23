import type { SpreadsheetOperation } from "@codenine/contracts";
import {
  ArrowDownAZIcon,
  ArrowUpZAIcon,
  BetweenHorizontalEndIcon,
  BetweenVerticalEndIcon,
  BoldIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  DollarSignIcon,
  EllipsisIcon,
  PaintBucketIcon,
  PercentIcon,
  Redo2Icon,
  Undo2Icon,
} from "lucide-react";
import {
  type ClipboardEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
} from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { requestConfirmDialog } from "~/confirmDialog";
import { useStableCallback } from "~/hooks/useStableCallback";
import { KEYBOARD_GRID_PROPS } from "~/lib/editableFocus";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";

import {
  FileStatusBar,
  FileSurfaceAction,
  FileSurfaceBar,
  FileSurfaceFailure,
  FileSurfaceLoading,
  FileSurfaceNotice,
  FileToolButton,
  FileToolRow,
  FileToolRowPinned,
  FileToolSeparator,
  FileToolStatus,
} from "../fileSurfaceChrome";
import {
  areaCellCount,
  areaLabel,
  areaToClipboardText,
  cellCopyText,
  cellDisplayText,
  cellEditText,
  cellLabel,
  type CellPosition,
  clampColumnWidth,
  clipboardTextToRows,
  columnLabel,
  columnLayout,
  DEFAULT_COLUMN_WIDTH,
  fittedColumnWidth,
  type GridSelection,
  moveSelection,
  parseCellInput,
  parseNameBoxInput,
  pasteTargets,
  selectionArea,
  selectionSummary,
  spreadsheetDocumentSelection,
  summaryNumber,
} from "./spreadsheetModel";
import { usePublishDocumentSelection } from "../documentSelectionPublisher";
import {
  acquireSpreadsheetSession,
  type SpreadsheetSession,
  type SpreadsheetSnapshot,
  type SpreadsheetTransport,
} from "./spreadsheetSession";
import { rememberColumnWidths, rememberSheetScroll, sheetView } from "./spreadsheetViewMemory";

const ROW_HEIGHT = 28;
/** The size cell text is drawn at, which is also the size it is measured at. */
const CELL_FONT_SIZE = 13;
/** A cell's side padding and border, plus a little air, around its measured text. */
const CELL_TEXT_PADDING = 20;
/** The rows whose text decides a column's fitted width. */
const FIT_ROWS = 200;
const HEADER_HEIGHT = 26;
const ROW_HEADER_WIDTH = 48;
const OVERSCAN = 3;
/** How far one press of the wider or narrower command moves a column's edge. */
const WIDTH_STEP = 16;
/** The most columns one fit or width command sizes, each of which is saved as an operation. */
const MAX_SIZED_COLUMNS = 100;
const NO_COLUMNS: ReadonlySet<number> = new Set();
const NO_WIDTHS: ReadonlyMap<number, number> = new Map();
/** The most cells one copy, paste or clear handles, so a whole-sheet selection cannot stall the tab. */
const MAX_BULK_CELLS = 10_000;

/** Six hex digits, as a workbook stores a fill. Pale, so dark text stays readable on them. */
const FILLS = [
  { label: "Amber", colour: "FDEFC8" },
  { label: "Green", colour: "DDF1E4" },
  { label: "Red", colour: "FADADA" },
] as const;

let measuringContext: CanvasRenderingContext2D | null = null;

/**
 * Widths for the columns on screen that have text and were not measured before. Null when there
 * are none, so a grid that is only scrolled or edited is never measured twice.
 */
function fitNewColumns(input: {
  readonly fitted: ReadonlySet<number>;
  readonly widths: ReadonlyMap<number, number>;
  readonly fontFamily: string;
  readonly firstColumn: number;
  readonly lastColumn: number;
  readonly rows: number;
  readonly text: (row: number, column: number) => { text: string; bold: boolean } | null;
}): { readonly widths: ReadonlyMap<number, number>; readonly columns: Array<number> } | null {
  const columns: Array<number> = [];
  let widths: Map<number, number> | null = null;
  for (let column = input.firstColumn; column < input.lastColumn; column++) {
    if (input.fitted.has(column)) continue;
    const textWidths: Array<number> = [];
    for (let row = 0; row < input.rows; row++) {
      const cell = input.text(row, column);
      if (cell === null) continue;
      measuringContext ??= document.createElement("canvas").getContext("2d");
      if (measuringContext === null) return null;
      measuringContext.font = `${cell.bold ? "600 " : ""}${CELL_FONT_SIZE}px ${input.fontFamily}`;
      textWidths.push(measuringContext.measureText(cell.text).width);
    }
    // A column with nothing read yet is looked at again when its cells arrive.
    if (textWidths.length === 0) continue;
    columns.push(column);
    const width = fittedColumnWidth(textWidths, CELL_TEXT_PADDING);
    if (width !== DEFAULT_COLUMN_WIDTH && !input.widths.has(column)) {
      (widths ??= new Map(input.widths)).set(column, width);
    }
  }
  return columns.length === 0 ? null : { widths: widths ?? input.widths, columns };
}

/** A cell's text as the grid draws it, for measuring. Null for a cell that holds nothing. */
const cellTextOf =
  (cellAt: SpreadsheetSnapshot["cellAt"], date1904: boolean) => (row: number, column: number) => {
    const cell = cellAt(row, column);
    return cell === undefined
      ? null
      : { text: cellDisplayText(cell, date1904), bold: cell.format?.bold === true };
  };

const CURRENCY_FORMAT = "$#,##0.00";
const PERCENT_FORMAT = "0%";
/** Formats that are asked for less often, offered in the menu. */
const MORE_NUMBER_FORMATS = [
  { label: "with two decimals", code: "#,##0.00" },
  { label: "as a date", code: "yyyy-mm-dd" },
] as const;

export interface SpreadsheetEditorState {
  /** The version on disk as the grid last read or wrote it. Absent while edits are unsaved. */
  readonly version: string | undefined;
  readonly reload: () => void;
}

/**
 * An editable grid over one spreadsheet file. It reads the cells on screen a page at a time and
 * saves edits as operations, so the file itself never crosses the connection.
 */
export default function SpreadsheetEditor(props: {
  /** Must keep its identity while the same file is shown. */
  readonly transport: SpreadsheetTransport;
  /** Names the file. A grid that returns to a file takes up the edits its last one left unsaved. */
  readonly sessionKey: string;
  readonly name: string;
  readonly readOnly: boolean;
  /** Changes when the workspace may have changed, so the file is checked again. */
  readonly refreshKey: string | null;
  readonly saveDelayMs?: number;
  readonly onPendingChange: (pending: boolean) => void;
  /** Shown instead when the file cannot be opened for editing here. */
  readonly fallback: ReactNode;
  /** A bar under the tools that acts on the whole file. */
  readonly renderHeader?: (state: SpreadsheetEditorState) => ReactNode;
  /** True while a change to the file is under review, when the cells it changed are marked. */
  readonly reviewing?: boolean;
}) {
  const { transport, sessionKey, saveDelayMs = 500 } = props;
  const [session, setSession] = useState<SpreadsheetSession | null>(null);
  const onPendingChange = useStableCallback(props.onPendingChange);
  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- the session owns the file's pages, save timer and unsaved edits; it is held for this mount and released on the way out, when it sends what is unsaved
  useEffect(() => {
    const acquired = acquireSpreadsheetSession(sessionKey, {
      transport,
      saveDelayMs,
      onPendingChange,
    });
    // oxlint-disable-next-line react/set-state-in-effect -- the session is acquired with the effect that releases it, so a remount never uses a stopped one
    setSession(acquired);
    return () => acquired.release();
  }, [transport, sessionKey, saveDelayMs, onPendingChange]);
  if (session === null) return <FileSurfaceLoading />;
  return <SpreadsheetSurface {...props} session={session} />;
}

function SpreadsheetSurface(props: {
  readonly session: SpreadsheetSession;
  readonly name: string;
  readonly readOnly: boolean;
  readonly refreshKey: string | null;
  readonly fallback: ReactNode;
  readonly renderHeader?: (state: SpreadsheetEditorState) => ReactNode;
  readonly reviewing?: boolean;
}) {
  const { session } = props;
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const openedWith = useRef(props.refreshKey);
  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- a workspace change is an outside event; the server is asked whether this file is still the one shown
  useEffect(() => {
    if (openedWith.current === props.refreshKey) return;
    openedWith.current = props.refreshKey;
    void session.checkForChanges();
  }, [session, props.refreshKey]);
  const [nameBox, setNameBox] = useState<NameBoxState>(null);
  const reviewing = props.reviewing === true;
  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- the session outlives this view and holds the marks, so it is told when a review starts and ends
  useEffect(() => {
    session.setReviewing(reviewing);
  }, [session, reviewing]);

  if (snapshot.status === "loading") return <FileSurfaceLoading />;
  if (snapshot.status === "unavailable") {
    const message = snapshot.unavailable?.message ?? "This file could not be opened.";
    if (!snapshot.unavailable?.fallback) {
      return <FileSurfaceFailure message={message} onRetry={() => void session.reload()} />;
    }
    return (
      <>
        <FileSurfaceNotice>Opened for viewing only. {message}</FileSurfaceNotice>
        {props.fallback}
      </>
    );
  }
  const saved = snapshot.saveState === "saved" && !snapshot.conflict;
  const bars = (
    <>
      {props.renderHeader?.({
        version: saved ? snapshot.version : undefined,
        reload: () => void session.reload(),
      })}
      {snapshot.conflict ? (
        <FileSurfaceBar
          tone="warning"
          actions={
            <>
              <Button
                type="button"
                size="micro"
                variant="outline"
                onClick={() => void session.reload()}
              >
                Reload from disk
              </Button>
              <Button
                type="button"
                size="micro"
                variant="destructive-outline"
                onClick={() => session.applyOverChange()}
              >
                Overwrite
              </Button>
            </>
          }
        >
          This file changed on disk while you were editing, so your edits are not saved. Reloading
          drops them. Overwriting saves only the cells you edited.
        </FileSurfaceBar>
      ) : null}
      {snapshot.saveState === "failed" ? (
        <FileSurfaceBar
          tone="warning"
          actions={
            <Button type="button" size="micro" variant="outline" onClick={() => session.retry()}>
              Try again
            </Button>
          }
        >
          Your edits could not be saved. They are kept here until saving works.
        </FileSurfaceBar>
      ) : null}
      {snapshot.notice !== null ? (
        <FileSurfaceBar
          tone="warning"
          actions={
            <Button
              type="button"
              size="micro"
              variant="outline"
              onClick={() => session.dismissNotice()}
            >
              Dismiss
            </Button>
          }
        >
          {snapshot.notice}
        </FileSurfaceBar>
      ) : null}
      {snapshot.sheetProblem !== null ? (
        <FileSurfaceNotice>
          This sheet cannot be shown here, so it looks empty. {snapshot.sheetProblem}
        </FileSurfaceNotice>
      ) : null}
    </>
  );
  return (
    <div className="@container flex min-h-0 flex-1 flex-col">
      <SpreadsheetGrid
        key={snapshot.activeSheet}
        session={session}
        snapshot={snapshot}
        name={props.name}
        readOnly={props.readOnly}
        bars={bars}
        onNameBox={setNameBox}
      />
      <SheetBar session={session} snapshot={snapshot} readOnly={props.readOnly} nameBox={nameBox} />
    </div>
  );
}

const SAVE_STATE_LABELS: Record<SpreadsheetSnapshot["saveState"], string> = {
  saved: "Saved",
  unsaved: "Unsaved",
  saving: "Saving…",
  failed: "Not saved",
};

/** What the name box is doing, which the status bar speaks for: it has no room for words. */
type NameBoxState = "typing" | "invalid" | null;

interface Editing extends CellPosition {
  readonly text: string;
  /** Where the text is typed: over the cell, or in the formula bar. */
  readonly surface: "cell" | "bar";
}

// Cells scroll under the headers, so a header is opaque: its tint is painted over the background.
const HEADER_FILL = "bg-background bg-linear-to-b from-muted to-muted";
const HEADER_SELECTED = "from-primary/14 to-primary/14 font-medium text-foreground";

const FIELD_CLASS =
  "h-7 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:ring-inset disabled:opacity-60";

function SpreadsheetGrid(props: {
  readonly session: SpreadsheetSession;
  readonly snapshot: SpreadsheetSnapshot;
  readonly name: string;
  readonly readOnly: boolean;
  readonly bars: ReactNode;
  readonly onNameBox: (state: NameBoxState) => void;
}) {
  const { session, snapshot } = props;
  const { selection, rowCount, columnCount, format, date1904, cellAt, changedAt, fileWidths } =
    snapshot;
  const editable =
    !props.readOnly && !snapshot.busy && !snapshot.conflict && snapshot.sheetProblem === null;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const [view, setView] = useState({ firstRow: 0, firstColumn: 0, rows: 40, columns: 12 });
  const sheet = snapshot.activeSheet;
  // The grid is keyed by its sheet, so this starts from the widths the sheet was left with.
  const [widths, setWidths] = useState(() => sheetView(session.view, sheet).widths);
  const layout = columnLayout(widths);
  const [editing, setEditingState] = useState<Editing | null>(null);
  // Handlers read the ref: a blur that follows Enter, Tab or Escape must not commit a second time.
  const editingRef = useRef<Editing | null>(null);
  const setEditing = (next: Editing | null) => {
    editingRef.current = next;
    setEditingState(next);
  };
  /** What is typed into the name box, until it is entered or left. */
  const [address, setAddress] = useState<{ text: string; invalid: boolean } | null>(null);

  // Stable for the scroll and resize listeners, which read the layout of the latest render.
  const measure = useStableCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    rememberSheetScroll(session.view, sheet, scroller.scrollTop, scroller.scrollLeft);
    const columns = layout;
    const firstVisible = columns.columnAt(scroller.scrollLeft);
    const next = {
      firstRow: Math.max(0, Math.floor(scroller.scrollTop / ROW_HEIGHT) - OVERSCAN),
      firstColumn: Math.max(0, firstVisible - OVERSCAN),
      rows: Math.ceil(scroller.clientHeight / ROW_HEIGHT) + OVERSCAN * 2 + 1,
      columns:
        columns.columnAt(scroller.scrollLeft + scroller.clientWidth) -
        firstVisible +
        OVERSCAN * 2 +
        1,
    };
    setView((current) =>
      current.firstRow === next.firstRow &&
      current.firstColumn === next.firstColumn &&
      current.rows === next.rows &&
      current.columns === next.columns
        ? current
        : next,
    );
  });
  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- reads the scroller's laid-out size before paint and follows its resizes, which decide the cells to render
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    // A grid that returns to a sheet shows the part of it the user left.
    const left = sheetView(session.view, sheet);
    scroller.scrollTop = left.scrollTop;
    scroller.scrollLeft = left.scrollLeft;
    measure();
    return observeResize(scroller, measure);
  }, [session, sheet, measure]);

  const lastRow = Math.min(rowCount, view.firstRow + view.rows);
  const lastColumn = Math.min(columnCount, view.firstColumn + view.columns);
  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- asks the server for the pages of cells now on screen
  useEffect(() => {
    if (lastRow > view.firstRow && lastColumn > view.firstColumn) {
      session.showArea({
        top: view.firstRow,
        left: view.firstColumn,
        bottom: lastRow - 1,
        right: lastColumn - 1,
      });
    }
  }, [session, view.firstRow, view.firstColumn, lastRow, lastColumn]);

  // `cellAt` changes only when cell contents may have, so moving the selection measures nothing.
  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- takes the widths the file sets, then measures cell text with a canvas once cells arrive so the other columns open wide enough for what they hold, before paint
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const held = sheetView(session.view, sheet);
    // A width the file gives a column is taken once. One the file gives later, as when an
    // agent sets it, is taken again, over a width the column was fitted or dragged to here.
    let base = widths;
    const fromFile: Array<number> = [];
    for (const [column, width] of fileWidths) {
      if (held.fileWidths.get(column) === width) continue;
      held.fileWidths.set(column, width);
      fromFile.push(column);
      if (base === widths) base = new Map(widths);
      (base as Map<number, number>).set(column, clampColumnWidth(width));
    }
    if (fromFile.length > 0) rememberColumnWidths(session.view, sheet, base, fromFile);
    const fitted = fitNewColumns({
      fitted: held.fitted,
      widths: base,
      fontFamily: getComputedStyle(scroller).fontFamily,
      firstColumn: view.firstColumn,
      lastColumn,
      rows: Math.min(rowCount, FIT_ROWS),
      text: cellTextOf(cellAt, date1904),
    });
    if (fitted !== null) {
      rememberColumnWidths(session.view, sheet, fitted.widths, fitted.columns);
      base = fitted.widths;
    }
    if (base !== widths) setWidths(base);
  }, [
    session,
    sheet,
    cellAt,
    fileWidths,
    widths,
    view.firstColumn,
    lastColumn,
    rowCount,
    date1904,
  ]);
  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- column widths decide which columns are on screen, so the scroller is measured again when they change
  useLayoutEffect(() => {
    measure();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `measure` reads the layout built from `widths`, so it runs again when they change
  }, [widths, measure]);

  const setColumnWidth = (column: number, width: number) => {
    const next = new Map(widths).set(column, clampColumnWidth(width));
    rememberColumnWidths(session.view, sheet, next, [column]);
    setWidths(next);
  };
  /** Gives columns the widths `size` says, here and, where it can be, in the file. */
  const sizeColumns = (first: number, last: number, size: (column: number) => number) => {
    const next = new Map(widths);
    const columns: Array<number> = [];
    const end = Math.min(last, columnCount - 1, first + MAX_SIZED_COLUMNS - 1);
    for (let column = first; column <= end; column++) {
      next.set(column, clampColumnWidth(size(column)));
      columns.push(column);
    }
    rememberColumnWidths(session.view, sheet, next, columns);
    setWidths(next);
    if (!editable) return;
    for (const column of columns) session.setColumnWidth(column, next.get(column)!);
  };
  /** Sizes columns to their text again, as a double click on a column's edge does. */
  const fitColumns = (first: number, last: number) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const fitted = fitNewColumns({
      fitted: NO_COLUMNS,
      widths: NO_WIDTHS,
      fontFamily: getComputedStyle(scroller).fontFamily,
      firstColumn: first,
      lastColumn: Math.min(last, first + MAX_SIZED_COLUMNS - 1) + 1,
      rows: Math.min(rowCount, FIT_ROWS),
      text: cellTextOf(cellAt, date1904),
    });
    sizeColumns(first, last, (column) => fitted?.widths.get(column) ?? DEFAULT_COLUMN_WIDTH);
  };
  const widenColumns = (step: number) =>
    sizeColumns(area.left, area.right, (column) => layout.widthOf(column) + step);
  const resizing = useRef<{ column: number; startX: number; startWidth: number } | null>(null);
  /** The drag is over: a width that changed is saved with the file where it can be. */
  const endResize = () => {
    const drag = resizing.current;
    resizing.current = null;
    if (drag === null) return;
    const width = sheetView(session.view, sheet).widths.get(drag.column);
    if (width !== undefined && width !== drag.startWidth && editable) {
      session.setColumnWidth(drag.column, width);
    }
  };

  const active = selection.anchor;
  const area = selectionArea(selection);
  const activeCell = cellAt(active.row, active.column);
  const bounds = { rowCount, columnCount };

  const reveal = ({ row, column }: CellPosition) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const top = row * ROW_HEIGHT;
    const left = layout.offsetOf(column);
    const columnWidth = layout.widthOf(column);
    const height = scroller.clientHeight - HEADER_HEIGHT;
    const width = scroller.clientWidth - ROW_HEADER_WIDTH;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (top + ROW_HEIGHT > scroller.scrollTop + height) {
      scroller.scrollTop = top + ROW_HEIGHT - height;
    }
    if (left < scroller.scrollLeft) scroller.scrollLeft = left;
    else if (left + columnWidth > scroller.scrollLeft + width) {
      scroller.scrollLeft = left + columnWidth - width;
    }
  };
  const select = (next: GridSelection) => {
    session.select(next);
    reveal(next.focus);
  };
  const move = (rows: number, columns: number, extend: boolean) =>
    select(moveSelection(selection, { rows, columns }, extend, bounds));
  const focusGrid = () => scrollerRef.current?.focus({ preventScroll: true });

  const startEditing = (text: string | null, surface: Editing["surface"]) => {
    if (!editable) return;
    reveal(active);
    setEditing({
      ...active,
      text: text ?? cellEditText(activeCell, format),
      surface,
    });
  };
  /** `then` is where the keyboard takes the selection next; a blur passes none and keeps focus where it went. */
  const finishEditing = (commit: boolean, then?: { rows: number; columns: number }) => {
    const current = editingRef.current;
    if (current === null) return;
    setEditing(null);
    if (commit && current.text !== cellEditText(cellAt(current.row, current.column), format)) {
      session.setCells([
        { row: current.row, column: current.column, input: parseCellInput(current.text, format) },
      ]);
    }
    if (then === undefined) return;
    focusGrid();
    if (then.rows !== 0 || then.columns !== 0) move(then.rows, then.columns, false);
  };
  const editorKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finishEditing(true, { rows: event.shiftKey ? -1 : 1, columns: 0 });
    } else if (event.key === "Tab") {
      event.preventDefault();
      finishEditing(true, { rows: 0, columns: event.shiftKey ? -1 : 1 });
    } else if (event.key === "Escape") {
      event.preventDefault();
      finishEditing(false, { rows: 0, columns: 0 });
    }
  };
  const goToAddress = (text: string) => {
    const target = parseNameBoxInput(text, bounds);
    if (target === null) {
      props.onNameBox("invalid");
      return setAddress({ text, invalid: true });
    }
    if (editingRef.current !== null) finishEditing(true);
    setAddress(null);
    session.select(target);
    reveal(target.focus);
    reveal(target.anchor);
    focusGrid();
  };

  const tooMany = () =>
    toastManager.add({
      type: "error",
      title: "That selection is too large",
      description: `Select up to ${MAX_BULK_CELLS.toLocaleString()} cells at a time.`,
    });
  const clearSelection = () => {
    if (!editable) return;
    if (areaCellCount(area) > MAX_BULK_CELLS) return tooMany();
    // Every cell is named: one on a page not read yet may hold something, and blanking an
    // empty cell changes nothing.
    const edits = [];
    for (let row = area.top; row <= area.bottom; row++) {
      for (let column = area.left; column <= area.right; column++) {
        edits.push({ row, column, input: { kind: "blank" } as const });
      }
    }
    session.setCells(edits);
  };

  const gridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const command = event.metaKey || event.ctrlKey;
    const key = event.key;
    const handled = () => event.preventDefault();
    if (command) {
      const letter = key.toLowerCase();
      if (letter === "z") {
        handled();
        if (event.shiftKey) session.redo();
        else session.undo();
      } else if (letter === "y") {
        handled();
        session.redo();
      } else if (letter === "s") {
        handled();
        void session.flush();
      } else if (letter === "a") {
        handled();
        session.select({
          anchor: { row: 0, column: 0 },
          focus: { row: rowCount - 1, column: columnCount - 1 },
        });
      } else if (letter === "f" && findRef.current !== null) {
        handled();
        event.stopPropagation();
        findRef.current.focus();
        findRef.current.select();
      } else if (letter === "b" && editable && format === "xlsx") {
        handled();
        session.setFormat({ bold: activeCell?.format?.bold !== true });
      }
      return;
    }
    if (event.altKey) {
      // Alt+Shift with a sideways arrow moves the selected columns' edge, as dragging it does.
      if (event.shiftKey && (key === "ArrowRight" || key === "ArrowLeft")) {
        handled();
        widenColumns(key === "ArrowRight" ? WIDTH_STEP : -WIDTH_STEP);
      }
      return;
    }
    const page = Math.max(1, view.rows - OVERSCAN * 2 - 2);
    switch (key) {
      case "ArrowUp":
        handled();
        return move(-1, 0, event.shiftKey);
      case "ArrowDown":
        handled();
        return move(1, 0, event.shiftKey);
      case "ArrowLeft":
        handled();
        return move(0, -1, event.shiftKey);
      case "ArrowRight":
        handled();
        return move(0, 1, event.shiftKey);
      case "PageUp":
        handled();
        return move(-page, 0, event.shiftKey);
      case "PageDown":
        handled();
        return move(page, 0, event.shiftKey);
      case "Home":
        handled();
        return move(0, -columnCount, event.shiftKey);
      case "Tab":
        handled();
        return move(0, event.shiftKey ? -1 : 1, false);
      case "Enter":
        handled();
        return move(event.shiftKey ? -1 : 1, 0, false);
      case "F2":
        handled();
        return startEditing(null, "cell");
      case "Delete":
      case "Backspace":
        handled();
        return clearSelection();
      default:
        // Typing replaces the cell's contents, starting with the typed character.
        if (key.length === 1 && editable) {
          handled();
          startEditing(key, "cell");
        }
    }
  };

  const copy = (event: ClipboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return false;
    event.preventDefault();
    if (areaCellCount(area) > MAX_BULK_CELLS) {
      tooMany();
      return false;
    }
    event.clipboardData.setData(
      "text/plain",
      areaToClipboardText(area, (row, column) => cellCopyText(cellAt(row, column))),
    );
    return true;
  };
  const paste = (event: ClipboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || !editable) return;
    event.preventDefault();
    const { targets, dropped } = pasteTargets(
      clipboardTextToRows(event.clipboardData.getData("text/plain")),
      area,
    );
    if (targets.length > MAX_BULK_CELLS) return tooMany();
    if (dropped > 0) {
      toastManager.add({
        type: "warning",
        title: "Not everything fitted",
        description: `${dropped.toLocaleString()} pasted cells fell past the last row or column and were left out.`,
      });
    }
    if (targets.length === 0) return;
    session.setCells(
      targets.map(({ row, column, text }) => ({
        row,
        column,
        input: parseCellInput(text, format),
      })),
    );
    const last = targets.at(-1)!;
    session.select({ anchor: targets[0]!, focus: { row: last.row, column: last.column } });
  };

  const positionAt = (event: PointerEvent<HTMLDivElement>): GridSelection | null => {
    const target = event.target as HTMLElement;
    if (target.closest("input,[data-column-resize]")) return null;
    const columnHeader = target.closest<HTMLElement>("[data-column-header]");
    if (columnHeader) {
      const column = Number(columnHeader.dataset.columnHeader);
      return { anchor: { row: 0, column }, focus: { row: rowCount - 1, column } };
    }
    const rowHeader = target.closest<HTMLElement>("[data-row-header]");
    if (rowHeader) {
      const row = Number(rowHeader.dataset.rowHeader);
      return { anchor: { row, column: 0 }, focus: { row, column: columnCount - 1 } };
    }
    if (target.closest("[data-grid-corner]")) return null;
    const rect = event.currentTarget.getBoundingClientRect();
    const across = event.clientX - rect.left - ROW_HEADER_WIDTH;
    const column = across < 0 ? -1 : layout.columnAt(across);
    const row = Math.floor((event.clientY - rect.top - HEADER_HEIGHT) / ROW_HEIGHT);
    if (row < 0 || column < 0 || row >= rowCount || column >= columnCount) return null;
    return { anchor: { row, column }, focus: { row, column } };
  };
  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const hit = positionAt(event);
    if (hit === null) return;
    if (editingRef.current !== null) finishEditing(true);
    // The grid keeps focus, so the keyboard works straight after a click.
    event.preventDefault();
    focusGrid();
    event.currentTarget.setPointerCapture(event.pointerId);
    session.select(event.shiftKey ? { anchor: selection.anchor, focus: hit.focus } : hit);
  };
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const hit = positionAt(event);
    if (hit === null) return;
    if (hit.focus.row !== selection.focus.row || hit.focus.column !== selection.focus.column) {
      session.select({ anchor: selection.anchor, focus: hit.focus });
    }
  };

  const restructure = (operation: SpreadsheetOperation) => {
    if (editingRef.current !== null) finishEditing(true);
    session.restructure(operation);
  };
  const sort = (descending: boolean) => {
    if (editingRef.current !== null) finishEditing(true);
    session.sortRows(descending);
  };
  const rows = area.bottom - area.top + 1;
  const columns = area.right - area.left + 1;
  usePublishDocumentSelection(
    spreadsheetDocumentSelection(sheet, area, (row, column) => cellCopyText(cellAt(row, column))),
  );
  const plural = (count: number, noun: string) => (count === 1 ? noun : `${count} ${noun}s`);

  const cells: Array<ReactNode> = [];
  for (let row = view.firstRow; row < lastRow; row++) {
    for (let column = view.firstColumn; column < lastColumn; column++) {
      const cell = cellAt(row, column);
      const changed = changedAt(row, column);
      if (cell === undefined && !changed) continue;
      const pending = cell?.value === undefined && cell?.formula !== undefined;
      cells.push(
        <div
          key={`${row}:${column}`}
          role="gridcell"
          aria-rowindex={row + 1}
          aria-colindex={column + 1}
          data-cell={cellLabel({ row, column })}
          {...(changed ? { "data-changed": "" } : {})}
          className={cn(
            "absolute overflow-hidden px-2 leading-6.75 text-ellipsis whitespace-nowrap",
            typeof cell?.value === "number" && !cell.error && "text-right tabular-nums",
            cell?.format?.bold && "font-semibold",
            cell?.error && "text-destructive",
            pending && "text-muted-foreground",
            // A change under review: a still tint and a corner mark, in both themes.
            changed &&
              "bg-info/12 after:absolute after:top-0 after:right-0 after:border-4 after:border-transparent after:border-t-info after:border-r-info",
          )}
          style={{
            top: HEADER_HEIGHT + row * ROW_HEIGHT,
            left: ROW_HEADER_WIDTH + layout.offsetOf(column),
            width: layout.widthOf(column) - 1,
            height: ROW_HEIGHT - 1,
            // A fill is a fixed colour, so its text stays dark in both themes.
            ...(cell?.format?.fill === undefined
              ? {}
              : { backgroundColor: `#${cell.format.fill}`, color: "#18181b" }),
          }}
        >
          {cellDisplayText(cell, date1904)}
        </div>,
      );
    }
  }

  const columnHeaders: Array<ReactNode> = [];
  const columnLines: Array<ReactNode> = [];
  for (let index = view.firstColumn; index < lastColumn; index++) {
    // The handlers below close over this, not the loop's counter.
    const column = index;
    const left = ROW_HEADER_WIDTH + layout.offsetOf(column);
    const width = layout.widthOf(column);
    columnLines.push(
      <div
        key={column}
        aria-hidden
        className="pointer-events-none absolute w-px bg-border"
        style={{ left: left + width - 1, top: HEADER_HEIGHT, height: rowCount * ROW_HEIGHT }}
      />,
    );
    columnHeaders.push(
      <div
        key={column}
        role="columnheader"
        data-column-header={column}
        className={cn(
          "absolute top-0 flex h-full items-center justify-center border-r border-border text-2xs text-muted-foreground select-none",
          HEADER_FILL,
          column >= area.left && column <= area.right && HEADER_SELECTED,
        )}
        style={{ left, width }}
      >
        {columnLabel(column)}
        <div
          data-column-resize={column}
          aria-hidden
          className="absolute top-0 -right-1 z-10 h-full w-2 cursor-col-resize touch-none hover:bg-primary/40"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.setPointerCapture(event.pointerId);
            resizing.current = { column, startX: event.clientX, startWidth: width };
          }}
          onPointerMove={(event) => {
            const drag = resizing.current;
            if (drag === null || drag.column !== column) return;
            setColumnWidth(column, drag.startWidth + event.clientX - drag.startX);
          }}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onDoubleClick={(event) => {
            event.stopPropagation();
            fitColumns(column, column);
          }}
        />
      </div>,
    );
  }
  const rowHeaders: Array<ReactNode> = [];
  for (let row = view.firstRow; row < lastRow; row++) {
    rowHeaders.push(
      <div
        key={row}
        role="rowheader"
        data-row-header={row}
        className={cn(
          "absolute left-0 flex items-center justify-center border-r border-b border-border text-2xs text-muted-foreground tabular-nums select-none",
          HEADER_FILL,
          row >= area.top && row <= area.bottom && HEADER_SELECTED,
        )}
        style={{ top: row * ROW_HEIGHT, width: ROW_HEADER_WIDTH, height: ROW_HEIGHT }}
      >
        {row + 1}
      </div>,
    );
  }

  const numberFormat = activeCell?.format?.numberFormat ?? "";
  const fill = activeCell?.format?.fill?.toUpperCase();
  return (
    <>
      <FileToolRow
        label="Spreadsheet tools"
        end={
          <FileToolStatus busy={snapshot.saveState === "saving"}>
            {props.readOnly ? "Read only" : SAVE_STATE_LABELS[snapshot.saveState]}
          </FileToolStatus>
        }
      >
        {props.readOnly ? null : (
          <>
            <FileSurfaceAction
              label="Undo"
              disabled={!editable || !snapshot.canUndo}
              onPress={() => session.undo()}
            >
              <Undo2Icon className="size-3.5" />
            </FileSurfaceAction>
            <FileSurfaceAction
              label="Redo"
              disabled={!editable || !snapshot.canRedo}
              onPress={() => session.redo()}
            >
              <Redo2Icon className="size-3.5" />
            </FileSurfaceAction>
            <FileToolSeparator />
            {format === "xlsx" ? (
              <>
                <FileSurfaceAction
                  label="Bold"
                  pressed={activeCell?.format?.bold === true}
                  disabled={!editable}
                  onPress={() => session.setFormat({ bold: activeCell?.format?.bold !== true })}
                >
                  <BoldIcon className="size-3.5" />
                </FileSurfaceAction>
                <FileSurfaceAction
                  label="Currency"
                  pressed={numberFormat === CURRENCY_FORMAT}
                  disabled={!editable}
                  onPress={() =>
                    session.setFormat({
                      numberFormat: numberFormat === CURRENCY_FORMAT ? "" : CURRENCY_FORMAT,
                    })
                  }
                >
                  <DollarSignIcon className="size-3.5" />
                </FileSurfaceAction>
                <FileSurfaceAction
                  label="Per cent"
                  pressed={numberFormat === PERCENT_FORMAT}
                  disabled={!editable}
                  onPress={() =>
                    session.setFormat({
                      numberFormat: numberFormat === PERCENT_FORMAT ? "" : PERCENT_FORMAT,
                    })
                  }
                >
                  <PercentIcon className="size-3.5" />
                </FileSurfaceAction>
                <FileToolSeparator />
                <div
                  role="group"
                  aria-label="Fill"
                  // Shown where the row has room; a narrower row offers the menu beside it.
                  className="hidden shrink-0 items-center gap-1 px-1 @[20.5rem]/tools:flex"
                >
                  <FillSwatch
                    label="No fill"
                    colour={null}
                    selected={fill === undefined}
                    disabled={!editable}
                    onPick={() => session.setFormat({ fill: null })}
                  />
                  {FILLS.map((item) => (
                    <FillSwatch
                      key={item.colour}
                      label={`${item.label} fill`}
                      colour={item.colour}
                      selected={fill === item.colour}
                      disabled={!editable}
                      onPick={() => session.setFormat({ fill: item.colour })}
                    />
                  ))}
                </div>
                <span className="flex shrink-0 @[20.5rem]/tools:hidden">
                  <Menu>
                    <MenuTrigger
                      render={
                        <Button
                          type="button"
                          className="relative"
                          variant="ghost"
                          size="icon-xs"
                          aria-label="Fill colour"
                          disabled={!editable}
                        />
                      }
                    >
                      <PaintBucketIcon className="size-3.5" />
                      {fill === undefined ? null : (
                        <span
                          aria-hidden
                          className="absolute right-0.5 bottom-0.5 size-2 rounded-full border border-border"
                          style={{ backgroundColor: `#${fill}` }}
                        />
                      )}
                    </MenuTrigger>
                    <MenuPopup align="start">
                      <MenuRadioGroup
                        value={fill ?? ""}
                        onValueChange={(value: string) =>
                          session.setFormat({ fill: value === "" ? null : value })
                        }
                      >
                        <MenuRadioItem value="">
                          <FillChoice colour={null} label="No fill" />
                        </MenuRadioItem>
                        {FILLS.map((item) => (
                          <MenuRadioItem key={item.colour} value={item.colour}>
                            <FillChoice colour={item.colour} label={item.label} />
                          </MenuRadioItem>
                        ))}
                      </MenuRadioGroup>
                    </MenuPopup>
                  </Menu>
                </span>
                <FileToolSeparator />
              </>
            ) : null}
            {session.tools ? (
              <span className="hidden shrink-0 @[16rem]/tools:flex">
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        type="button"
                        className="shrink-0"
                        variant="ghost"
                        size="xs"
                        disabled={!editable}
                      />
                    }
                  >
                    Sort
                  </MenuTrigger>
                  <MenuPopup align="start">
                    <MenuItem onClick={() => sort(false)}>
                      <ArrowDownAZIcon />
                      Column {columnLabel(active.column)} ascending
                    </MenuItem>
                    <MenuItem onClick={() => sort(true)}>
                      <ArrowUpZAIcon />
                      Column {columnLabel(active.column)} descending
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              </span>
            ) : null}
            <span className="hidden shrink-0 items-center gap-0.5 @[23.5rem]/tools:flex">
              <FileToolButton
                label="+ Row"
                name="Insert a row below"
                collapse="wide"
                disabled={!editable}
                onPress={() =>
                  restructure({ type: "insertRows", sheet, index: area.bottom + 1, count: 1 })
                }
              >
                <BetweenHorizontalEndIcon />
              </FileToolButton>
              <FileToolButton
                label="+ Column"
                name="Insert a column to the right"
                collapse="wide"
                disabled={!editable}
                onPress={() =>
                  restructure({ type: "insertColumns", sheet, index: area.right + 1, count: 1 })
                }
              >
                <BetweenVerticalEndIcon />
              </FileToolButton>
            </span>
            <FileToolRowPinned>
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      type="button"
                      className="shrink-0"
                      variant="ghost"
                      size="icon-xs"
                      aria-label="More for rows, columns and formats"
                      disabled={!editable}
                    />
                  }
                >
                  <EllipsisIcon className="size-3.5" />
                </MenuTrigger>
                <MenuPopup align="end">
                  {session.tools ? (
                    <>
                      <MenuItem onClick={() => sort(false)}>
                        <ArrowDownAZIcon />
                        Sort by column {columnLabel(active.column)}, ascending
                      </MenuItem>
                      <MenuItem onClick={() => sort(true)}>
                        <ArrowUpZAIcon />
                        Sort by column {columnLabel(active.column)}, descending
                      </MenuItem>
                      <MenuSeparator />
                    </>
                  ) : null}
                  <MenuItem
                    onClick={() =>
                      restructure({ type: "insertRows", sheet, index: area.top, count: rows })
                    }
                  >
                    Insert {plural(rows, "row")} above
                  </MenuItem>
                  <MenuItem
                    onClick={() =>
                      restructure({
                        type: "insertRows",
                        sheet,
                        index: area.bottom + 1,
                        count: rows,
                      })
                    }
                  >
                    Insert {plural(rows, "row")} below
                  </MenuItem>
                  <MenuItem
                    onClick={() =>
                      restructure({
                        type: "insertColumns",
                        sheet,
                        index: area.left,
                        count: columns,
                      })
                    }
                  >
                    Insert {plural(columns, "column")} left
                  </MenuItem>
                  <MenuItem
                    onClick={() =>
                      restructure({
                        type: "insertColumns",
                        sheet,
                        index: area.right + 1,
                        count: columns,
                      })
                    }
                  >
                    Insert {plural(columns, "column")} right
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem onClick={() => fitColumns(area.left, area.right)}>
                    Fit {plural(columns, "column")} to the text
                  </MenuItem>
                  <MenuItem onClick={() => widenColumns(WIDTH_STEP)}>
                    Make {plural(columns, "column")} wider
                    <MenuShortcut>Alt+Shift+→</MenuShortcut>
                  </MenuItem>
                  <MenuItem onClick={() => widenColumns(-WIDTH_STEP)}>
                    Make {plural(columns, "column")} narrower
                    <MenuShortcut>Alt+Shift+←</MenuShortcut>
                  </MenuItem>
                  {format === "xlsx" ? (
                    <>
                      <MenuSeparator />
                      <MenuItem onClick={() => session.setFormat({ numberFormat: "" })}>
                        Format as a plain number
                      </MenuItem>
                      <MenuItem
                        onClick={() => session.setFormat({ numberFormat: CURRENCY_FORMAT })}
                      >
                        Format as currency
                      </MenuItem>
                      <MenuItem onClick={() => session.setFormat({ numberFormat: PERCENT_FORMAT })}>
                        Format as a per cent
                      </MenuItem>
                      {MORE_NUMBER_FORMATS.map((item) => (
                        <MenuItem
                          key={item.label}
                          onClick={() => session.setFormat({ numberFormat: item.code })}
                        >
                          Format {item.label}
                        </MenuItem>
                      ))}
                    </>
                  ) : null}
                  <MenuSeparator />
                  <MenuItem
                    variant="destructive"
                    onClick={() =>
                      restructure({ type: "deleteRows", sheet, index: area.top, count: rows })
                    }
                  >
                    Delete {plural(rows, "row")}
                  </MenuItem>
                  <MenuItem
                    variant="destructive"
                    onClick={() =>
                      restructure({
                        type: "deleteColumns",
                        sheet,
                        index: area.left,
                        count: columns,
                      })
                    }
                  >
                    Delete {plural(columns, "column")}
                  </MenuItem>
                </MenuPopup>
              </Menu>
            </FileToolRowPinned>
          </>
        )}
      </FileToolRow>
      {props.bars}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 bg-background px-2">
        <input
          aria-label="Name box"
          aria-invalid={address?.invalid === true}
          className={cn(
            FIELD_CLASS,
            "w-18 shrink-0 text-center font-mono text-2xs text-muted-foreground focus-visible:text-foreground",
            // An address that leads nowhere is marked while the box still has the focus.
            "aria-invalid:border-destructive aria-invalid:focus-visible:border-destructive aria-invalid:focus-visible:ring-destructive/30",
          )}
          spellCheck={false}
          value={address?.text ?? areaLabel(area)}
          onFocus={(event) => {
            event.currentTarget.select();
            props.onNameBox("typing");
          }}
          onChange={(event) => {
            setAddress({ text: event.target.value, invalid: false });
            if (address?.invalid) props.onNameBox("typing");
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              goToAddress(event.currentTarget.value);
            } else if (event.key === "Escape") {
              event.preventDefault();
              setAddress(null);
              focusGrid();
            }
          }}
          onBlur={() => {
            setAddress(null);
            props.onNameBox(null);
          }}
        />
        <input
          aria-label="Cell contents"
          className={cn(FIELD_CLASS, "min-w-0 flex-1")}
          spellCheck={false}
          disabled={!editable}
          value={editing?.text ?? cellEditText(activeCell, format)}
          onFocus={() => {
            if (editingRef.current === null) startEditing(null, "bar");
          }}
          onChange={(event) =>
            setEditing({ ...active, surface: editing?.surface ?? "bar", text: event.target.value })
          }
          onKeyDown={editorKeyDown}
          onBlur={() => {
            if (editingRef.current?.surface === "bar") finishEditing(true);
          }}
        />
        {session.canFind ? (
          <SheetFind
            session={session}
            onInput={(element) => {
              findRef.current = element;
            }}
            onGo={(cell) => select({ anchor: cell, focus: cell })}
            onDone={focusGrid}
          />
        ) : null}
      </div>
      <div
        ref={scrollerRef}
        role="grid"
        tabIndex={0}
        // A grid that cannot be edited leaves typing to the composer, as any other view does.
        {...(props.readOnly ? {} : KEYBOARD_GRID_PROPS)}
        aria-label={`${props.name}: ${sheet}`}
        aria-rowcount={rowCount}
        aria-colcount={columnCount}
        aria-readonly={!editable}
        className="relative min-h-0 flex-1 overflow-auto bg-background outline-none"
        onScroll={measure}
        onKeyDown={gridKeyDown}
        onCopy={copy}
        onCut={(event) => {
          if (editable && copy(event)) clearSelection();
        }}
        onPaste={paste}
      >
        <div
          className="relative"
          style={{
            width: ROW_HEADER_WIDTH + layout.offsetOf(columnCount),
            height: HEADER_HEIGHT + rowCount * ROW_HEIGHT,
            fontSize: CELL_FONT_SIZE,
            backgroundImage: "linear-gradient(to bottom, var(--border) 1px, transparent 1px)",
            backgroundSize: `100% ${ROW_HEIGHT}px`,
            backgroundPosition: `0 ${HEADER_HEIGHT - 1}px`,
          }}
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onDoubleClick={(event) => {
            if (
              !(event.target as HTMLElement).closest("[role=columnheader],[role=rowheader],input")
            ) {
              startEditing(null, "cell");
            }
          }}
        >
          <div
            className={cn("sticky top-0 z-20 border-b border-border", HEADER_FILL)}
            style={{ height: HEADER_HEIGHT }}
          >
            <div
              data-grid-corner
              className={cn("sticky left-0 z-10 h-full border-r border-border", HEADER_FILL)}
              style={{ width: ROW_HEADER_WIDTH }}
            />
            {columnHeaders}
          </div>
          <div className="sticky left-0 z-10 h-0" style={{ width: ROW_HEADER_WIDTH }}>
            {rowHeaders}
          </div>
          {cells}
          {columnLines}
          {rows > 1 || columns > 1 ? (
            <div
              aria-hidden
              className="pointer-events-none absolute border border-primary/50 bg-primary/8"
              style={{
                top: HEADER_HEIGHT + area.top * ROW_HEIGHT - 1,
                left: ROW_HEADER_WIDTH + layout.offsetOf(area.left) - 1,
                width: layout.offsetOf(area.right + 1) - layout.offsetOf(area.left) + 1,
                height: rows * ROW_HEIGHT + 1,
              }}
            />
          ) : null}
          <div
            aria-hidden
            data-active-cell={cellLabel(active)}
            className="pointer-events-none absolute border-2 border-primary"
            style={{
              top: HEADER_HEIGHT + active.row * ROW_HEIGHT - 1,
              left: ROW_HEADER_WIDTH + layout.offsetOf(active.column) - 1,
              width: layout.widthOf(active.column) + 1,
              height: ROW_HEIGHT + 1,
            }}
          />
          {editing?.surface === "cell" ? (
            <input
              autoFocus
              aria-label={`Edit ${cellLabel(editing)}`}
              className="absolute z-10 border-2 border-primary bg-background px-1.5 outline-none"
              spellCheck={false}
              style={{
                top: HEADER_HEIGHT + editing.row * ROW_HEIGHT - 1,
                left: ROW_HEADER_WIDTH + layout.offsetOf(editing.column) - 1,
                minWidth: layout.widthOf(editing.column) + 1,
                width: `${Math.max(12, editing.text.length + 2)}ch`,
                height: ROW_HEIGHT + 1,
              }}
              value={editing.text}
              onChange={(event) => setEditing({ ...editing, text: event.target.value })}
              onKeyDown={editorKeyDown}
              onBlur={() => finishEditing(true)}
            />
          ) : null}
        </div>
      </div>
    </>
  );
}

interface Found {
  readonly query: string;
  readonly version: string | undefined;
  readonly matches: ReadonlyArray<CellPosition>;
  readonly truncated: boolean;
  readonly at: number;
}

/** Finds text in the active sheet. The server searches, since the grid holds only what is on screen. */
function SheetFind({
  session,
  onInput,
  ...props
}: {
  readonly session: SpreadsheetSession;
  /** Hands over the search box, so the grid's shortcut can put the caret in it. */
  readonly onInput: (element: HTMLInputElement | null) => void;
  readonly onGo: (cell: CellPosition) => void;
  readonly onDone: () => void;
}) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Found | null>(null);
  const [searching, setSearching] = useState(false);
  const text = query.trim();

  const step = async (direction: 1 | -1) => {
    if (text === "" || searching) return;
    let next: Found;
    if (found?.query === text && found.version === session.getSnapshot().version) {
      const count = found.matches.length;
      next = count === 0 ? found : { ...found, at: (found.at + direction + count) % count };
    } else {
      setSearching(true);
      const result = await session.find(text);
      setSearching(false);
      if (result === null) {
        toastManager.add({ type: "error", title: "This sheet could not be searched" });
        return;
      }
      // The search starts from the selected cell and wraps round.
      const { version, selection } = session.getSnapshot();
      const { row, column } = selection.anchor;
      const from = result.matches.findIndex(
        (match) => match.row > row || (match.row === row && match.column >= column),
      );
      next = { query: text, version, ...result, at: Math.max(0, from) };
    }
    setFound(next);
    const match = next.matches[next.at];
    if (match !== undefined) props.onGo(match);
  };
  const current = found?.query === text ? found : null;

  return (
    <div role="search" className="flex shrink-0 items-center gap-0.5">
      <div className="w-32">
        <Input
          ref={onInput}
          size="compact"
          type="search"
          aria-label="Find in sheet"
          placeholder="Find in sheet"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void step(event.shiftKey ? -1 : 1);
            } else if (event.key === "Escape") {
              event.preventDefault();
              setQuery("");
              props.onDone();
            }
          }}
        />
      </div>
      {text !== "" ? (
        <>
          <span
            role="status"
            className="px-1 text-2xs whitespace-nowrap text-muted-foreground tabular-nums"
          >
            {searching
              ? "Searching…"
              : current === null
                ? "Press Enter"
                : current.matches.length === 0
                  ? "No matches"
                  : `${current.at + 1} of ${current.matches.length}${current.truncated ? "+" : ""}`}
          </span>
          <FileSurfaceAction label="Previous match" onPress={() => void step(-1)}>
            <ChevronUpIcon className="size-3.5" />
          </FileSurfaceAction>
          <FileSurfaceAction label="Next match" onPress={() => void step(1)}>
            <ChevronDownIcon className="size-3.5" />
          </FileSurfaceAction>
        </>
      ) : null}
    </div>
  );
}

function FillChoice(props: { readonly colour: string | null; readonly label: string }) {
  return (
    <span className="flex items-center gap-2">
      <span
        aria-hidden
        className="size-3.5 shrink-0 rounded-full border border-border bg-background"
        style={props.colour === null ? undefined : { backgroundColor: `#${props.colour}` }}
      />
      {props.label}
    </span>
  );
}

function FillSwatch(props: {
  readonly label: string;
  /** Six hex digits, or null for no fill. */
  readonly colour: string | null;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onPick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={props.label}
            aria-pressed={props.selected}
            disabled={props.disabled}
            className={cn(
              "size-4.5 shrink-0 rounded-full border border-border bg-background outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:opacity-50",
              props.selected && "border-primary ring-1 ring-primary",
            )}
            style={props.colour === null ? undefined : { backgroundColor: `#${props.colour}` }}
            onClick={props.onPick}
          />
        }
      />
      <TooltipPopup>{props.label}</TooltipPopup>
    </Tooltip>
  );
}

/** Under the grid: the workbook's sheets, and what the selection adds up to. */
function SheetBar(props: {
  readonly session: SpreadsheetSession;
  readonly snapshot: SpreadsheetSnapshot;
  readonly readOnly: boolean;
  readonly nameBox: NameBoxState;
}) {
  const { session, snapshot } = props;
  const editable =
    !props.readOnly && !snapshot.busy && !snapshot.conflict && snapshot.sheetProblem === null;
  const [renaming, setRenaming] = useState<string | null>(null);
  const sheets = snapshot.sheets.filter((sheet) => sheet.hidden !== true);
  const active = snapshot.activeSheet;
  const { top, left, bottom, right } = selectionArea(snapshot.selection);
  const { cellAt } = snapshot;
  const summary = selectionSummary({ top, left, bottom, right }, cellAt);
  const selected = areaCellCount({ top, left, bottom, right });

  const addSheet = () => {
    const names = new Set(snapshot.sheets.map((sheet) => sheet.name.toLowerCase()));
    let number = snapshot.sheets.length + 1;
    while (names.has(`sheet${number}`)) number += 1;
    session.restructure({ type: "addSheet", name: `Sheet${number}` });
  };
  const rename = (name: string) => {
    setRenaming(null);
    const trimmed = name.trim();
    if (trimmed !== "" && trimmed !== active) {
      session.restructure({ type: "renameSheet", sheet: active, name: trimmed });
    }
  };
  const remove = async () => {
    const confirmed = await requestConfirmDialog(
      `Delete the sheet "${active}"?\nIts cells are removed from the workbook. Formulas that read them will show an error.`,
      { variant: "destructive" },
    );
    if (confirmed === true) session.restructure({ type: "deleteSheet", sheet: active });
  };

  return (
    <FileStatusBar>
      {snapshot.format === "xlsx" ? (
        <div className="flex min-w-0 shrink items-center gap-0.5">
          <div
            role="tablist"
            aria-label="Sheets"
            className="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {sheets.map((sheet) =>
              renaming !== null && sheet.name === active ? (
                <input
                  key={sheet.name}
                  aria-label="Sheet name"
                  autoFocus
                  className="h-5.5 w-32 shrink-0 rounded-sm border border-ring bg-background px-1.5 text-xs text-foreground outline-none"
                  maxLength={31}
                  value={renaming}
                  onChange={(event) => setRenaming(event.target.value)}
                  onBlur={(event) => rename(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") rename(event.currentTarget.value);
                    else if (event.key === "Escape") setRenaming(null);
                  }}
                />
              ) : (
                <button
                  key={sheet.name}
                  type="button"
                  role="tab"
                  aria-selected={sheet.name === active}
                  className={cn(
                    "h-5.5 max-w-40 shrink-0 truncate rounded-sm px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                    sheet.name === active
                      ? "bg-background font-medium text-foreground shadow-xs ring-1 ring-border"
                      : "hover:bg-accent hover:text-foreground",
                  )}
                  onClick={() => session.selectSheet(sheet.name)}
                  onDoubleClick={() => {
                    if (editable && sheet.name === active) setRenaming(active);
                  }}
                >
                  {sheet.name}
                </button>
              ),
            )}
          </div>
          {editable ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    type="button"
                    className="shrink-0"
                    variant="ghost"
                    size="icon-micro"
                    aria-label="Sheet options"
                  />
                }
              >
                <EllipsisIcon />
              </MenuTrigger>
              <MenuPopup align="start" side="top">
                <MenuItem onClick={addSheet}>Add a sheet</MenuItem>
                <MenuItem onClick={() => setRenaming(active)}>Rename this sheet</MenuItem>
                <MenuItem
                  variant="destructive"
                  disabled={sheets.length <= 1}
                  onClick={() => void remove()}
                >
                  Delete this sheet
                </MenuItem>
              </MenuPopup>
            </Menu>
          ) : null}
        </div>
      ) : null}
      <span role="status" className="ml-auto min-w-0 truncate tabular-nums">
        {props.nameBox === "invalid" ? (
          <span className="text-destructive">
            No cell or range is called that. Try B16 or A1:C4.
          </span>
        ) : props.nameBox === "typing" ? (
          "Type a cell or a range, such as B16 or A1:C4, and press Enter"
        ) : summary !== null ? (
          <>
            {summary.numbers > 0 ? (
              <>
                Sum {summaryNumber(summary.sum)}
                <span aria-hidden> · </span>
                Average {summaryNumber(summary.sum / summary.numbers)}
                <span aria-hidden> · </span>
              </>
            ) : null}
            Count {summary.count.toLocaleString("en-GB")}
          </>
        ) : selected > 1 ? (
          `${selected.toLocaleString("en-GB")} cells selected`
        ) : editable ? (
          snapshot.format === "xlsx" ? (
            "Type a value, or a formula such as =SUM(C2:C9)"
          ) : (
            "Type to change a cell. A CSV or TSV file holds text only."
          )
        ) : props.readOnly ? (
          "Read only"
        ) : null}
      </span>
    </FileStatusBar>
  );
}
