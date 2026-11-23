import {
  type PdfEditInput,
  type PdfEditResult,
  type PdfOpenInput,
  type PdfOpenResult,
  PdfOperationError,
  PdfRefusedError,
  type PdfSignaturePlacement,
  type SpreadsheetEditInput,
  type SpreadsheetEditResult,
  type SpreadsheetOpenInput,
  type SpreadsheetOpenResult,
  SpreadsheetOperationError,
  type SpreadsheetReadRangeInput,
  type SpreadsheetReadRangeResult,
  SpreadsheetTooLargeError,
  SpreadsheetUnsupportedError,
} from "@codenine/contracts";
import { editableSpreadsheetKind } from "@codenine/shared/filePreview";
import * as KeyedLock from "@codenine/shared/KeyedLock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as FileVersions from "../fileVersions/FileVersions.ts";
import type * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import type * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { editPdf as editPdfBytes, inspectPdf, PdfProblem } from "./pdf/pdfEdits.ts";
import { DelimitedTable } from "./spreadsheet/delimitedTable.ts";
import {
  type SpreadsheetLimits,
  type SpreadsheetModel,
  SpreadsheetProblem,
} from "./spreadsheet/problems.ts";
import { XlsxWorkbook } from "./spreadsheet/xlsxWorkbook.ts";

const MEBIBYTE = 1024 * 1024;
// Models are whole files held as objects, so only the ones in use are kept.
const MAX_HELD_MODELS = 2;

/**
 * How large a spreadsheet may be. A workbook is parsed on the server's own thread, so the
 * limits also bound how long one open or save can hold up other requests.
 */
export const DocumentLimits = Context.Reference<SpreadsheetLimits>(
  "codenine/documents/DocumentLimits",
  {
    defaultValue: () => ({
      maxFileBytes: 16 * MEBIBYTE,
      maxUnpackedBytes: 96 * MEBIBYTE,
      maxCells: 600_000,
      maxFormatCells: 100_000,
      maxRecalculationSteps: 12_000_000,
    }),
  },
);

/**
 * The largest PDF changed here. It is parsed and written whole on the server's own thread, and
 * the version store keeps no copy of a larger file.
 */
export const PdfLimits = Context.Reference<{ readonly maxFileBytes: number }>(
  "codenine/documents/PdfLimits",
  { defaultValue: () => ({ maxFileBytes: 32 * MEBIBYTE }) },
);

export class DocumentMissingError extends Schema.TaggedError<DocumentMissingError>()(
  "DocumentMissingError",
  { relativePath: Schema.String },
) {
  override get message(): string {
    return `'${this.relativePath}' no longer exists.`;
  }
}

export class DocumentFailureError extends Schema.TaggedError<DocumentFailureError>()(
  "DocumentFailureError",
  {
    relativePath: Schema.String,
    stage: Schema.Literals(["open", "read", "edit"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.stage === "edit"
      ? `The change to '${this.relativePath}' could not be made, so the file was left as it is.`
      : `'${this.relativePath}' could not be read as a spreadsheet.`;
  }
}

type ReadError =
  | SpreadsheetTooLargeError
  | SpreadsheetUnsupportedError
  | SpreadsheetOperationError
  | DocumentMissingError
  | DocumentFailureError
  | WorkspaceFileSystem.WorkspaceFileSystemError
  | WorkspacePaths.WorkspacePathOutsideRootError;

type PdfReadError =
  | PdfRefusedError
  | DocumentMissingError
  | DocumentFailureError
  | WorkspaceFileSystem.WorkspaceFileSystemError
  | WorkspacePaths.WorkspacePathOutsideRootError;

type PdfEditError =
  | PdfReadError
  | PdfOperationError
  | WorkspaceFileSystem.WorkspaceFileConflictError
  | KnownWorkspaces.UnknownWorkspaceError;

/**
 * Office documents, read and changed on the server so that a client sends edits and receives
 * pages, never whole files. Every write goes through the version store's save.
 */
export class Documents extends Context.Service<
  Documents,
  {
    readonly openSpreadsheet: (
      input: SpreadsheetOpenInput,
    ) => Effect.Effect<SpreadsheetOpenResult, ReadError>;
    /** One page of a sheet's cells. */
    readonly readSpreadsheetRange: (
      input: SpreadsheetReadRangeInput,
    ) => Effect.Effect<SpreadsheetReadRangeResult, ReadError>;
    /**
     * Applies the operations in order and saves. Nothing is written unless all of them apply,
     * and a file that no longer has the expected version is left alone.
     */
    readonly editSpreadsheet: (
      input: SpreadsheetEditInput,
    ) => Effect.Effect<
      SpreadsheetEditResult,
      | ReadError
      | WorkspaceFileSystem.WorkspaceFileConflictError
      | KnownWorkspaces.UnknownWorkspaceError
    >;
    /** A PDF's highlights, notes and form fields, and whether it can be changed here. */
    readonly openPdf: (input: PdfOpenInput) => Effect.Effect<PdfOpenResult, PdfReadError>;
    /**
     * Adds and removes highlights and notes and fills form fields, then saves. Nothing is
     * written unless every operation applies, and a file that no longer has the expected
     * version is left alone. It cannot sign.
     */
    readonly editPdf: (
      input: Omit<PdfEditInput, "signatures">,
    ) => Effect.Effect<PdfEditResult, PdfEditError>;
    /**
     * `editPdf` that also draws the user's signatures into their pages. Only a person signs, so
     * the only caller is the RPC a user's client makes: no agent tool may reach this.
     */
    readonly editPdfWithSignatures: (
      input: PdfEditInput,
    ) => Effect.Effect<PdfEditResult, PdfEditError>;
  }
>()("codenine/documents/Documents") {}

const make = Effect.gen(function* () {
  const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
  const fileVersions = yield* FileVersions.FileVersions;
  const limits = yield* DocumentLimits;
  const pdfLimits = yield* PdfLimits;
  const path = yield* Path.Path;
  const locks = yield* KeyedLock.make<string>();
  // Newest last. A model is dropped before it is changed and held again once the save succeeds.
  const held = new Map<string, { readonly version: string; readonly model: SpreadsheetModel }>();

  const keyOf = (input: SpreadsheetOpenInput) =>
    `${path.resolve(input.cwd)}\u0000${input.relativePath}`;

  const hold = (key: string, version: string, model: SpreadsheetModel) => {
    held.delete(key);
    held.set(key, { version, model });
    const oldest = held.keys().next();
    if (held.size > MAX_HELD_MODELS && !oldest.done) held.delete(oldest.value);
  };

  /** Runs the spreadsheet code, which reports what it refuses by throwing. */
  const attempt = <A>(
    relativePath: string,
    stage: DocumentFailureError["stage"],
    run: () => Promise<A> | A,
  ) =>
    Effect.tryPromise({
      try: async () => run(),
      catch: (cause) => {
        if (!(cause instanceof SpreadsheetProblem)) {
          return new DocumentFailureError({ relativePath, stage, cause });
        }
        const { detail, operationIndex } = cause;
        const at = { relativePath, ...(operationIndex === undefined ? {} : { operationIndex }) };
        switch (detail.kind) {
          case "too-large":
            return new SpreadsheetTooLargeError({ ...at, limit: detail.limit });
          case "unsupported":
            return new SpreadsheetUnsupportedError({ ...at, feature: detail.feature });
          case "operation":
            return new SpreadsheetOperationError({ ...at, reason: detail.reason });
        }
      },
    });

  const load = Effect.fn("Documents.load")(function* (input: SpreadsheetOpenInput) {
    const { relativePath } = input;
    const kind = editableSpreadsheetKind(relativePath);
    if (kind === null) {
      return yield* new SpreadsheetUnsupportedError({ relativePath, feature: "not-a-workbook" });
    }
    const file = yield* workspaceFileSystem.readFileBytes({
      cwd: input.cwd,
      relativePath,
      maxBytes: limits.maxFileBytes,
    });
    if (file.kind === "absent") return yield* new DocumentMissingError({ relativePath });
    if (file.kind === "too-large") {
      return yield* new SpreadsheetTooLargeError({ relativePath, limit: "file-size" });
    }
    const version = WorkspaceFileSystem.fileVersion(file.bytes);
    const key = keyOf(input);
    const known = held.get(key);
    if (known?.version === version) return known;
    const model = yield* attempt(
      relativePath,
      "open",
      (): Promise<SpreadsheetModel> | SpreadsheetModel =>
        kind.format === "xlsx"
          ? XlsxWorkbook.open(file.bytes, limits)
          : DelimitedTable.open(file.bytes, kind.delimiter, limits),
    );
    hold(key, version, model);
    return { version, model };
  });

  const openSpreadsheet: Documents["Service"]["openSpreadsheet"] = Effect.fn(
    "Documents.openSpreadsheet",
  )(function* (input) {
    return yield* locks.withLock(
      keyOf(input),
      Effect.map(load(input), ({ version, model }) => ({
        version,
        format: model.format,
        sheets: model.sheets(),
        date1904: model.date1904,
      })),
    );
  });

  const readSpreadsheetRange: Documents["Service"]["readSpreadsheetRange"] = Effect.fn(
    "Documents.readSpreadsheetRange",
  )(function* (input) {
    return yield* locks.withLock(
      keyOf(input),
      Effect.gen(function* () {
        const { version, model } = yield* load(input);
        const range = yield* attempt(input.relativePath, "read", () => model.readRange(input));
        return { version, ...range };
      }),
    );
  });

  const editSpreadsheet: Documents["Service"]["editSpreadsheet"] = Effect.fn(
    "Documents.editSpreadsheet",
  )(function* (input) {
    const { cwd, relativePath } = input;
    const key = keyOf(input);
    return yield* locks.withLock(
      key,
      Effect.gen(function* () {
        const { version, model } = yield* load(input);
        if (input.expectedVersion !== undefined && input.expectedVersion !== version) {
          return yield* new WorkspaceFileSystem.WorkspaceFileConflictError({
            workspaceRoot: cwd,
            relativePath,
            currentVersion: version,
          });
        }
        held.delete(key);
        const bytes = yield* attempt(relativePath, "edit", async () => {
          await model.apply(input.operations);
          return model.save();
        });
        if (bytes.byteLength > limits.maxFileBytes) {
          return yield* new SpreadsheetTooLargeError({ relativePath, limit: "file-size" });
        }
        // The write checks the version again, so a change since the read above is still refused.
        const written = yield* fileVersions.writeFileBytes({
          cwd,
          relativePath,
          bytes,
          expectedVersion: version,
        });
        const saved = written.version ?? WorkspaceFileSystem.fileVersion(bytes);
        hold(key, saved, model);
        return { version: saved, sheets: model.sheets() };
      }),
    );
  });

  const readPdf = Effect.fn("Documents.readPdf")(function* (input: PdfOpenInput) {
    const { relativePath } = input;
    const file = yield* workspaceFileSystem.readFileBytes({
      cwd: input.cwd,
      relativePath,
      maxBytes: pdfLimits.maxFileBytes,
    });
    if (file.kind === "absent") return yield* new DocumentMissingError({ relativePath });
    if (file.kind === "too-large") {
      return yield* new PdfRefusedError({ relativePath, reason: "too-large" });
    }
    return { bytes: file.bytes, version: WorkspaceFileSystem.fileVersion(file.bytes) };
  });

  /** Runs the PDF code, which reports what it refuses by throwing. */
  const attemptPdfEdit = <A>(relativePath: string, run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) => {
        if (!(cause instanceof PdfProblem)) {
          return new DocumentFailureError({ relativePath, stage: "edit", cause });
        }
        return cause.detail.kind === "refused"
          ? new PdfRefusedError({ relativePath, reason: cause.detail.reason })
          : new PdfOperationError({
              relativePath,
              reason: cause.detail.reason,
              ...(cause.index === undefined ? {} : { operationIndex: cause.index }),
            });
      },
    });

  const openPdf: Documents["Service"]["openPdf"] = Effect.fn("Documents.openPdf")(
    function* (input) {
      const { bytes, version } = yield* readPdf(input);
      // An inspection answers a refusal instead of failing.
      const contents = yield* Effect.promise(() => inspectPdf(bytes));
      return { version, ...contents };
    },
  );

  const savePdf = Effect.fn("Documents.savePdf")(function* (
    input: Omit<PdfEditInput, "signatures">,
    signatures: ReadonlyArray<PdfSignaturePlacement>,
  ) {
    const { cwd, relativePath } = input;
    return yield* locks.withLock(
      keyOf(input),
      Effect.gen(function* () {
        const { bytes, version } = yield* readPdf(input);
        if (input.expectedVersion !== undefined && input.expectedVersion !== version) {
          return yield* new WorkspaceFileSystem.WorkspaceFileConflictError({
            workspaceRoot: cwd,
            relativePath,
            currentVersion: version,
          });
        }
        const now = DateTime.toDateUtc(yield* DateTime.now);
        const edited = yield* attemptPdfEdit(relativePath, () =>
          editPdfBytes(bytes, { operations: input.operations, signatures, now }),
        );
        if (edited.byteLength > pdfLimits.maxFileBytes) {
          return yield* new PdfRefusedError({ relativePath, reason: "too-large" });
        }
        // The write checks the version again, so a change since the read above is still refused.
        const written = yield* fileVersions.writeFileBytes({
          cwd,
          relativePath,
          bytes: edited,
          expectedVersion: version,
          ...(signatures.length > 0 ? { action: "signed" as const } : {}),
        });
        const contents = yield* Effect.promise(() => inspectPdf(edited));
        return {
          version: written.version ?? WorkspaceFileSystem.fileVersion(edited),
          annotations: contents.annotations,
          fields: contents.fields,
        };
      }),
    );
  });

  const editPdf: Documents["Service"]["editPdf"] = Effect.fn("Documents.editPdf")((input) =>
    savePdf(input, []),
  );

  const editPdfWithSignatures: Documents["Service"]["editPdfWithSignatures"] = Effect.fn(
    "Documents.editPdfWithSignatures",
  )((input) => savePdf(input, input.signatures ?? []));

  return Documents.of({
    openSpreadsheet,
    readSpreadsheetRange,
    editSpreadsheet,
    openPdf,
    editPdf,
    editPdfWithSignatures,
  });
});

export const layer = Layer.effect(Documents, make);
