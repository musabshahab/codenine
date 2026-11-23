import {
  DeckEditInput,
  DeckOpenResult,
  OrchestratorMcpFailure,
  PdfFieldValue,
  PdfFormField,
  PdfReadTextResult,
  PdfRefusalReason,
  PdfTextMark,
  SpreadsheetCell,
  SpreadsheetEditInput,
  SpreadsheetEditResult,
  SpreadsheetOpenResult,
  SpreadsheetReadRangeInput,
  SpreadsheetReadRangeResult,
} from "@codenine/contracts";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as Documents from "../../../documents/Documents.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    Documents.Documents,
    Path.Path,
  ],
};

// Relative to this chat's folder, or absolute inside it.
const DocumentPath = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const ExpectedVersion = { expectedVersion: SpreadsheetEditInput.fields.expectedVersion };
const AGENT_MAX_OPERATIONS = 2000;

const SpreadsheetReadTool = Tool.make("codenine_spreadsheet_read", {
  ...shared,
  description:
    "Read a .xlsx, .csv or .tsv file in this chat's folder: its sheets, and one sheet's values and formulas for a block of cells (default: the first sheet's first 100 rows and 26 columns). Rows and columns count from 0. Use this, not a script or unzipping the file.",
  parameters: Schema.Struct({
    path: DocumentPath,
    sheet: Schema.optional(SpreadsheetReadRangeInput.fields.sheet),
    row: Schema.optional(SpreadsheetReadRangeInput.fields.row),
    column: Schema.optional(SpreadsheetReadRangeInput.fields.column),
    rowCount: Schema.optional(SpreadsheetReadRangeInput.fields.rowCount),
    columnCount: Schema.optional(SpreadsheetReadRangeInput.fields.columnCount),
  }),
  success: Schema.Struct({
    version: SpreadsheetOpenResult.fields.version,
    sheets: SpreadsheetOpenResult.fields.sheets,
    sheet: Schema.String,
    // The sheet's used size, which can be past the block read.
    rowCount: SpreadsheetReadRangeResult.fields.rowCount,
    columnCount: SpreadsheetReadRangeResult.fields.columnCount,
    cells: Schema.Array(SpreadsheetCell.mapFields(({ format: _format, ...fields }) => fields)),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const SpreadsheetEditTool = Tool.make("codenine_spreadsheet_edit", {
  ...shared,
  description:
    "Change a .xlsx, .csv or .tsv file in this chat's folder: set cells (text, numbers, formulas) and formats, insert or delete rows and columns, sort a table's rows by a column (sortRows takes any cell of the table in the column to sort by; headings and a row of totals stay where they are), set column widths, add, rename or delete sheets. Operations apply in order, all or none. Everything else in the workbook is kept, formulas are recalculated, and the user can review and undo the change. Never rewrite a workbook with a script or edit its XML by hand: that drops formats, charts and formulas.",
  parameters: Schema.Struct({
    path: DocumentPath,
    ...ExpectedVersion,
    operations: SpreadsheetEditInput.fields.operations.check(
      Schema.isMaxLength(AGENT_MAX_OPERATIONS),
    ),
  }),
  success: SpreadsheetEditResult,
}).annotate(Tool.Destructive, true);

const PdfReadTool = Tool.make("codenine_pdf_read", {
  ...shared,
  description:
    "Read a PDF in this chat's folder: the text of a run of pages (pages count from 0; default: the first 5), and its form fields with their values. A scanned page has no text.",
  parameters: Schema.Struct({
    path: DocumentPath,
    page: Schema.optional(PdfReadTextResult.fields.pageCount),
    pageCount: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  }),
  success: Schema.Struct({
    ...PdfReadTextResult.fields,
    fields: Schema.Array(PdfFormField.mapFields(({ widgets: _widgets, ...fields }) => fields)),
    // Present when the PDF can be read but not changed here.
    cannotEdit: Schema.optionalKey(PdfRefusalReason),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const PdfEditTool = Tool.make("codenine_pdf_edit", {
  ...shared,
  description:
    "Fill a PDF's form fields and highlight text, each highlight with an optional note. A highlight quotes the text to mark as `codenine_pdf_read` returned it. The change is saved inside the PDF and the user can undo it. This cannot place a signature: only the user signs, in the file's tab, so ask them to.",
  parameters: Schema.Struct({
    path: DocumentPath,
    ...ExpectedVersion,
    fields: Schema.optional(
      Schema.Array(Schema.Struct({ name: PdfFormField.fields.name, value: PdfFieldValue })).check(
        Schema.isMaxLength(500),
      ),
    ),
    highlights: Schema.optional(Schema.Array(PdfTextMark).check(Schema.isMaxLength(200))),
  }),
  success: Schema.Struct({
    version: Schema.String,
    highlights: Schema.Int,
    fields: Schema.Int,
  }),
}).annotate(Tool.Destructive, true);

const DeckReadTool = Tool.make("codenine_deck_read", {
  ...shared,
  description:
    "Read a .pptx deck in this chat's folder: each slide's layout, its text shapes (with the id an edit names) and speaker notes, and the layouts a new slide can use. Slides count from 1.",
  parameters: Schema.Struct({ path: DocumentPath }),
  success: DeckOpenResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const DeckEditTool = Tool.make("codenine_deck_edit", {
  ...shared,
  description:
    "Change a .pptx deck in this chat's folder: replace a shape's text (`setText`, by shape id or placeholder kind such as `title` or `body`), add a slide from one of the deck's layouts, delete or move slides, set speaker notes. Slides count from 1. Operations apply in order, all or none. Pictures, charts, themes and animations are kept, and the user can review and undo the change. Never unzip a deck or rebuild it with a script: that loses its design.",
  parameters: Schema.Struct({
    path: DocumentPath,
    ...ExpectedVersion,
    operations: DeckEditInput.fields.operations,
  }),
  success: Schema.Struct({ version: Schema.String, slideCount: Schema.Int }),
}).annotate(Tool.Destructive, true);

export const DocumentsToolkit = Toolkit.make(
  SpreadsheetReadTool,
  SpreadsheetEditTool,
  PdfReadTool,
  PdfEditTool,
  DeckReadTool,
  DeckEditTool,
);
