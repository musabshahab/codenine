import { readZip, writeZip } from "./zip.mjs";

const decoder = new TextDecoder("utf-8");

export function columnLetter(index) {
  let letters = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  }
  return letters;
}

export function cellRef(rowIndex, colIndex) {
  return `${columnLetter(colIndex)}${rowIndex + 1}`;
}

function parseCellRef(ref) {
  const match = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(ref);
  if (!match) throw new Error(`Invalid cell reference: ${ref}`);
  let col = 0;
  for (const letter of match[1].toUpperCase()) col = col * 26 + letter.charCodeAt(0) - 64;
  return { row: Number(match[2]) - 1, col: col - 1 };
}

const TOKEN =
  /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
const ATTRIBUTE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

const localName = (name) => name.slice(name.indexOf(":") + 1);

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_, entity) => {
    if (entity[0] !== "#") return ENTITIES[entity];
    const code = entity[1] === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return String.fromCodePoint(code);
  });
}

// Excel escapes characters XML cannot carry as _xHHHH_, and a literal "_x" as _x005F_.
function decodeEscapes(text) {
  return text.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// A small non-validating parser: elements keep local names (prefixes dropped) and text children.
function parseXml(text) {
  const root = { name: "#document", attrs: {}, children: [] };
  const stack = [root];
  for (const [, cdata, closeName, openName, attrText, selfClose, chars] of text.matchAll(TOKEN)) {
    const parent = stack.at(-1);
    if (chars !== undefined) parent.children.push(decodeEntities(chars));
    else if (cdata !== undefined) parent.children.push(cdata);
    else if (openName !== undefined) {
      const attrs = {};
      for (const [, name, double, single] of attrText.matchAll(ATTRIBUTE)) {
        attrs[localName(name)] = decodeEntities(double ?? single);
      }
      const element = { name: localName(openName), attrs, children: [] };
      parent.children.push(element);
      if (!selfClose) stack.push(element);
    } else if (closeName !== undefined && stack.length > 1) stack.pop();
  }
  return root.children.find((node) => typeof node !== "string");
}

const elements = (node, name) =>
  (node?.children ?? []).filter(
    (child) => typeof child !== "string" && (name === undefined || child.name === name),
  );
const child = (node, name) => elements(node, name)[0];
const textOf = (node) =>
  (node?.children ?? []).map((c) => (typeof c === "string" ? c : textOf(c))).join("");

// Plain <t> and rich-text runs <r><t>; phonetic hints (<rPh>) are not part of the value.
function stringItemText(item) {
  let text = "";
  for (const node of elements(item)) {
    if (node.name === "t") text += textOf(node);
    else if (node.name === "r") text += textOf(child(node, "t"));
  }
  return decodeEscapes(text);
}

function resolvePartPath(baseDir, target) {
  const segments = (target.startsWith("/") ? target.slice(1) : baseDir + target).split("/");
  const resolved = [];
  for (const segment of segments) {
    if (segment === "..") resolved.pop();
    else if (segment !== "." && segment !== "") resolved.push(segment);
  }
  return resolved.join("/");
}

function cellValue(cell, sharedStrings) {
  const type = cell.attrs.t ?? "n";
  if (type === "inlineStr") return stringItemText(child(cell, "is"));
  const v = child(cell, "v");
  if (!v) return null;
  const raw = textOf(v);
  switch (type) {
    case "s":
      return sharedStrings[Number(raw)] ?? null;
    case "b":
      return raw === "1" || raw === "true";
    case "str":
    case "e":
    case "d":
      return decodeEscapes(raw);
    default: {
      if (raw.trim() === "") return null;
      const number = Number(raw);
      return Number.isNaN(number) ? raw : number;
    }
  }
}

function readRows(worksheet, sharedStrings) {
  const sparse = [];
  let rowIndex = -1;
  for (const row of elements(child(worksheet, "sheetData"), "row")) {
    rowIndex = row.attrs.r ? Number(row.attrs.r) - 1 : rowIndex + 1;
    const values = (sparse[rowIndex] ??= []);
    let colIndex = -1;
    for (const cell of elements(row, "c")) {
      colIndex = cell.attrs.r ? parseCellRef(cell.attrs.r).col : colIndex + 1;
      values[colIndex] = cellValue(cell, sharedStrings);
    }
  }
  // Styled but empty cells and rows trail real data in files saved by Excel and LibreOffice.
  let height = 0;
  let width = 0;
  sparse.forEach((values, r) => {
    values.forEach((value, c) => {
      if (value === null || value === undefined) return;
      height = Math.max(height, r + 1);
      width = Math.max(width, c + 1);
    });
  });
  return Array.from({ length: height }, (_, r) =>
    Array.from({ length: width }, (_, c) => sparse[r]?.[c] ?? null),
  );
}

export function readXlsx(bytes) {
  const zip = readZip(bytes);
  // OPC part names are case-insensitive, and some writers disagree on case.
  const parts = new Map([...zip].map(([name, data]) => [name.toLowerCase(), data]));
  const readPart = (path) => {
    const data = parts.get(path.toLowerCase());
    return data ? parseXml(decoder.decode(data)) : undefined;
  };
  const relationships = (partPath) => {
    const slash = partPath.lastIndexOf("/") + 1;
    const dir = partPath.slice(0, slash);
    const rels = readPart(`${dir}_rels/${partPath.slice(slash)}.rels`);
    return elements(rels, "Relationship").map(({ attrs }) => ({
      id: attrs.Id,
      type: attrs.Type ?? "",
      target: attrs.TargetMode === "External" ? attrs.Target : resolvePartPath(dir, attrs.Target),
    }));
  };

  const workbookPath =
    relationships("").find((rel) => rel.type.endsWith("/officeDocument"))?.target ??
    "xl/workbook.xml";
  const workbook = readPart(workbookPath);
  if (!workbook || workbook.name !== "workbook") {
    throw new Error("Not an Excel workbook: the file has no spreadsheet part");
  }
  const workbookRels = relationships(workbookPath);
  const sharedStringsRel = workbookRels.find((rel) => rel.type.endsWith("/sharedStrings"));
  const sharedStrings = sharedStringsRel
    ? elements(readPart(sharedStringsRel.target), "si").map(stringItemText)
    : [];

  const sheets = [];
  for (const sheet of elements(child(workbook, "sheets"), "sheet")) {
    const rel = workbookRels.find((candidate) => candidate.id === sheet.attrs.id);
    // Chart sheets and dialog sheets have no cells.
    if (!rel?.type.endsWith("/worksheet")) continue;
    const worksheet = readPart(rel.target);
    if (!worksheet) throw new Error(`Workbook part is missing: ${rel.target}`);
    sheets.push({ name: sheet.attrs.name, rows: readRows(worksheet, sharedStrings) });
  }
  return { sheets };
}

const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

// cellXfs indexes in styles.xml below.
const HEADER_STYLE = 1;
const FORMAT_STYLES = { integer: 2, decimal2: 3, percent1: 4, currency2: 5, text: 6 };

const STYLES_XML = `${XML_DECLARATION}<styleSheet xmlns="${MAIN_NS}">
<numFmts count="2"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/><numFmt numFmtId="165" formatCode="0.0%"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FF9BB7D4"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
<dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>
</styleSheet>`;

function escapeXml(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeCellText(value) {
  const encoded = String(value)
    .replace(/_(x[0-9A-Fa-f]{4}_)/g, "_x005F_$1")
    .replace(
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,
      (ch) => `_x${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}_`,
    );
  return escapeXml(encoded);
}

function textElement(value) {
  const space = /^\s|\s$|\n/.test(value) ? ' xml:space="preserve"' : "";
  return `<t${space}>${escapeCellText(value)}</t>`;
}

function isoDate(value) {
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function corePropertiesXml({ title, creator, created } = {}) {
  const dates = created
    ? `<dcterms:created xsi:type="dcterms:W3CDTF">${isoDate(created)}</dcterms:created>` +
      `<dcterms:modified xsi:type="dcterms:W3CDTF">${isoDate(created)}</dcterms:modified>`
    : "";
  return (
    `${XML_DECLARATION}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    (title ? `<dc:title>${escapeXml(title)}</dc:title>` : "") +
    (creator
      ? `<dc:creator>${escapeXml(creator)}</dc:creator><cp:lastModifiedBy>${escapeXml(creator)}</cp:lastModifiedBy>`
      : "") +
    `${dates}</cp:coreProperties>`
  );
}

const APP_XML = `${XML_DECLARATION}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Codenine demo</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop></Properties>`;

function validateSheetNames(sheets) {
  const seen = new Set();
  for (const { name } of sheets) {
    if (
      typeof name !== "string" ||
      name.length < 1 ||
      name.length > 31 ||
      /[[\]:*?/\\]/.test(name)
    ) {
      throw new Error(`Invalid sheet name: ${JSON.stringify(name)}`);
    }
    if (seen.has(name.toLowerCase())) throw new Error(`Duplicate sheet name: ${name}`);
    seen.add(name.toLowerCase());
  }
}

function estimatedWidth(column, index, rows) {
  // Room for the header, its filter button, and the widest value as Excel will display it.
  let longest = column.header.length + 3;
  for (const row of rows) {
    const cell = row[index];
    const value = cell !== null && typeof cell === "object" ? cell.value : cell;
    if (value === null || value === undefined) continue;
    const shown =
      typeof value === "number"
        ? value.toLocaleString("en-US", { maximumFractionDigits: 2 }).length + 2
        : String(value).length;
    longest = Math.max(longest, shown);
  }
  return Math.min(60, Math.max(8, longest + 2));
}

function sheetXml(sheet, sheetIndex, strings) {
  const { columns, rows, freezeHeader = false, autoFilter = false } = sheet;
  const lastColumn = columnLetter(Math.max(columns.length, 1) - 1);
  const range = `A1:${lastColumn}${rows.length + 1}`;
  const stringIndex = (text) => {
    strings.count++;
    if (!strings.index.has(text)) strings.index.set(text, strings.index.size);
    return strings.index.get(text);
  };

  const cellXml = (value, rowIndex, colIndex, style) => {
    const ref = cellRef(rowIndex, colIndex);
    const cell = value !== null && typeof value === "object" ? value : { value };
    const styleIndex = cell.format ? FORMAT_STYLES[cell.format] : style;
    const s = styleIndex ? ` s="${styleIndex}"` : "";
    const formula = cell.formula ? `<f>${escapeXml(cell.formula.replace(/^=/, ""))}</f>` : "";
    const v = cell.value;
    if (typeof v === "string") {
      return formula
        ? `<c r="${ref}"${s} t="str">${formula}<v>${escapeCellText(v)}</v></c>`
        : `<c r="${ref}"${s} t="s"><v>${stringIndex(v)}</v></c>`;
    }
    if (typeof v === "boolean") return `<c r="${ref}"${s} t="b">${formula}<v>${v ? 1 : 0}</v></c>`;
    if (typeof v === "number" && Number.isFinite(v)) {
      return `<c r="${ref}"${s}>${formula}<v>${v}</v></c>`;
    }
    return formula ? `<c r="${ref}"${s}>${formula}</c>` : "";
  };

  const columnStyles = columns.map((column) => FORMAT_STYLES[column.format] ?? 0);
  const rowXml = [
    `<row r="1">${columns.map((column, c) => cellXml(column.header, 0, c, HEADER_STYLE)).join("")}</row>`,
  ];
  rows.forEach((row, r) => {
    const cells = row.map((value, c) => cellXml(value, r + 1, c, columnStyles[c])).join("");
    rowXml.push(`<row r="${r + 2}">${cells}</row>`);
  });

  const cols = columns
    .map((column, c) => {
      const width = column.width ?? estimatedWidth(column, c, rows);
      const style = columnStyles[c] ? ` style="${columnStyles[c]}"` : "";
      return `<col min="${c + 1}" max="${c + 1}" width="${width}" customWidth="1"${style}/>`;
    })
    .join("");
  const selected = sheetIndex === 0 ? ' tabSelected="1"' : "";
  const view = freezeHeader
    ? `<sheetView workbookViewId="0"${selected}><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView>`
    : `<sheetView workbookViewId="0"${selected}/>`;

  return (
    `${XML_DECLARATION}<worksheet xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">` +
    `<dimension ref="${range}"/><sheetViews>${view}</sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>${cols ? `<cols>${cols}</cols>` : ""}` +
    `<sheetData>${rowXml.join("")}</sheetData>` +
    (autoFilter ? `<autoFilter ref="${range}"/>` : "") +
    `<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>` +
    `</worksheet>`
  );
}

export function writeXlsx({ sheets, properties = {} }) {
  if (!sheets?.length) throw new Error("A workbook needs at least one sheet");
  validateSheetNames(sheets);
  const strings = { index: new Map(), count: 0 };
  const worksheets = sheets.map((sheet, i) => sheetXml(sheet, i, strings));

  // Excel records an autofilter range as this hidden name; it repairs files that omit it.
  const filterNames = sheets
    .map((sheet, i) => {
      if (!sheet.autoFilter) return "";
      const lastColumn = columnLetter(Math.max(sheet.columns.length, 1) - 1);
      const quoted = `'${sheet.name.replace(/'/g, "''")}'`;
      return `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${escapeXml(`${quoted}!$A$1:$${lastColumn}$${sheet.rows.length + 1}`)}</definedName>`;
    })
    .join("");

  const workbookXml =
    `${XML_DECLARATION}<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">` +
    `<bookViews><workbookView activeTab="0"/></bookViews><sheets>` +
    sheets
      .map(
        (sheet, i) =>
          `<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
      )
      .join("") +
    `</sheets>${filterNames ? `<definedNames>${filterNames}</definedNames>` : ""}` +
    `<calcPr calcId="191029"/></workbook>`;

  const workbookRels =
    `${XML_DECLARATION}<Relationships xmlns="${PACKAGE_REL_NS}">` +
    sheets
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join("") +
    `<Relationship Id="rId${sheets.length + 1}" Type="${REL_NS}/styles" Target="styles.xml"/>` +
    `<Relationship Id="rId${sheets.length + 2}" Type="${REL_NS}/sharedStrings" Target="sharedStrings.xml"/>` +
    `</Relationships>`;

  const sharedStringsXml =
    `${XML_DECLARATION}<sst xmlns="${MAIN_NS}" count="${strings.count}" uniqueCount="${strings.index.size}">` +
    [...strings.index.keys()].map((text) => `<si>${textElement(text)}</si>`).join("") +
    `</sst>`;

  const contentTypes =
    `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    sheets
      .map(
        (_, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
      )
      .join("") +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>` +
    `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
    `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>` +
    `</Types>`;

  const rootRels =
    `${XML_DECLARATION}<Relationships xmlns="${PACKAGE_REL_NS}">` +
    `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
    `<Relationship Id="rId3" Type="${REL_NS}/extended-properties" Target="docProps/app.xml"/>` +
    `</Relationships>`;

  return writeZip([
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels", data: rootRels },
    { name: "docProps/core.xml", data: corePropertiesXml(properties) },
    { name: "docProps/app.xml", data: APP_XML },
    { name: "xl/workbook.xml", data: workbookXml },
    { name: "xl/_rels/workbook.xml.rels", data: workbookRels },
    { name: "xl/styles.xml", data: STYLES_XML },
    { name: "xl/sharedStrings.xml", data: sharedStringsXml },
    ...worksheets.map((xml, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: xml })),
  ]);
}
