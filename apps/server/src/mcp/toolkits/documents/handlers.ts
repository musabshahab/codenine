import { OrchestratorMcpFailure } from "@codenine/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as Documents from "../../../documents/Documents.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller, unavailable } from "../../threadAccess.ts";
import { DocumentsToolkit } from "./tools.ts";

const DEFAULT_ROWS = 100;
const DEFAULT_COLUMNS = 26;
const DEFAULT_PDF_PAGES = 5;

/** Errors whose message tells the agent what to do differently. */
const EXPLAINED = new Set([
  "SpreadsheetTooLargeError",
  "SpreadsheetUnsupportedError",
  "SpreadsheetOperationError",
  "PdfRefusedError",
  "PdfOperationError",
  "DeckOperationError",
  "DocumentMissingError",
  "WorkspacePathOutsideRootError",
]);

const isMcpFailure = Schema.is(OrchestratorMcpFailure);

const documentFailure = (cause: { readonly _tag: string; readonly message: string }) => {
  if (isMcpFailure(cause)) return cause;
  if (cause._tag === "WorkspaceFileConflictError") {
    return new OrchestratorMcpFailure({
      code: "invalid_request",
      message:
        "The file changed since the version you named. Read it again, then repeat the change with the new version.",
    });
  }
  const operationIndex =
    "operationIndex" in cause && typeof cause.operationIndex === "number"
      ? ` (operation ${cause.operationIndex})`
      : "";
  return EXPLAINED.has(cause._tag)
    ? new OrchestratorMcpFailure({
        code: "invalid_request",
        message: `${cause.message}${operationIndex}`,
      })
    : new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: "The document could not be read or changed.",
      });
};

/** The calling chat's folder and the file's path inside it. */
const locate = Effect.fn("mcp.documents.locate")(function* (
  requested: string,
  access: "read" | "edit",
) {
  const { caller } = yield* loadCaller();
  if (caller === undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "thread_credential_required",
      message: "Document tools work on the calling chat's folder.",
    });
  }
  if (access === "edit" && caller.interactionMode === "plan") {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This chat is in plan mode, which does not change files.",
    });
  }
  // These tools are pre-approved for the provider, so no approval card would cover the write.
  if (access === "edit" && caller.runtimeMode === "approval-required") {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message:
        "This chat asks the user before each file change, and Codenine cannot ask for a document edit. Tell the user what you would change, and that they can make the change in the file's tab or switch the chat to a mode that accepts edits.",
    });
  }
  const projects = yield* ProjectService.ProjectService;
  const project = yield* projects.getById(caller.projectId).pipe(Effect.mapError(unavailable));
  if (Option.isNone(project)) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "This chat's workspace was not found.",
    });
  }
  const path = yield* Path.Path;
  const cwd = caller.worktreePath ?? project.value.workspaceRoot;
  const relativePath = path.isAbsolute(requested) ? path.relative(cwd, requested) : requested;
  return { cwd, relativePath: relativePath.replaceAll("\\", "/") };
});

// The agent edits during its turn, so the user reviews these as they do its other changes.
const DURING_TURN = { duringTurn: true } as const;

export const layer = McpToolAccess.toLayer(DocumentsToolkit, {
  codenine_spreadsheet_read: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const file = yield* locate(input.path, "read");
      const documents = yield* Documents.Documents;
      const opened = yield* documents.openSpreadsheet(file);
      const sheet = input.sheet ?? opened.sheets[0]?.name ?? "";
      const range = yield* documents.readSpreadsheetRange({
        ...file,
        sheet,
        row: input.row ?? 0,
        column: input.column ?? 0,
        rowCount: input.rowCount ?? DEFAULT_ROWS,
        columnCount: input.columnCount ?? DEFAULT_COLUMNS,
      });
      return {
        version: range.version,
        sheets: opened.sheets,
        sheet,
        rowCount: range.rowCount,
        columnCount: range.columnCount,
        cells: range.cells.map(({ format: _format, ...cell }) => cell),
      };
    }).pipe(Effect.mapError(documentFailure)),
  ),
  codenine_spreadsheet_edit: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const file = yield* locate(input.path, "edit");
      const documents = yield* Documents.Documents;
      return yield* documents.editSpreadsheet(
        { ...file, expectedVersion: input.expectedVersion, operations: input.operations },
        DURING_TURN,
      );
    }).pipe(Effect.mapError(documentFailure)),
  ),
  codenine_pdf_read: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const file = yield* locate(input.path, "read");
      const documents = yield* Documents.Documents;
      const text = yield* documents.readPdfText({
        ...file,
        page: input.page ?? 0,
        pageCount: input.pageCount ?? DEFAULT_PDF_PAGES,
      });
      const opened = yield* documents.openPdf(file);
      return {
        ...text,
        fields: opened.fields.map(({ widgets: _widgets, ...field }) => field),
        ...(opened.refusal === undefined ? {} : { cannotEdit: opened.refusal }),
      };
    }).pipe(Effect.mapError(documentFailure)),
  ),
  codenine_pdf_edit: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const file = yield* locate(input.path, "edit");
      const documents = yield* Documents.Documents;
      const fields = input.fields ?? [];
      const highlights = input.highlights ?? [];
      // The service method that cannot sign: an agent never reaches the one that can.
      const saved = yield* documents.editPdf(
        {
          ...file,
          expectedVersion: input.expectedVersion,
          operations: fields.map((field) => ({ type: "setField" as const, ...field })),
          marks: highlights,
        },
        DURING_TURN,
      );
      return { version: saved.version, highlights: highlights.length, fields: fields.length };
    }).pipe(Effect.mapError(documentFailure)),
  ),
  codenine_deck_read: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const file = yield* locate(input.path, "read");
      const documents = yield* Documents.Documents;
      return yield* documents.openDeck(file);
    }).pipe(Effect.mapError(documentFailure)),
  ),
  codenine_deck_edit: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const file = yield* locate(input.path, "edit");
      const documents = yield* Documents.Documents;
      const saved = yield* documents.editDeck(
        { ...file, expectedVersion: input.expectedVersion, operations: input.operations },
        DURING_TURN,
      );
      return { version: saved.version, slideCount: saved.slides.length };
    }).pipe(Effect.mapError(documentFailure)),
  ),
});
