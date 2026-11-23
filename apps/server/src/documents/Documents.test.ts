import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import type { SpreadsheetCell, SpreadsheetOperation } from "@codenine/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import JSZip from "jszip";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as FileVersionStorage from "../fileVersions/FileVersionStorage.ts";
import * as FileVersions from "../fileVersions/FileVersions.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as Documents from "./Documents.ts";
import type { SpreadsheetLimits } from "./spreadsheet/problems.ts";

const LIMITS: SpreadsheetLimits = {
  maxFileBytes: 1024 * 1024,
  maxUnpackedBytes: 4 * 1024 * 1024,
  maxCells: 10_000,
  maxFormatCells: 1000,
};

const layerWith = (limits: Partial<SpreadsheetLimits> = {}) =>
  Documents.layer.pipe(
    Layer.provide(Layer.succeed(Documents.DocumentLimits, { ...LIMITS, ...limits })),
    Layer.provideMerge(FileVersions.layer),
    Layer.provide(FileVersionStorage.layer),
    Layer.provide(
      Layer.mock(CheckpointStore.CheckpointStore)({
        isGitRepository: () => Effect.succeed(false),
      }),
    ),
    Layer.provideMerge(
      WorkspaceFileSystem.layer.pipe(
        Layer.provide(
          Layer.mock(KnownWorkspaces.KnownWorkspaces)({ assertContains: () => Effect.void }),
        ),
        Layer.provide(
          Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
        ),
      ),
    ),
    Layer.provideMerge(WorkspacePaths.layer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(
      ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "codenine-documents-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const RELATIONSHIPS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_RELATIONSHIPS = "http://schemas.openxmlformats.org/package/2006/relationships";
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const CHART = `${XML}<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:plotArea><c:barChart><c:ser><c:val><c:numRef><c:f>Data!$B$2:$B$4</c:f></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>`;
const DRAWING = `${XML}<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"><xdr:twoCellAnchor/></xdr:wsDr>`;
const DATA_SHEET = `${XML}<worksheet xmlns="${MAIN}" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac"><dimension ref="A1:C5"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><cols><col min="2" max="2" width="18" customWidth="1"/></cols><sheetData><row r="1" spans="1:3" x14ac:dyDescent="0.25"><c r="A1" t="s"><v>0</v></c><c r="B1" s="1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row><row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2"><v>10</v></c><c r="C2"><f t="shared" ref="C2:C4" si="0">B2*2</f><v>20</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>Pear &amp; plum</t></is></c><c r="B3"><v>20</v></c><c r="C3"><f t="shared" si="0"/><v>40</v></c></row><row r="4"><c r="A4" t="s"><v>3</v></c><c r="B4" s="2"><v>30.5</v></c><c r="C4"><f t="shared" si="0"/><v>61</v></c></row><row r="5"><c r="A5" t="s"><v>4</v></c><c r="B5"><f>SUM(B2:B4)</f><v>60.5</v></c><c r="C5"><f>VLOOKUP(10,B2:C4,2,FALSE)</f><v>20</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="A7:B8"/></mergeCells><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;
const SUMMARY_SHEET = `${XML}<worksheet xmlns="${MAIN}" xmlns:r="${RELATIONSHIPS}"><sheetData><row r="1"><c r="A1"><f>Data!B5+1</f><v>61.5</v></c><c r="B1"><f>TODAY()</f><v>45000</v></c></row></sheetData><drawing r:id="rId1"/></worksheet>`;
const UNTOUCHED_SHEET = `${XML}<worksheet xmlns="${MAIN}"><sheetData><row r="1"><c r="A1"><v>7</v></c><c r="B1"><f>A1*3</f><v>21</v></c></row></sheetData></worksheet>`;
const STYLES = `${XML}<styleSheet xmlns="${MAIN}"><numFmts count="1"><numFmt numFmtId="164" formatCode="0.0&quot; kg&quot;"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`;

const workbookParts = (): Record<string, string> => ({
  "[Content_Types].xml": `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/></Types>`,
  "_rels/.rels": `${XML}<Relationships xmlns="${PACKAGE_RELATIONSHIPS}"><Relationship Id="rId1" Type="${RELATIONSHIPS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  "xl/workbook.xml": `${XML}<workbook xmlns="${MAIN}" xmlns:r="${RELATIONSHIPS}"><workbookPr/><bookViews><workbookView activeTab="0"/></bookViews><sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Summary" sheetId="2" r:id="rId2"/><sheet name="Notes" sheetId="3" r:id="rId3"/></sheets><definedNames><definedName name="Totals">Data!$B$5:$C$5</definedName></definedNames><calcPr calcId="191029"/></workbook>`,
  "xl/_rels/workbook.xml.rels": `${XML}<Relationships xmlns="${PACKAGE_RELATIONSHIPS}"><Relationship Id="rId1" Type="${RELATIONSHIPS}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${RELATIONSHIPS}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${RELATIONSHIPS}/worksheet" Target="worksheets/sheet3.xml"/><Relationship Id="rId4" Type="${RELATIONSHIPS}/styles" Target="styles.xml"/><Relationship Id="rId5" Type="${RELATIONSHIPS}/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId6" Type="${RELATIONSHIPS}/calcChain" Target="calcChain.xml"/></Relationships>`,
  "xl/worksheets/sheet1.xml": DATA_SHEET,
  "xl/worksheets/sheet2.xml": SUMMARY_SHEET,
  "xl/worksheets/sheet3.xml": UNTOUCHED_SHEET,
  "xl/worksheets/_rels/sheet2.xml.rels": `${XML}<Relationships xmlns="${PACKAGE_RELATIONSHIPS}"><Relationship Id="rId1" Type="${RELATIONSHIPS}/drawing" Target="../drawings/drawing1.xml"/></Relationships>`,
  "xl/drawings/drawing1.xml": DRAWING,
  "xl/charts/chart1.xml": CHART,
  "xl/styles.xml": STYLES,
  "xl/sharedStrings.xml": `${XML}<sst xmlns="${MAIN}" count="5" uniqueCount="5"><si><t>Fruit</t></si><si><t>Weight</t></si><si><t>Double</t></si><si><r><t>App</t></r><r><rPr><b/></rPr><t>le</t></r></si><si><t>Total</t></si></sst>`,
  "xl/calcChain.xml": `${XML}<calcChain xmlns="${MAIN}"><c r="C2" i="1"/></calcChain>`,
});

const zipOf = (parts: Record<string, string>) => {
  const zip = new JSZip();
  for (const [path, text] of Object.entries(parts)) zip.file(path, text);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
};

const makeWorkspace = Effect.fn("DocumentsTest.makeWorkspace")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const documents = yield* Documents.Documents;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codenine-documents-work-" });
  const write = (name: string, contents: Uint8Array | string) =>
    typeof contents === "string"
      ? fileSystem.writeFileString(path.join(cwd, name), contents)
      : fileSystem.writeFile(path.join(cwd, name), contents);
  const readBytes = (name: string) => fileSystem.readFile(path.join(cwd, name));
  const parts = Effect.fn("DocumentsTest.parts")(function* (name: string) {
    const bytes = yield* readBytes(name);
    const zip = yield* Effect.promise(() => JSZip.loadAsync(bytes));
    const text = (part: string) => Effect.promise(() => zip.file(part)!.async("string"));
    return { names: Object.keys(zip.files), text };
  });
  /** A sheet's cells by name, such as `B5`, read in one page. */
  const cells = Effect.fn("DocumentsTest.cells")(function* (relativePath: string, sheet: string) {
    const range = yield* documents.readSpreadsheetRange({
      cwd,
      relativePath,
      sheet,
      row: 0,
      column: 0,
      rowCount: 100,
      columnCount: 26,
    });
    const byName: Record<string, SpreadsheetCell> = {};
    for (const cell of range.cells) {
      byName[`${String.fromCharCode(65 + cell.column)}${cell.row + 1}`] = cell;
    }
    return { ...range, byName };
  });
  const edit = (
    relativePath: string,
    operations: ReadonlyArray<SpreadsheetOperation>,
    expectedVersion?: string,
  ) => documents.editSpreadsheet({ cwd, relativePath, operations, expectedVersion });
  return { cwd, documents, write, readBytes, parts, cells, edit };
});

const setCell = (
  sheet: string,
  name: string,
  input: Extract<SpreadsheetOperation, { type: "setCell" }>["input"],
): SpreadsheetOperation => ({
  type: "setCell",
  sheet,
  row: Number(name.slice(1)) - 1,
  column: name.charCodeAt(0) - 65,
  input,
});

describe("Documents spreadsheets", () => {
  it.layer(layerWith())("workbooks", (it) => {
    it.effect("reads values, formulas and formats a page at a time", () =>
      Effect.gen(function* () {
        const workspace = yield* makeWorkspace();
        yield* workspace.write("book.xlsx", yield* Effect.promise(() => zipOf(workbookParts())));
        const opened = yield* workspace.documents.openSpreadsheet({
          cwd: workspace.cwd,
          relativePath: "book.xlsx",
        });
        expect(opened.format).toBe("xlsx");
        expect(opened.sheets.map((sheet) => sheet.name)).toEqual(["Data", "Summary", "Notes"]);
        const data = yield* workspace.cells("book.xlsx", "Data");
        expect(data.version).toBe(opened.version);
        expect({ rows: data.rowCount, columns: data.columnCount }).toEqual({ rows: 5, columns: 3 });
        expect(data.byName.A2?.value).toBe("Apple");
        expect(data.byName.A3?.value).toBe("Pear & plum");
        expect(data.byName.C3).toMatchObject({ formula: "B3*2", value: 40 });
        expect(data.byName.B5).toMatchObject({ formula: "SUM(B2:B4)", value: 60.5 });
        expect(data.formats[data.byName.B1!.format!]).toEqual({ bold: true });
        expect(data.formats[data.byName.B4!.format!]).toEqual({ numberFormat: '0.0" kg"' });
        const page = yield* workspace.documents.readSpreadsheetRange({
          cwd: workspace.cwd,
          relativePath: "book.xlsx",
          sheet: "Data",
          row: 1,
          column: 1,
          rowCount: 2,
          columnCount: 1,
        });
        expect(page.cells.map((cell) => cell.value)).toEqual([10, 20]);
      }),
    );

    it.effect("saves edits, recalculates what it can and keeps the rest of the workbook", () =>
      Effect.gen(function* () {
        const workspace = yield* makeWorkspace();
        yield* workspace.write("book.xlsx", yield* Effect.promise(() => zipOf(workbookParts())));
        const opened = yield* workspace.documents.openSpreadsheet({
          cwd: workspace.cwd,
          relativePath: "book.xlsx",
        });
        const saved = yield* workspace.edit(
          "book.xlsx",
          [
            setCell("Data", "B2", { kind: "number", number: 12 }),
            setCell("Data", "A3", { kind: "text", text: "Fig <ripe>" }),
            setCell("Data", "D2", { kind: "formula", formula: "=B2+B3" }),
            setCell("Data", "D3", { kind: "boolean", boolean: true }),
            setCell("Data", "A4", { kind: "blank" }),
            {
              type: "setFormat",
              sheet: "Data",
              row: 1,
              column: 1,
              rowCount: 1,
              columnCount: 1,
              format: { bold: true, numberFormat: "0.00", fill: "FFF2CC" },
            },
          ],
          opened.version,
        );
        expect(saved.version).not.toBe(opened.version);

        const data = yield* workspace.cells("book.xlsx", "Data");
        expect(data.version).toBe(saved.version);
        expect(data.byName.B2?.value).toBe(12);
        expect(data.byName.A3?.value).toBe("Fig <ripe>");
        expect(data.byName.A4).toBeUndefined();
        expect(data.byName.D2).toMatchObject({ formula: "B2+B3", value: 32 });
        expect(data.byName.D3?.value).toBe(true);
        // Formulas that read the edited cell are worked out again, across sheets too.
        expect(data.byName.C2).toMatchObject({ formula: "B2*2", value: 24 });
        expect(data.byName.C3).toMatchObject({ formula: "B3*2", value: 40 });
        expect(data.byName.B5).toMatchObject({ formula: "SUM(B2:B4)", value: 62.5 });
        expect((yield* workspace.cells("book.xlsx", "Summary")).byName.A1?.value).toBe(63.5);
        // One this code cannot calculate loses its stored result instead of keeping a stale one.
        expect(data.byName.C5).toEqual({
          row: 4,
          column: 2,
          formula: "VLOOKUP(10,B2:C4,2,FALSE)",
        });
        expect(data.formats[data.byName.B2!.format!]).toEqual({
          bold: true,
          numberFormat: "0.00",
          fill: "FFF2CC",
        });
        expect(data.formats[data.byName.B4!.format!]).toEqual({ numberFormat: '0.0" kg"' });

        const written = yield* workspace.parts("book.xlsx");
        // Parts the edit did not touch are the bytes they were.
        expect(yield* written.text("xl/worksheets/sheet3.xml")).toBe(UNTOUCHED_SHEET);
        expect(yield* written.text("xl/charts/chart1.xml")).toBe(CHART);
        expect(yield* written.text("xl/drawings/drawing1.xml")).toBe(DRAWING);
        expect(yield* written.text("xl/sharedStrings.xml")).toBe(
          workbookParts()["xl/sharedStrings.xml"],
        );
        const sheet = yield* written.text("xl/worksheets/sheet1.xml");
        expect(sheet).toContain('<mergeCell ref="A7:B8"/>');
        expect(sheet).toContain('<col min="2" max="2" width="18" customWidth="1"/>');
        expect(sheet).toContain('x14ac:dyDescent="0.25"');
        expect(yield* written.text("xl/worksheets/sheet2.xml")).toContain('<drawing r:id="rId1"/>');
        const workbook = yield* written.text("xl/workbook.xml");
        expect(workbook).toContain('<definedName name="Totals">Data!$B$5:$C$5</definedName>');
        expect(workbook).toContain('<calcPr calcId="191029" fullCalcOnLoad="1"/>');
        // The stored calculation order no longer matches, so a spreadsheet app rebuilds it.
        expect(written.names).not.toContain("xl/calcChain.xml");
        expect(yield* written.text("[Content_Types].xml")).not.toContain("calcChain");
        expect(yield* written.text("xl/styles.xml")).toContain('<numFmt numFmtId="164"');
      }),
    );

    it.effect("moves formulas, names and chart series with inserted and deleted rows", () =>
      Effect.gen(function* () {
        const workspace = yield* makeWorkspace();
        yield* workspace.write("book.xlsx", yield* Effect.promise(() => zipOf(workbookParts())));
        yield* workspace.edit("book.xlsx", [
          { type: "insertRows", sheet: "Data", index: 2, count: 2 },
          { type: "deleteColumns", sheet: "Data", index: 0, count: 1 },
        ]);
        const data = yield* workspace.cells("book.xlsx", "Data");
        expect(data.byName.A2?.value).toBe(10);
        expect(data.byName.A5?.value).toBe(20);
        expect(data.byName.B5).toMatchObject({ formula: "A5*2", value: 40 });
        expect(data.byName.A7).toMatchObject({ formula: "SUM(A2:A6)", value: 60.5 });
        const summary = yield* workspace.cells("book.xlsx", "Summary");
        expect(summary.byName.A1).toMatchObject({ formula: "Data!A7+1", value: 61.5 });
        const written = yield* workspace.parts("book.xlsx");
        expect(yield* written.text("xl/charts/chart1.xml")).toContain("<c:f>Data!$A$2:$A$6</c:f>");
        expect(yield* written.text("xl/workbook.xml")).toContain("Data!$A$7:$B$7</definedName>");
        const sheet = yield* written.text("xl/worksheets/sheet1.xml");
        expect(sheet).toContain('<mergeCell ref="A9:A10"/>');
        expect(sheet).toContain('<col min="1" max="1" width="18" customWidth="1"/>');
      }),
    );

    it.effect("adds, renames and deletes sheets", () =>
      Effect.gen(function* () {
        const workspace = yield* makeWorkspace();
        yield* workspace.write("book.xlsx", yield* Effect.promise(() => zipOf(workbookParts())));
        const saved = yield* workspace.edit("book.xlsx", [
          { type: "addSheet", name: "Plan 2026" },
          setCell("Plan 2026", "A1", { kind: "formula", formula: "Data!B5" }),
          { type: "renameSheet", sheet: "Data", name: "Raw data" },
          { type: "deleteSheet", sheet: "Notes" },
        ]);
        expect(saved.sheets.map((sheet) => sheet.name)).toEqual([
          "Raw data",
          "Summary",
          "Plan 2026",
        ]);
        expect((yield* workspace.cells("book.xlsx", "Plan 2026")).byName.A1).toMatchObject({
          formula: "'Raw data'!B5",
          value: 60.5,
        });
        expect((yield* workspace.cells("book.xlsx", "Summary")).byName.A1?.formula).toBe(
          "'Raw data'!B5+1",
        );
        const written = yield* workspace.parts("book.xlsx");
        expect(written.names).not.toContain("xl/worksheets/sheet3.xml");
        expect(yield* written.text("xl/charts/chart1.xml")).toContain(
          "<c:f>'Raw data'!$B$2:$B$4</c:f>",
        );
        expect(yield* written.text("[Content_Types].xml")).toContain("/xl/worksheets/sheet4.xml");
      }),
    );

    it.effect("refuses changes that would damage what the workbook holds", () =>
      Effect.gen(function* () {
        const workspace = yield* makeWorkspace();
        const original = yield* Effect.promise(() => zipOf(workbookParts()));
        yield* workspace.write("book.xlsx", original);
        const refused = (operations: ReadonlyArray<SpreadsheetOperation>) =>
          workspace.edit("book.xlsx", operations).pipe(Effect.flip);
        // The Summary sheet holds a chart, whose anchors a row insert would leave behind.
        expect(
          yield* refused([{ type: "insertRows", sheet: "Summary", index: 0, count: 1 }]),
        ).toMatchObject({ _tag: "SpreadsheetUnsupportedError", feature: "sheet-objects" });
        expect(yield* refused([{ type: "deleteSheet", sheet: "Summary" }])).toMatchObject({
          _tag: "SpreadsheetUnsupportedError",
          feature: "sheet-objects",
        });
        expect(yield* refused([{ type: "addSheet", name: "data" }])).toMatchObject({
          _tag: "SpreadsheetOperationError",
          reason: "sheet-name-taken",
        });
        // A batch is all or nothing: the valid edit before the refused one is not saved either.
        expect(
          yield* refused([
            setCell("Data", "B2", { kind: "number", number: 99 }),
            setCell("Gone", "A1", { kind: "number", number: 1 }),
          ]),
        ).toMatchObject({ _tag: "SpreadsheetOperationError", reason: "unknown-sheet" });
        expect(
          Buffer.from(yield* workspace.readBytes("book.xlsx")).equals(Buffer.from(original)),
        ).toBe(true);
        expect((yield* workspace.cells("book.xlsx", "Data")).byName.B2?.value).toBe(10);
      }),
    );

    it.effect("refuses a save over a file that changed, and records versions without Git", () =>
      Effect.gen(function* () {
        const workspace = yield* makeWorkspace();
        const versions = yield* FileVersions.FileVersions;
        yield* workspace.write("book.xlsx", yield* Effect.promise(() => zipOf(workbookParts())));
        const opened = yield* workspace.documents.openSpreadsheet({
          cwd: workspace.cwd,
          relativePath: "book.xlsx",
        });
        const saved = yield* workspace.edit(
          "book.xlsx",
          [setCell("Data", "B2", { kind: "number", number: 11 })],
          opened.version,
        );
        const conflict = yield* workspace
          .edit(
            "book.xlsx",
            [setCell("Data", "B2", { kind: "number", number: 12 })],
            opened.version,
          )
          .pipe(Effect.flip);
        assert.deepInclude(conflict, {
          _tag: "WorkspaceFileConflictError",
          currentVersion: saved.version,
        });
        expect((yield* workspace.cells("book.xlsx", "Data")).byName.B2?.value).toBe(11);

        const listed = yield* versions.list({ cwd: workspace.cwd, relativePath: "book.xlsx" });
        expect(listed.versions.map((version) => [version.origin, version.version])).toEqual([
          ["user", saved.version],
          ["external", opened.version],
        ]);
        const before = listed.versions[1]!;
        yield* versions.restore({
          cwd: workspace.cwd,
          relativePath: "book.xlsx",
          versionId: before.id,
          expectedVersion: saved.version,
        });
        expect((yield* workspace.cells("book.xlsx", "Data")).byName.B2?.value).toBe(10);
      }),
    );
  });

  it.layer(layerWith({ maxFileBytes: 64 * 1024, maxUnpackedBytes: 64 * 1024, maxCells: 12 }))(
    "limits",
    (it) => {
      it.effect("answers that a file, its contents or a format range is too large", () =>
        Effect.gen(function* () {
          const workspace = yield* makeWorkspace();
          yield* workspace.write("big.csv", "x,".repeat(40_000));
          expect(
            yield* workspace.documents
              .openSpreadsheet({ cwd: workspace.cwd, relativePath: "big.csv" })
              .pipe(Effect.flip),
          ).toMatchObject({ _tag: "SpreadsheetTooLargeError", limit: "file-size" });
          yield* workspace.write("wide.csv", "1,2,3,4,5,6,7\n1,2,3,4,5,6,7\n");
          expect(
            yield* workspace.documents
              .openSpreadsheet({ cwd: workspace.cwd, relativePath: "wide.csv" })
              .pipe(Effect.flip),
          ).toMatchObject({ _tag: "SpreadsheetTooLargeError", limit: "cell-count" });
          // The archive is small; what it unpacks to is not.
          yield* workspace.write(
            "bomb.xlsx",
            yield* Effect.promise(() =>
              zipOf({
                ...workbookParts(),
                "xl/worksheets/sheet1.xml": DATA_SHEET.replace(
                  "</worksheet>",
                  `${"<!-- padding -->".repeat(400_000)}</worksheet>`,
                ),
              }),
            ),
          );
          expect(yield* workspace.cells("bomb.xlsx", "Data").pipe(Effect.flip)).toMatchObject({
            _tag: "SpreadsheetTooLargeError",
            limit: "unpacked-size",
          });
        }),
      );
    },
  );

  it.layer(layerWith())("delimited files", (it) => {
    it.effect.each([
      {
        name: "keeps quoting, the byte order mark and CRLF of rows it does not change",
        file: "table.csv",
        before: '﻿name,note\r\n"Smith, J","said ""hi"""\r\nplain,  padded  \r\n',
        operations: [setCell("Sheet1", "B3", { kind: "text", text: 'a "b", c\nd' })],
        after: '﻿name,note\r\n"Smith, J","said ""hi"""\r\nplain,"a ""b"", c\nd"\r\n',
        read: { A2: "Smith, J", B2: 'said "hi"', B3: 'a "b", c\nd' },
      },
      {
        name: "writes numbers, booleans and formulas as text and pads short rows",
        file: "table.tsv",
        before: "a\tb\nc",
        operations: [
          setCell("Sheet1", "C1", { kind: "number", number: 1.5 }),
          setCell("Sheet1", "A3", { kind: "formula", formula: "A1+1" }),
          setCell("Sheet1", "B3", { kind: "boolean", boolean: false }),
          { type: "insertRows", sheet: "Sheet1", index: 1, count: 1 },
          { type: "deleteColumns", sheet: "Sheet1", index: 1, count: 1 },
        ] satisfies ReadonlyArray<SpreadsheetOperation>,
        after: "a\t1.5\n\nc\n=A1+1\n",
        read: { A1: "a", B1: "1.5", A4: "=A1+1" },
      },
    ])("$name", ({ file, before, operations, after, read }) =>
      Effect.gen(function* () {
        const workspace = yield* makeWorkspace();
        yield* workspace.write(file, before);
        const opened = yield* workspace.documents.openSpreadsheet({
          cwd: workspace.cwd,
          relativePath: file,
        });
        expect(opened).toMatchObject({ format: "delimited", sheets: [{ name: "Sheet1" }] });
        yield* workspace.edit(file, operations, opened.version);
        expect(Buffer.from(yield* workspace.readBytes(file)).toString("utf-8")).toBe(after);
        const cells = (yield* workspace.cells(file, "Sheet1")).byName;
        for (const [name, value] of Object.entries(read)) expect(cells[name]?.value).toBe(value);
      }),
    );

    it.effect("refuses text in another encoding and what a delimited file cannot hold", () =>
      Effect.gen(function* () {
        const workspace = yield* makeWorkspace();
        // "café" in Windows-1252, which a UTF-8 save would turn into a replacement character.
        yield* workspace.write("latin.csv", Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x2c, 0x31]));
        expect(
          yield* workspace.documents
            .openSpreadsheet({ cwd: workspace.cwd, relativePath: "latin.csv" })
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "SpreadsheetUnsupportedError", feature: "text-encoding" });
        yield* workspace.write("table.csv", "a,b\n");
        expect(
          yield* workspace
            .edit("table.csv", [{ type: "addSheet", name: "More" }])
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "SpreadsheetUnsupportedError", feature: "delimited-sheets" });
      }),
    );
  });
});
