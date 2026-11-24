// Briefings are blocks of text with figure tokens such as [[otd.current]]. A token always
// shows the model's current value, so a corrected source figure reaches every briefing, and
// an approval records the values the approver saw so a later change withdraws it.

import { id } from "./store.mjs";
import { summarizeCells } from "../web/cells.js";

const TOKEN = /\[\[([a-z0-9_.]+)\]\]/g;

export function defaultBlocks() {
  const block = (type, fields) => ({ id: id("blk"), type, ...fields });
  return [
    block("heading", { level: 1, text: "Weekly business review: [[week.label]]" }),
    block("paragraph", {
      style: "Callout",
      text:
        "On-time delivery [[otd.change_word]] to [[otd.current]] from [[otd.previous]] ([[otd.delta]]), " +
        "[[otd.gap]] against the [[otd.target]] target. The largest contributor was [[driver.top.label]], " +
        "which accounts for [[driver.top.share]] of the change.",
    }),
    block("heading", { level: 2, text: "What changed" }),
    block("bullets", {
      items: [
        "[[driver.top.label]]: on-time delivery [[driver.top.otd.previous]] → [[driver.top.otd.current]]; late shipments [[driver.top.late.previous]] → [[driver.top.late.current]].",
        "[[driver.second.label]]: on-time delivery [[driver.second.otd.previous]] → [[driver.second.otd.current]] ([[driver.second.share]] of the change).",
        "Without [[driver.top.label]], on-time delivery would have been [[excl_top.otd.current]].",
        "By region: North [[region.north.otd]] ([[region.north.delta]]), South [[region.south.otd]], East [[region.east.otd]], West [[region.west.otd]].",
      ],
    }),
    block("heading", { level: 2, text: "Other measures" }),
    block("table", {
      header: ["Measure", "This week", "Last week", "Target"],
      rows: [
        ["Orders", "[[orders.current]]", "[[orders.previous]]", "–"],
        ["Cost per order", "[[cpo.current]]", "[[cpo.previous]]", "[[cpo.target]]"],
        ["Returns rate", "[[returns.current]]", "[[returns.previous]]", "[[returns.target]]"],
        ["Backlog", "[[backlog.current]]", "[[backlog.previous]]", "[[backlog.target]]"],
      ],
    }),
    block("paragraph", {
      style: "Normal",
      text: "Orders [[orders.change_word]] [[orders.delta_pct]] week on week and backlog [[backlog.change_word]] [[backlog.delta_pct]].",
    }),
    block("heading", { level: 2, text: "Recommended actions" }),
    block("bullets", {
      items: [
        "Agree a recovery plan for [[driver.top.label]] and report on-time delivery daily until it is back above target.",
        "Review expedited re-shipment costs with Finance before month end.",
        "Re-check backlog against the [[backlog.target]] limit at Wednesday's stand-up.",
      ],
    }),
    block("paragraph", {
      style: "Subtle",
      text: "Source: [[source.file]], data [[source.version]]. Every figure links to the report and to its source cells.",
    }),
  ];
}

/** A copy of a briefing's blocks with fresh ids, so a scheduled run can reuse an approved layout. */
export function cloneBlocks(blocks) {
  return blocks.map((block) => ({ ...structuredClone(block), id: id("blk") }));
}

export function textsOf(block) {
  if (block.type === "bullets") return block.items;
  if (block.type === "table") return [...block.header, ...block.rows.flat()];
  return [block.text];
}

export function boundKeys(blocks) {
  const keys = new Set();
  for (const block of blocks) {
    for (const text of textsOf(block)) for (const match of text.matchAll(TOKEN)) keys.add(match[1]);
  }
  return [...keys];
}

/** Splits text into plain strings and figure references, for rendering anywhere. */
export function segments(text) {
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index) });
    parts.push({ key: match[1] });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

/** Numbers typed straight into the text: they will not update and cannot be traced. */
export function checks(blocks, figures) {
  const problems = [];
  for (const block of blocks) {
    for (const text of textsOf(block)) {
      for (const match of text.matchAll(TOKEN)) {
        if (!figures[match[1]]) {
          problems.push({
            blockId: block.id,
            kind: "unknown-figure",
            detail: `[[${match[1]}]] is not a figure.`,
          });
        }
      }
      const plain = text.replace(TOKEN, "");
      const typed = plain.match(/\d[\d,.]*\s?(%|pp)?/g);
      if (typed) {
        problems.push({
          blockId: block.id,
          kind: "typed-number",
          detail: `Typed ${typed.map((value) => `"${value.trim()}"`).join(", ")}: not linked to a figure.`,
        });
      }
    }
  }
  return problems;
}

export function snapshot(blocks, figures) {
  return Object.fromEntries(
    boundKeys(blocks)
      .filter((key) => !figures[key]?.meta)
      .map((key) => [key, figures[key]?.display ?? "(missing)"]),
  );
}

export function diff(before, after) {
  return Object.keys({ ...before, ...after })
    .filter((key) => before[key] !== after[key])
    .map((key) => ({ key, before: before[key] ?? null, after: after[key] ?? null }));
}

export function plainText(text, figures) {
  return segments(text)
    .map((part) => (part.key ? (figures[part.key]?.display ?? `[[${part.key}]]`) : part.text))
    .join("");
}

export function reportUrl(origin, figure) {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(figure.link ?? {})) if (value) params.set(name, value);
  params.set("figure", figure.key);
  return `${origin}/#/report?${params}`;
}

export function sourceUrl(origin, figure) {
  const params = new URLSearchParams({ figure: figure.key });
  if (figure.provenance?.rows?.length) params.set("rows", figure.provenance.rows.join(","));
  if (figure.provenance?.cells?.length) params.set("cells", figure.provenance.cells.join(","));
  return `${origin}/#/data?${params}`;
}

/** The briefing as docx.mjs blocks: figures become bold links to the report. */
export function docxBlocks(briefing, figures, origin) {
  const runs = (text, base = {}) =>
    segments(text).map((part) => {
      if (!part.key) return { ...base, text: part.text };
      const figure = figures[part.key];
      if (!figure) return { ...base, text: `[[${part.key}]]`, color: "B91C1C" };
      return { ...base, text: String(figure.display), bold: true, link: reportUrl(origin, figure) };
    });
  const blocks = [];
  // The first level-1 heading becomes the document title, so it is not repeated.
  const titleBlock = briefing.blocks.find((block) => block.type === "heading" && block.level === 1);
  for (const block of briefing.blocks) {
    if (block === titleBlock) continue;
    if (block.type === "heading") {
      blocks.push({ type: "heading", level: block.level, text: plainText(block.text, figures) });
    } else if (block.type === "paragraph") {
      blocks.push({ type: "paragraph", style: block.style ?? "Normal", runs: runs(block.text) });
    } else if (block.type === "bullets") {
      blocks.push({ type: "bullets", items: block.items.map((item) => runs(item)) });
    } else if (block.type === "table") {
      blocks.push({
        type: "table",
        header: block.header.map((cell) => plainText(cell, figures)),
        rows: block.rows.map((row) => row.map((cell) => runs(cell))),
      });
    }
  }
  const used = boundKeys(briefing.blocks)
    .map((key) => figures[key])
    .filter((figure) => figure?.provenance);
  if (used.length > 0) {
    blocks.push({ type: "pageBreak" });
    blocks.push({ type: "heading", level: 2, text: "Figure sources" });
    blocks.push({
      type: "paragraph",
      style: "Subtle",
      runs: [
        { text: "Each value links to the cells it was calculated from in the source workbook." },
      ],
    });
    blocks.push({
      type: "table",
      header: ["Figure", "Value", "Calculation", "Source cells"],
      columnWidths: [2600, 1300, 2600, 2900],
      rows: used.map((figure) => [
        [{ text: figure.label }],
        [{ text: String(figure.display), bold: true, link: reportUrl(origin, figure) }],
        [
          {
            text: `${figure.provenance.formula}${figure.provenance.filter ? ` where ${figure.provenance.filter}` : ""}`,
          },
        ],
        [
          {
            text: `${figure.provenance.sheet}!${summarizeCells(figure.provenance.cells)}`,
            link: sourceUrl(origin, figure),
          },
        ],
      ]),
    });
  }
  return blocks;
}
