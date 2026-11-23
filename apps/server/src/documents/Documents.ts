import {
  ATTACHMENT_COPY_MAX_BYTES,
  AttachmentCopyError,
  type AttachmentCopyInput,
  type AttachmentCopyResult,
  type DeckEditInput,
  type DeckEditResult,
  type DeckOpenInput,
  type DeckOpenResult,
  DeckOperationError,
  type PdfEditInput,
  type PdfEditResult,
  type PdfOpenInput,
  type PdfOpenResult,
  PdfOperationError,
  type PdfReadTextInput,
  type PdfReadTextResult,
  PdfRefusedError,
  type PdfSignaturePlacement,
  type PdfTextMark,
  ReplyFileError,
  ReplyFileExistsError,
  type ReplyFileSaveInput,
  type ReplyFileSaveResult,
  type SpreadsheetEditInput,
  type SpreadsheetEditResult,
  SPREADSHEET_FIND_MAX_MATCHES,
  type SpreadsheetFindInput,
  type SpreadsheetFindResult,
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
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as FileVersions from "../fileVersions/FileVersions.ts";
import type * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import type * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import {
  DEFAULT_PDF_UNPACK_LIMITS,
  editPdf as editPdfBytes,
  inspectPdf,
  PdfProblem,
} from "./pdf/pdfEdits.ts";
import { locatePdfText, readPdfText as readPdfTextBytes } from "./pdf/pdfText.ts";
import { DeckProblem, PptxDeck } from "./pptx/pptxDeck.ts";
import { copyNameCandidates } from "./attachmentCopy.ts";
import { markdownPdf, markdownTables, tableWorkbook } from "./reply/replyFile.ts";
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
 * the version store keeps no copy of a larger file. The unpacked limit bounds what a small file
 * with tightly packed streams can make that parse hold.
 */
export const PdfLimits = Context.Reference<{
  readonly maxFileBytes: number;
  readonly maxUnpackedBytes: number;
}>("codenine/documents/PdfLimits", {
  defaultValue: () => ({ maxFileBytes: 32 * MEBIBYTE, ...DEFAULT_PDF_UNPACK_LIMITS }),
});

/** The largest deck changed here, and the most its XML parts may unpack to. */
const DeckLimits = Context.Reference<{
  readonly maxFileBytes: number;
  readonly maxUnpackedBytes: number;
}>("codenine/documents/DeckLimits", {
  defaultValue: () => ({ maxFileBytes: 32 * MEBIBYTE, maxUnpackedBytes: 96 * MEBIBYTE }),
});

const REPLY_EXTENSIONS = {
  markdown: /\.(md|markdown)$/i,
  pdf: /\.pdf$/i,
  xlsx: /\.xlsx$/i,
} as const;

/** The colour of a highlight whose caller names none. */
const DEFAULT_HIGHLIGHT_COLOUR = "FFE066";

export interface DocumentEditOptions {
  /**
   * True when an agent makes the edit during its turn, so the version store records it as that
   * turn's change and the user can review and discard it as they do the agent's other edits.
   */
  readonly duringTurn?: boolean | undefined;
}

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

type DeckError =
  | DeckOperationError
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
    /** Where a sheet's cells hold some text, in reading order and capped. */
    readonly findInSpreadsheet: (
      input: SpreadsheetFindInput,
    ) => Effect.Effect<SpreadsheetFindResult, ReadError>;
    /**
     * Applies the operations in order and saves. Nothing is written unless all of them apply,
     * and a file that no longer has the expected version is left alone.
     */
    readonly editSpreadsheet: (
      input: SpreadsheetEditInput,
      options?: DocumentEditOptions,
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
      input: Omit<PdfEditInput, "signatures"> & {
        /** Highlights placed by quoting the page's text. They are added before the operations. */
        readonly marks?: ReadonlyArray<PdfTextMark> | undefined;
      },
      options?: DocumentEditOptions,
    ) => Effect.Effect<PdfEditResult, PdfEditError>;
    /** The text of a run of a PDF's pages. */
    readonly readPdfText: (
      input: PdfReadTextInput,
    ) => Effect.Effect<PdfReadTextResult, PdfReadError | PdfOperationError>;
    /** A deck's slides with their text and notes, and the layouts a new slide can use. */
    readonly openDeck: (input: DeckOpenInput) => Effect.Effect<DeckOpenResult, DeckError>;
    /**
     * Applies the operations to a .pptx deck in order and saves. Nothing is written unless all
     * of them apply, and a file that no longer has the expected version is left alone.
     */
    readonly editDeck: (
      input: DeckEditInput,
      options?: DocumentEditOptions,
    ) => Effect.Effect<
      DeckEditResult,
      | DeckError
      | WorkspaceFileSystem.WorkspaceFileConflictError
      | KnownWorkspaces.UnknownWorkspaceError
    >;
    /**
     * Writes a chat reply into the workspace as Markdown, as a PDF, or as a workbook of its first
     * table. A file that is already there is only replaced when the caller names its version.
     */
    readonly saveReplyFile: (
      input: ReplyFileSaveInput,
    ) => Effect.Effect<ReplyFileSaveResult, ReplyFileExistsError | ReplyFileError>;
    /**
     * Saves a copy of a chat attachment at the top of the workspace, under its name or, when
     * that is taken, the name with a number. Nothing already there is ever replaced.
     */
    readonly copyAttachment: (
      input: AttachmentCopyInput,
    ) => Effect.Effect<AttachmentCopyResult, AttachmentCopyError>;
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
  const deckLimits = yield* DeckLimits;
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* ServerConfig.ServerConfig;
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

  const findInSpreadsheet: Documents["Service"]["findInSpreadsheet"] = Effect.fn(
    "Documents.findInSpreadsheet",
  )(function* (input) {
    return yield* locks.withLock(
      keyOf(input),
      Effect.gen(function* () {
        const { version, model } = yield* load(input);
        const found = yield* attempt(input.relativePath, "read", () =>
          model.find(input.sheet, input.query, SPREADSHEET_FIND_MAX_MATCHES),
        );
        return { version, ...found };
      }),
    );
  });

  const editSpreadsheet: Documents["Service"]["editSpreadsheet"] = Effect.fn(
    "Documents.editSpreadsheet",
  )(function* (input, options) {
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
        // Operations that changed nothing, such as sorting rows already in order, write nothing.
        if (WorkspaceFileSystem.fileVersion(bytes) === version) {
          hold(key, version, model);
          return { version, sheets: model.sheets(), unchanged: true };
        }
        // The write checks the version again, so a change since the read above is still refused.
        const written = yield* fileVersions.writeFileBytes({
          cwd,
          relativePath,
          bytes,
          expectedVersion: version,
          duringTurn: options?.duringTurn,
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
      const contents = yield* Effect.promise(() => inspectPdf(bytes, pdfLimits));
      const versionsKept = yield* fileVersions.keepsVersions(input.cwd);
      return { version, versionsKept, ...contents };
    },
  );

  const savePdf = Effect.fn("Documents.savePdf")(function* (
    input: Omit<PdfEditInput, "signatures"> & {
      readonly marks?: ReadonlyArray<PdfTextMark> | undefined;
    },
    signatures: ReadonlyArray<PdfSignaturePlacement>,
    options?: DocumentEditOptions,
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
        const marks = input.marks ?? [];
        const located =
          marks.length === 0
            ? []
            : yield* attemptPdfEdit(relativePath, () => locatePdfText(bytes, marks));
        const operations = [
          ...marks.map((mark, index) => ({
            type: "addHighlight" as const,
            page: mark.page,
            rects: located[index] ?? [],
            colour: mark.colour ?? DEFAULT_HIGHLIGHT_COLOUR,
            ...(mark.note === undefined ? {} : { contents: mark.note }),
          })),
          ...input.operations,
        ];
        const edited = yield* attemptPdfEdit(relativePath, () =>
          editPdfBytes(bytes, {
            operations,
            signatures,
            now,
            limits: pdfLimits,
          }),
        );
        if (edited.bytes.byteLength > pdfLimits.maxFileBytes) {
          return yield* new PdfRefusedError({ relativePath, reason: "too-large" });
        }
        // The write checks the version again, so a change since the read above is still refused.
        const written = yield* fileVersions.writeFileBytes({
          cwd,
          relativePath,
          bytes: edited.bytes,
          expectedVersion: version,
          duringTurn: options?.duringTurn,
          ...(signatures.length > 0 ? { action: "signed" as const } : {}),
        });
        return {
          version: written.version ?? WorkspaceFileSystem.fileVersion(edited.bytes),
          annotations: edited.annotations,
          fields: edited.fields,
        };
      }),
    );
  });

  const editPdf: Documents["Service"]["editPdf"] = Effect.fn("Documents.editPdf")(
    (input, options) => savePdf(input, [], options),
  );

  const readPdfText: Documents["Service"]["readPdfText"] = Effect.fn("Documents.readPdfText")(
    function* (input) {
      const { bytes, version } = yield* readPdf(input);
      const text = yield* attemptPdfEdit(input.relativePath, () =>
        readPdfTextBytes(bytes, { page: input.page, pageCount: input.pageCount }),
      ).pipe(
        Effect.mapError((cause) =>
          cause._tag === "DocumentFailureError"
            ? new DocumentFailureError({
                relativePath: cause.relativePath,
                stage: "read",
                cause: cause.cause,
              })
            : cause,
        ),
      );
      return { version, ...text };
    },
  );

  const readDeck = Effect.fn("Documents.readDeck")(function* (input: DeckOpenInput) {
    const { relativePath } = input;
    if (!relativePath.toLowerCase().endsWith(".pptx")) {
      return yield* new DeckOperationError({ relativePath, reason: "not-a-deck" });
    }
    const file = yield* workspaceFileSystem.readFileBytes({
      cwd: input.cwd,
      relativePath,
      maxBytes: deckLimits.maxFileBytes,
    });
    if (file.kind === "absent") return yield* new DocumentMissingError({ relativePath });
    if (file.kind === "too-large") {
      return yield* new DeckOperationError({ relativePath, reason: "too-large" });
    }
    return { bytes: file.bytes, version: WorkspaceFileSystem.fileVersion(file.bytes) };
  });

  /** Runs the deck code, which reports what it refuses by throwing. */
  const attemptDeck = <A>(
    relativePath: string,
    stage: DocumentFailureError["stage"],
    run: () => Promise<A>,
  ) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) =>
        cause instanceof DeckProblem
          ? new DeckOperationError({
              relativePath,
              reason: cause.reason,
              ...(cause.operationIndex === undefined
                ? {}
                : { operationIndex: cause.operationIndex }),
            })
          : new DocumentFailureError({ relativePath, stage, cause }),
    });

  const openDeck: Documents["Service"]["openDeck"] = Effect.fn("Documents.openDeck")(
    function* (input) {
      const { bytes, version } = yield* readDeck(input);
      const contents = yield* attemptDeck(input.relativePath, "open", async () =>
        (await PptxDeck.open(bytes, deckLimits)).contents(),
      );
      return { version, ...contents };
    },
  );

  const editDeck: Documents["Service"]["editDeck"] = Effect.fn("Documents.editDeck")(
    function* (input, options) {
      const { cwd, relativePath } = input;
      return yield* locks.withLock(
        keyOf(input),
        Effect.gen(function* () {
          const { bytes, version } = yield* readDeck(input);
          if (input.expectedVersion !== undefined && input.expectedVersion !== version) {
            return yield* new WorkspaceFileSystem.WorkspaceFileConflictError({
              workspaceRoot: cwd,
              relativePath,
              currentVersion: version,
            });
          }
          const edited = yield* attemptDeck(relativePath, "edit", async () => {
            const deck = await PptxDeck.open(bytes, deckLimits);
            await deck.apply(input.operations);
            return { bytes: await deck.save(), contents: await deck.contents() };
          });
          if (edited.bytes.byteLength > deckLimits.maxFileBytes) {
            return yield* new DeckOperationError({ relativePath, reason: "too-large" });
          }
          // The write checks the version again, so a change since the read above is still refused.
          const written = yield* fileVersions.writeFileBytes({
            cwd,
            relativePath,
            bytes: edited.bytes,
            expectedVersion: version,
            duringTurn: options?.duringTurn,
          });
          return {
            version: written.version ?? WorkspaceFileSystem.fileVersion(edited.bytes),
            ...edited.contents,
          };
        }),
      );
    },
  );

  const replyBytes = Effect.fn("Documents.replyBytes")(function* (input: ReplyFileSaveInput) {
    const failed = (cause: unknown) =>
      new ReplyFileError({
        reason: "failed",
        message: "The reply could not be turned into that kind of file.",
        cause,
      });
    switch (input.format) {
      case "markdown":
        return Buffer.from(input.markdown.endsWith("\n") ? input.markdown : `${input.markdown}\n`);
      case "pdf":
        return yield* Effect.tryPromise({ try: () => markdownPdf(input.markdown), catch: failed });
      case "xlsx": {
        const table = markdownTables(input.markdown)[0];
        if (table === undefined) {
          return yield* new ReplyFileError({
            reason: "no-table",
            message: "This reply has no table to save as a spreadsheet.",
          });
        }
        return yield* Effect.tryPromise({ try: () => tableWorkbook(table, limits), catch: failed });
      }
    }
  });

  const saveReplyFile: Documents["Service"]["saveReplyFile"] = Effect.fn("Documents.saveReplyFile")(
    function* (input) {
      const { cwd, relativePath } = input;
      if (!REPLY_EXTENSIONS[input.format].test(relativePath)) {
        return yield* new ReplyFileError({
          reason: "wrong-extension",
          message: "The file name does not end with the extension of the chosen format.",
        });
      }
      const bytes = yield* replyBytes(input);
      const written = yield* fileVersions
        .writeFileBytes({
          cwd,
          relativePath,
          bytes,
          ...(input.replaceVersion === undefined
            ? { createOnly: true }
            : { expectedVersion: input.replaceVersion }),
        })
        .pipe(
          Effect.mapError((cause) =>
            cause._tag === "WorkspaceFileConflictError" && cause.currentVersion !== undefined
              ? new ReplyFileExistsError({ relativePath, currentVersion: cause.currentVersion })
              : new ReplyFileError({
                  reason: "failed",
                  message:
                    cause._tag === "WorkspaceFileConflictError"
                      ? `'${relativePath}' was removed while it was being replaced. Save again.`
                      : cause.message,
                  cause,
                }),
          ),
        );
      return {
        relativePath: written.relativePath,
        version: written.version ?? WorkspaceFileSystem.fileVersion(bytes),
      };
    },
  );

  const copyAttachment: Documents["Service"]["copyAttachment"] = Effect.fn(
    "Documents.copyAttachment",
  )(function* (input) {
    const names = copyNameCandidates(input.name);
    if (names === null) {
      return yield* new AttachmentCopyError({
        reason: "bad-name",
        message: "That name cannot be used for a file.",
      });
    }
    const source = resolveAttachmentPathById({
      attachmentsDir: serverConfig.attachmentsDir,
      attachmentId: input.attachmentId,
    });
    const missing = new AttachmentCopyError({
      reason: "not-found",
      message: "The attachment is no longer on this machine.",
    });
    if (source === null) return yield* missing;
    const size = yield* fileSystem.stat(source).pipe(Effect.mapError(() => missing));
    if (Number(size.size) > ATTACHMENT_COPY_MAX_BYTES) {
      return yield* new AttachmentCopyError({
        reason: "too-large",
        message: "The attachment is too large to copy into the workspace.",
      });
    }
    const bytes = yield* fileSystem.readFile(source).pipe(Effect.mapError(() => missing));
    for (const relativePath of names) {
      const written = yield* fileVersions
        .writeFileBytes({ cwd: input.cwd, relativePath, bytes, createOnly: true })
        .pipe(
          Effect.map((result) => ({ taken: false as const, result })),
          Effect.catchTags({
            WorkspaceFileConflictError: () => Effect.succeed({ taken: true as const }),
          }),
          Effect.mapError(
            (cause) => new AttachmentCopyError({ reason: "failed", message: cause.message, cause }),
          ),
        );
      if (written.taken) continue;
      return {
        relativePath: written.result.relativePath,
        version: written.result.version ?? WorkspaceFileSystem.fileVersion(bytes),
      };
    }
    return yield* new AttachmentCopyError({
      reason: "failed",
      message: `Too many files are already named like '${input.name}'. Rename one and try again.`,
    });
  });

  const editPdfWithSignatures: Documents["Service"]["editPdfWithSignatures"] = Effect.fn(
    "Documents.editPdfWithSignatures",
  )((input) => savePdf(input, input.signatures ?? []));

  return Documents.of({
    openSpreadsheet,
    readSpreadsheetRange,
    findInSpreadsheet,
    editSpreadsheet,
    openPdf,
    editPdf,
    editPdfWithSignatures,
    readPdfText,
    openDeck,
    editDeck,
    saveReplyFile,
    copyAttachment,
  });
});

export const layer = Layer.effect(Documents, make);
