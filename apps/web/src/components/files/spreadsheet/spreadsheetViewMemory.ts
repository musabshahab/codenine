import type { GridSelection } from "./spreadsheetModel";

/** Where the user was in one sheet: what they see when they come back to it. */
export interface SheetView {
  /** Columns with a width of their own: fitted to their text, or dragged. Replaced, never changed. */
  widths: ReadonlyMap<number, number>;
  /** Columns whose width is settled, so loading more cells never moves them again. */
  readonly fitted: Set<number>;
  /** The width the file gave each column when it was last taken, so only a new one is taken again. */
  readonly fileWidths: Map<number, number>;
  scrollTop: number;
  scrollLeft: number;
  selection: GridSelection | null;
}

export interface WorkbookView {
  activeSheet: string | null;
  readonly sheets: Map<string, SheetView>;
}

// A grid is unmounted while another document is shown, so the place in each file is kept here.
const views = new Map<string, WorkbookView>();
const MAX_WORKBOOK_VIEWS = 24;

export const newWorkbookView = (): WorkbookView => ({ activeSheet: null, sheets: new Map() });

/** The remembered view of a file, the most recently used ones only. */
export function workbookView(key: string): WorkbookView {
  const held = views.get(key) ?? newWorkbookView();
  views.delete(key);
  views.set(key, held);
  if (views.size > MAX_WORKBOOK_VIEWS) views.delete(views.keys().next().value!);
  return held;
}

export function sheetView(view: WorkbookView, sheet: string): SheetView {
  let held = view.sheets.get(sheet);
  if (held === undefined) {
    held = {
      widths: new Map(),
      fitted: new Set(),
      fileWidths: new Map(),
      scrollTop: 0,
      scrollLeft: 0,
      selection: null,
    };
    view.sheets.set(sheet, held);
  }
  return held;
}

/** The grid's scroll position in a sheet, kept as it scrolls. */
export function rememberSheetScroll(
  view: WorkbookView,
  sheet: string,
  scrollTop: number,
  scrollLeft: number,
): void {
  const held = sheetView(view, sheet);
  held.scrollTop = scrollTop;
  held.scrollLeft = scrollLeft;
}

/** `columns` names the ones whose width is now settled. */
export function rememberColumnWidths(
  view: WorkbookView,
  sheet: string,
  widths: ReadonlyMap<number, number>,
  columns: ReadonlyArray<number>,
): void {
  const held = sheetView(view, sheet);
  held.widths = widths;
  for (const column of columns) held.fitted.add(column);
}
