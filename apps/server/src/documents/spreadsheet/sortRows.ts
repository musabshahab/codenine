/** What a row is ordered by: its cell in the sort column. Null for an empty cell. */
export type SortKey = number | string | boolean | { readonly error: string } | null;

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

const rank = (key: Exclude<SortKey, null>) =>
  typeof key === "number" ? 0 : typeof key === "string" ? 1 : typeof key === "boolean" ? 2 : 3;

function compareKeys(left: Exclude<SortKey, null>, right: Exclude<SortKey, null>): number {
  const byKind = rank(left) - rank(right);
  if (byKind !== 0) return byKind;
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (typeof left === "string" && typeof right === "string") return collator.compare(left, right);
  if (typeof left === "boolean" && typeof right === "boolean") return Number(left) - Number(right);
  return 0;
}

/**
 * The order that sorts rows by their keys, as positions in `keys`. Numbers come before text,
 * then booleans, then errors, as spreadsheet apps order them. Empty cells go last either way,
 * and rows with equal keys keep the order they had.
 */
export function sortedOrder(keys: ReadonlyArray<SortKey>, descending: boolean): Array<number> {
  return keys
    .map((_, position) => position)
    .sort((left, right) => {
      const [a, b] = [keys[left]!, keys[right]!];
      if (a === null || b === null) return a === b ? left - right : a === null ? 1 : -1;
      const order = compareKeys(a, b);
      return order === 0 ? left - right : descending ? -order : order;
    });
}

export interface HeaderProbeCell {
  readonly column: number;
  /** Plain text that is not a formula's result. */
  readonly text: boolean;
  readonly style: string | undefined;
}

/**
 * Whether the first of a table's rows holds headings. Each row lists its cells that hold
 * something. Headings are all text, and sit over a column that holds something other than text,
 * or look different from the row below, or head a table of several columns of text.
 */
export function hasHeaderRow(rows: ReadonlyArray<ReadonlyArray<HeaderProbeCell>>): boolean {
  const [head, ...body] = rows;
  if (head === undefined || body.length === 0 || head.length === 0) return false;
  if (head.some((cell) => !cell.text)) return false;
  const headed = new Set(head.map((cell) => cell.column));
  if (body.some((row) => row.some((cell) => !cell.text && headed.has(cell.column)))) return true;
  const below = new Map(body[0]!.map((cell) => [cell.column, cell]));
  const shared = head.filter((cell) => below.has(cell.column));
  if (shared.length > 0 && shared.every((cell) => below.get(cell.column)!.style !== cell.style)) {
    return true;
  }
  return head.length > 1;
}
