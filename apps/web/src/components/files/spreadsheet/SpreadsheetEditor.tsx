import type { SpreadsheetOperation } from "@codenine/contracts";
import { BoldIcon, EllipsisIcon, HashIcon, PlusIcon, Rows3Icon } from "lucide-react";
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
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import { requestConfirmDialog } from "~/confirmDialog";
import { useStableCallback } from "~/hooks/useStableCallback";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";

import {
  FileSurfaceAction,
  FileSurfaceBar,
  FileSurfaceFailure,
  FileSurfaceLoading,
  FileSurfaceNotice,
} from "../fileSurfaceChrome";
import {
  areaCellCount,
  areaToClipboardText,
  cellCopyText,
  cellDisplayText,
  cellEditText,
  cellLabel,
  type CellPosition,
  clipboardTextToRows,
  columnLabel,
  type GridSelection,
  moveSelection,
  parseCellInput,
  pasteTargets,
  selectionArea,
} from "./spreadsheetModel";
import {
  SpreadsheetSession,
  type SpreadsheetSnapshot,
  type SpreadsheetTransport,
} from "./spreadsheetSession";

const ROW_HEIGHT = 24;
const COLUMN_WIDTH = 112;
const HEADER_HEIGHT = 24;
const ROW_HEADER_WIDTH = 52;
const OVERSCAN = 3;
/** The most cells one copy, paste or clear handles, so a whole-sheet selection cannot stall the tab. */
const MAX_BULK_CELLS = 10_000;

const NUMBER_FORMATS = [
  { label: "Automatic", code: "" },
  { label: "Number", code: "#,##0.00" },
  { label: "Percent", code: "0%" },
  { label: "Date", code: "yyyy-mm-dd" },
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
  readonly name: string;
  readonly readOnly: boolean;
  /** Changes when the workspace may have changed, so the file is checked again. */
  readonly refreshKey: string | null;
  readonly saveDelayMs?: number;
  readonly onPendingChange: (pending: boolean) => void;
  /** Shown instead when the file cannot be opened for editing here. */
  readonly fallback: ReactNode;
  /** Bars above the grid that act on the whole file. */
  readonly renderHeader?: (state: SpreadsheetEditorState) => ReactNode;
}) {
  const { transport, saveDelayMs = 500 } = props;
  const [session, setSession] = useState<SpreadsheetSession | null>(null);
  const onPendingChange = useStableCallback(props.onPendingChange);
  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- the session owns the file's pages, save timer and unsaved edits for this mount, and flushes on the way out
  useEffect(() => {
    const created = new SpreadsheetSession({ transport, saveDelayMs, onPendingChange });
    // oxlint-disable-next-line react/set-state-in-effect -- the session is made with the effect that disposes of it, so a remount never reuses a stopped one
    setSession(created);
    void created.open();
    return () => created.dispose();
  }, [transport, saveDelayMs, onPendingChange]);
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
  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
          That change was not saved. {snapshot.notice}
        </FileSurfaceBar>
      ) : null}
      <SpreadsheetGrid
        key={snapshot.activeSheet}
        session={session}
        snapshot={snapshot}
        name={props.name}
        readOnly={props.readOnly}
      />
      {snapshot.format === "xlsx" ? (
        <SheetTabs session={session} snapshot={snapshot} readOnly={props.readOnly} />
      ) : null}
    </div>
  );
}

const SAVE_STATE_LABELS: Record<SpreadsheetSnapshot["saveState"], string> = {
  saved: "Saved",
  unsaved: "Unsaved",
  saving: "Saving...",
  failed: "Not saved",
};

interface Editing extends CellPosition {
  readonly text: string;
  /** Where the text is typed: over the cell, or in the formula bar. */
  readonly surface: "cell" | "bar";
}

function SpreadsheetGrid(props: {
  readonly session: SpreadsheetSession;
  readonly snapshot: SpreadsheetSnapshot;
  readonly name: string;
  readonly readOnly: boolean;
}) {
  const { session, snapshot } = props;
  const { selection, rowCount, columnCount, format, date1904 } = snapshot;
  const editable = !props.readOnly && !snapshot.busy && !snapshot.conflict;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ firstRow: 0, firstColumn: 0, rows: 40, columns: 12 });
  const [editing, setEditingState] = useState<Editing | null>(null);
  // Handlers read the ref: a blur that follows Enter, Tab or Escape must not commit a second time.
  const editingRef = useRef<Editing | null>(null);
  const setEditing = (next: Editing | null) => {
    editingRef.current = next;
    setEditingState(next);
  };

  const measure = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const next = {
      firstRow: Math.max(0, Math.floor(scroller.scrollTop / ROW_HEIGHT) - OVERSCAN),
      firstColumn: Math.max(0, Math.floor(scroller.scrollLeft / COLUMN_WIDTH) - OVERSCAN),
      rows: Math.ceil(scroller.clientHeight / ROW_HEIGHT) + OVERSCAN * 2 + 1,
      columns: Math.ceil(scroller.clientWidth / COLUMN_WIDTH) + OVERSCAN * 2 + 1,
    };
    setView((current) =>
      current.firstRow === next.firstRow &&
      current.firstColumn === next.firstColumn &&
      current.rows === next.rows &&
      current.columns === next.columns
        ? current
        : next,
    );
  };
  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- reads the scroller's laid-out size before paint and follows its resizes, which decide the cells to render
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    measure();
    return observeResize(scroller, measure);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `measure` only reads the scroller, which is the same element for the life of the grid
  }, []);

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

  const active = selection.anchor;
  const area = selectionArea(selection);
  const activeCell = snapshot.cellAt(active.row, active.column);
  const bounds = { rowCount, columnCount };

  const reveal = ({ row, column }: CellPosition) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const top = row * ROW_HEIGHT;
    const left = column * COLUMN_WIDTH;
    const height = scroller.clientHeight - HEADER_HEIGHT;
    const width = scroller.clientWidth - ROW_HEADER_WIDTH;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (top + ROW_HEIGHT > scroller.scrollTop + height) {
      scroller.scrollTop = top + ROW_HEIGHT - height;
    }
    if (left < scroller.scrollLeft) scroller.scrollLeft = left;
    else if (left + COLUMN_WIDTH > scroller.scrollLeft + width) {
      scroller.scrollLeft = left + COLUMN_WIDTH - width;
    }
  };
  const select = (next: GridSelection) => {
    session.select(next);
    reveal(next.focus);
  };
  const move = (rows: number, columns: number, extend: boolean) =>
    select(moveSelection(selection, { rows, columns }, extend, bounds));

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
    if (
      commit &&
      current.text !== cellEditText(snapshot.cellAt(current.row, current.column), format)
    ) {
      session.setCells([
        { row: current.row, column: current.column, input: parseCellInput(current.text, format) },
      ]);
    }
    if (then === undefined) return;
    scrollerRef.current?.focus({ preventScroll: true });
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
      }
      return;
    }
    if (event.altKey) return;
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
      areaToClipboardText(area, (row, column) => cellCopyText(snapshot.cellAt(row, column))),
    );
    return true;
  };
  const paste = (event: ClipboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || !editable) return;
    event.preventDefault();
    const targets = pasteTargets(
      clipboardTextToRows(event.clipboardData.getData("text/plain")),
      area,
      bounds,
    );
    if (targets.length > MAX_BULK_CELLS) return tooMany();
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
    if (target.closest("input")) return null;
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
    const column = Math.floor((event.clientX - rect.left - ROW_HEADER_WIDTH) / COLUMN_WIDTH);
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
    scrollerRef.current?.focus({ preventScroll: true });
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
  const rows = area.bottom - area.top + 1;
  const columns = area.right - area.left + 1;
  const sheet = snapshot.activeSheet;
  const plural = (count: number, noun: string) => (count === 1 ? noun : `${count} ${noun}s`);

  const cells: Array<ReactNode> = [];
  for (let row = view.firstRow; row < lastRow; row++) {
    for (let column = view.firstColumn; column < lastColumn; column++) {
      const cell = snapshot.cellAt(row, column);
      if (cell === undefined) continue;
      const pending = cell.value === undefined && cell.formula !== undefined;
      cells.push(
        <div
          key={`${row}:${column}`}
          role="gridcell"
          aria-rowindex={row + 1}
          aria-colindex={column + 1}
          data-cell={cellLabel({ row, column })}
          className={cn(
            "absolute overflow-hidden px-1.5 text-xs leading-6 text-ellipsis whitespace-nowrap",
            typeof cell.value === "number" && !cell.error && "text-right tabular-nums",
            cell.format?.bold && "font-semibold",
            cell.error && "text-destructive",
            pending && "text-muted-foreground",
          )}
          style={{
            top: HEADER_HEIGHT + row * ROW_HEIGHT,
            left: ROW_HEADER_WIDTH + column * COLUMN_WIDTH,
            width: COLUMN_WIDTH - 1,
            height: ROW_HEIGHT - 1,
            // A fill is a fixed colour, so its text stays dark in both themes.
            ...(cell.format?.fill === undefined
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
  for (let column = view.firstColumn; column < lastColumn; column++) {
    columnHeaders.push(
      <div
        key={column}
        role="columnheader"
        data-column-header={column}
        className={cn(
          "absolute top-0 flex h-full items-center justify-center border-r border-border/60 text-2xs text-muted-foreground select-none",
          column >= area.left && column <= area.right && "bg-accent text-foreground",
        )}
        style={{ left: ROW_HEADER_WIDTH + column * COLUMN_WIDTH, width: COLUMN_WIDTH }}
      >
        {columnLabel(column)}
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
          "absolute left-0 flex items-center justify-center border-r border-b border-border/60 bg-background text-2xs text-muted-foreground tabular-nums select-none",
          row >= area.top && row <= area.bottom && "bg-accent text-foreground",
        )}
        style={{ top: row * ROW_HEIGHT, width: ROW_HEADER_WIDTH, height: ROW_HEIGHT }}
      >
        {row + 1}
      </div>,
    );
  }

  return (
    <>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-2 text-xs">
        <span
          className="w-12 shrink-0 text-center font-mono text-2xs text-muted-foreground"
          aria-label="Selected cell"
        >
          {cellLabel(active)}
        </span>
        <input
          aria-label="Cell contents"
          className="h-6.5 min-w-0 flex-1 rounded-sm border border-input bg-transparent px-2 font-mono text-xs outline-none focus-visible:border-ring disabled:opacity-60"
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
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Number format"
                    title="Number format"
                    disabled={!editable}
                  />
                }
              >
                <HashIcon className="size-3.5" />
              </MenuTrigger>
              <MenuPopup align="end">
                {NUMBER_FORMATS.map((item) => (
                  <MenuItem
                    key={item.label}
                    onClick={() => session.setFormat({ numberFormat: item.code })}
                  >
                    {item.label}
                  </MenuItem>
                ))}
              </MenuPopup>
            </Menu>
          </>
        ) : null}
        <Menu>
          <MenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Rows and columns"
                title="Rows and columns"
                disabled={!editable}
              />
            }
          >
            <Rows3Icon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem
              onClick={() =>
                restructure({ type: "insertRows", sheet, index: area.top, count: rows })
              }
            >
              Insert {plural(rows, "row")} above
            </MenuItem>
            <MenuItem
              onClick={() =>
                restructure({ type: "insertRows", sheet, index: area.bottom + 1, count: rows })
              }
            >
              Insert {plural(rows, "row")} below
            </MenuItem>
            <MenuItem
              onClick={() =>
                restructure({ type: "insertColumns", sheet, index: area.left, count: columns })
              }
            >
              Insert {plural(columns, "column")} left
            </MenuItem>
            <MenuItem
              onClick={() =>
                restructure({ type: "insertColumns", sheet, index: area.right + 1, count: columns })
              }
            >
              Insert {plural(columns, "column")} right
            </MenuItem>
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
                restructure({ type: "deleteColumns", sheet, index: area.left, count: columns })
              }
            >
              Delete {plural(columns, "column")}
            </MenuItem>
          </MenuPopup>
        </Menu>
        <span
          className="shrink-0 pr-1 text-2xs whitespace-nowrap text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          {props.readOnly ? "Read only" : SAVE_STATE_LABELS[snapshot.saveState]}
        </span>
      </div>
      <div
        ref={scrollerRef}
        role="grid"
        tabIndex={0}
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
            width: ROW_HEADER_WIDTH + columnCount * COLUMN_WIDTH,
            height: HEADER_HEIGHT + rowCount * ROW_HEIGHT,
            backgroundImage:
              "linear-gradient(to right, var(--border) 1px, transparent 1px), linear-gradient(to bottom, var(--border) 1px, transparent 1px)",
            backgroundSize: `${COLUMN_WIDTH}px ${ROW_HEIGHT}px`,
            backgroundPosition: `${ROW_HEADER_WIDTH - 1}px ${HEADER_HEIGHT - 1}px`,
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
            className="sticky top-0 z-20 border-b border-border/60 bg-background"
            style={{ height: HEADER_HEIGHT }}
          >
            <div
              data-grid-corner
              className="sticky left-0 z-10 h-full border-r border-border/60 bg-background"
              style={{ width: ROW_HEADER_WIDTH }}
            />
            {columnHeaders}
          </div>
          <div className="sticky left-0 z-10 h-0" style={{ width: ROW_HEADER_WIDTH }}>
            {rowHeaders}
          </div>
          {cells}
          <div
            aria-hidden
            className="pointer-events-none absolute bg-primary/8"
            style={{
              top: HEADER_HEIGHT + area.top * ROW_HEIGHT,
              left: ROW_HEADER_WIDTH + area.left * COLUMN_WIDTH,
              width: columns * COLUMN_WIDTH - 1,
              height: rows * ROW_HEIGHT - 1,
            }}
          />
          <div
            aria-hidden
            data-active-cell={cellLabel(active)}
            className="pointer-events-none absolute border-2 border-primary"
            style={{
              top: HEADER_HEIGHT + active.row * ROW_HEIGHT - 1,
              left: ROW_HEADER_WIDTH + active.column * COLUMN_WIDTH - 1,
              width: COLUMN_WIDTH + 1,
              height: ROW_HEIGHT + 1,
            }}
          />
          {editing?.surface === "cell" ? (
            <input
              autoFocus
              aria-label={`Edit ${cellLabel(editing)}`}
              className="absolute z-10 border-2 border-primary bg-background px-1 text-xs outline-none"
              spellCheck={false}
              style={{
                top: HEADER_HEIGHT + editing.row * ROW_HEIGHT - 1,
                left: ROW_HEADER_WIDTH + editing.column * COLUMN_WIDTH - 1,
                minWidth: COLUMN_WIDTH + 1,
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

function SheetTabs(props: {
  readonly session: SpreadsheetSession;
  readonly snapshot: SpreadsheetSnapshot;
  readonly readOnly: boolean;
}) {
  const { session, snapshot } = props;
  const editable = !props.readOnly && !snapshot.busy && !snapshot.conflict;
  const [renaming, setRenaming] = useState<string | null>(null);
  const sheets = snapshot.sheets.filter((sheet) => sheet.hidden !== true);
  const active = snapshot.activeSheet;

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
    <div className="flex h-8 shrink-0 items-center gap-1 border-t border-border/60 px-2">
      <div
        role="tablist"
        aria-label="Sheets"
        className="flex min-w-0 items-center gap-0.5 overflow-x-auto"
      >
        {sheets.map((sheet) =>
          renaming !== null && sheet.name === active ? (
            <input
              key={sheet.name}
              aria-label="Sheet name"
              autoFocus
              className="h-6 w-32 shrink-0 rounded-sm border border-ring bg-background px-1.5 text-xs outline-none"
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
                "h-6 max-w-40 shrink-0 truncate rounded-sm px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                sheet.name === active
                  ? "bg-accent font-medium text-foreground"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
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
        <>
          <FileSurfaceAction label="Add sheet" onPress={addSheet}>
            <PlusIcon className="size-3.5" />
          </FileSurfaceAction>
          <Menu>
            <MenuTrigger
              render={
                <Button type="button" variant="ghost" size="icon-xs" aria-label="Sheet options" />
              }
            >
              <EllipsisIcon className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="start" side="top">
              <MenuItem onClick={() => setRenaming(active)}>Rename sheet</MenuItem>
              <MenuItem
                variant="destructive"
                disabled={sheets.length <= 1}
                onClick={() => void remove()}
              >
                Delete sheet
              </MenuItem>
            </MenuPopup>
          </Menu>
        </>
      ) : null}
    </div>
  );
}
