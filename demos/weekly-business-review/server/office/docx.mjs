import { writeZip } from "./zip.mjs";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NAMESPACES = `xmlns:w="${W_NS}" xmlns:r="${REL_NS}"`;
// A4 with 2 cm margins, in twips.
const PAGE = { width: 11906, height: 16838, margin: 1134 };
const TEXT_WIDTH = PAGE.width - 2 * PAGE.margin;
const NUMERIC_TEXT = /^[-+−]?[$£€]?\d[\d,]*(\.\d+)?\s?(%|pp|p\.p\.)?$/;

function escapeXml(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function hexColor(color) {
  const hex = String(color).replace(/^#/, "");
  if (!/^[0-9A-Fa-f]{6}$/.test(hex)) throw new Error(`Invalid run color: ${color}`);
  return hex.toUpperCase();
}

function checkLink(link) {
  let url;
  try {
    url = new URL(link);
  } catch {
    throw new Error(`Hyperlinks must be absolute URLs: ${link}`);
  }
  if (!["http:", "https:", "mailto:"].includes(url.protocol)) {
    throw new Error(`Unsupported hyperlink protocol: ${link}`);
  }
  return link;
}

// Relationships of one part. Hyperlink targets are deduplicated by URL.
function partRelationships() {
  const entries = [];
  const links = new Map();
  const add = (type, target, external) => {
    const id = `rId${entries.length + 1}`;
    entries.push({ id, type, target, external });
    return id;
  };
  return {
    add,
    link(url) {
      if (!links.has(url)) links.set(url, add("hyperlink", checkLink(url), true));
      return links.get(url);
    },
    get size() {
      return entries.length;
    },
    xml() {
      const items = entries.map(
        ({ id, type, target, external }) =>
          `<Relationship Id="${id}" Type="${REL_NS}/${type}" Target="${escapeXml(target)}"${external ? ' TargetMode="External"' : ""}/>`,
      );
      return `${XML_DECLARATION}<Relationships xmlns="${PACKAGE_REL_NS}">${items.join("")}</Relationships>`;
    },
  };
}

function runXml(run) {
  const props =
    (run.link ? '<w:rStyle w:val="Hyperlink"/>' : "") +
    (run.bold ? "<w:b/><w:bCs/>" : "") +
    (run.italic ? "<w:i/><w:iCs/>" : "") +
    (run.color ? `<w:color w:val="${hexColor(run.color)}"/>` : "") +
    (run.highlight ? '<w:highlight w:val="yellow"/>' : "") +
    (run.superscript ? '<w:vertAlign w:val="superscript"/>' : "");
  const content = String(run.text ?? "")
    .split("\n")
    .map((line) =>
      line
        .split("\t")
        .map((part) => (part ? `<w:t xml:space="preserve">${escapeXml(part)}</w:t>` : ""))
        .join("<w:tab/>"),
    )
    .join("<w:br/>");
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}${content}</w:r>`;
}

function runsXml(runs, rels) {
  return toRuns(runs)
    .map((run) =>
      run.link
        ? `<w:hyperlink r:id="${rels.link(run.link)}" w:history="1">${runXml(run)}</w:hyperlink>`
        : runXml(run),
    )
    .join("");
}

const toRuns = (value) => (typeof value === "string" ? [{ text: value }] : (value ?? []));
const runsText = (runs) =>
  toRuns(runs)
    .map((run) => run.text ?? "")
    .join("");

function paragraphXml(runs, rels, { style, numbered = false, align } = {}) {
  const props =
    (style && style !== "Normal" ? `<w:pStyle w:val="${style}"/>` : "") +
    (numbered ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' : "") +
    (align ? `<w:jc w:val="${align}"/>` : "");
  return `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ""}${runsXml(runs, rels)}</w:p>`;
}

function tableXml({ header, rows, columnWidths }, rels) {
  const count = header.length;
  if (count === 0) throw new Error("A table needs at least one column");
  if (columnWidths && columnWidths.length !== count) {
    throw new Error(`Expected ${count} column widths, got ${columnWidths.length}`);
  }
  const widths =
    columnWidths ?? Array.from({ length: count }, () => Math.floor(TEXT_WIDTH / count));
  // Numbers line up on the right when the column's first value reads as a number.
  const aligns = header.map((_, c) =>
    rows.length > 0 && NUMERIC_TEXT.test(runsText(rows[0][c]).trim()) ? "right" : undefined,
  );
  const cell = (runs, c, isHeader) =>
    `<w:tc><w:tcPr><w:tcW w:w="${widths[c]}" w:type="dxa"/>` +
    (isHeader ? '<w:shd w:val="clear" w:color="auto" w:fill="E8EEF7"/>' : "") +
    `</w:tcPr>${paragraphXml(runs, rels, { align: aligns[c] })}</w:tc>`;
  const headerRow =
    `<w:tr><w:trPr><w:tblHeader/></w:trPr>` +
    header.map((text, c) => cell([{ text, bold: true }], c, true)).join("") +
    `</w:tr>`;
  const bodyRows = rows.map(
    (row) => `<w:tr>${header.map((_, c) => cell(row[c], c, false)).join("")}</w:tr>`,
  );
  return (
    `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/>` +
    `<w:tblW w:w="${widths.reduce((sum, w) => sum + w, 0)}" w:type="dxa"/>` +
    `<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/>` +
    `</w:tblPr><w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>` +
    `${headerRow}${bodyRows.join("")}</w:tbl>` +
    // Keeps two tables from merging and gives the table room before the next block.
    `<w:p/>`
  );
}

function blockXml(block, rels) {
  switch (block.type) {
    case "heading":
      if (![1, 2, 3].includes(block.level))
        throw new Error(`Invalid heading level: ${block.level}`);
      return paragraphXml(block.text, rels, { style: `Heading${block.level}` });
    case "paragraph":
      return paragraphXml(block.runs ?? block.text, rels, { style: block.style });
    case "bullets":
      return block.items
        .map((item) => paragraphXml(item, rels, { style: "ListParagraph", numbered: true }))
        .join("");
    case "table":
      return tableXml(block, rels);
    case "pageBreak":
      return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
    default:
      throw new Error(`Unknown block type: ${block.type}`);
  }
}

const STYLES_XML = `${XML_DECLARATION}<w:styles ${NAMESPACES}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-GB" w:eastAsia="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>
<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
<w:style w:type="numbering" w:default="1" w:styleId="NoList"><w:name w:val="No List"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="10"/><w:qFormat/><w:pPr><w:spacing w:after="240" w:line="240" w:lineRule="auto"/><w:contextualSpacing/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri Light" w:hAnsi="Calibri Light" w:cs="Calibri Light"/><w:color w:val="1F2A44"/><w:kern w:val="28"/><w:sz w:val="52"/><w:szCs w:val="52"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:bCs/><w:color w:val="1F3864"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:unhideWhenUsed/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:bCs/><w:color w:val="2F5496"/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:unhideWhenUsed/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="200" w:after="60"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:bCs/><w:color w:val="1F3763"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="Subtle"><w:name w:val="Subtle"/><w:basedOn w:val="Normal"/><w:qFormat/><w:rPr><w:color w:val="6B7280"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="Callout"><w:name w:val="Callout"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:pBdr><w:left w:val="single" w:sz="24" w:space="8" w:color="2F5496"/></w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="EEF3FA"/><w:spacing w:before="120" w:after="200"/><w:ind w:left="170" w:right="113"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/><w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Header"><w:name w:val="header"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:pPr><w:spacing w:after="0"/><w:jc w:val="right"/></w:pPr><w:rPr><w:color w:val="6B7280"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:pPr><w:spacing w:after="0"/></w:pPr><w:rPr><w:color w:val="6B7280"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="39"/><w:pPr><w:spacing w:before="40" w:after="40" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:left w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:right w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/></w:tblBorders></w:tblPr></w:style>
</w:styles>`;

const SETTINGS_XML = `${XML_DECLARATION}<w:settings ${NAMESPACES}><w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;

const NUMBERING_XML = `${XML_DECLARATION}<w:numbering ${NAMESPACES}><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;

const APP_XML = `${XML_DECLARATION}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Codenine demo</Application><DocSecurity>0</DocSecurity></Properties>`;

function isoDate(value) {
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function corePropertiesXml(title, core) {
  const { creator, lastModifiedBy = creator, created, modified = created } = core;
  const element = (name, value) => (value ? `<${name}>${escapeXml(value)}</${name}>` : "");
  const date = (name, value) =>
    value ? `<${name} xsi:type="dcterms:W3CDTF">${isoDate(value)}</${name}>` : "";
  return (
    `${XML_DECLARATION}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    element("dc:title", title) +
    element("dc:subject", core.subject) +
    element("dc:creator", creator) +
    element("cp:keywords", core.keywords) +
    element("dc:description", core.description) +
    element("cp:lastModifiedBy", lastModifiedBy) +
    date("dcterms:created", created) +
    date("dcterms:modified", modified) +
    `</cp:coreProperties>`
  );
}

const CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml";

export function buildDocx({ title, blocks, header, footer, core = {} }) {
  const rels = partRelationships();
  rels.add("styles", "styles.xml");
  rels.add("settings", "settings.xml");
  rels.add("numbering", "numbering.xml");
  const parts = [];
  const overrides = [
    ["/word/document.xml", `${CONTENT_TYPE}.document.main+xml`],
    ["/word/styles.xml", `${CONTENT_TYPE}.styles+xml`],
    ["/word/settings.xml", `${CONTENT_TYPE}.settings+xml`],
    ["/word/numbering.xml", `${CONTENT_TYPE}.numbering+xml`],
    ["/docProps/core.xml", "application/vnd.openxmlformats-package.core-properties+xml"],
    ["/docProps/app.xml", "application/vnd.openxmlformats-officedocument.extended-properties+xml"],
  ];

  let sectionReferences = "";
  for (const [kind, root, style, runs] of [
    ["header", "w:hdr", "Header", header],
    ["footer", "w:ftr", "Footer", footer],
  ]) {
    if (!runs || runs.length === 0) continue;
    const partRels = partRelationships();
    const xml = `${XML_DECLARATION}<${root} ${NAMESPACES}>${paragraphXml(runs, partRels, { style })}</${root}>`;
    parts.push({ name: `word/${kind}1.xml`, data: xml });
    if (partRels.size > 0)
      parts.push({ name: `word/_rels/${kind}1.xml.rels`, data: partRels.xml() });
    overrides.push([`/word/${kind}1.xml`, `${CONTENT_TYPE}.${kind}+xml`]);
    sectionReferences += `<w:${kind}Reference w:type="default" r:id="${rels.add(kind, `${kind}1.xml`)}"/>`;
  }

  const body =
    (title ? paragraphXml(title, rels, { style: "Title" }) : "") +
    blocks.map((block) => blockXml(block, rels)).join("");
  const documentXml =
    `${XML_DECLARATION}<w:document ${NAMESPACES}><w:body>${body}` +
    `<w:sectPr>${sectionReferences}<w:pgSz w:w="${PAGE.width}" w:h="${PAGE.height}"/>` +
    `<w:pgMar w:top="${PAGE.margin}" w:right="${PAGE.margin}" w:bottom="${PAGE.margin}" w:left="${PAGE.margin}" w:header="567" w:footer="567" w:gutter="0"/>` +
    `<w:cols w:space="708"/><w:docGrid w:linePitch="360"/></w:sectPr></w:body></w:document>`;

  const contentTypes =
    `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    overrides
      .map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`)
      .join("") +
    `</Types>`;
  const rootRels =
    `${XML_DECLARATION}<Relationships xmlns="${PACKAGE_REL_NS}">` +
    `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="word/document.xml"/>` +
    `<Relationship Id="rId2" Type="${PACKAGE_REL_NS}/metadata/core-properties" Target="docProps/core.xml"/>` +
    `<Relationship Id="rId3" Type="${REL_NS}/extended-properties" Target="docProps/app.xml"/>` +
    `</Relationships>`;

  return writeZip([
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels", data: rootRels },
    { name: "docProps/core.xml", data: corePropertiesXml(core.title ?? title, core) },
    { name: "docProps/app.xml", data: APP_XML },
    { name: "word/document.xml", data: documentXml },
    { name: "word/_rels/document.xml.rels", data: rels.xml() },
    { name: "word/styles.xml", data: STYLES_XML },
    { name: "word/settings.xml", data: SETTINGS_XML },
    { name: "word/numbering.xml", data: NUMBERING_XML },
    ...parts,
  ]);
}
