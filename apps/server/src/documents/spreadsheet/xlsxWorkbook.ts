import type {
  SpreadsheetCell,
  SpreadsheetCellFormat,
  SpreadsheetCellInput,
  SpreadsheetOperation,
  SpreadsheetSheet,
} from "@codenine/contracts";
import JSZip from "jszip";

import {
  evaluateFormula,
  FormulaErrorValue,
  FormulaNotCalculated,
  type FormulaValue,
} from "./formulaEvaluation.ts";
import {
  type SpreadsheetLimits,
  type SpreadsheetModel,
  atOperation,
  invalidOperation,
  tooLarge,
  unsupported,
} from "./problems.ts";
import {
  type Axis,
  type CellArea,
  type FormulaReference,
  type ReferenceRewrite,
  areaName,
  cellName,
  formulaIsComplete,
  formulaReferences,
  mapFormulaReferences,
  MAX_COLUMNS,
  MAX_ROWS,
  offsetReference,
  parseArea,
  parseCellName,
  REFERENCE_ERROR,
  shiftReference,
  type UnfollowedSheet,
} from "./references.ts";
import {
  type XmlElement,
  attributeText,
  childElements,
  escapeAttribute,
  escapeXml,
  findChild,
  localNameOf,
  parseAttributes,
  rootElement,
  unescapeXml,
} from "./xml.ts";

const RELATIONSHIPS_NAMESPACE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const WORKSHEET_RELATIONSHIP = `${RELATIONSHIPS_NAMESPACE}/worksheet`;
const WORKSHEET_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml";
const MAIN_NAMESPACE = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
// Parts of a sheet that name cells by position, which inserting or deleting rows would leave
// pointing at the wrong cells.
// Formulas a sheet holds outside its cells: validation lists, formatting rules and their
// extended forms. They may read any sheet, so they move with the cells they name.
const RULE_FORMULA_PATTERN = /(<((?:\w+:)?(?:formula[12]?|f))>)([^<]*)(<\/\2>)/g;
const HYPERLINK_LOCATION_PATTERN = /(<hyperlink\b[^>]*?\blocation=")([^"]*)(")/g;
const VOLATILE_REFERENCE_PATTERN = /\b(?:INDIRECT|OFFSET)\s*\(/i;

const POSITIONED_SHEET_PARTS =
  /<(?:conditionalFormatting|dataValidations|autoFilter|hyperlinks|tableParts|drawing|legacyDrawing|legacyDrawingHF|rowBreaks|colBreaks|sortState|protectedRanges|scenarios|customSheetViews|oleObjects|controls|extLst|picture|ignoredErrors|dataConsolidate|cellWatches)[\s/>]/;

const BUILT_IN_NUMBER_FORMATS: Record<number, string> = {
  1: "0",
  2: "0.00",
  3: "#,##0",
  4: "#,##0.00",
  9: "0%",
  10: "0.00%",
  11: "0.00E+00",
  12: "# ?/?",
  13: "# ??/??",
  14: "m/d/yyyy",
  15: "d-mmm-yy",
  16: "d-mmm",
  17: "mmm-yy",
  18: "h:mm AM/PM",
  19: "h:mm:ss AM/PM",
  20: "h:mm",
  21: "h:mm:ss",
  22: "m/d/yyyy h:mm",
  37: "#,##0;(#,##0)",
  38: "#,##0;[Red](#,##0)",
  39: "#,##0.00;(#,##0.00)",
  40: "#,##0.00;[Red](#,##0.00)",
  45: "mm:ss",
  46: "[h]:mm:ss",
  47: "mm:ss.0",
  48: "##0.0E+0",
  49: "@",
};

interface Cell {
  column: number;
  style: string | undefined;
  type: string | undefined;
  /** Attributes other than the position, style and type, as written. */
  extra: string;
  /** The cell's child elements, as written. */
  inner: string;
}

interface Row {
  index: number;
  /** Attributes other than the row number and the span hint, as written. */
  readonly attributes: string;
  cells: Array<Cell>;
}

interface SheetContents {
  prefix: string;
  suffix: string;
  readonly sheetDataAttributes: string;
  rows: Array<Row>;
  /** Shared formulas by group: the cell that holds the text the others derive theirs from. */
  readonly shared: Map<string, { row: number; column: number; text: string }>;
  /** Areas held by an array formula or a data table, whose cells cannot be changed one by one. */
  readonly arrayAreas: ReadonlyArray<CellArea>;
  /** The styles the `cols` records of `prefix` give whole columns, read when first needed. */
  columnStyles?: {
    readonly prefix: string;
    readonly records: ReadonlyArray<{ min: number; max: number; style: string }>;
  };
  dirty: boolean;
}

interface Sheet {
  name: string;
  readonly sheetId: number;
  readonly relationshipId: string;
  readonly path: string;
  /** Attributes other than the name, id and relationship, such as `state`. */
  readonly attributes: Map<string, string>;
  /** A chart sheet holds no cells and is never offered. */
  readonly worksheet: boolean;
  contents: SheetContents | null;
}

interface DefinedName {
  attributes: Map<string, string>;
  text: string;
}

interface Styles {
  readonly xml: string;
  readonly root: XmlElement;
  readonly sections: Map<string, { element: XmlElement; children: Array<string> }>;
  readonly customNumberFormats: Map<number, string>;
  readonly derived: Map<string, string>;
  readonly formats: Map<string, SpreadsheetCellFormat | null>;
  dirty: boolean;
}

const FORMULA_PATTERN = /<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/;
const VALUE_PATTERN = /<v\b[^>]*?(?:\/>|>([\s\S]*?)<\/v>)/;
const TEXT_RUN_PATTERN = /<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g;
const PHONETIC_PATTERN = /<rPh\b[\s\S]*?<\/rPh>/g;

/** The text of a string item, which may be split into formatted runs. */
function richText(xml: string): string {
  let text = "";
  const visible = xml.includes("<rPh") ? xml.replace(PHONETIC_PATTERN, "") : xml;
  for (const match of visible.matchAll(TEXT_RUN_PATTERN)) text += unescapeXml(match[1] ?? "");
  return text;
}

const sameName = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

function resolveTarget(sourcePath: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const segments = sourcePath.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "..") segments.pop();
    else if (segment !== "." && segment !== "") segments.push(segment);
  }
  return segments.join("/");
}

const relationshipsPath = (partPath: string) => {
  const slash = partPath.lastIndexOf("/");
  return `${partPath.slice(0, slash + 1)}_rels/${partPath.slice(slash + 1)}.rels`;
};

function lowerBound<T>(items: ReadonlyArray<T>, value: number, key: (item: T) => number) {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (key(items[middle]!) < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

const rowIndex = (row: Row) => row.index;
const cellColumn = (cell: Cell) => cell.column;

function formulaOf(cell: Cell): { attributes: Map<string, string>; text: string } | null {
  if (!cell.inner.includes("<f")) return null;
  const match = FORMULA_PATTERN.exec(cell.inner);
  if (!match) return null;
  return { attributes: parseAttributes(match[1] ?? ""), text: unescapeXml(match[2] ?? "") };
}

function validSheetName(name: string): boolean {
  return (
    name.length >= 1 &&
    name.length <= 31 &&
    !/[[\]:*?/\\]/.test(name) &&
    !name.startsWith("'") &&
    !name.endsWith("'")
  );
}

/**
 * An .xlsx workbook held as its parts. Only the parts an edit touches are rewritten, and in a
 * sheet that is rewritten everything but its cells is kept as written, so charts, styles, names
 * and whatever else the file holds survive a save.
 */
export class XlsxWorkbook implements SpreadsheetModel {
  readonly format = "xlsx";
  readonly date1904: boolean;
  private readonly zip: JSZip;
  private readonly limits: SpreadsheetLimits;
  private readonly parts = new Map<string, string>();
  private readonly changedParts = new Set<string>();
  private readonly removedParts = new Set<string>();
  // A part counts toward the unpacked limit once, however often it is read again after a save.
  private readonly countedParts = new Set<string>();
  private unpackedBytes = 0;
  private cellCount = 0;
  private readonly workbookPath: string;
  private readonly relationshipPrefix: string;
  private workbookXml: string;
  private workbookDirty = false;
  private valuesChanged = false;
  private readonly allSheets: Array<Sheet>;
  private readonly definedNames: Array<DefinedName>;
  private readonly sharedStringsPath: string | null;
  private readonly stylesPath: string | null;
  private sharedStrings: ReadonlyArray<string> | null = null;
  private styles: Styles | null = null;

  private constructor(input: {
    zip: JSZip;
    limits: SpreadsheetLimits;
    workbookPath: string;
    workbookXml: string;
    relationshipPrefix: string;
    sheets: Array<Sheet>;
    definedNames: Array<DefinedName>;
    sharedStringsPath: string | null;
    stylesPath: string | null;
    date1904: boolean;
    unpackedBytes: number;
  }) {
    this.zip = input.zip;
    this.limits = input.limits;
    this.workbookPath = input.workbookPath;
    this.workbookXml = input.workbookXml;
    this.relationshipPrefix = input.relationshipPrefix;
    this.allSheets = input.sheets;
    this.definedNames = input.definedNames;
    this.sharedStringsPath = input.sharedStringsPath;
    this.stylesPath = input.stylesPath;
    this.date1904 = input.date1904;
    this.unpackedBytes = input.unpackedBytes;
  }

  static async open(bytes: Uint8Array, limits: SpreadsheetLimits): Promise<XlsxWorkbook> {
    const zip = await JSZip.loadAsync(bytes).catch(() => {
      throw unsupported("not-a-workbook");
    });
    let unpackedBytes = 0;
    const read = async (path: string) => {
      const text = await readZipText(zip, path, limits.maxUnpackedBytes - unpackedBytes);
      unpackedBytes += text?.length ?? 0;
      return text;
    };
    const packageRelationships = await read("_rels/.rels");
    if (packageRelationships === null) throw unsupported("not-a-workbook");
    const workbookPath =
      readRelationships(packageRelationships, "").find((relationship) =>
        relationship.type.endsWith("/officeDocument"),
      )?.path ?? "xl/workbook.xml";
    const workbookXml = await read(workbookPath);
    if (workbookXml === null) throw unsupported("not-a-workbook");
    const root = rootElement(workbookXml);
    // A workbook that prefixes the main namespace, or uses the strict one, is not parsed here.
    if (root?.name !== "workbook" || root.inner === null) throw unsupported("workbook-layout");
    const rootAttributes = parseAttributes(root.attributes);
    if (rootAttributes.get("xmlns") !== MAIN_NAMESPACE) throw unsupported("workbook-layout");
    const relationshipPrefix = [...rootAttributes].find(
      ([name, value]) => name.startsWith("xmlns:") && value === RELATIONSHIPS_NAMESPACE,
    )?.[0];
    if (relationshipPrefix === undefined) throw unsupported("workbook-layout");
    const prefix = relationshipPrefix.slice("xmlns:".length);
    const relationships = readRelationships(
      (await read(relationshipsPath(workbookPath))) ?? "",
      workbookPath,
    );
    const sheetsElement = findChild(root.inner, "sheets");
    if (sheetsElement?.name !== "sheets") throw unsupported("workbook-layout");
    const sheets: Array<Sheet> = [];
    for (const element of childElements(sheetsElement.inner ?? "")) {
      const attributes = parseAttributes(element.attributes);
      const relationshipId = attributes.get(`${prefix}:id`);
      const relationship = relationships.find((candidate) => candidate.id === relationshipId);
      const name = attributes.get("name");
      if (name === undefined || relationshipId === undefined || relationship === undefined) {
        throw unsupported("workbook-layout");
      }
      const sheetId = Number(attributes.get("sheetId"));
      attributes.delete("name");
      attributes.delete("sheetId");
      attributes.delete(`${prefix}:id`);
      sheets.push({
        name,
        sheetId,
        relationshipId,
        path: relationship.path,
        attributes,
        worksheet: relationship.type === WORKSHEET_RELATIONSHIP,
        contents: null,
      });
    }
    const definedNames: Array<DefinedName> = [];
    for (const element of childElements(findChild(root.inner, "definedNames")?.inner ?? "")) {
      definedNames.push({
        attributes: parseAttributes(element.attributes),
        text: unescapeXml(element.inner ?? ""),
      });
    }
    const workbookProperties = findChild(root.inner, "workbookPr");
    const date1904 = /^(1|true)$/.test(
      parseAttributes(workbookProperties?.attributes ?? "").get("date1904") ?? "",
    );
    const partOfType = (suffix: string) =>
      relationships.find((relationship) => relationship.type.endsWith(suffix))?.path ?? null;
    return new XlsxWorkbook({
      zip,
      limits,
      workbookPath,
      workbookXml,
      relationshipPrefix: prefix,
      sheets,
      definedNames,
      sharedStringsPath: partOfType("/sharedStrings"),
      stylesPath: partOfType("/styles"),
      date1904,
      unpackedBytes,
    });
  }

  sheets(): ReadonlyArray<SpreadsheetSheet> {
    return this.worksheets().map((sheet) => ({
      name: sheet.name,
      ...(this.isHidden(sheet) ? { hidden: true } : {}),
    }));
  }

  async readRange(input: {
    readonly sheet: string;
    readonly row: number;
    readonly column: number;
    readonly rowCount: number;
    readonly columnCount: number;
  }) {
    const sheet = this.sheetNamed(input.sheet);
    const contents = await this.load(sheet);
    const strings = await this.strings();
    const styles = await this.loadStyles();
    const cells: Array<SpreadsheetCell> = [];
    const formats: Record<string, SpreadsheetCellFormat> = {};
    const lastRow = input.row + input.rowCount;
    const lastColumn = input.column + input.columnCount;
    for (
      let at = lowerBound(contents.rows, input.row, rowIndex);
      at < contents.rows.length && contents.rows[at]!.index < lastRow;
      at++
    ) {
      const row = contents.rows[at]!;
      for (
        let cellAt = lowerBound(row.cells, input.column, cellColumn);
        cellAt < row.cells.length && row.cells[cellAt]!.column < lastColumn;
        cellAt++
      ) {
        const cell = row.cells[cellAt]!;
        const formula = this.formulaText(contents, row, cell);
        const value = cachedValue(cell, strings);
        const format =
          cell.style === undefined || styles === null ? null : formatOf(styles, cell.style);
        if (formula === null && value === undefined && format === null) continue;
        if (format !== null && cell.style !== undefined) formats[cell.style] = format;
        cells.push({
          row: row.index,
          column: cell.column,
          ...(value === undefined || value === null
            ? {}
            : value instanceof FormulaErrorValue
              ? { value: value.code, error: true }
              : { value }),
          ...(formula === null ? {} : { formula }),
          ...(format === null || cell.style === undefined ? {} : { format: cell.style }),
        });
      }
    }
    return { ...usedSize(contents), cells, formats };
  }

  async apply(operations: ReadonlyArray<SpreadsheetOperation>): Promise<void> {
    for (const sheet of this.worksheets()) await this.load(sheet);
    await this.strings();
    const changed = new Map<Sheet, Array<{ row: number; column: number }>>();
    let everythingChanged = false;
    const applyOne = async (operation: SpreadsheetOperation) => {
      switch (operation.type) {
        case "setCell": {
          const sheet = this.sheetNamed(operation.sheet);
          this.setCell(sheet, operation.row, operation.column, operation.input);
          const list = changed.get(sheet) ?? [];
          list.push({ row: operation.row, column: operation.column });
          changed.set(sheet, list);
          break;
        }
        case "setFormat":
          await this.setFormat(this.sheetNamed(operation.sheet), operation);
          break;
        case "insertRows":
        case "deleteRows":
        case "insertColumns":
        case "deleteColumns":
          await this.resize(
            this.sheetNamed(operation.sheet),
            operation.type.endsWith("Rows") ? "row" : "column",
            operation.index,
            operation.type.startsWith("insert") ? operation.count : -operation.count,
          );
          everythingChanged = true;
          break;
        case "addSheet":
          await this.addSheet(operation.name);
          break;
        case "renameSheet":
          await this.renameSheet(this.sheetNamed(operation.sheet), operation.name);
          break;
        case "deleteSheet":
          await this.deleteSheet(this.sheetNamed(operation.sheet));
          everythingChanged = true;
          break;
      }
    };
    for (const [index, operation] of operations.entries()) {
      try {
        await applyOne(operation);
      } catch (cause) {
        throw atOperation(cause, index);
      }
    }
    if (everythingChanged || changed.size > 0) {
      this.valuesChanged = true;
      this.recalculate(everythingChanged ? null : changed);
    }
  }

  async save(): Promise<Uint8Array> {
    for (const sheet of this.allSheets) {
      if (sheet.contents?.dirty) {
        this.setPart(sheet.path, serializeSheet(sheet.contents));
        sheet.contents.dirty = false;
      }
    }
    if (this.styles?.dirty && this.stylesPath !== null) {
      this.setPart(this.stylesPath, serializeStyles(this.styles));
      this.styles = null;
    }
    if (this.valuesChanged) await this.dropCalculationChain();
    if (this.workbookDirty || this.valuesChanged) {
      this.setPart(this.workbookPath, this.serializeWorkbook());
    }
    this.workbookDirty = false;
    this.valuesChanged = false;
    for (const path of this.removedParts) this.zip.remove(path);
    for (const path of this.changedParts) this.zip.file(path, this.parts.get(path) ?? "");
    this.removedParts.clear();
    this.changedParts.clear();
    // The archive now holds every part, so the copies kept as text are read again when needed.
    this.parts.clear();
    return this.zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  }

  private worksheets() {
    return this.allSheets.filter((sheet) => sheet.worksheet);
  }

  private isHidden(sheet: Sheet) {
    const state = sheet.attributes.get("state");
    return state === "hidden" || state === "veryHidden";
  }

  private sheetNamed(name: string): Sheet {
    const sheet = this.worksheets().find((candidate) => sameName(candidate.name, name));
    if (sheet === undefined) throw invalidOperation("unknown-sheet");
    return sheet;
  }

  private async part(path: string): Promise<string | null> {
    if (this.removedParts.has(path)) return null;
    const held = this.parts.get(path);
    if (held !== undefined) return held;
    const counted = this.countedParts.has(path);
    const text = await readZipText(
      this.zip,
      path,
      counted ? this.limits.maxUnpackedBytes : this.limits.maxUnpackedBytes - this.unpackedBytes,
    );
    if (text === null) return null;
    if (!counted) this.unpackedBytes += text.length;
    this.countedParts.add(path);
    this.parts.set(path, text);
    return text;
  }

  private setPart(path: string, text: string) {
    this.parts.set(path, text);
    this.changedParts.add(path);
    this.removedParts.delete(path);
  }

  private removePart(path: string) {
    this.parts.delete(path);
    this.changedParts.delete(path);
    this.removedParts.add(path);
  }

  private partPaths(pattern: RegExp) {
    return Object.keys(this.zip.files).filter(
      (path) => pattern.test(path) && !this.removedParts.has(path),
    );
  }

  private async strings(): Promise<ReadonlyArray<string>> {
    if (this.sharedStrings !== null) return this.sharedStrings;
    const xml = this.sharedStringsPath === null ? null : await this.part(this.sharedStringsPath);
    const strings: Array<string> = [];
    const root = xml === null ? null : rootElement(xml);
    for (const item of childElements(root?.inner ?? "")) strings.push(richText(item.inner ?? ""));
    // The table is only read, so its text is not held twice.
    if (this.sharedStringsPath !== null) this.parts.delete(this.sharedStringsPath);
    this.sharedStrings = strings;
    return strings;
  }

  private async loadStyles(): Promise<Styles | null> {
    if (this.styles !== null) return this.styles;
    const xml = this.stylesPath === null ? null : await this.part(this.stylesPath);
    const root = xml === null ? null : rootElement(xml);
    if (xml === null || root?.name !== "styleSheet" || root.inner === null) return null;
    const sections: Styles["sections"] = new Map();
    for (const element of childElements(xml, root.innerStart)) {
      if (!["numFmts", "fonts", "fills", "cellXfs"].includes(element.name)) continue;
      const children: Array<string> = [];
      for (const child of childElements(element.inner ?? "")) {
        children.push((element.inner ?? "").slice(child.start, child.end));
      }
      sections.set(element.name, { element, children });
    }
    if (!sections.has("cellXfs") || !sections.has("fonts") || !sections.has("fills")) return null;
    const customNumberFormats = new Map<number, string>();
    for (const child of sections.get("numFmts")?.children ?? []) {
      const attributes = parseAttributes(child);
      customNumberFormats.set(
        Number(attributes.get("numFmtId")),
        attributes.get("formatCode") ?? "",
      );
    }
    this.styles = {
      xml,
      root,
      sections,
      customNumberFormats,
      derived: new Map(),
      formats: new Map(),
      dirty: false,
    };
    return this.styles;
  }

  private async load(sheet: Sheet): Promise<SheetContents> {
    if (sheet.contents !== null) return sheet.contents;
    const xml = await this.part(sheet.path);
    const root = xml === null ? null : rootElement(xml);
    if (xml === null || root?.name !== "worksheet" || root.inner === null) {
      throw unsupported("workbook-layout");
    }
    let sheetData: XmlElement | null = null;
    for (const element of childElements(xml, root.innerStart)) {
      if (element.name === "sheetData") {
        sheetData = element;
        break;
      }
      if (localNameOf(element.name) === "sheetData") throw unsupported("workbook-layout");
    }
    if (sheetData === null) throw unsupported("workbook-layout");
    const rows: Array<Row> = [];
    const shared: SheetContents["shared"] = new Map();
    const arrayAreas: Array<CellArea> = [];
    let sorted = true;
    let nextRow = 0;
    // Added to the workbook's count only once the sheet is held, so a refused sheet costs nothing.
    let cellCount = 0;
    for (const rowElement of childElements(sheetData.inner ?? "")) {
      if (rowElement.name !== "row") throw unsupported("workbook-layout");
      const rowAttributes = parseAttributes(rowElement.attributes);
      const named = Number(rowAttributes.get("r"));
      const index = Number.isInteger(named) && named >= 1 ? named - 1 : nextRow;
      if (index < nextRow) sorted = false;
      nextRow = index + 1;
      rowAttributes.delete("r");
      rowAttributes.delete("spans");
      const cells: Array<Cell> = [];
      let nextColumn = 0;
      for (const cellElement of childElements(rowElement.inner ?? "")) {
        if (cellElement.name !== "c") throw unsupported("workbook-layout");
        const attributes = parseAttributes(cellElement.attributes);
        const column = parseCellName(attributes.get("r") ?? "")?.column ?? nextColumn;
        if (column < nextColumn) sorted = false;
        nextColumn = column + 1;
        const cell: Cell = {
          column,
          style: attributes.get("s"),
          type: attributes.get("t"),
          extra: "",
          inner: cellElement.inner ?? "",
        };
        attributes.delete("r");
        attributes.delete("s");
        attributes.delete("t");
        if (attributes.size > 0) cell.extra = attributeText(attributes);
        cells.push(cell);
        if (cell.inner.includes("<f")) {
          const formula = formulaOf(cell);
          const kind = formula?.attributes.get("t");
          if (formula && kind === "shared" && formula.text !== "") {
            shared.set(formula.attributes.get("si") ?? "", {
              row: index,
              column,
              text: formula.text,
            });
          } else if (formula && (kind === "array" || kind === "dataTable")) {
            const area = parseArea(formula.attributes.get("ref") ?? "");
            if (
              area &&
              (area.top !== area.bottom || area.left !== area.right || kind !== "array")
            ) {
              arrayAreas.push(area);
            }
          }
        }
      }
      cellCount += cells.length;
      if (this.cellCount + cellCount > this.limits.maxCells) throw tooLarge("cell-count");
      rows.push({ index, attributes: attributeText(rowAttributes), cells });
    }
    this.cellCount += cellCount;
    if (!sorted) {
      rows.sort((left, right) => left.index - right.index);
      for (const row of rows) row.cells.sort((left, right) => left.column - right.column);
    }
    sheet.contents = {
      prefix: xml.slice(0, sheetData.start),
      suffix: xml.slice(sheetData.end),
      sheetDataAttributes: sheetData.attributes,
      rows,
      shared,
      arrayAreas,
      dirty: false,
    };
    // The parsed rows replace the text, which is rebuilt from them when the sheet is saved.
    this.parts.delete(sheet.path);
    return sheet.contents;
  }

  private formulaText(contents: SheetContents, row: Row, cell: Cell): string | null {
    const formula = formulaOf(cell);
    if (formula === null) return null;
    if (formula.attributes.get("t") !== "shared" || formula.text !== "") return formula.text;
    const origin = contents.shared.get(formula.attributes.get("si") ?? "");
    if (origin === undefined) return null;
    return mapFormulaReferences(origin.text, (reference) =>
      offsetReference(reference, row.index - origin.row, cell.column - origin.column),
    ).formula;
  }

  /** Gives every cell of a shared formula its own text, so each can be changed on its own. */
  private expandSharedFormulas(contents: SheetContents) {
    if (contents.shared.size === 0) return;
    for (const row of contents.rows) {
      for (const cell of row.cells) {
        const formula = formulaOf(cell);
        if (formula?.attributes.get("t") !== "shared") continue;
        const text = this.formulaText(contents, row, cell);
        cell.inner = cell.inner.replace(FORMULA_PATTERN, () =>
          text === null ? "" : `<f>${escapeXml(text)}</f>`,
        );
      }
    }
    contents.shared.clear();
    contents.dirty = true;
  }

  private cellAt(contents: SheetContents, row: number, column: number, create: true): Cell;
  private cellAt(contents: SheetContents, row: number, column: number, create: false): Cell | null;
  private cellAt(contents: SheetContents, row: number, column: number, create: boolean) {
    const rowAt = lowerBound(contents.rows, row, rowIndex);
    let found = contents.rows[rowAt];
    if (found?.index !== row) {
      if (!create) return null;
      found = { index: row, attributes: "", cells: [] };
      contents.rows.splice(rowAt, 0, found);
    }
    const cellIndex = lowerBound(found.cells, column, cellColumn);
    const cell = found.cells[cellIndex];
    if (cell?.column === column) return cell;
    if (!create) return null;
    const made: Cell = {
      column,
      style: inheritedStyle(contents, found, column),
      type: undefined,
      extra: "",
      inner: "",
    };
    found.cells.splice(cellIndex, 0, made);
    this.cellCount += 1;
    if (this.cellCount > this.limits.maxCells) throw tooLarge("cell-count");
    return made;
  }

  private setCell(sheet: Sheet, row: number, column: number, input: SpreadsheetCellInput) {
    const contents = sheet.contents!;
    if (row >= MAX_ROWS || column >= MAX_COLUMNS) throw invalidOperation("out-of-bounds");
    if (
      contents.arrayAreas.some(
        (area) =>
          row >= area.top && row <= area.bottom && column >= area.left && column <= area.right,
      )
    ) {
      throw unsupported("array-formula");
    }
    this.expandSharedFormulas(contents);
    const formula = input.kind === "formula" ? input.formula.replace(/^=/, "") : "";
    // A spreadsheet app treats a formula it cannot read as damage and removes it.
    if (!formulaIsComplete(formula)) throw invalidOperation("formula-invalid");
    const blank =
      input.kind === "blank" ||
      (input.kind === "text" && input.text === "") ||
      (input.kind === "formula" && formula === "");
    const cell = blank
      ? this.cellAt(contents, row, column, false)
      : this.cellAt(contents, row, column, true);
    if (cell === null) return;
    contents.dirty = true;
    cell.type = undefined;
    // Cell and value metadata describe the contents being replaced.
    cell.extra = "";
    if (blank) {
      cell.inner = "";
      if (cell.style === undefined && cell.extra === "") {
        const held = contents.rows[lowerBound(contents.rows, row, rowIndex)]!;
        held.cells.splice(held.cells.indexOf(cell), 1);
        this.cellCount -= 1;
      }
    } else if (input.kind === "number") cell.inner = `<v>${input.number}</v>`;
    else if (input.kind === "boolean") {
      cell.type = "b";
      cell.inner = `<v>${input.boolean ? 1 : 0}</v>`;
    } else if (input.kind === "text") {
      cell.type = "inlineStr";
      cell.inner = `<is><t xml:space="preserve">${escapeXml(input.text)}</t></is>`;
    } else cell.inner = `<f>${escapeXml(formula)}</f>`;
  }

  private async setFormat(
    sheet: Sheet,
    operation: Extract<SpreadsheetOperation, { type: "setFormat" }>,
  ) {
    const contents = sheet.contents!;
    if (
      operation.row + operation.rowCount > MAX_ROWS ||
      operation.column + operation.columnCount > MAX_COLUMNS
    ) {
      throw invalidOperation("out-of-bounds");
    }
    if (operation.rowCount * operation.columnCount > this.limits.maxFormatCells) {
      throw tooLarge("range-size");
    }
    const { fill } = operation.format;
    if (typeof fill === "string" && !/^[0-9A-Fa-f]{6}$/.test(fill)) {
      throw invalidOperation("format-invalid");
    }
    const styles = await this.loadStyles();
    if (styles === null) throw unsupported("workbook-layout");
    for (let row = operation.row; row < operation.row + operation.rowCount; row++) {
      for (
        let column = operation.column;
        column < operation.column + operation.columnCount;
        column++
      ) {
        const cell = this.cellAt(contents, row, column, true);
        cell.style = styleWith(styles, cell.style, operation.format);
      }
    }
    contents.dirty = true;
  }

  /** Refuses a sheet that owns other parts, such as drawings, tables, comments or pivot tables. */
  private async assertNoSheetObjects(sheet: Sheet) {
    const relations = await this.part(relationshipsPath(sheet.path));
    for (const element of childElements(rootElement(relations ?? "")?.inner ?? "")) {
      const type = parseAttributes(element.attributes).get("Type") ?? "";
      if (!type.endsWith("/printerSettings") && !type.endsWith("/hyperlink")) {
        throw unsupported("sheet-objects");
      }
    }
  }

  private async assertNoPivotSource(sheet: Sheet) {
    const marker = `sheet="${escapeAttribute(sheet.name)}"`;
    for (const path of this.partPaths(/pivotCacheDefinition[^/]*\.xml$/)) {
      if ((await this.part(path))?.includes(marker)) throw unsupported("pivot-tables");
    }
  }

  private async resize(sheet: Sheet, axis: Axis, index: number, count: number) {
    const contents = sheet.contents!;
    if (contents.arrayAreas.length > 0) throw unsupported("array-formula");
    if (
      POSITIONED_SHEET_PARTS.test(contents.prefix) ||
      POSITIONED_SHEET_PARTS.test(contents.suffix)
    ) {
      throw unsupported("sheet-objects");
    }
    await this.assertNoSheetObjects(sheet);
    await this.assertNoPivotSource(sheet);
    const limit = axis === "row" ? MAX_ROWS : MAX_COLUMNS;
    const size = usedSize(contents);
    const used = axis === "row" ? size.rowCount : size.columnCount;
    if (index >= limit || (count > 0 && Math.max(used, index) + count > limit)) {
      throw invalidOperation("out-of-bounds");
    }
    // A copied formula in another sheet follows its origin, which would move without it.
    for (const other of this.worksheets()) {
      const held = other.contents!;
      if (
        other === sheet ||
        [...held.shared.values()].some((origin) => namesSheet(origin.text, sheet.name))
      ) {
        this.expandSharedFormulas(held);
      }
    }
    const removedEnd = index - count;
    const moved = (position: number) =>
      count > 0
        ? position >= index
          ? position + count
          : position
        : position >= removedEnd
          ? position + count
          : position >= index
            ? -1
            : position;
    if (axis === "row") {
      contents.rows = contents.rows.filter((row) => {
        row.index = moved(row.index);
        return row.index >= 0;
      });
    } else {
      for (const row of contents.rows) {
        row.cells = row.cells.filter((cell) => {
          cell.column = moved(cell.column);
          return cell.column >= 0;
        });
      }
    }
    contents.dirty = true;
    const shift = (reference: Pick<FormulaReference, "start" | "end">) =>
      shiftReference(reference, axis, index + 1, count);
    await this.rewriteReferences(sheet, "resize", shift);
    contents.suffix = shiftAreaList(contents.suffix, "mergeCells", "mergeCell", shift);
    if (axis === "column") contents.prefix = shiftColumnWidths(contents.prefix, index + 1, count);
  }

  /**
   * Rewrites every reference to one sheet: in cells, in the rules other sheets hold, in defined
   * names and in chart series. Refuses when a formula names the sheet in a way that cannot be
   * followed and the change would leave it wrong.
   */
  private async rewriteReferences(
    changed: Sheet,
    change: "resize" | "rename" | "delete",
    rewrite: (reference: FormulaReference) => ReferenceRewrite,
  ) {
    const sheetName = changed.name;
    const position = this.allSheets.indexOf(changed);
    const positionOf = (name: string) =>
      this.allSheets.findIndex((sheet) => sameName(sheet.name, name));
    const breaks = ({ sheet, through }: UnfollowedSheet) => {
      // A name such as `Data!Rate` keeps its meaning when cells move, since the name is rewritten.
      if (through === null) return change !== "resize" && sameName(sheet, sheetName);
      if (change === "rename") return sameName(sheet, sheetName) || sameName(through, sheetName);
      const [from, to] = [positionOf(sheet), positionOf(through)];
      return (
        from !== -1 && to !== -1 && position >= Math.min(from, to) && position <= Math.max(from, to)
      );
    };
    const mapper = (own: string | null) => {
      const map = (reference: FormulaReference) => {
        const target = reference.sheet ?? own;
        return target !== null && sameName(target, sheetName) ? rewrite(reference) : null;
      };
      return (text: string) => {
        const mapped = mapFormulaReferences(text, map);
        if (mapped.unfollowed.some(breaks)) throw unsupported("sheet-references");
        return mapped.formula;
      };
    };
    for (const sheet of this.worksheets()) {
      const contents = sheet.contents!;
      const map = mapper(sheet.name);
      const mapXml = (_: string, open: string, _name: string, text: string, close: string) =>
        `${open}${escapeXml(map(unescapeXml(text)))}${close}`;
      const mapLocation = (_: string, open: string, text: string, close: string) =>
        `${open}${escapeAttribute(map(unescapeXml(text)))}${close}`;
      for (const part of ["prefix", "suffix"] as const) {
        const next = contents[part]
          .replace(RULE_FORMULA_PATTERN, mapXml)
          .replace(HYPERLINK_LOCATION_PATTERN, mapLocation);
        if (next === contents[part]) continue;
        contents[part] = next;
        contents.dirty = true;
      }
      for (const row of contents.rows) {
        for (const cell of row.cells) {
          const formula = formulaOf(cell);
          if (formula === null || formula.text === "") continue;
          const next = map(formula.text);
          if (next === formula.text) continue;
          cell.inner = cell.inner.replace(
            FORMULA_PATTERN,
            () => `<f${attributeText(formula.attributes)}>${escapeXml(next)}</f>`,
          );
          contents.dirty = true;
        }
      }
    }
    const foreign = mapper(null);
    for (const name of this.definedNames) {
      const next = foreign(name.text);
      if (next !== name.text) {
        name.text = next;
        this.workbookDirty = true;
      }
    }
    for (const path of this.partPaths(/^xl\/charts\/[^/]+\.xml$/)) {
      const xml = await this.part(path);
      if (xml === null) continue;
      const next = xml.replace(
        /(<(?:\w+:)?f>)([^<]*)(<\/(?:\w+:)?f>)/g,
        (_, open: string, text: string, close: string) =>
          `${open}${escapeXml(foreign(unescapeXml(text)))}${close}`,
      );
      if (next !== xml) this.setPart(path, next);
    }
  }

  private assertNewName(name: string) {
    if (!validSheetName(name)) throw invalidOperation("sheet-name-invalid");
    if (this.allSheets.some((sheet) => sameName(sheet.name, name))) {
      throw invalidOperation("sheet-name-taken");
    }
  }

  private async addSheet(name: string) {
    this.assertNewName(name);
    const folder = `${this.workbookPath.slice(0, this.workbookPath.lastIndexOf("/") + 1)}worksheets/`;
    let number = this.allSheets.length + 1;
    const taken = (path: string) =>
      this.zip.file(path) !== null ||
      this.parts.has(path) ||
      // A sheet added earlier in the same edit is in neither until it is saved.
      this.allSheets.some((sheet) => sheet.path === path);
    while (taken(`${folder}sheet${number}.xml`)) number += 1;
    const path = `${folder}sheet${number}.xml`;
    const relationsPath = relationshipsPath(this.workbookPath);
    const relations = (await this.part(relationsPath)) ?? "";
    const contentTypes = await this.part("[Content_Types].xml");
    if (contentTypes === null || !relations.includes("</Relationships>")) {
      throw unsupported("workbook-layout");
    }
    let idNumber = 1;
    while (relations.includes(`Id="rId${idNumber}"`)) idNumber += 1;
    const relationshipId = `rId${idNumber}`;
    this.setPart(
      relationsPath,
      relations.replace(
        "</Relationships>",
        `<Relationship Id="${relationshipId}" Type="${WORKSHEET_RELATIONSHIP}" Target="worksheets/sheet${number}.xml"/></Relationships>`,
      ),
    );
    this.setPart(
      "[Content_Types].xml",
      contentTypes.replace(
        "</Types>",
        `<Override PartName="/${path}" ContentType="${WORKSHEET_CONTENT_TYPE}"/></Types>`,
      ),
    );
    this.allSheets.push({
      name,
      sheetId: Math.max(0, ...this.allSheets.map((sheet) => sheet.sheetId)) + 1,
      relationshipId,
      path,
      attributes: new Map(),
      worksheet: true,
      contents: {
        prefix: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${MAIN_NAMESPACE}">`,
        suffix: "</worksheet>",
        sheetDataAttributes: "",
        rows: [],
        shared: new Map(),
        arrayAreas: [],
        dirty: true,
      },
    });
    this.workbookDirty = true;
  }

  private async renameSheet(sheet: Sheet, name: string) {
    if (name === sheet.name) return;
    if (!validSheetName(name)) throw invalidOperation("sheet-name-invalid");
    if (this.allSheets.some((other) => other !== sheet && sameName(other.name, name))) {
      throw invalidOperation("sheet-name-taken");
    }
    await this.assertNoPivotSource(sheet);
    for (const other of this.worksheets()) {
      const held = other.contents!;
      if ([...held.shared.values()].some((origin) => namesSheet(origin.text, sheet.name))) {
        this.expandSharedFormulas(held);
      }
    }
    await this.rewriteReferences(sheet, "rename", (reference) =>
      // A reference without a sheet stays one: it is in the renamed sheet itself.
      reference.sheet === null ? null : { start: reference.start, end: reference.end, sheet: name },
    );
    sheet.name = name;
    this.workbookDirty = true;
  }

  private async deleteSheet(sheet: Sheet) {
    if (!this.worksheets().some((other) => other !== sheet && !this.isHidden(other))) {
      throw unsupported("last-sheet");
    }
    await this.assertNoSheetObjects(sheet);
    await this.assertNoPivotSource(sheet);
    if (this.zip.file(relationshipsPath(sheet.path)) !== null) {
      this.removePart(relationshipsPath(sheet.path));
    }
    for (const other of this.worksheets()) this.expandSharedFormulas(other.contents!);
    const position = this.allSheets.indexOf(sheet);
    await this.rewriteReferences(sheet, "delete", (reference) =>
      reference.sheet === null ? null : REFERENCE_ERROR,
    );
    const relationsPath = relationshipsPath(this.workbookPath);
    const relations = (await this.part(relationsPath)) ?? "";
    const contentTypes = (await this.part("[Content_Types].xml")) ?? "";
    this.setPart(
      relationsPath,
      removeElements(relations, (attributes) => attributes.get("Id") === sheet.relationshipId),
    );
    this.setPart(
      "[Content_Types].xml",
      removeElements(contentTypes, (attributes) => attributes.get("PartName") === `/${sheet.path}`),
    );
    this.removePart(sheet.path);
    this.allSheets.splice(position, 1);
    for (let index = this.definedNames.length - 1; index >= 0; index--) {
      const scope = this.definedNames[index]!.attributes.get("localSheetId");
      if (scope === undefined) continue;
      if (Number(scope) === position) this.definedNames.splice(index, 1);
      else if (Number(scope) > position) {
        this.definedNames[index]!.attributes.set("localSheetId", String(Number(scope) - 1));
      }
    }
    this.workbookXml = this.workbookXml.replace(
      /(<workbookView\b[^>]*\bactiveTab=")(\d+)(")/g,
      (_, before: string, tab: string, after: string) =>
        `${before}${Math.min(Number(tab) > position ? Number(tab) - 1 : Number(tab), this.allSheets.length - 1)}${after}`,
    );
    this.workbookDirty = true;
  }

  /**
   * Brings formula results up to date after an edit. A formula the edit reaches, directly or
   * through other formulas, is calculated again, or loses its stored result when this code cannot
   * calculate it; the others keep theirs. Nothing recurses per formula: a long chain costs steps.
   */
  private recalculate(changed: Map<Sheet, Array<{ row: number; column: number }>> | null) {
    const strings = this.sharedStrings ?? [];
    const sheets = this.worksheets();
    const sheetsByName = new Map(sheets.map((sheet) => [sheet.name.toLowerCase(), sheet]));
    const sheetFor = (name: string | null, own: Sheet) =>
      name === null ? own : sheetsByName.get(name.toLowerCase());
    const numberOf = new Map(sheets.map((sheet, index) => [sheet, index]));
    const areaOf = (reference: FormulaReference): CellArea => {
      const end = reference.end ?? reference.start;
      return {
        top: Math.min(reference.start.row ?? 1, end.row ?? 1) - 1,
        bottom: Math.max(reference.start.row ?? MAX_ROWS, end.row ?? MAX_ROWS) - 1,
        left: Math.min(reference.start.column ?? 1, end.column ?? 1) - 1,
        right: Math.max(reference.start.column ?? MAX_COLUMNS, end.column ?? MAX_COLUMNS) - 1,
      };
    };
    let budget = this.limits.maxRecalculationSteps;
    const spend = () => {
      budget -= 1;
      if (budget < 0) throw new RecalculationTooLarge();
    };

    const entries: Array<Entry> = [];
    const entryOf = new Map<Cell, Entry>();
    for (const sheet of sheets) {
      for (const row of sheet.contents!.rows) {
        for (const cell of row.cells) {
          if (!cell.inner.includes("<f")) continue;
          const text = this.formulaText(sheet.contents!, row, cell);
          if (text === null) continue;
          const entry = { sheet, row, cell, text, stale: changed === null };
          entries.push(entry);
          entryOf.set(cell, entry);
        }
      }
    }

    if (changed !== null) {
      // Staleness spreads forwards from the edited cells to the formulas that read them.
      const cellReaders = new Map<Sheet, Map<number, Array<Entry>>>();
      const areaReaders = new Map<Sheet, Map<string, { area: CellArea; readers: Array<Entry> }>>();
      const queue: Array<{ sheet: Sheet; row: number; column: number }> = [];
      const mark = (entry: Entry) => {
        if (entry.stale) return;
        entry.stale = true;
        queue.push({ sheet: entry.sheet, row: entry.row.index, column: entry.cell.column });
      };
      const listed = <K, V>(map: Map<K, V>, key: K, make: () => V) => {
        let value = map.get(key);
        if (value === undefined) map.set(key, (value = make()));
        return value;
      };
      for (const entry of entries) {
        const { references, opaque } = formulaReferences(entry.text);
        if (opaque || VOLATILE_REFERENCE_PATTERN.test(entry.text)) {
          mark(entry);
          continue;
        }
        for (const reference of references) {
          const target = sheetFor(reference.sheet, entry.sheet);
          if (target === undefined) {
            mark(entry);
            break;
          }
          const area = areaOf(reference);
          if (area.top === area.bottom && area.left === area.right) {
            const byCell = listed(cellReaders, target, () => new Map<number, Array<Entry>>());
            listed(byCell, area.top * MAX_COLUMNS + area.left, () => []).push(entry);
          } else {
            const byArea = listed(areaReaders, target, () => new Map());
            const key = `${area.top}:${area.bottom}:${area.left}:${area.right}`;
            listed(byArea, key, () => ({ area, readers: [] as Array<Entry> })).readers.push(entry);
          }
        }
      }
      for (const [sheet, edits] of changed) {
        for (const edit of edits) {
          queue.push({ sheet, row: edit.row, column: edit.column });
          const cell = this.cellAt(sheet.contents!, edit.row, edit.column, false);
          const entry = cell === null ? undefined : entryOf.get(cell);
          if (entry !== undefined) mark(entry);
        }
      }
      const watched = new Map<Sheet, Array<{ area: CellArea; readers: Array<Entry> }>>();
      for (const [sheet, byArea] of areaReaders) watched.set(sheet, [...byArea.values()]);
      try {
        for (let from = 0; from < queue.length;) {
          // Changed cells, as sorted rows by column, for one pass over the watched areas.
          const batch = new Map<Sheet, Map<number, Array<number>>>();
          for (; from < queue.length; from++) {
            const point = queue[from]!;
            const readers = cellReaders
              .get(point.sheet)
              ?.get(point.row * MAX_COLUMNS + point.column);
            for (const reader of readers ?? []) mark(reader);
            if (!watched.has(point.sheet)) continue;
            const columns = listed(batch, point.sheet, () => new Map<number, Array<number>>());
            listed(columns, point.column, () => []).push(point.row);
          }
          for (const [sheet, columns] of batch) {
            for (const rows of columns.values()) rows.sort((left, right) => left - right);
            const areas = watched.get(sheet)!;
            for (let index = areas.length - 1; index >= 0; index--) {
              const { area, readers } = areas[index]!;
              let reached = false;
              for (const [column, rows] of columns) {
                spend();
                if (column < area.left || column > area.right) continue;
                const row = rows[lowerBound(rows, area.top, (value) => value)];
                if (row !== undefined && row <= area.bottom) {
                  reached = true;
                  break;
                }
              }
              if (!reached) continue;
              for (const reader of readers) mark(reader);
              areas[index] = areas.at(-1)!;
              areas.pop();
            }
          }
        }
      } catch (cause) {
        if (!(cause instanceof RecalculationTooLarge)) throw cause;
        // What the edit reaches is unknown, so every result is worked out again or dropped.
        for (const entry of entries) entry.stale = true;
      }
    }

    const cellsIn = function* (sheet: Sheet, area: CellArea) {
      const contents = sheet.contents!;
      for (
        let at = lowerBound(contents.rows, area.top, rowIndex);
        at < contents.rows.length && contents.rows[at]!.index <= area.bottom;
        at++
      ) {
        const row = contents.rows[at]!;
        for (
          let cellAt = lowerBound(row.cells, area.left, cellColumn);
          cellAt < row.cells.length && row.cells[cellAt]!.column <= area.right;
          cellAt++
        ) {
          yield row.cells[cellAt]!;
        }
      }
    };

    // Undefined marks a formula that cannot be calculated here.
    const computed = new Map<Cell, FormulaValue | undefined>();
    const waiting = new Set<Entry>();
    const areaValues = new Map<string, ReadonlyArray<FormulaValue>>();
    /** A cell's value, or null after adding the formula that has to be calculated first. */
    const valueOf = (cell: Cell, needed: Array<Entry>): FormulaValue => {
      const entry = entryOf.get(cell);
      if (entry === undefined) return cachedValue(cell, strings) ?? null;
      if (!entry.stale) {
        const held = cachedValue(cell, strings);
        if (held !== undefined) return held;
      }
      if (computed.has(cell)) {
        const value = computed.get(cell);
        if (value === undefined) throw new FormulaNotCalculated();
        return value;
      }
      // A formula that reads itself, directly or through others, has no result here.
      if (waiting.has(entry)) throw new FormulaNotCalculated();
      needed.push(entry);
      return null;
    };
    const evaluate = (entry: Entry) =>
      evaluateFormula(entry.text, {
        values: (reference) => {
          const target = sheetFor(reference.sheet, entry.sheet);
          if (target === undefined) return [new FormulaErrorValue(REFERENCE_ERROR)];
          const area = areaOf(reference);
          const key = `${numberOf.get(target)}:${area.top}:${area.bottom}:${area.left}:${area.right}`;
          const known = areaValues.get(key);
          if (known !== undefined) return known;
          const values: Array<FormulaValue> = [];
          const needed: Array<Entry> = [];
          for (const cell of cellsIn(target, area)) {
            spend();
            const value = valueOf(cell, needed);
            if (value !== null) values.push(value);
          }
          if (needed.length > 0) throw new FormulasNeeded(needed);
          // Many formulas read the same area, such as one total; its values are gathered once.
          if (reference.end !== null) areaValues.set(key, values);
          return values;
        },
      });
    /** Calculates a formula after the formulas it reads, which wait on a list, not the stack. */
    const calculate = (root: Entry) => {
      const pending = [root];
      waiting.add(root);
      while (pending.length > 0) {
        const entry = pending.at(-1)!;
        try {
          computed.set(entry.cell, evaluate(entry));
        } catch (cause) {
          if (cause instanceof FormulasNeeded) {
            for (const needed of cause.entries) {
              if (waiting.has(needed) || computed.has(needed.cell)) continue;
              waiting.add(needed);
              pending.push(needed);
            }
            if (pending.at(-1) !== entry) continue;
          }
          // A formula nested too deeply to parse overflows the stack; it is left uncalculated.
          if (
            !(cause instanceof FormulaNotCalculated) &&
            !(cause instanceof FormulasNeeded) &&
            !(cause instanceof RangeError)
          ) {
            throw cause;
          }
          computed.set(entry.cell, undefined);
        }
        pending.pop();
        waiting.delete(entry);
      }
    };

    const store = (contents: SheetContents, cell: Cell, value: FormulaValue | undefined) => {
      const formula = FORMULA_PATTERN.exec(cell.inner)?.[0] ?? "";
      let type: string | undefined;
      let inner = formula;
      if (value instanceof FormulaErrorValue) {
        type = "e";
        inner += `<v>${escapeXml(value.code)}</v>`;
      } else if (typeof value === "string") {
        type = "str";
        inner += `<v>${escapeXml(value)}</v>`;
      } else if (typeof value === "boolean") {
        type = "b";
        inner += `<v>${value ? 1 : 0}</v>`;
      } else if (typeof value === "number") inner += `<v>${value}</v>`;
      if (cell.inner === inner && cell.type === type) return;
      cell.inner = inner;
      cell.type = type;
      contents.dirty = true;
    };

    budget = this.limits.maxRecalculationSteps;
    let exhausted = false;
    for (const entry of entries) {
      if (!entry.stale) continue;
      if (!exhausted && !computed.has(entry.cell)) {
        try {
          calculate(entry);
        } catch (cause) {
          if (!(cause instanceof RecalculationTooLarge)) throw cause;
          // The stale results not worked out by now are dropped; the others are kept.
          exhausted = true;
        }
      }
      store(entry.sheet.contents!, entry.cell, computed.get(entry.cell));
    }
  }

  private async dropCalculationChain() {
    const relationsPath = relationshipsPath(this.workbookPath);
    const relations = await this.part(relationsPath);
    const chain = readRelationships(relations ?? "", this.workbookPath).find((relationship) =>
      relationship.type.endsWith("/calcChain"),
    );
    if (relations === null || chain === undefined) return;
    const contentTypes = (await this.part("[Content_Types].xml")) ?? "";
    this.setPart(
      relationsPath,
      removeElements(relations, (attributes) => attributes.get("Id") === chain.id),
    );
    this.setPart(
      "[Content_Types].xml",
      removeElements(contentTypes, (attributes) => attributes.get("PartName") === `/${chain.path}`),
    );
    this.removePart(chain.path);
  }

  private serializeWorkbook(): string {
    let xml = this.workbookXml;
    const replaceChild = (name: string, text: string, after: ReadonlyArray<string>) => {
      const root = rootElement(xml)!;
      let existing: XmlElement | null = null;
      let insertAt = root.innerStart;
      for (const element of childElements(xml, root.innerStart)) {
        if (element.name === name) existing = element;
        if (after.includes(element.name)) insertAt = element.end;
      }
      xml =
        existing === null
          ? xml.slice(0, insertAt) + text + xml.slice(insertAt)
          : xml.slice(0, existing.start) + text + xml.slice(existing.end);
    };
    const prefix = this.relationshipPrefix;
    replaceChild(
      "sheets",
      `<sheets>${this.allSheets
        .map(
          (sheet) =>
            `<sheet name="${escapeAttribute(sheet.name)}" sheetId="${sheet.sheetId}"${attributeText(sheet.attributes)} ${prefix}:id="${escapeAttribute(sheet.relationshipId)}"/>`,
        )
        .join("")}</sheets>`,
      [],
    );
    const before = ["sheets", "functionGroups", "externalReferences"];
    replaceChild(
      "definedNames",
      this.definedNames.length === 0
        ? ""
        : `<definedNames>${this.definedNames
            .map(
              (name) =>
                `<definedName${attributeText(name.attributes)}>${escapeXml(name.text)}</definedName>`,
            )
            .join("")}</definedNames>`,
      before,
    );
    if (this.valuesChanged) {
      const root = rootElement(xml)!;
      const calculation = findChild(root.inner ?? "", "calcPr");
      const attributes = parseAttributes(calculation?.attributes ?? "");
      // Makes a spreadsheet app work every formula out on opening, whatever results are stored.
      attributes.set("fullCalcOnLoad", "1");
      replaceChild("calcPr", `<calcPr${attributeText(attributes)}/>`, [...before, "definedNames"]);
    }
    this.workbookXml = xml;
    return xml;
  }
}

// @effect-diagnostics-next-line extendsNativeError:off - a local sentinel that never leaves `recalculate`.
class RecalculationTooLarge extends Error {}

/** A formula cell during a recalculation. */
interface Entry {
  readonly sheet: Sheet;
  readonly row: Row;
  readonly cell: Cell;
  readonly text: string;
  /** True when an edit reaches the formula, so its stored result can no longer be trusted. */
  stale: boolean;
}

/** Formulas whose results another formula is waiting for. Never leaves `recalculate`. */
class FormulasNeeded {
  readonly entries: ReadonlyArray<Entry>;
  constructor(entries: ReadonlyArray<Entry>) {
    this.entries = entries;
  }
}

async function readZipText(zip: JSZip, path: string, budget: number): Promise<string | null> {
  const file = zip.file(path);
  if (file === null) return null;
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    const stream = file.nodeStream();
    stream
      .on("data", (chunk: Uint8Array) => {
        size += chunk.length;
        // Stops inflating at the limit, whatever size the archive claims for the part.
        if (size > budget) {
          stream.pause();
          reject(tooLarge("unpacked-size"));
        } else chunks.push(chunk);
      })
      .on("error", () => reject(unsupported("not-a-workbook")))
      .on("end", () => resolve());
  });
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}

function readRelationships(xml: string, sourcePath: string) {
  const relationships: Array<{ id: string; type: string; path: string }> = [];
  for (const element of childElements(rootElement(xml)?.inner ?? "")) {
    const attributes = parseAttributes(element.attributes);
    if (attributes.get("TargetMode") === "External") continue;
    relationships.push({
      id: attributes.get("Id") ?? "",
      type: attributes.get("Type") ?? "",
      path: resolveTarget(sourcePath, attributes.get("Target") ?? ""),
    });
  }
  return relationships;
}

/** Drops the root's children whose attributes match. */
function removeElements(xml: string, matches: (attributes: Map<string, string>) => boolean) {
  const root = rootElement(xml);
  if (root === null) return xml;
  let output = xml;
  const doomed = [...childElements(xml, root.innerStart)].filter((element) =>
    matches(parseAttributes(element.attributes)),
  );
  for (const element of doomed.toReversed()) {
    output = output.slice(0, element.start) + output.slice(element.end);
  }
  return output;
}

function cachedValue(cell: Cell, strings: ReadonlyArray<string>): FormulaValue | undefined {
  if (cell.type === "inlineStr") return richText(cell.inner);
  const match = VALUE_PATTERN.exec(cell.inner);
  const raw = match?.[1];
  if (raw === undefined || raw === "") return undefined;
  switch (cell.type) {
    case "s":
      return strings[Number(raw)] ?? "";
    case "str":
    case "d":
      return unescapeXml(raw);
    case "b":
      return raw === "1";
    case "e":
      return new FormulaErrorValue(unescapeXml(raw));
    default: {
      const number = Number(raw);
      return Number.isFinite(number) ? number : undefined;
    }
  }
}

function usedSize(contents: SheetContents) {
  let rowCount = 0;
  let columnCount = 0;
  for (const row of contents.rows) {
    const last = row.cells.at(-1);
    if (last === undefined) continue;
    rowCount = row.index + 1;
    columnCount = Math.max(columnCount, last.column + 1);
  }
  return { rowCount, columnCount };
}

function serializeSheet(contents: SheetContents): string {
  const size = usedSize(contents);
  const dimension = areaName({
    top: 0,
    left: 0,
    bottom: Math.max(0, size.rowCount - 1),
    right: Math.max(0, size.columnCount - 1),
  });
  const pieces: Array<string> = [
    contents.prefix.replace(/<dimension\b[^>]*\/>/, `<dimension ref="${dimension}"/>`),
    `<sheetData${contents.sheetDataAttributes}>`,
  ];
  for (const row of contents.rows) {
    if (row.cells.length === 0 && row.attributes === "") continue;
    pieces.push(`<row r="${row.index + 1}"${row.attributes}>`);
    for (const cell of row.cells) {
      pieces.push(
        `<c r="${cellName(row.index, cell.column)}"${cell.style === undefined ? "" : ` s="${cell.style}"`}${
          cell.type === undefined ? "" : ` t="${cell.type}"`
        }${cell.extra}${cell.inner === "" ? "/>" : `>${cell.inner}</c>`}`,
      );
    }
    pieces.push("</row>");
  }
  pieces.push("</sheetData>", contents.suffix);
  return pieces.join("");
}

type Shift = (reference: Pick<FormulaReference, "start" | "end">) => ReferenceRewrite;

/** Moves the areas an element lists, such as merged cells, and drops the ones that were deleted. */
function shiftAreaList(xml: string, container: string, item: string, shift: Shift): string {
  const start = xml.indexOf(`<${container}`);
  if (start === -1) return xml;
  const element = childElements(xml, start).next().value;
  if (element?.name !== container) return xml;
  const items: Array<string> = [];
  for (const child of childElements(element.inner ?? "")) {
    const attributes = parseAttributes(child.attributes);
    const area = parseArea(attributes.get("ref") ?? "");
    if (child.name !== item || area === null) continue;
    const moved = shift({
      start: { row: area.top + 1, column: area.left + 1, rowFixed: false, columnFixed: false },
      end: { row: area.bottom + 1, column: area.right + 1, rowFixed: false, columnFixed: false },
    });
    if (moved === REFERENCE_ERROR) continue;
    if (moved !== null && moved.end !== null) {
      const next = {
        top: moved.start.row! - 1,
        left: moved.start.column! - 1,
        bottom: moved.end.row! - 1,
        right: moved.end.column! - 1,
      };
      // A merge that shrank to one cell is no merge.
      if (next.top === next.bottom && next.left === next.right) continue;
      attributes.set("ref", areaName(next));
    }
    items.push(`<${item}${attributeText(attributes)}/>`);
  }
  const rebuilt =
    items.length === 0
      ? ""
      : `<${container} count="${items.length}">${items.join("")}</${container}>`;
  return xml.slice(0, element.start) + rebuilt + xml.slice(element.end);
}

/** Moves the column width records with their columns, `count` of them from the one-based `at`. */
function shiftColumnWidths(xml: string, at: number, count: number): string {
  const start = xml.indexOf("<cols");
  if (start === -1) return xml;
  const element = childElements(xml, start).next().value;
  if (element?.name !== "cols") return xml;
  const items: Array<string> = [];
  for (const child of childElements(element.inner ?? "")) {
    const attributes = parseAttributes(child.attributes);
    let min = Number(attributes.get("min"));
    let max = Number(attributes.get("max"));
    if (count > 0) {
      if (min >= at) min += count;
      // A record that runs to the last column still does: only what is pushed past it is lost.
      if (max >= at) max = Math.min(MAX_COLUMNS, max + count);
    } else {
      const end = at - count - 1;
      min = min > end ? min + count : Math.min(min, at);
      max = max > end ? max + count : Math.min(max, at - 1);
    }
    if (min > max) continue;
    attributes.set("min", String(min));
    attributes.set("max", String(max));
    items.push(`<col${attributeText(attributes)}/>`);
  }
  const rebuilt = items.length === 0 ? "" : `<cols>${items.join("")}</cols>`;
  return xml.slice(0, element.start) + rebuilt + xml.slice(element.end);
}

/** The style a new cell starts with: its row's when the row has one, or else its column's. */
function inheritedStyle(contents: SheetContents, row: Row, column: number): string | undefined {
  if (row.attributes.includes("customFormat")) {
    const attributes = parseAttributes(row.attributes);
    const style = attributes.get("s");
    if (style !== undefined && /^(1|true)$/.test(attributes.get("customFormat") ?? "")) {
      return style;
    }
  }
  if (contents.columnStyles?.prefix !== contents.prefix) {
    const records: Array<{ min: number; max: number; style: string }> = [];
    const start = contents.prefix.indexOf("<cols");
    const element = start === -1 ? undefined : childElements(contents.prefix, start).next().value;
    for (const child of childElements(element?.name === "cols" ? (element.inner ?? "") : "")) {
      const attributes = parseAttributes(child.attributes);
      const style = attributes.get("style");
      if (style !== undefined) {
        records.push({
          min: Number(attributes.get("min")),
          max: Number(attributes.get("max")),
          style,
        });
      }
    }
    contents.columnStyles = { prefix: contents.prefix, records };
  }
  return contents.columnStyles.records.find(
    (record) => column + 1 >= record.min && column + 1 <= record.max,
  )?.style;
}

/** Whether a formula reads the sheet, or reads something that cannot be followed and so might. */
function namesSheet(formula: string, name: string): boolean {
  const { references, opaque } = formulaReferences(formula);
  return (
    opaque ||
    references.some((reference) => reference.sheet !== null && sameName(reference.sheet, name))
  );
}

function formatOf(styles: Styles, style: string): SpreadsheetCellFormat | null {
  const known = styles.formats.get(style);
  if (known !== undefined) return known;
  const record = styles.sections.get("cellXfs")!.children[Number(style)];
  let format: SpreadsheetCellFormat | null = null;
  if (record !== undefined) {
    const attributes = parseAttributes(record.slice(0, record.indexOf(">")));
    const numberFormatId = Number(attributes.get("numFmtId") ?? 0);
    const numberFormat =
      styles.customNumberFormats.get(numberFormatId) ?? BUILT_IN_NUMBER_FORMATS[numberFormatId];
    const font =
      styles.sections.get("fonts")!.children[Number(attributes.get("fontId") ?? 0)] ?? "";
    const bold = /<b(?:\s+val="(?:1|true)")?\s*\/>/.test(font);
    const fill =
      styles.sections.get("fills")!.children[Number(attributes.get("fillId") ?? 0)] ?? "";
    const colour = /patternType="solid"[\s\S]*?<fgColor\b[^>]*\brgb="([0-9A-Fa-f]{6,8})"/.exec(
      fill,
    )?.[1];
    if (numberFormat !== undefined || bold || colour !== undefined) {
      format = {
        ...(numberFormat === undefined ? {} : { numberFormat }),
        ...(bold ? { bold: true } : {}),
        ...(colour === undefined ? {} : { fill: colour.slice(-6).toUpperCase() }),
      };
    }
  }
  styles.formats.set(style, format);
  return format;
}

/** The style a cell gets when some of its format changes: an existing record, or a new one. */
function styleWith(
  styles: Styles,
  base: string | undefined,
  format: Extract<SpreadsheetOperation, { type: "setFormat" }>["format"],
): string {
  const key = `${base ?? ""}|${JSON.stringify(format)}`;
  const known = styles.derived.get(key);
  if (known !== undefined) return known;
  const records = styles.sections.get("cellXfs")!.children;
  const record = records[Number(base ?? 0)] ?? "<xf/>";
  const openEnd = record.indexOf(">");
  const selfClosing = record[openEnd - 1] === "/";
  const attributes = parseAttributes(record.slice(3, selfClosing ? openEnd - 1 : openEnd));
  const rest = selfClosing ? "/>" : record.slice(openEnd);
  const intern = (section: string, child: string) => {
    const children = styles.sections.get(section)!.children;
    const found = children.indexOf(child);
    return found === -1 ? children.push(child) - 1 : found;
  };
  if (format.numberFormat !== undefined) {
    attributes.set("numFmtId", String(numberFormatId(styles, format.numberFormat)));
    attributes.set("applyNumberFormat", "1");
  }
  if (format.bold !== undefined) {
    const fonts = styles.sections.get("fonts")!.children;
    const font = fonts[Number(attributes.get("fontId") ?? 0)] ?? "<font/>";
    const plain = font.replace(/<b(?:\s[^>]*)?\/>/, "");
    const bold = plain.endsWith("/>")
      ? "<font><b/></font>"
      : plain.replace(/^(<font\b[^>]*>)/, "$1<b/>");
    attributes.set("fontId", String(intern("fonts", format.bold ? bold : plain)));
    attributes.set("applyFont", "1");
  }
  if (format.fill !== undefined) {
    attributes.set(
      "fillId",
      format.fill === null
        ? "0"
        : String(
            intern(
              "fills",
              `<fill><patternFill patternType="solid"><fgColor rgb="FF${format.fill.toUpperCase()}"/><bgColor indexed="64"/></patternFill></fill>`,
            ),
          ),
    );
    attributes.set("applyFill", "1");
  }
  const style = String(intern("cellXfs", `<xf${attributeText(attributes)}${rest}`));
  styles.derived.set(key, style);
  styles.dirty = true;
  return style;
}

function numberFormatId(styles: Styles, code: string): number {
  if (code === "" || code === "General") return 0;
  for (const [id, known] of Object.entries(BUILT_IN_NUMBER_FORMATS)) {
    if (known === code) return Number(id);
  }
  for (const [id, known] of styles.customNumberFormats) if (known === code) return id;
  const id = Math.max(163, ...styles.customNumberFormats.keys()) + 1;
  styles.customNumberFormats.set(id, code);
  let section = styles.sections.get("numFmts");
  if (section === undefined) {
    // The element does not exist yet; an empty one at the start of the sheet marks where it goes.
    const at = styles.root.innerStart;
    section = {
      element: { name: "numFmts", attributes: "", inner: "", innerStart: at, start: at, end: at },
      children: [],
    };
    styles.sections.set("numFmts", section);
  }
  section.children.push(`<numFmt numFmtId="${id}" formatCode="${escapeAttribute(code)}"/>`);
  return id;
}

function serializeStyles(styles: Styles): string {
  let xml = styles.xml;
  const sections = [...styles.sections.entries()].toSorted(
    ([, left], [, right]) => right.element.start - left.element.start,
  );
  for (const [name, section] of sections) {
    const attributes = parseAttributes(section.element.attributes);
    attributes.set("count", String(section.children.length));
    xml = `${xml.slice(0, section.element.start)}<${name}${attributeText(attributes)}>${section.children.join("")}</${name}>${xml.slice(section.element.end)}`;
  }
  return xml;
}
