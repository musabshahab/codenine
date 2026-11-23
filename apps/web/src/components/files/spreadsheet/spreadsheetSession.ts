import type {
  SpreadsheetCellFormat,
  SpreadsheetCellInput,
  SpreadsheetEditResult,
  SpreadsheetFindResult,
  SpreadsheetOpenResult,
  SpreadsheetOperation,
  SpreadsheetReadRangeInput,
  SpreadsheetReadRangeResult,
  SpreadsheetSheet,
} from "@codenine/contracts";

import {
  areaCellCount,
  type CellChange,
  type CellData,
  cellFromInput,
  cellKey,
  type CellPosition,
  cellToInput,
  changedCellKeys,
  changeOperations,
  type EditHistory,
  EMPTY_HISTORY,
  type GridArea,
  type GridSelection,
  MAX_GRID_COLUMNS,
  MAX_GRID_ROWS,
  recordChanges,
  redoChanges,
  selectionArea,
  undoChanges,
} from "./spreadsheetModel";
import {
  newWorkbookView,
  sheetView,
  type WorkbookView,
  workbookView,
} from "./spreadsheetViewMemory";

export type SpreadsheetFailure =
  /** The file changed on disk since it was opened. */
  | { readonly kind: "conflict" }
  /** The server understood the request and will not do it; `fallback` when the file cannot be opened here at all. */
  | {
      readonly kind: "refused";
      readonly message: string;
      readonly fallback: boolean;
      /** The one operation of an edit that was refused; absent when the whole request was. */
      readonly operationIndex?: number;
    }
  | { readonly kind: "failed"; readonly message: string };

export type SpreadsheetResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly failure: SpreadsheetFailure };

type RangeRequest = Pick<
  SpreadsheetReadRangeInput,
  "sheet" | "row" | "column" | "rowCount" | "columnCount"
>;

/** How a session reaches the file. The grid never sees more of it than these calls. */
export interface SpreadsheetTransport {
  readonly open: () => Promise<SpreadsheetResult<SpreadsheetOpenResult>>;
  readonly readRange: (
    range: RangeRequest,
  ) => Promise<SpreadsheetResult<SpreadsheetReadRangeResult>>;
  /** Without an expected version the operations apply to whatever is on disk. */
  readonly edit: (
    operations: ReadonlyArray<SpreadsheetOperation>,
    expectedVersion: string | undefined,
  ) => Promise<SpreadsheetResult<SpreadsheetEditResult>>;
  /** Present when the file's holder can search a sheet. */
  readonly find?: (
    sheet: string,
    query: string,
  ) => Promise<SpreadsheetResult<SpreadsheetFindResult>>;
  /** True when the file's holder sorts rows and saves column widths. */
  readonly tools?: boolean;
}

export interface SpreadsheetSnapshot {
  readonly status: "loading" | "ready" | "unavailable";
  /** Why the file cannot be opened; `fallback` asks for the read-only viewer instead. */
  readonly unavailable: { readonly message: string; readonly fallback: boolean } | null;
  /** The version on disk as last read or written. */
  readonly version: string | undefined;
  readonly format: "xlsx" | "delimited";
  readonly date1904: boolean;
  readonly sheets: ReadonlyArray<SpreadsheetSheet>;
  readonly activeSheet: string;
  readonly selection: GridSelection;
  /** The size the grid lays out: the sheet's used size plus room to grow. */
  readonly rowCount: number;
  readonly columnCount: number;
  /**
   * Reads a cell of the active sheet. A new function whenever cell contents may have changed,
   * so whatever is derived from cells is derived again.
   */
  readonly cellAt: (row: number, column: number) => CellData | undefined;
  /** Whether a cell of the active sheet differs from before the file last changed outside the grid. */
  readonly changedAt: (row: number, column: number) => boolean;
  /** The widths the file sets for the active sheet's columns, in pixels. Replaced, never changed. */
  readonly fileWidths: ReadonlyMap<number, number>;
  readonly saveState: "saved" | "unsaved" | "saving" | "failed";
  readonly conflict: boolean;
  /** A change the server refused, to tell the user about once. */
  readonly notice: string | null;
  /** Why the active sheet's cells cannot be read, when they cannot. */
  readonly sheetProblem: string | null;
  /** True while a change that moves cells is being saved, when no other edit can be placed. */
  readonly busy: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

const PAGE_ROWS = 100;
const PAGE_COLUMNS = 40;
const MAX_PAGES = 48;
const SPARE_ROWS = 100;
const SPARE_COLUMNS = 12;
const MIN_ROWS = 200;
const MIN_COLUMNS = 26;
/** The most cells a format change shows at once before the server confirms it. */
const MAX_OPTIMISTIC_FORMAT_CELLS = 5000;
/** The most operations one save sends, under the server's limit for a request. */
const MAX_BATCH_OPERATIONS = 10_000;
const NOT_SAVED = "That change was not saved.";
const MOVE_NOT_MADE = `${NOT_SAVED} Saving failed, so the rows, columns and sheets were left as they were.`;
const NOTHING_SORTED =
  "Nothing was sorted. The rows around the selected cell are already in that order, or the cell is not in a table.";
const ORIGIN: GridSelection = { anchor: { row: 0, column: 0 }, focus: { row: 0, column: 0 } };

interface Page {
  readonly cells: Map<number, CellData>;
  /** A page read before the last save still shows until its fresh copy arrives. */
  stale: boolean;
}

interface Override {
  readonly data: CellData | undefined;
  /** The edit that made it; the override goes once a page read after that edit's save arrives. */
  readonly sequence: number;
}

const pageKey = (sheet: string, pageRow: number, pageColumn: number) =>
  `${sheet}\u0000${pageRow}\u0000${pageColumn}`;

const movesCells = (operation: SpreadsheetOperation) =>
  operation.type !== "setCell" &&
  operation.type !== "setFormat" &&
  operation.type !== "setColumnWidth";

const NO_WIDTHS: ReadonlyMap<number, number> = new Map();
const NOTHING_CHANGED = () => false;

interface SessionInput {
  readonly transport: SpreadsheetTransport;
  readonly saveDelayMs: number;
  readonly onPendingChange: (pending: boolean) => void;
}

// Sessions whose grid is gone while edits are still unsaved, by file.
const parked = new Map<string, SpreadsheetSession>();

/**
 * The session for a file: the one an earlier grid left holding unsaved edits, or a new one
 * that opens the file. The caller releases it when its grid goes.
 */
export function acquireSpreadsheetSession(key: string, input: SessionInput): SpreadsheetSession {
  const held = parked.get(key);
  if (held !== undefined) {
    parked.delete(key);
    held.resume(input.onPendingChange);
    return held;
  }
  const session = new SpreadsheetSession({ ...input, key });
  void session.open();
  return session;
}

/**
 * One open spreadsheet: the pages of cells read so far, the user's edits not yet saved, and
 * their undo history. Edits show at once and are sent as operations after a short pause.
 */
export class SpreadsheetSession {
  private readonly transport: SpreadsheetTransport;
  private readonly saveDelayMs: number;
  private readonly key: string | null;
  /** Where the user was in this file, kept after the session ends when the file has a key. */
  readonly view: WorkbookView;
  private onPendingChange: (pending: boolean) => void;
  private readonly listeners = new Set<() => void>();
  private snapshot: SpreadsheetSnapshot = {
    status: "loading",
    unavailable: null,
    version: undefined,
    format: "xlsx",
    date1904: false,
    sheets: [],
    activeSheet: "",
    selection: ORIGIN,
    rowCount: MIN_ROWS,
    columnCount: MIN_COLUMNS,
    cellAt: () => undefined,
    changedAt: () => false,
    fileWidths: NO_WIDTHS,
    saveState: "saved",
    conflict: false,
    notice: null,
    sheetProblem: null,
    busy: false,
    canUndo: false,
    canRedo: false,
  };
  private version: string | undefined;
  private readonly pages = new Map<string, Page>();
  private readonly loading = new Set<string>();
  private readonly overrides = new Map<string, Map<number, Override>>();
  private readonly usedSizes = new Map<string, { rows: number; columns: number }>();
  /** Sheets the server refused to read, with why, so they are not asked for again. */
  private readonly unreadable = new Map<string, string>();
  private readonly fileWidths = new Map<string, ReadonlyMap<number, number>>();
  /** Pages as they were when the file last changed outside the grid, until read again. */
  private readonly before = new Map<string, ReadonlyMap<number, CellData>>();
  /** Cells found to differ from `before`, by sheet. */
  private readonly changed = new Map<string, Set<number>>();
  private reviewing = false;
  private pending: Array<SpreadsheetOperation> = [];
  private history: EditHistory = EMPTY_HISTORY;
  private sequence = 0;
  private savedSequence = 0;
  private saving = false;
  private failed = false;
  private overwrite = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private visible: GridArea | null = null;
  private reportedPending = false;
  private released = false;
  private disposed = false;

  /** Without a key the session ends with its grid, whatever is still unsaved. */
  constructor(input: SessionInput & { readonly key?: string }) {
    this.transport = input.transport;
    this.saveDelayMs = input.saveDelayMs;
    this.onPendingChange = input.onPendingChange;
    this.key = input.key ?? null;
    this.view = this.key === null ? newWorkbookView() : workbookView(this.key);
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = () => this.snapshot;

  /** Whether rows can be sorted and column widths saved with the file. */
  get tools(): boolean {
    return this.transport.tools === true;
  }

  get canFind(): boolean {
    return this.transport.find !== undefined;
  }

  /**
   * Where a sheet's cells hold some text, after saving what is unsaved so the search sees it.
   * Null when the search could not be made.
   */
  async find(query: string): Promise<Omit<SpreadsheetFindResult, "version"> | null> {
    const { find } = this.transport;
    if (find === undefined || this.snapshot.status !== "ready") return null;
    await this.save();
    const result = await find(this.snapshot.activeSheet, query);
    return result.ok ? result.value : null;
  }

  /**
   * While a change to the file is under review, the cells it changed are marked. Ending the
   * review forgets them.
   */
  setReviewing(reviewing: boolean): void {
    if (reviewing === this.reviewing) return;
    this.reviewing = reviewing;
    if (!reviewing) {
      this.changed.clear();
      this.before.clear();
    }
    if (this.snapshot.status === "ready") this.bump();
  }

  async open(): Promise<void> {
    const result = await this.transport.open();
    if (this.disposed) return;
    if (!result.ok) {
      const { failure } = result;
      this.update({
        status: "unavailable",
        unavailable: {
          message: failure.kind === "conflict" ? "The file changed on disk." : failure.message,
          fallback: failure.kind === "refused" && failure.fallback,
        },
      });
      return;
    }
    this.adopt(result.value, true);
  }

  /** Reads the file again after something outside the grid may have changed it. */
  async checkForChanges(): Promise<void> {
    if (this.snapshot.status !== "ready" || this.saving) return;
    const result = await this.transport.open();
    if (this.disposed || this.saving || !result.ok || result.value.version === this.version) return;
    if (this.pending.length > 0) this.update({ conflict: true });
    else this.adopt(result.value, false);
  }

  private cell(row: number, column: number): CellData | undefined {
    const sheet = this.snapshot.activeSheet;
    const override = this.overrides.get(sheet)?.get(cellKey(row, column));
    if (override !== undefined) return override.data;
    return this.pages
      .get(pageKey(sheet, Math.floor(row / PAGE_ROWS), Math.floor(column / PAGE_COLUMNS)))
      ?.cells.get(cellKey(row, column));
  }

  private isRead(sheet: string, row: number, column: number) {
    return this.pages.has(
      pageKey(sheet, Math.floor(row / PAGE_ROWS), Math.floor(column / PAGE_COLUMNS)),
    );
  }

  /** Tells the session which cells are on screen, so it reads the pages that hold them. */
  showArea(area: GridArea): void {
    this.visible = area;
    if (this.snapshot.status !== "ready") return;
    const sheet = this.snapshot.activeSheet;
    if (this.unreadable.has(sheet)) return;
    for (
      let pageRow = Math.floor(area.top / PAGE_ROWS);
      pageRow <= Math.floor(area.bottom / PAGE_ROWS);
      pageRow++
    ) {
      for (
        let pageColumn = Math.floor(area.left / PAGE_COLUMNS);
        pageColumn <= Math.floor(area.right / PAGE_COLUMNS);
        pageColumn++
      ) {
        const key = pageKey(sheet, pageRow, pageColumn);
        const page = this.pages.get(key);
        if ((page === undefined || page.stale) && !this.loading.has(key)) {
          void this.loadPage(sheet, pageRow, pageColumn);
        } else if (page !== undefined) {
          // Keeps pages on screen newest, so they are the last to be dropped.
          this.pages.delete(key);
          this.pages.set(key, page);
        }
      }
    }
  }

  select(selection: GridSelection): void {
    sheetView(this.view, this.snapshot.activeSheet).selection = selection;
    this.update({ selection });
  }

  selectSheet(name: string): void {
    if (name === this.snapshot.activeSheet) return;
    this.view.activeSheet = name;
    this.update({
      activeSheet: name,
      selection: sheetView(this.view, name).selection ?? ORIGIN,
      sheetProblem: this.unreadable.get(name) ?? null,
      fileWidths: this.fileWidths.get(name) ?? NO_WIDTHS,
      ...this.gridSize(name),
    });
    this.bump();
  }

  /** One user action that changes cell contents, such as typing, clearing or pasting. */
  setCells(edits: ReadonlyArray<CellPosition & { readonly input: SpreadsheetCellInput }>): void {
    if (!this.canEdit()) return;
    const sheet = this.snapshot.activeSheet;
    const changes = edits.map((edit) => ({
      sheet,
      row: edit.row,
      column: edit.column,
      before: cellToInput(this.cell(edit.row, edit.column)),
      after: edit.input,
    }));
    const unread = changes.filter((change) => !this.isRead(sheet, change.row, change.column));
    if (unread.length === 0) {
      const recorded = recordChanges(this.history, changes);
      this.history = recorded.history;
      this.applyChanges(recorded.changes);
      return;
    }
    // What a cell on an unread page held is unknown, so the edit cannot be taken back, and
    // earlier steps could not be taken back across it either.
    const read = recordChanges(
      EMPTY_HISTORY,
      changes.filter((change) => this.isRead(sheet, change.row, change.column)),
    );
    this.history = EMPTY_HISTORY;
    this.applyChanges([...read.changes, ...unread]);
  }

  undo(): void {
    const step = this.canEdit() ? undoChanges(this.history) : null;
    if (step === null) return;
    this.history = step.history;
    this.applyChanges(step.changes);
  }

  redo(): void {
    const step = this.canEdit() ? redoChanges(this.history) : null;
    if (step === null) return;
    this.history = step.history;
    this.applyChanges(step.changes);
  }

  /** Changes the format of the selected cells. Not part of undo. */
  setFormat(format: Extract<SpreadsheetOperation, { type: "setFormat" }>["format"]): void {
    if (!this.canEdit()) return;
    const sheet = this.snapshot.activeSheet;
    const selected = selectionArea(this.snapshot.selection);
    const used = this.usedSizes.get(sheet) ?? { rows: 0, columns: 0 };
    // A whole column or row is selected to the grid's edge, past the last cell in use. Only the
    // part in use is formatted, so the sheet does not grow by empty cells that carry a format.
    const area = {
      ...selected,
      bottom:
        selected.top === 0 && selected.bottom >= this.snapshot.rowCount - 1
          ? Math.max(0, used.rows - 1)
          : selected.bottom,
      right:
        selected.left === 0 && selected.right >= this.snapshot.columnCount - 1
          ? Math.max(0, used.columns - 1)
          : selected.right,
    };
    this.sequence += 1;
    if (areaCellCount(area) <= MAX_OPTIMISTIC_FORMAT_CELLS) {
      for (let row = area.top; row <= area.bottom; row++) {
        for (let column = area.left; column <= area.right; column++) {
          const cell = this.cell(row, column);
          const { fill: _fill, ...withoutFill } = cell?.format ?? {};
          const next: SpreadsheetCellFormat = {
            ...(format.fill === undefined ? cell?.format : withoutFill),
            ...(format.bold === undefined ? {} : { bold: format.bold }),
            ...(format.numberFormat === undefined ? {} : { numberFormat: format.numberFormat }),
            ...(typeof format.fill === "string" ? { fill: format.fill } : {}),
          };
          this.override(sheet, row, column, { ...cell, format: next });
        }
      }
    }
    this.pending.push({
      type: "setFormat",
      sheet,
      row: area.top,
      column: area.left,
      rowCount: area.bottom - area.top + 1,
      columnCount: area.right - area.left + 1,
      format,
    });
    this.bump();
    this.scheduleSave();
  }

  /**
   * A change that moves cells or sheets. It is saved at once, after the cell edits made before
   * it and in a request of its own, and the edit history ends there: the cells it names are no
   * longer where it left them.
   */
  restructure(operation: SpreadsheetOperation): void {
    if (!this.canEdit()) return;
    this.sequence += 1;
    this.pending.push(operation);
    this.update({ busy: true });
    void this.save();
  }

  /**
   * Sorts the table around the selected cell by that cell's column. The server finds the table
   * and its headings, since it holds every row and the grid only the pages on screen.
   */
  sortRows(descending: boolean): void {
    const { row, column } = this.snapshot.selection.anchor;
    this.restructure({
      type: "sortRows",
      sheet: this.snapshot.activeSheet,
      row,
      column,
      descending,
    });
  }

  /** Saves a column width with the file. Not part of undo. */
  setColumnWidth(column: number, width: number): void {
    if (!this.canEdit() || !this.tools || this.snapshot.format !== "xlsx") return;
    const sheet = this.snapshot.activeSheet;
    const last = this.pending.at(-1);
    // A column dragged again before the save goes once, at its last width.
    if (last?.type === "setColumnWidth" && last.sheet === sheet && last.column === column) {
      this.pending.pop();
    }
    this.sequence += 1;
    this.pending.push({ type: "setColumnWidth", sheet, column, count: 1, width });
    this.scheduleSave();
  }

  /** Saves pending edits now instead of after the pause. Settles when that save has. */
  flush(): Promise<void> {
    return this.save();
  }

  /** Drops unsaved edits and shows the file as it is on disk. */
  async reload(): Promise<void> {
    this.pending = [];
    this.failed = false;
    this.overwrite = false;
    this.update({
      status: "loading",
      conflict: false,
      notice: null,
      sheetProblem: null,
      busy: false,
    });
    this.reportPending();
    await this.open();
  }

  /** Applies the unsaved edits to the file as it is now on disk. */
  applyOverChange(): void {
    this.overwrite = true;
    this.update({ conflict: false });
    void this.save();
  }

  retry(): void {
    this.failed = false;
    void this.save();
  }

  dismissNotice(): void {
    this.update({ notice: null });
  }

  /**
   * The grid is gone. Edits still unsaved are sent, and the session lives on until they are
   * saved; while a save keeps failing or the file is in conflict it waits for the next grid
   * over the same file, which takes it up with those edits.
   */
  release(): void {
    this.visible = null;
    this.released = true;
    if (!this.hasUnsaved()) return this.stop();
    if (this.key !== null) parked.set(this.key, this);
    this.failed = false;
    void this.save();
  }

  /** A new grid takes up the session an earlier one released. */
  resume(onPendingChange: (pending: boolean) => void): void {
    this.released = false;
    this.onPendingChange = onPendingChange;
    if (this.reportedPending) onPendingChange(true);
    if (this.failed) this.retry();
    void this.checkForChanges();
  }

  private hasUnsaved() {
    return this.saving || this.pending.length > 0;
  }

  private stop() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.disposed = true;
    if (this.key !== null && parked.get(this.key) === this) parked.delete(this.key);
    if (this.reportedPending) this.onPendingChange(false);
  }

  private canEdit() {
    const { status, busy, conflict, sheetProblem } = this.snapshot;
    return status === "ready" && !busy && !conflict && sheetProblem === null;
  }

  private adopt(opened: SpreadsheetOpenResult, resetView: boolean) {
    this.version = opened.version;
    if (resetView) {
      this.before.clear();
      this.changed.clear();
    } else {
      // The file changed outside the grid: what was on screen is kept to compare with what is
      // read next. Marks from a change nobody is reviewing are stale by now.
      if (!this.reviewing) this.changed.clear();
      for (const [key, page] of this.pages) {
        if (!this.before.has(key)) this.before.set(key, page.cells);
      }
    }
    this.fileWidths.clear();
    this.pages.clear();
    this.overrides.clear();
    this.usedSizes.clear();
    this.unreadable.clear();
    this.history = EMPTY_HISTORY;
    this.savedSequence = this.sequence;
    const visibleSheets = opened.sheets.filter((sheet) => sheet.hidden !== true);
    const wanted = resetView ? this.view.activeSheet : this.snapshot.activeSheet;
    const kept = opened.sheets.find((sheet) => sheet.name === wanted);
    const activeSheet = (kept ?? visibleSheets[0] ?? opened.sheets[0])?.name ?? "";
    const remembered = sheetView(this.view, activeSheet).selection;
    this.update({
      status: "ready",
      unavailable: null,
      version: opened.version,
      format: opened.format,
      date1904: opened.date1904,
      sheets: opened.sheets,
      activeSheet,
      sheetProblem: null,
      fileWidths: NO_WIDTHS,
      // A file opened again returns to the sheet and cell the user left it on.
      selection: resetView
        ? (remembered ?? ORIGIN)
        : kept === undefined
          ? ORIGIN
          : this.snapshot.selection,
      ...this.gridSize(activeSheet),
    });
    this.bump();
    if (this.visible !== null) this.showArea(this.visible);
  }

  private gridSize(sheet: string) {
    const used = this.usedSizes.get(sheet) ?? { rows: 0, columns: 0 };
    return {
      rowCount: Math.min(MAX_GRID_ROWS, Math.max(MIN_ROWS, used.rows + SPARE_ROWS)),
      columnCount: Math.min(MAX_GRID_COLUMNS, Math.max(MIN_COLUMNS, used.columns + SPARE_COLUMNS)),
    };
  }

  private grow(sheet: string, rows: number, columns: number) {
    const used = this.usedSizes.get(sheet) ?? { rows: 0, columns: 0 };
    if (rows <= used.rows && columns <= used.columns) return;
    this.usedSizes.set(sheet, {
      rows: Math.max(used.rows, rows),
      columns: Math.max(used.columns, columns),
    });
    if (sheet === this.snapshot.activeSheet) this.update(this.gridSize(sheet));
  }

  private async loadPage(sheet: string, pageRow: number, pageColumn: number) {
    const key = pageKey(sheet, pageRow, pageColumn);
    const requestedAt = this.version;
    const coveredSequence = this.savedSequence;
    this.loading.add(key);
    const result = await this.transport.readRange({
      sheet,
      row: pageRow * PAGE_ROWS,
      column: pageColumn * PAGE_COLUMNS,
      rowCount: PAGE_ROWS,
      columnCount: PAGE_COLUMNS,
    });
    this.loading.delete(key);
    if (this.disposed) return;
    if (!result.ok) {
      // A sheet the server will not read is said to be so, not shown as empty and asked for again.
      if (result.failure.kind !== "refused") return;
      this.unreadable.set(sheet, result.failure.message);
      if (sheet === this.snapshot.activeSheet) {
        this.update({ sheetProblem: result.failure.message });
      }
      return;
    }
    const range = result.value;
    if (range.version !== this.version) {
      // A page answered before this session's own save landed is read again; any other version
      // means the file changed outside the grid.
      if (range.version === requestedAt) {
        if (this.visible !== null) this.showArea(this.visible);
      } else void this.checkForChanges();
      return;
    }
    const cells = new Map<number, CellData>();
    for (const cell of range.cells) {
      const format = cell.format === undefined ? undefined : range.formats[cell.format];
      cells.set(cellKey(cell.row, cell.column), {
        ...(cell.value === undefined ? {} : { value: cell.value }),
        ...(cell.formula === undefined ? {} : { formula: cell.formula }),
        ...(cell.error === true ? { error: true } : {}),
        ...(format === undefined ? {} : { format }),
      });
    }
    this.pages.delete(key);
    this.pages.set(key, { cells, stale: false });
    const earlier = this.before.get(key);
    if (earlier !== undefined) {
      this.before.delete(key);
      const differing = changedCellKeys(earlier, cells);
      if (differing.length > 0) {
        const marked = this.changed.get(sheet) ?? new Set<number>();
        for (const cell of differing) marked.add(cell);
        this.changed.set(sheet, marked);
      }
    }
    this.readWidths(sheet, pageColumn, range.columnWidths ?? []);
    const oldest = this.pages.keys().next();
    if (this.pages.size > MAX_PAGES && !oldest.done) this.pages.delete(oldest.value);
    // The page holds every edit saved before it was asked for, so those no longer need showing.
    const overrides = this.overrides.get(sheet);
    if (overrides !== undefined) {
      for (const [cell, override] of overrides) {
        const row = Math.floor(cell / MAX_GRID_COLUMNS);
        const column = cell % MAX_GRID_COLUMNS;
        if (
          override.sequence <= coveredSequence &&
          Math.floor(row / PAGE_ROWS) === pageRow &&
          Math.floor(column / PAGE_COLUMNS) === pageColumn
        ) {
          overrides.delete(cell);
        }
      }
    }
    this.grow(sheet, range.rowCount, range.columnCount);
    this.bump();
  }

  /** Takes a page's column widths as the file's for those columns. */
  private readWidths(
    sheet: string,
    pageColumn: number,
    read: NonNullable<SpreadsheetReadRangeResult["columnWidths"]>,
  ) {
    const held = this.fileWidths.get(sheet) ?? NO_WIDTHS;
    const first = pageColumn * PAGE_COLUMNS;
    const same =
      read.every(({ column, width }) => held.get(column) === width) &&
      ![...held.keys()].some(
        (column) =>
          column >= first &&
          column < first + PAGE_COLUMNS &&
          !read.some((entry) => entry.column === column),
      );
    if (same) return;
    const next = new Map(held);
    for (let column = first; column < first + PAGE_COLUMNS; column++) next.delete(column);
    for (const { column, width } of read) next.set(column, width);
    this.fileWidths.set(sheet, next);
    if (sheet === this.snapshot.activeSheet) this.update({ fileWidths: next });
  }

  private override(sheet: string, row: number, column: number, data: CellData | undefined) {
    let overrides = this.overrides.get(sheet);
    if (overrides === undefined) {
      overrides = new Map();
      this.overrides.set(sheet, overrides);
    }
    overrides.set(cellKey(row, column), { data, sequence: this.sequence });
    this.grow(sheet, row + 1, column + 1);
  }

  private applyChanges(changes: ReadonlyArray<CellChange>) {
    if (changes.length > 0) {
      this.sequence += 1;
      const active = this.snapshot.activeSheet;
      for (const change of changes) {
        const previous =
          change.sheet === active
            ? this.cell(change.row, change.column)
            : this.overrides.get(change.sheet)?.get(cellKey(change.row, change.column))?.data;
        this.override(
          change.sheet,
          change.row,
          change.column,
          cellFromInput(change.after, previous),
        );
      }
      this.pending.push(...changeOperations(changes));
      this.scheduleSave();
    }
    this.bump();
  }

  private scheduleSave() {
    this.reportPending();
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.save();
    }, this.saveDelayMs);
  }

  private async save(): Promise<void> {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.saving || this.failed || this.snapshot.conflict || this.pending.length === 0) {
      this.reportPending();
      return;
    }
    // A change that moves cells travels alone: refused or failed, it takes no cell edit with it.
    const firstMove = this.pending.findIndex(movesCells);
    const size =
      firstMove === 0
        ? 1
        : Math.min(firstMove === -1 ? this.pending.length : firstMove, MAX_BATCH_OPERATIONS);
    const batch = this.pending.slice(0, size);
    const rest = this.pending.slice(size);
    // Edits left for the next batch are not saved by this one, so their cells keep showing.
    const batchSequence = rest.length === 0 ? this.sequence : this.savedSequence;
    const moved = batch.some(movesCells);
    this.pending = rest;
    this.saving = true;
    this.reportPending();
    const result = await this.transport.edit(batch, this.overwrite ? undefined : this.version);
    this.saving = false;
    if (result.ok) {
      this.overwrite = false;
      this.version = result.value.version;
      this.update({ version: this.version });
      this.savedSequence = batchSequence;
      if (moved && result.value.unchanged === true) {
        // Nothing moved, so the cells read, and the steps to undo, are still right.
        this.update({
          busy: this.pending.some(movesCells),
          ...(batch[0]?.type === "sortRows" ? { notice: NOTHING_SORTED } : {}),
        });
      } else if (moved) this.afterMove(result.value.sheets, batch);
      else for (const page of this.pages.values()) page.stale = true;
      this.saveNext(false);
    } else if (result.failure.kind === "refused") {
      const { message, operationIndex } = result.failure;
      if (operationIndex === undefined || operationIndex >= batch.length) {
        // Nothing can be saved to this file as it is, so the grid shows it as it is on disk.
        await this.reload();
        this.update({ notice: `${NOT_SAVED} ${message}` });
      } else {
        // Only that operation is at fault. The others were not written either, so they go again
        // without it. Undo steps may name the refused change, so they end here.
        this.pending = [...batch.filter((_, index) => index !== operationIndex), ...this.pending];
        this.history = EMPTY_HISTORY;
        this.update({
          notice: `${NOT_SAVED} ${message}`,
          busy: this.pending.some(movesCells),
        });
        if (this.pending.length === 0) {
          this.savedSequence = this.sequence;
          for (const page of this.pages.values()) page.stale = true;
        }
        this.saveNext(true);
      }
    } else {
      // The grid still shows cells where they were, so a move that was not made is not kept:
      // cell edits queued behind it would land on the wrong cells once it went through.
      const kept = [...batch, ...this.pending];
      this.pending = kept.filter((operation) => !movesCells(operation));
      const notice = kept.length === this.pending.length ? this.snapshot.notice : MOVE_NOT_MADE;
      if (this.pending.length === 0) {
        this.update({ busy: false, notice });
        void this.checkForChanges();
      } else if (result.failure.kind === "conflict") {
        this.update({ conflict: true, busy: false, notice });
      } else {
        this.failed = true;
        this.update({ busy: false, notice });
      }
    }
    this.reportPending();
    if (this.released && !this.hasUnsaved()) this.stop();
  }

  /**
   * After a save settles: the next batch and fresh pages. The batch goes at once when it was
   * already due, when a move is waiting, or when no grid is left to wait for more typing.
   */
  private saveNext(due: boolean) {
    const next = this.pending[0];
    if (next !== undefined && (due || movesCells(next) || this.released)) void this.save();
    else {
      if (this.visible !== null) this.showArea(this.visible);
      if (next !== undefined) this.scheduleSave();
    }
  }

  /** Cells and sheets are somewhere else now, so everything read or recorded before is dropped. */
  private afterMove(
    sheets: ReadonlyArray<SpreadsheetSheet>,
    batch: ReadonlyArray<SpreadsheetOperation>,
  ) {
    this.pages.clear();
    this.overrides.clear();
    this.usedSizes.clear();
    this.unreadable.clear();
    this.fileWidths.clear();
    this.before.clear();
    this.changed.clear();
    this.history = EMPTY_HISTORY;
    let activeSheet = this.snapshot.activeSheet;
    for (const operation of batch) {
      if (operation.type === "addSheet") activeSheet = operation.name;
      else if (operation.type === "renameSheet" && operation.sheet === activeSheet) {
        activeSheet = operation.name;
      }
    }
    if (!sheets.some((sheet) => sheet.name === activeSheet)) {
      activeSheet = (sheets.find((sheet) => sheet.hidden !== true) ?? sheets[0])?.name ?? "";
    }
    const changedSheet = activeSheet !== this.snapshot.activeSheet;
    this.update({
      sheets,
      activeSheet,
      sheetProblem: null,
      busy: false,
      fileWidths: NO_WIDTHS,
      selection: changedSheet ? ORIGIN : this.snapshot.selection,
      ...this.gridSize(activeSheet),
    });
    this.bump();
  }

  private reportPending() {
    const saveState = this.failed
      ? "failed"
      : this.saving
        ? "saving"
        : this.pending.length > 0
          ? "unsaved"
          : "saved";
    if (saveState !== this.snapshot.saveState) this.update({ saveState });
    const pending = saveState !== "saved";
    if (pending !== this.reportedPending) {
      this.reportedPending = pending;
      this.onPendingChange(pending);
    }
  }

  private bump() {
    const marked = this.reviewing ? this.changed.get(this.snapshot.activeSheet) : undefined;
    this.update({
      cellAt: (row, column) => this.cell(row, column),
      changedAt:
        marked === undefined || marked.size === 0
          ? NOTHING_CHANGED
          : (row, column) => marked.has(cellKey(row, column)),
    });
  }

  private update(change: Partial<SpreadsheetSnapshot>) {
    this.snapshot = {
      ...this.snapshot,
      ...change,
      canUndo: this.history.undo.length > 0,
      canRedo: this.history.redo.length > 0,
    };
    for (const listener of this.listeners) listener();
  }
}
