import type { SpreadsheetOperation } from "@codenine/contracts";
import { PDFDocument, type PDFFont, type PDFPage, StandardFonts, rgb } from "@cantoo/pdf-lib";
import JSZip from "jszip";

import type { SpreadsheetLimits } from "../spreadsheet/problems.ts";
import { XlsxWorkbook } from "../spreadsheet/xlsxWorkbook.ts";

type Block =
  | { readonly kind: "heading"; readonly level: number; readonly text: string }
  | { readonly kind: "paragraph"; readonly text: string }
  | {
      readonly kind: "item";
      readonly depth: number;
      readonly marker: string;
      readonly text: string;
    }
  | { readonly kind: "quote"; readonly text: string }
  | { readonly kind: "code"; readonly lines: ReadonlyArray<string> }
  | { readonly kind: "table"; readonly rows: ReadonlyArray<ReadonlyArray<string>> }
  | { readonly kind: "rule" };

const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;

/** Markdown marks removed, leaving the words: a link keeps its address after its text. */
function plainText(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_whole, text: string, address: string) =>
      text === address ? text : `${text} (${address})`,
    )
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\\*\w])\*([^*\n]+)\*/g, "$1$2")
    .replace(/(^|[^\\\w])_([^_\n]+)_(?!\w)/g, "$1$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, "$1")
    .trim();
}

function tableCells(line: string): Array<string> {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: Array<string> = [];
  let cell = "";
  for (let index = 0; index < trimmed.length; index++) {
    const character = trimmed[index]!;
    if (character === "\\" && trimmed[index + 1] === "|") {
      cell += "|";
      index++;
    } else if (character === "|") {
      cells.push(plainText(cell));
      cell = "";
    } else cell += character;
  }
  cells.push(plainText(cell));
  return cells;
}

function blocks(markdown: string): Array<Block> {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const found: Array<Block> = [];
  let paragraph: Array<string> = [];
  const flush = () => {
    if (paragraph.length > 0)
      found.push({ kind: "paragraph", text: plainText(paragraph.join(" ")) });
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence !== null) {
      flush();
      const code: Array<string> = [];
      for (index++; index < lines.length && !lines[index]!.trim().startsWith(fence[1]!); index++) {
        code.push(lines[index]!);
      }
      found.push({ kind: "code", lines: code });
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    if (line.includes("|") && TABLE_DIVIDER.test(lines[index + 1] ?? "")) {
      flush();
      const rows = [tableCells(line)];
      for (index += 2; index < lines.length && lines[index]!.includes("|"); index++) {
        rows.push(tableCells(lines[index]!));
      }
      index--;
      found.push({ kind: "table", rows });
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading !== null) {
      flush();
      found.push({ kind: "heading", level: heading[1]!.length, text: plainText(heading[2]!) });
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      found.push({ kind: "rule" });
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item !== null) {
      flush();
      found.push({
        kind: "item",
        depth: Math.floor(item[1]!.replaceAll("\t", "  ").length / 2),
        marker: /\d/.test(item[2]!) ? item[2]!.replace(")", ".") : "•",
        text: plainText(item[3]!.replace(/^\[( |x|X)\]\s+/, "")),
      });
      continue;
    }
    const quote = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (quote !== null) {
      flush();
      found.push({ kind: "quote", text: plainText(quote[1]!) });
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return found;
}

/** The reply's tables, each as rows of cell text with the header row first. */
export function markdownTables(markdown: string): Array<ReadonlyArray<ReadonlyArray<string>>> {
  return blocks(markdown).flatMap((block) => (block.kind === "table" ? [block.rows] : []));
}

const PLAIN_NUMBER = /^-?(0|[1-9]\d*|[1-9]\d{0,2}(,\d{3})+)(\.\d+)?$/;

/**
 * The number a cell's text writes, or undefined when it should stay text. Leading zeros and more
 * digits than a number holds exactly mark an identifier, which a number would change.
 */
function plainNumber(text: string): number | undefined {
  if (!PLAIN_NUMBER.test(text) || text.replaceAll(/\D/g, "").length > 15) return undefined;
  return Number(text.replaceAll(",", ""));
}

const EMPTY_WORKBOOK_PARTS: Readonly<Record<string, string>> = {
  "[Content_Types].xml":
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
  "_rels/.rels":
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  "xl/workbook.xml":
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Table" sheetId="1" r:id="rId1"/></sheets></workbook>',
  "xl/_rels/workbook.xml.rels":
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
  "xl/worksheets/sheet1.xml":
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>',
  "xl/styles.xml":
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>',
};

/**
 * A workbook of one sheet holding the table: a bold header row, and plain numbers as numbers so
 * they can be summed. Text that looks like a formula stays text.
 */
export async function tableWorkbook(
  rows: ReadonlyArray<ReadonlyArray<string>>,
  limits: SpreadsheetLimits,
): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [path, text] of Object.entries(EMPTY_WORKBOOK_PARTS)) zip.file(path, text);
  const workbook = await XlsxWorkbook.open(await zip.generateAsync({ type: "uint8array" }), limits);
  const operations: Array<SpreadsheetOperation> = [];
  for (const [row, cells] of rows.entries()) {
    for (const [column, text] of cells.entries()) {
      if (text === "") continue;
      const number = row > 0 ? plainNumber(text) : undefined;
      operations.push({
        type: "setCell",
        sheet: "Table",
        row,
        column,
        input: number === undefined ? { kind: "text", text } : { kind: "number", number },
      });
    }
  }
  const columnCount = Math.max(1, ...rows.map((cells) => cells.length));
  operations.push({
    type: "setFormat",
    sheet: "Table",
    row: 0,
    column: 0,
    rowCount: 1,
    columnCount,
    format: { bold: true },
  });
  await workbook.apply(operations);
  return workbook.save();
}

const PAGE = { width: 595.28, height: 841.89, margin: 56 };
const BODY_SIZE = 10.5;
const HEADING_SIZES = [20, 16, 13.5, 12, 11, 10.5];
const INK = rgb(0.1, 0.1, 0.12);
const RULE = rgb(0.75, 0.75, 0.78);

/** Lays text out down pages, starting a new page when the current one is full. */
class PageWriter {
  private readonly document: PDFDocument;
  private page: PDFPage;
  private y: number;
  constructor(document: PDFDocument) {
    this.document = document;
    this.page = document.addPage([PAGE.width, PAGE.height]);
    this.y = PAGE.height - PAGE.margin;
  }

  space(height: number) {
    this.y -= height;
  }

  private room(height: number) {
    if (this.y - height >= PAGE.margin) return;
    this.page = this.document.addPage([PAGE.width, PAGE.height]);
    this.y = PAGE.height - PAGE.margin;
  }

  line(text: string, font: PDFFont, size: number, x: number) {
    const height = size * 1.4;
    this.room(height);
    this.y -= height;
    if (text !== "")
      this.page.drawText(text, { x, y: this.y + size * 0.3, size, font, color: INK });
  }

  rule() {
    this.room(8);
    this.y -= 8;
    this.page.drawLine({
      start: { x: PAGE.margin, y: this.y + 4 },
      end: { x: PAGE.width - PAGE.margin, y: this.y + 4 },
      thickness: 0.6,
      color: RULE,
    });
  }

  /** Columns of wrapped lines drawn side by side as one row. */
  row(cells: ReadonlyArray<ReadonlyArray<string>>, font: PDFFont, size: number, width: number) {
    const lines = Math.max(1, ...cells.map((cell) => cell.length));
    const height = size * 1.4;
    for (let line = 0; line < lines; line++) {
      this.room(height);
      this.y -= height;
      for (const [column, cell] of cells.entries()) {
        const text = cell[line];
        if (text === undefined || text === "") continue;
        this.page.drawText(text, {
          x: PAGE.margin + column * width,
          y: this.y + size * 0.3,
          size,
          font,
          color: INK,
        });
      }
    }
    this.rule();
  }
}

/** Characters the built-in font cannot draw become "?", and tabs become spaces. */
function drawable(font: PDFFont, text: string): string {
  const known = new Set(font.getCharacterSet());
  let output = "";
  for (const character of text.replaceAll("\t", "    ")) {
    output += known.has(character.codePointAt(0)!) ? character : "?";
  }
  return output;
}

function wrap(font: PDFFont, size: number, text: string, width: number): Array<string> {
  const lines: Array<string> = [];
  let line = "";
  const fits = (candidate: string) => font.widthOfTextAtSize(candidate, size) <= width;
  // How much of `word` fits after `lead`. It measures prefixes about a line long, never the whole
  // word, so a long run with no spaces costs time in proportion to its length.
  const fitting = (lead: string, word: string) => {
    let high = 1;
    while (high < word.length && fits(lead + word.slice(0, high))) high *= 2;
    high = Math.min(high, word.length);
    if (fits(lead + word.slice(0, high))) return high;
    let low = 0;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (fits(lead + word.slice(0, middle))) low = middle;
      else high = middle;
    }
    return low;
  };
  for (const word of drawable(font, text).split(/\s+/).filter(Boolean)) {
    let rest = word;
    // A word wider than the line is cut across lines.
    while (fitting("", rest) < rest.length) {
      const lead = line === "" ? "" : `${line} `;
      const cut = fitting(lead, rest);
      if (line !== "" && cut <= 1) {
        lines.push(line);
        line = "";
        continue;
      }
      const taken = Math.max(1, cut);
      lines.push(lead + rest.slice(0, taken));
      line = "";
      rest = rest.slice(taken);
    }
    if (rest === "") continue;
    const candidate = line === "" ? rest : `${line} ${rest}`;
    if (fits(candidate)) line = candidate;
    else {
      lines.push(line);
      line = rest;
    }
  }
  if (line !== "" || lines.length === 0) lines.push(line);
  return lines;
}

/**
 * The reply as a PDF of text: headings, paragraphs, lists, quotes, code and tables. It uses the
 * PDF's built-in fonts, so characters outside Western European text print as "?".
 */
export async function markdownPdf(markdown: string): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const regular = document.embedStandardFont(StandardFonts.Helvetica);
  const bold = document.embedStandardFont(StandardFonts.HelveticaBold);
  const mono = document.embedStandardFont(StandardFonts.Courier);
  const writer = new PageWriter(document);
  const width = PAGE.width - PAGE.margin * 2;
  for (const block of blocks(markdown)) {
    switch (block.kind) {
      case "heading": {
        const size = HEADING_SIZES[block.level - 1] ?? BODY_SIZE;
        writer.space(size * 0.5);
        for (const line of wrap(bold, size, block.text, width)) {
          writer.line(line, bold, size, PAGE.margin);
        }
        break;
      }
      case "paragraph":
        for (const line of wrap(regular, BODY_SIZE, block.text, width)) {
          writer.line(line, regular, BODY_SIZE, PAGE.margin);
        }
        writer.space(BODY_SIZE * 0.6);
        break;
      case "item": {
        const indent = PAGE.margin + 12 + Math.min(block.depth, 6) * 14;
        const lines = wrap(regular, BODY_SIZE, block.text, PAGE.width - PAGE.margin - indent);
        for (const [index, line] of lines.entries()) {
          writer.line(line, regular, BODY_SIZE, indent);
          if (index === 0) {
            // The marker shares the first line, so it is drawn back up on that line.
            writer.space(-BODY_SIZE * 1.4);
            writer.line(drawable(regular, block.marker), regular, BODY_SIZE, indent - 14);
          }
        }
        break;
      }
      case "quote":
        for (const line of wrap(regular, BODY_SIZE, block.text, width - 16)) {
          writer.line(line, regular, BODY_SIZE, PAGE.margin + 16);
        }
        break;
      case "code":
        writer.space(3);
        for (const source of block.lines) {
          const text = drawable(mono, source);
          const fit = Math.max(1, Math.floor(width / mono.widthOfTextAtSize("m", 9)));
          for (let start = 0; start === 0 || start < text.length; start += fit) {
            writer.line(text.slice(start, start + fit), mono, 9, PAGE.margin);
          }
        }
        writer.space(6);
        break;
      case "table": {
        const columns = Math.max(1, ...block.rows.map((row) => row.length));
        const columnWidth = width / columns;
        writer.rule();
        for (const [index, row] of block.rows.entries()) {
          const font = index === 0 ? bold : regular;
          writer.row(
            Array.from({ length: columns }, (_, column) =>
              wrap(font, 9.5, row[column] ?? "", columnWidth - 8),
            ),
            font,
            9.5,
            columnWidth,
          );
        }
        writer.space(6);
        break;
      }
      case "rule":
        writer.rule();
        break;
    }
  }
  return document.save();
}
