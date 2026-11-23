import type {
  SpreadsheetOperation,
  SpreadsheetOperationError,
  SpreadsheetReadRangeInput,
  SpreadsheetReadRangeResult,
  SpreadsheetSheet,
  SpreadsheetTooLargeError,
  SpreadsheetUnsupportedError,
} from "@codenine/contracts";

export type SpreadsheetProblemDetail =
  | { readonly kind: "too-large"; readonly limit: SpreadsheetTooLargeError["limit"] }
  | { readonly kind: "unsupported"; readonly feature: SpreadsheetUnsupportedError["feature"] }
  | { readonly kind: "operation"; readonly reason: SpreadsheetOperationError["reason"] };

/** Thrown by the pure spreadsheet code; the service turns it into the matching typed error. */
// @effect-diagnostics-next-line extendsNativeError:off - thrown by pure code and mapped to a typed error at the service.
export class SpreadsheetProblem extends Error {
  readonly detail: SpreadsheetProblemDetail;
  /** The operation that could not be applied, when the problem is one operation's. */
  operationIndex: number | undefined = undefined;
  constructor(detail: SpreadsheetProblemDetail) {
    super(detail.kind);
    this.detail = detail;
  }
}

export const tooLarge = (limit: SpreadsheetTooLargeError["limit"]) =>
  new SpreadsheetProblem({ kind: "too-large", limit });
export const unsupported = (feature: SpreadsheetUnsupportedError["feature"]) =>
  new SpreadsheetProblem({ kind: "unsupported", feature });
export const invalidOperation = (reason: SpreadsheetOperationError["reason"]) =>
  new SpreadsheetProblem({ kind: "operation", reason });

/** Marks a problem thrown while applying the operation at `index` as that operation's. */
export function atOperation(cause: unknown, index: number): unknown {
  if (cause instanceof SpreadsheetProblem) cause.operationIndex ??= index;
  return cause;
}

export interface SpreadsheetLimits {
  /** The largest file read from disk. */
  readonly maxFileBytes: number;
  /** The most a workbook's parts may unpack to, which bounds a compressed file's real size. */
  readonly maxUnpackedBytes: number;
  readonly maxCells: number;
  /** The most cells one format change may touch. */
  readonly maxFormatCells: number;
  /** The most cells and ranges one recalculation may visit before it leaves the rest uncalculated. */
  readonly maxRecalculationSteps: number;
}

/** A spreadsheet file held in memory: read in pages, changed by operations, written back whole. */
export interface SpreadsheetModel {
  readonly format: "xlsx" | "delimited";
  readonly date1904: boolean;
  readonly sheets: () => ReadonlyArray<SpreadsheetSheet>;
  readonly readRange: (
    input: Pick<SpreadsheetReadRangeInput, "sheet" | "row" | "column" | "rowCount" | "columnCount">,
  ) => Promise<Omit<SpreadsheetReadRangeResult, "version">>;
  /** A failed operation may leave the model half changed, so the caller must drop it. */
  readonly apply: (operations: ReadonlyArray<SpreadsheetOperation>) => Promise<void>;
  readonly save: () => Promise<Uint8Array>;
}
