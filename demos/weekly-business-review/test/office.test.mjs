import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";
import * as NodeZlib from "node:zlib";

import { buildWorkbook, generateShipments, SAMPLE_FILES } from "../scripts/make-sample-data.mjs";
import { buildDocx } from "../server/office/docx.mjs";
import { cellRef, columnLetter, readXlsx } from "../server/office/xlsx.mjs";
import { crc32, readZip, writeZip } from "../server/office/zip.mjs";

const { test } = NodeTest;
const SAMPLE_DIR = NodeURL.fileURLToPath(new URL("../sample-data/", import.meta.url));
const SOFFICE = (process.env.PATH ?? "")
  .split(NodePath.delimiter)
  .some((dir) =>
    ["soffice", "soffice.exe"].some((name) => NodeFS.existsSync(NodePath.join(dir, name))),
  );
const NO_SOFFICE = SOFFICE ? false : "LibreOffice (soffice) is not on PATH";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function withTempDir(fn) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "wbr-office-"));
  try {
    return fn(dir);
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}

// A private profile keeps soffice from handing the job to an instance that is already running.
function convertWithSoffice(input, format, outDir) {
  const profile = NodeURL.pathToFileURL(NodePath.join(outDir, ".lo-profile")).href;
  const result = NodeChildProcess.spawnSync(
    "soffice",
    [
      `-env:UserInstallation=${profile}`,
      "--headless",
      "--convert-to",
      format,
      "--outdir",
      outDir,
      input,
    ],
    { encoding: "utf8", timeout: 180_000 },
  );
  const extension = format.split(":")[0];
  const output = NodePath.join(outDir, `${NodePath.parse(input).name}.${extension}`);
  NodeAssert.ok(NodeFS.existsSync(output), `soffice failed: ${result.stderr}${result.stdout}`);
  return output;
}

// Writes entries the way streaming zip writers do: sizes and CRC follow the data.
function zipWithDataDescriptors(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data, method } of entries) {
    const nameBytes = encoder.encode(name);
    const body = method === 8 ? NodeZlib.deflateRawSync(data) : data;
    const crc = NodeZlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0808, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(nameBytes.length, 26);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(body.length, 8);
    descriptor.writeUInt32LE(data.length, 12);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0808, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(offset, 42);
    parts.push(local, nameBytes, body, descriptor);
    central.push(header, nameBytes);
    offset += 30 + nameBytes.length + body.length + 16;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, centralBytes, end]));
}

function localMethods(zip) {
  const view = Buffer.from(zip);
  const methods = {};
  for (let offset = 0; view.readUInt32LE(offset) === 0x04034b50;) {
    const nameLength = view.readUInt16LE(offset + 26);
    const name = view.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    methods[name] = view.readUInt16LE(offset + 8);
    offset += 30 + nameLength + view.readUInt16LE(offset + 28) + view.readUInt32LE(offset + 18);
  }
  return methods;
}

test("zip: round trip of deflated, stored, empty and Unicode-named entries", () => {
  const text = "Week,Region,On time\n".repeat(200);
  const random = NodeCrypto.randomBytes(4096);
  const unicodeName = "données/Überblick 週報 \u{1F4E6}.txt";
  const zip = writeZip([
    { name: "text.csv", data: text },
    { name: "random.bin", data: random },
    { name: unicodeName, data: "Zürich → Tōkyō" },
    { name: "empty.txt", data: "" },
  ]);
  const entries = readZip(zip);
  NodeAssert.deepEqual([...entries.keys()], ["text.csv", "random.bin", unicodeName, "empty.txt"]);
  NodeAssert.equal(decoder.decode(entries.get("text.csv")), text);
  NodeAssert.deepEqual(Buffer.from(entries.get("random.bin")), random);
  NodeAssert.equal(decoder.decode(entries.get(unicodeName)), "Zürich → Tōkyō");
  NodeAssert.equal(entries.get("empty.txt").length, 0);
  const methods = localMethods(zip);
  NodeAssert.deepEqual(
    [methods["text.csv"], methods["random.bin"], methods["empty.txt"]],
    [8, 0, 0],
  );
  NodeAssert.deepEqual(
    writeZip([{ name: "a.txt", data: text }]),
    writeZip([{ name: "a.txt", data: text }]),
  );
});

test("zip: reads entries written with data descriptors", () => {
  const data = encoder.encode("Late = Shipped - On time\n".repeat(50));
  const zip = zipWithDataDescriptors([
    { name: "stored/ünïcode.txt", data, method: 0 },
    { name: "deflated.txt", data, method: 8 },
  ]);
  const entries = readZip(zip);
  NodeAssert.deepEqual(entries.get("stored/ünïcode.txt"), data);
  NodeAssert.deepEqual(entries.get("deflated.txt"), data);
});

test("zip: crc32 matches zlib and bad input fails clearly", () => {
  for (const sample of ["", "a", "The quick brown fox jumps over the lazy dog", "€ 4.80"]) {
    NodeAssert.equal(crc32(encoder.encode(sample)), NodeZlib.crc32(sample));
  }
  NodeAssert.throws(() => readZip(new Uint8Array(64)), { message: "Not a valid zip file" });
  NodeAssert.throws(() => readZip(encoder.encode("Region,Orders\nNorth,5200\n")), {
    message: "Not a valid zip file",
  });
  const zip = writeZip([{ name: "a.txt", data: "a" }]);
  zip[zip.length - 12] = 0xff;
  zip[zip.length - 11] = 0xff;
  NodeAssert.throws(() => readZip(zip), /ZIP64/);
});

test("xlsx: column letters and cell references", () => {
  NodeAssert.deepEqual([0, 25, 26, 27, 701, 702, 16383].map(columnLetter), [
    "A",
    "Z",
    "AA",
    "AB",
    "ZZ",
    "AAA",
    "XFD",
  ]);
  NodeAssert.equal(cellRef(0, 0), "A1");
  NodeAssert.equal(cellRef(11, 27), "AB12");
});

test("xlsx: reads Excel-style parts (rich text, inline strings, errors, gaps, prefixes)", () => {
  const ns = 'xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const zip = writeZip([
    {
      name: "_rels/.rels",
      data: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="/xl/workbook.xml"/></Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0"?><x:workbook ${ns} xmlns:r="${rel}"><x:sheets><x:sheet name="Summary &amp; notes" sheetId="2" r:id="rId2"/><x:sheet name="Data" sheetId="1" r:id="rId1"/></x:sheets></x:workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${rel}/worksheet" Target="/xl/worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${rel}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    },
    {
      name: "xl/sharedStrings.xml",
      data: `<x:sst ${ns}><x:si><x:t>Region</x:t></x:si><x:si><x:r><x:rPr><x:b/></x:rPr><x:t xml:space="preserve">North </x:t></x:r><x:r><x:t>&amp; East</x:t></x:r><x:rPh sb="0" eb="1"><x:t>phonetic</x:t></x:rPh></x:si><x:si><x:t>Line_x000D_\nbreak</x:t></x:si></x:sst>`,
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data: `<x:worksheet ${ns}><x:sheetData>
        <x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c><x:c r="C1" t="inlineStr"><x:is><x:t>Inline &lt;3 &#x2192;</x:t></x:is></x:c></x:row>
        <x:row r="3"><x:c r="A3" t="s"><x:v>1</x:v></x:c><x:c r="B3"><x:v>1.5</x:v></x:c><x:c r="C3" t="b"><x:v>1</x:v></x:c><x:c r="D3" t="e"><x:f>1/0</x:f><x:v>#DIV/0!</x:v></x:c><x:c r="E3" t="str"><x:f>"a"&amp;"b"</x:f><x:v>ab</x:v></x:c><x:c r="F3"><x:f>B3*2</x:f><x:v>3</x:v></x:c><x:c r="G3" s="1"/></x:row>
        <x:row><x:c t="s"><x:v>2</x:v></x:c><x:c><x:v>-2E-3</x:v></x:c></x:row>
        <x:row r="9" s="2" customFormat="1"/>
      </x:sheetData></x:worksheet>`,
    },
    {
      name: "xl/worksheets/sheet2.xml",
      data: `<x:worksheet ${ns}><x:sheetData><x:row r="2"><x:c r="AB2"><x:v>7</x:v></x:c></x:row></x:sheetData></x:worksheet>`,
    },
  ]);

  const { sheets } = readXlsx(zip);
  NodeAssert.deepEqual(
    sheets.map((sheet) => sheet.name),
    ["Summary & notes", "Data"],
  );
  NodeAssert.deepEqual(sheets[1].rows, [
    ["Region", null, "Inline <3 →", null, null, null],
    [null, null, null, null, null, null],
    ["North & East", 1.5, true, "#DIV/0!", "ab", 3],
    ["Line\r\nbreak", -0.002, null, null, null, null],
  ]);
  NodeAssert.equal(sheets[0].rows.length, 2);
  NodeAssert.equal(sheets[0].rows[1].length, 28);
  NodeAssert.equal(sheets[0].rows[1][27], 7);
});

function expectedSampleRows(shipments) {
  return shipments.map((row) => [
    row.week,
    row.weekStart,
    row.region,
    row.carrier,
    row.orders,
    row.shipped,
    row.onTime,
    row.shipped - row.onTime,
    row.returns,
    row.cost,
    row.backlog,
  ]);
}

test("xlsx: sample workbook round trip keeps sheet order, values and cached formula values", () => {
  const shipments = generateShipments();
  const bytes = buildWorkbook(shipments, 48);
  NodeAssert.deepEqual(bytes, buildWorkbook(generateShipments(), 48));

  const { sheets } = readXlsx(bytes);
  NodeAssert.deepEqual(
    sheets.map((sheet) => sheet.name),
    ["Shipments", "Targets", "About"],
  );
  const [header, ...rows] = sheets[0].rows;
  NodeAssert.deepEqual(header, [
    "Week",
    "Week start",
    "Region",
    "Carrier",
    "Orders",
    "Shipped",
    "On time",
    "Late",
    "Returns",
    "Fulfilment cost",
    "Backlog",
  ]);
  NodeAssert.deepEqual(rows, expectedSampleRows(shipments));
  NodeAssert.deepEqual(sheets[1].rows, [
    ["KPI", "Target", "Unit"],
    ["On-time delivery", 0.95, "percent"],
    ["Cost per order", 4.8, "currency"],
    ["Returns rate", 0.03, "percent"],
    ["Backlog", 1500, "integer"],
  ]);
  NodeAssert.deepEqual(sheets[2].rows.slice(1, 3), [
    ["Source system", "Contoso WMS weekly extract (fictional demo data)"],
    ["Extracted", "2026-11-30 06:00 UTC"],
  ]);

  const sheetXml = decoder.decode(readZip(bytes).get("xl/worksheets/sheet1.xml"));
  NodeAssert.match(sheetXml, /<c r="H2" s="\d+"><f>F2-G2<\/f><v>\d+<\/v><\/c>/);
  NodeAssert.match(
    sheetXml,
    /<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/,
  );
  NodeAssert.match(sheetXml, /<autoFilter ref="A1:K169"\/>/);
});

test("xlsx: committed sample files match the generator", () => {
  const shipments = generateShipments();
  for (const { lastWeek, file } of SAMPLE_FILES) {
    const committed = readXlsx(NodeFS.readFileSync(NodePath.join(SAMPLE_DIR, file)));
    NodeAssert.deepEqual(committed, readXlsx(buildWorkbook(shipments, lastWeek)), file);
  }
});

test("xlsx: reads the sample workbook after LibreOffice re-saves it", { skip: NO_SOFFICE }, () => {
  withTempDir((dir) => {
    const source = NodePath.join(SAMPLE_DIR, "contoso-fulfilment-2026-W47.xlsx");
    const resaved = convertWithSoffice(source, "xlsx", dir);
    const original = readXlsx(NodeFS.readFileSync(source));
    const roundTripped = readXlsx(NodeFS.readFileSync(resaved));
    NodeAssert.notDeepEqual(NodeFS.readFileSync(resaved), NodeFS.readFileSync(source));
    NodeAssert.deepEqual(roundTripped, original);
  });
});

function loadSample(file) {
  const path = NodePath.join(SAMPLE_DIR, file);
  NodeAssert.ok(NodeFS.existsSync(path), `${path} is missing: run scripts/make-sample-data.mjs`);
  const [header, ...rows] = readXlsx(NodeFS.readFileSync(path)).sheets[0].rows;
  return rows.map((row) => Object.fromEntries(header.map((name, i) => [name, row[i]])));
}

const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);
const onTimeRate = (rows) => sum(rows, "On time") / sum(rows, "Shipped");
const isLane = (row) => row.Region === "North" && row.Carrier === "Northwind Freight";

function assertBetween(value, min, max, label) {
  NodeAssert.ok(value >= min && value <= max, `${label}: ${value} is outside [${min}, ${max}]`);
}

test("sample data: the week 47 workbook tells the storm story", () => {
  const rows = loadSample("contoso-fulfilment-2026-W47.xlsx");
  NodeAssert.equal(rows.length, 156);
  const weeks = Map.groupBy(rows, (row) => row.Week);
  NodeAssert.deepEqual(
    [...weeks.keys()],
    Array.from({ length: 13 }, (_, i) => `2026-W${35 + i}`),
  );
  NodeAssert.equal(weeks.get("2026-W35")[0]["Week start"], "2026-08-24");
  NodeAssert.equal(weeks.get("2026-W47")[0]["Week start"], "2026-11-16");

  for (const row of rows) {
    NodeAssert.equal(row.Late, row.Shipped - row["On time"]);
    const label = `${row.Week} ${row.Region} ${row.Carrier}`;
    assertBetween(row.Returns / row.Shipped, 0.024, 0.033, `${label} returns rate`);
    if (row.Week === "2026-W47" && row.Region === "North") continue;
    assertBetween(row["On time"] / row.Shipped, 0.934, 0.956, `${label} on-time rate`);
    assertBetween(row.Shipped / row.Orders, 0.969, 0.991, `${label} shipped share`);
    assertBetween(row["Fulfilment cost"] / row.Orders, 4.4, 4.9, `${label} cost per order`);
    assertBetween(row.Backlog, 60, 140, `${label} backlog`);
  }

  for (let week = 35; week <= 46; week++) {
    assertBetween(onTimeRate(weeks.get(`2026-W${week}`)), 0.94, 0.946, `W${week} on-time rate`);
  }
  const w46 = weeks.get("2026-W46");
  const w47 = weeks.get("2026-W47");
  const before = onTimeRate(w46);
  const after = onTimeRate(w47);
  assertBetween(before, 0.941, 0.945, "W46 on-time rate");
  assertBetween(after, 0.895, 0.9, "W47 on-time rate");
  assertBetween(before - after, 0.042, 0.048, "W47 drop");
  assertBetween(sum(w47, "Orders") / sum(w46, "Orders"), 1.05, 1.07, "W47 order growth");

  const lane46 = w46.find(isLane);
  const lane47 = w47.find(isLane);
  assertBetween(onTimeRate([lane47]), 0.66, 0.7, "North x Northwind W47 on-time rate");
  assertBetween(lane47.Backlog / lane46.Backlog, 2.6, 3.4, "North x Northwind backlog growth");
  assertBetween(
    lane47["Fulfilment cost"] / lane47.Orders,
    5.7,
    5.9,
    "North x Northwind cost per order",
  );
  for (const row of w47.filter((r) => r.Region === "North" && !isLane(r))) {
    assertBetween(onTimeRate([row]), 0.91, 0.92, `${row.Carrier} North W47 on-time rate`);
  }
  // The overall rate W47 would have had if this row had kept its W46 on-time rate.
  const recovered =
    (lane47.Shipped * (onTimeRate([lane46]) - onTimeRate([lane47]))) / sum(w47, "Shipped");
  NodeAssert.ok(
    recovered / (before - after) >= 0.65,
    `share of drop ${recovered / (before - after)}`,
  );
});

test("sample data: the week 48 workbook adds a recovering week to identical history", () => {
  const w47File = loadSample("contoso-fulfilment-2026-W47.xlsx");
  const rows = loadSample("contoso-fulfilment-2026-W48.xlsx");
  NodeAssert.equal(rows.length, 168);
  NodeAssert.deepEqual(rows.slice(0, 156), w47File);

  const w46 = rows.filter((row) => row.Week === "2026-W46");
  const w47 = rows.filter((row) => row.Week === "2026-W47");
  const w48 = rows.filter((row) => row.Week === "2026-W48");
  NodeAssert.equal(w48[0]["Week start"], "2026-11-23");
  assertBetween(onTimeRate(w48), 0.92, 0.928, "W48 on-time rate");
  const lane48 = w48.find(isLane);
  assertBetween(onTimeRate([lane48]), 0.84, 0.87, "North x Northwind W48 on-time rate");
  NodeAssert.ok(lane48.Backlog < w47.find(isLane).Backlog, "backlog is falling");
  NodeAssert.ok(lane48.Backlog > 1.5 * w46.find(isLane).Backlog, "backlog is still elevated");
});

test("docx: links become external hyperlink relationships and LibreOffice renders the text", () => {
  const reportUrl = "https://wbr.example.test/report?week=2026-W47&region=North#on-time";
  const cellUrl = "https://wbr.example.test/source/contoso-fulfilment-2026-W47.xlsx#Shipments!G146";
  const bytes = buildDocx({
    title: "Weekly business review 2026-W47",
    header: [{ text: "DRAFT - not approved", bold: true, color: "B91C1C" }],
    footer: "Contoso Fulfilment (fictional)",
    core: { creator: "Fulfilment Analytics", created: "2026-11-24T09:00:00Z" },
    blocks: [
      { type: "heading", level: 1, text: "Summary" },
      {
        type: "paragraph",
        runs: [
          { text: "On-time delivery fell to " },
          { text: "89.8%", bold: true, link: reportUrl },
          { text: " (source " },
          { text: "Shipments!G146", link: cellUrl },
          { text: "), down 4.5 pp & <worse> than target." },
        ],
      },
      {
        type: "paragraph",
        style: "Callout",
        runs: [{ text: "North x Northwind Freight drove the drop." }],
      },
      { type: "bullets", items: [[{ text: "Winter storm at the northern hub" }]] },
      {
        type: "table",
        header: ["Region", "On time"],
        rows: [[[{ text: "North" }], [{ text: "83.2%", link: reportUrl }]]],
      },
    ],
  });

  const parts = readZip(bytes);
  const documentXml = decoder.decode(parts.get("word/document.xml"));
  const relsXml = decoder.decode(parts.get("word/_rels/document.xml.rels"));
  const relationships = new Map(
    [
      ...relsXml.matchAll(
        /<Relationship Id="([^"]+)" Type="([^"]+)" Target="([^"]+)"( TargetMode="External")?\/>/g,
      ),
    ].map(([, id, type, target, external]) => [
      id,
      { type, target: target.replace(/&amp;/g, "&"), external },
    ]),
  );
  const linkIds = [...documentXml.matchAll(/<w:hyperlink r:id="([^"]+)"/g)].map(
    (match) => match[1],
  );
  NodeAssert.equal(linkIds.length, 3);
  for (const id of linkIds) {
    const relationship = relationships.get(id);
    NodeAssert.ok(relationship?.external, `${id} is not an external relationship`);
    NodeAssert.ok(relationship.type.endsWith("/hyperlink"));
  }
  NodeAssert.deepEqual(
    new Set(linkIds.map((id) => relationships.get(id).target)),
    new Set([reportUrl, cellUrl]),
  );
  NodeAssert.match(documentXml, /&amp; &lt;worse&gt;/);
  NodeAssert.ok(parts.has("word/header1.xml") && parts.has("word/footer1.xml"));
  NodeAssert.match(
    decoder.decode(parts.get("docProps/core.xml")),
    /<dc:title>Weekly business review 2026-W47<\/dc:title>/,
  );

  if (!SOFFICE) return;
  withTempDir((dir) => {
    const input = NodePath.join(dir, "briefing.docx");
    NodeFS.writeFileSync(input, bytes);
    const pdf = NodeFS.readFileSync(convertWithSoffice(input, "pdf", dir));
    NodeAssert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-");
    const text = NodeFS.readFileSync(convertWithSoffice(input, "txt:Text", dir), "utf8");
    for (const expected of [
      "Weekly business review 2026-W47",
      "On-time delivery fell to 89.8% (source Shipments!G146), down 4.5 pp & <worse> than target.",
      "North x Northwind Freight drove the drop.",
      "Winter storm at the northern hub",
      "83.2%",
    ]) {
      NodeAssert.ok(text.includes(expected), `LibreOffice text is missing: ${expected}\n${text}`);
    }
  });
});
