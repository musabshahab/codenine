import type {
  SpreadsheetCellFormat,
  SpreadsheetCellInput,
  SpreadsheetEditResult,
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

export type SpreadsheetFailure =
  /** The file changed on disk since it was opened. */
  | { readonly kind: "conflict" }
  /** The server understood the request and will not do it; `fallback` when the file cannot be opened here at all. */
  | { readonly kind: "refused"; readonly message: string; readonly fallback: boolean }
  | { readonly kind: "failed"; readonly message: string };

export type SpreadsheetResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly failure: SpreadsheetFailure };

type RangeRequest = Pick<
  SpreadsheetReadRangeInput,
  "sheet" | "row" | "column" | "rowCount" | "columnCount"
>;

/** How a session reaches the file. The grid never sees more of it than these three calls. */
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
  readonly saveState: "saved" | "unsaved" | "saving" | "failed";
  readonly conflict: boolean;
  /** A change the server refused, to tell the user about once. */
  readonly notice: string | null;
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
  operation.type !== "setCell" && operation.type !== "setFormat";

/**
 * One open spreadsheet: the pages of cells read so far, the user's edits not yet saved, and
 * their undo history. Edits show at once and are sent as operations after a short pause.
 */
export class SpreadsheetSession {
  private readonly transport: SpreadsheetTransport;
  private readonly saveDelayMs: number;
  private readonly onPendingChange: (pending: boolean) => void;
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
    saveState: "saved",
    conflict: false,
    notice: null,
    busy: false,
    canUndo: false,
    canRedo: false,
  };
  private version: string | undefined;
  private readonly pages = new Map<string, Page>();
  private readonly loading = new Set<string>();
  private readonly overrides = new Map<string, Map<number, Override>>();
  private readonly usedSizes = new Map<string, { rows: number; columns: number }>();
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
  private disposed = false;

  constructor(input: {
    readonly transport: SpreadsheetTransport;
    readonly saveDelayMs: number;
    readonly onPendingChange: (pending: boolean) => void;
  }) {
    this.transport = input.transport;
    this.saveDelayMs = input.saveDelayMs;
    this.onPendingChange = input.onPendingChange;
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = () => this.snapshot;

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
    this.update({ selection });
  }

  selectSheet(name: string): void {
    if (name === this.snapshot.activeSheet) return;
    this.update({ activeSheet: name, selection: ORIGIN, ...this.gridSize(name) });
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
    const area = selectionArea(this.snapshot.selection);
    this.sequence += 1;
    if (areaCellCount(area) <= MAX_OPTIMISTIC_FORMAT_CELLS) {
      for (let row = area.top; row <= area.bottom; row++) {
        for (let column = area.left; column <= area.right; column++) {
          const cell = this.cell(row, column);
          const next: SpreadsheetCellFormat = {
            ...cell?.format,
            ...(format.bold === undefined ? {} : { bold: format.bold }),
            ...(format.numberFormat === undefined ? {} : { numberFormat: format.numberFormat }),
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
   * A change that moves cells or sheets. It is saved at once, and the edit history ends there:
   * the cells it names are no longer where it left them.
   */
  restructure(operation: SpreadsheetOperation): void {
    if (!this.canEdit()) return;
    this.sequence += 1;
    this.pending.push(operation);
    this.update({ busy: true });
    void this.save();
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
    this.update({ status: "loading", conflict: false, notice: null, busy: false });
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

  /** Stops the session. Edits still waiting are sent on their way out. */
  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.pending.length > 0 && !this.snapshot.conflict && !this.saving) void this.save();
    this.disposed = true;
    this.listeners.clear();
    if (this.reportedPending) this.onPendingChange(false);
  }

  private canEdit() {
    return this.snapshot.status === "ready" && !this.snapshot.busy && !this.snapshot.conflict;
  }

  private adopt(opened: SpreadsheetOpenResult, resetView: boolean) {
    this.version = opened.version;
    this.pages.clear();
    this.overrides.clear();
    this.usedSizes.clear();
    this.history = EMPTY_HISTORY;
    this.savedSequence = this.sequence;
    const visibleSheets = opened.sheets.filter((sheet) => sheet.hidden !== true);
    const kept = opened.sheets.find((sheet) => sheet.name === this.snapshot.activeSheet);
    const activeSheet = (kept ?? visibleSheets[0] ?? opened.sheets[0])?.name ?? "";
    this.update({
      status: "ready",
      unavailable: null,
      version: opened.version,
      format: opened.format,
      date1904: opened.date1904,
      sheets: opened.sheets,
      activeSheet,
      selection: resetView || kept === undefined ? ORIGIN : this.snapshot.selection,
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
    if (this.disposed || !result.ok) return;
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
    const batch = this.pending.slice(0, MAX_BATCH_OPERATIONS);
    const rest = this.pending.slice(MAX_BATCH_OPERATIONS);
    // Edits left for the next batch are not saved by this one, so their cells keep showing.
    const batchSequence = rest.length === 0 ? this.sequence : this.savedSequence;
    const moved = batch.some(movesCells);
    this.pending = rest;
    this.saving = true;
    this.reportPending();
    const result = await this.transport.edit(batch, this.overwrite ? undefined : this.version);
    this.saving = false;
    if (this.disposed) return;
    if (result.ok) {
      this.overwrite = false;
      this.version = result.value.version;
      this.update({ version: this.version });
      this.savedSequence = batchSequence;
      if (moved) this.afterMove(result.value.sheets, batch);
      else for (const page of this.pages.values()) page.stale = true;
      if (this.visible !== null) this.showArea(this.visible);
      if (this.pending.length > 0) this.scheduleSave();
      this.reportPending();
      return;
    }
    const { failure } = result;
    if (failure.kind === "refused") {
      // Nothing of the batch was written, and what the grid shows no longer matches the file.
      await this.reload();
      this.update({ notice: failure.message });
    } else {
      this.pending = [...batch, ...this.pending];
      if (failure.kind === "conflict") this.update({ conflict: true, busy: false });
      else {
        this.failed = true;
        this.update({ busy: false });
      }
    }
    this.reportPending();
  }

  /** Cells and sheets are somewhere else now, so everything read or recorded before is dropped. */
  private afterMove(
    sheets: ReadonlyArray<SpreadsheetSheet>,
    batch: ReadonlyArray<SpreadsheetOperation>,
  ) {
    this.pages.clear();
    this.overrides.clear();
    this.usedSizes.clear();
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
      busy: false,
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
    this.update({ cellAt: (row, column) => this.cell(row, column) });
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
