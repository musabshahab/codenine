// The semantic model behind the simulated Power BI report and the briefing: weekly KPIs,
// trends, an exact decomposition of a KPI change, and named figures that carry their value,
// their source cells and a link back to the report.

import { columnLetter } from "./office/xlsx.mjs";

export const SHIPMENT_COLUMNS = [
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
];
const NUMERIC = new Set([
  "Orders",
  "Shipped",
  "On time",
  "Late",
  "Returns",
  "Fulfilment cost",
  "Backlog",
]);
export const EDITABLE_COLUMNS = [
  "Orders",
  "Shipped",
  "On time",
  "Returns",
  "Fulfilment cost",
  "Backlog",
];
export const REGIONS = ["North", "South", "East", "West"];

/** Turns a parsed workbook into a dataset, or throws an Error a user can act on. */
export function datasetFromWorkbook(workbook, meta) {
  const sheet = workbook.sheets.find((candidate) => candidate.name === "Shipments");
  if (!sheet) throw new Error('The workbook has no "Shipments" sheet.');
  const [header = [], ...body] = sheet.rows;
  const names = header.map((value) => String(value ?? "").trim());
  const missing = SHIPMENT_COLUMNS.filter((column) => !names.includes(column));
  if (missing.length > 0) {
    throw new Error(`The Shipments sheet is missing ${missing.map((m) => `"${m}"`).join(", ")}.`);
  }
  const rows = [];
  body.forEach((values, index) => {
    if (values.every((value) => value === null || value === "")) return;
    const row = { rowNumber: index + 2 };
    for (const column of SHIPMENT_COLUMNS) {
      const raw = values[names.indexOf(column)];
      row[column] = NUMERIC.has(column) ? toNumber(raw) : String(raw ?? "").trim();
    }
    rows.push(row);
  });
  if (rows.length === 0) throw new Error("The Shipments sheet has no rows.");
  return {
    ...meta,
    columns: names,
    rows,
    targets: readTargets(workbook),
  };
}

function toNumber(value) {
  if (typeof value === "number") return value;
  const parsed = Number(String(value ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function readTargets(workbook) {
  const defaults = { otd: 0.95, cpo: 4.8, returns: 0.03, backlog: 1500 };
  const sheet = workbook.sheets.find((candidate) => candidate.name === "Targets");
  if (!sheet) return defaults;
  const byName = new Map(sheet.rows.slice(1).map((row) => [String(row[0] ?? "").trim(), row[1]]));
  return {
    otd: toNumber(byName.get("On-time delivery") ?? defaults.otd),
    cpo: toNumber(byName.get("Cost per order") ?? defaults.cpo),
    returns: toNumber(byName.get("Returns rate") ?? defaults.returns),
    backlog: toNumber(byName.get("Backlog") ?? defaults.backlog),
  };
}

/** Problems a reviewer should know about before trusting the numbers. */
export function dataQuality(dataset) {
  const issues = [];
  for (const row of dataset.rows) {
    if (row["On time"] > row["Shipped"]) {
      issues.push(`Row ${row.rowNumber}: On time (${row["On time"]}) is more than Shipped.`);
    }
    const late = row["Shipped"] - row["On time"];
    if (Math.abs(late - row["Late"]) > 0.5) {
      issues.push(
        `Row ${row.rowNumber}: Late is ${row["Late"]} but Shipped minus On time is ${late}.`,
      );
    }
  }
  return issues.slice(0, 20);
}

export function weeksOf(dataset) {
  return [...new Set(dataset.rows.map((row) => row.Week))].sort();
}

export function weekStart(dataset, week) {
  return dataset.rows.find((row) => row.Week === week)?.["Week start"] ?? "";
}

function totals(rows) {
  const sum = (column) => rows.reduce((total, row) => total + row[column], 0);
  const shipped = sum("Shipped");
  const onTime = sum("On time");
  const orders = sum("Orders");
  return {
    orders,
    shipped,
    onTime,
    late: shipped - onTime,
    returns: sum("Returns"),
    cost: sum("Fulfilment cost"),
    backlog: sum("Backlog"),
    otd: shipped > 0 ? onTime / shipped : 0,
    cpo: orders > 0 ? sum("Fulfilment cost") / orders : 0,
    returnsRate: shipped > 0 ? sum("Returns") / shipped : 0,
  };
}

const matches = (filter) => (row) =>
  (!filter?.week || row.Week === filter.week) &&
  (!filter?.region || row.Region === filter.region) &&
  (!filter?.carrier || row.Carrier === filter.carrier);

export function previousWeek(dataset, week) {
  const weeks = weeksOf(dataset);
  const index = weeks.indexOf(week);
  return index > 0 ? weeks[index - 1] : null;
}

/** Each region x carrier segment's exact share of a change in overall on-time delivery. */
export function decompose(dataset, week, previous) {
  const current = dataset.rows.filter((row) => row.Week === week);
  const before = dataset.rows.filter((row) => row.Week === previous);
  const shippedNow = current.reduce((total, row) => total + row.Shipped, 0);
  const shippedBefore = before.reduce((total, row) => total + row.Shipped, 0);
  const rateBeforeAll = totals(before).otd;
  const change = totals(current).otd - rateBeforeAll;
  const segments = current.map((row) => {
    const match = before.find((old) => old.Region === row.Region && old.Carrier === row.Carrier);
    const weightNow = row.Shipped / shippedNow;
    const rateNow = row.Shipped > 0 ? row["On time"] / row.Shipped : 0;
    const weightBefore = match ? match.Shipped / shippedBefore : 0;
    const rateBefore = match && match.Shipped > 0 ? match["On time"] / match.Shipped : 0;
    // Rate effect at this week's mix, plus the mix shift measured against last week's overall
    // rate. The mix terms sum to zero around that rate, so contributions add up exactly.
    const rateEffect = weightNow * (rateNow - rateBefore);
    const mixEffect = (weightNow - weightBefore) * (rateBefore - rateBeforeAll);
    const contribution = rateEffect + mixEffect;
    return {
      region: row.Region,
      carrier: row.Carrier,
      otd: rateNow,
      otdBefore: rateBefore,
      late: row.Shipped - row["On time"],
      lateBefore: match ? match.Shipped - match["On time"] : 0,
      contribution,
      rateEffect,
      mixEffect,
      share: change !== 0 ? contribution / change : 0,
      rowNumber: row.rowNumber,
      previousRowNumber: match?.rowNumber ?? null,
    };
  });
  segments.sort((a, b) =>
    change < 0 ? a.contribution - b.contribution : b.contribution - a.contribution,
  );
  return { change, segments };
}

/** Everything the report page shows for a week, optionally filtered to one region. */
export function report(dataset, week, region = null) {
  const weeks = weeksOf(dataset);
  const selected = weeks.includes(week) ? week : weeks.at(-1);
  const previous = previousWeek(dataset, selected);
  const filter = { region };
  const now = totals(dataset.rows.filter(matches({ ...filter, week: selected })));
  const before = previous
    ? totals(dataset.rows.filter(matches({ ...filter, week: previous })))
    : null;
  const trend = weeks.map((each) => {
    const t = totals(dataset.rows.filter(matches({ ...filter, week: each })));
    return { week: each, otd: t.otd, orders: t.orders, cpo: t.cpo, backlog: t.backlog };
  });
  const regions = REGIONS.map((name) => {
    const a = totals(dataset.rows.filter(matches({ week: selected, region: name })));
    const b = previous ? totals(dataset.rows.filter(matches({ week: previous, region: name }))) : a;
    return { region: name, otd: a.otd, otdBefore: b.otd, delta: a.otd - b.otd, late: a.late };
  });
  const breakdown = previous ? decompose(dataset, selected, previous) : { change: 0, segments: [] };
  return {
    week: selected,
    weekStart: weekStart(dataset, selected),
    previous,
    region,
    weeks,
    targets: dataset.targets,
    kpis: { now, before },
    trend,
    regions,
    breakdown: {
      change: breakdown.change,
      segments: region
        ? breakdown.segments.filter((segment) => segment.region === region)
        : breakdown.segments,
    },
  };
}

const percent = (value) => `${(value * 100).toFixed(1)}%`;
const points = (value) =>
  Math.abs(value) < 0.0005
    ? "0.0 pp"
    : `${value >= 0 ? "+" : "−"}${Math.abs(value * 100).toFixed(1)} pp`;
const money = (value) =>
  `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const count = (value) => Math.round(value).toLocaleString("en-US");
const signedPercent = (value) => `${value >= 0 ? "+" : "−"}${Math.abs(value * 100).toFixed(1)}%`;
const changeWord = (value, up, down) => (Math.abs(value) < 1e-9 ? "held" : value > 0 ? up : down);

/** "2026-W47" and "2026-11-16" become "Week 47 (16–22 Nov 2026)". */
export function weekLabel(week, start) {
  const number = Number(week.split("-W")[1]);
  if (!start) return `Week ${number}`;
  const first = new Date(`${start}T00:00:00Z`);
  const last = new Date(first.getTime() + 6 * 86_400_000);
  const month = (date) => date.toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
  const range =
    month(first) === month(last)
      ? `${first.getUTCDate()}–${last.getUTCDate()} ${month(last)}`
      : `${first.getUTCDate()} ${month(first)} – ${last.getUTCDate()} ${month(last)}`;
  return `Week ${number} (${range} ${last.getUTCFullYear()})`;
}

/**
 * The named figures a briefing can bind to, for one week. Each knows its value, how it is
 * shown, where it comes from in the workbook, and which report visual shows it.
 */
export function figures(dataset, week) {
  const previous = previousWeek(dataset, week);
  const rowsNow = dataset.rows.filter((row) => row.Week === week);
  const rowsBefore = dataset.rows.filter((row) => row.Week === previous);
  const now = totals(rowsNow);
  const before = previous ? totals(rowsBefore) : now;
  const col = (name) => columnLetter(dataset.columns.indexOf(name));
  const cells = (rows, columns) =>
    rows.flatMap((row) => columns.map((name) => `${col(name)}${row.rowNumber}`));
  const span = (rows, columns, formula, filterText) => ({
    sheet: "Shipments",
    file: dataset.fileName,
    datasetVersion: dataset.version,
    filter: filterText,
    formula,
    cells: cells(rows, columns),
    rows: rows.map((row) => row.rowNumber),
  });
  const thisWeek = `Week = ${week}`;
  const lastWeek = `Week = ${previous}`;
  const otdNow = span(rowsNow, ["On time", "Shipped"], "SUM(On time) / SUM(Shipped)", thisWeek);
  const otdBefore = span(
    rowsBefore,
    ["On time", "Shipped"],
    "SUM(On time) / SUM(Shipped)",
    lastWeek,
  );
  const list = [];
  const add = (key, label, value, display, provenance, link, meta = false) =>
    list.push({ key, label, value, display, provenance, link: { week, ...link }, meta });

  add("week.label", "Week", week, weekLabel(week, weekStart(dataset, week)), null, {
    visual: "cards",
  });
  // Metadata, not figures: a new data version alone does not withdraw an approval.
  add(
    "source.file",
    "Source workbook",
    dataset.fileName,
    dataset.fileName,
    null,
    { visual: "cards" },
    true,
  );
  add(
    "source.version",
    "Data version",
    dataset.version,
    `v${dataset.version}`,
    null,
    { visual: "cards" },
    true,
  );
  add("otd.current", "On-time delivery, this week", now.otd, percent(now.otd), otdNow, {
    visual: "otd-trend",
  });
  add("otd.previous", "On-time delivery, last week", before.otd, percent(before.otd), otdBefore, {
    visual: "otd-trend",
    week: previous,
  });
  add(
    "otd.delta",
    "On-time delivery, change",
    now.otd - before.otd,
    points(now.otd - before.otd),
    otdNow,
    {
      visual: "otd-trend",
    },
  );
  add(
    "otd.change_word",
    "On-time delivery, direction",
    changeWord(now.otd - before.otd, "rose", "fell"),
    changeWord(now.otd - before.otd, "rose", "fell"),
    otdNow,
    {
      visual: "otd-trend",
    },
  );
  add(
    "otd.target",
    "On-time delivery target",
    dataset.targets.otd,
    percent(dataset.targets.otd),
    {
      sheet: "Targets",
      file: dataset.fileName,
      datasetVersion: dataset.version,
      formula: "Target for On-time delivery",
      cells: ["B2"],
      rows: [],
    },
    { visual: "otd-trend" },
  );
  add(
    "otd.gap",
    "On-time delivery against target",
    now.otd - dataset.targets.otd,
    points(now.otd - dataset.targets.otd),
    otdNow,
    {
      visual: "cards",
    },
  );
  const ordersNow = span(rowsNow, ["Orders"], "SUM(Orders)", thisWeek);
  add("orders.current", "Orders, this week", now.orders, count(now.orders), ordersNow, {
    visual: "cards",
  });
  add(
    "orders.previous",
    "Orders, last week",
    before.orders,
    count(before.orders),
    span(rowsBefore, ["Orders"], "SUM(Orders)", lastWeek),
    {
      visual: "cards",
      week: previous,
    },
  );
  const ordersChange = before.orders > 0 ? now.orders / before.orders - 1 : 0;
  add("orders.delta_pct", "Orders, change", ordersChange, signedPercent(ordersChange), ordersNow, {
    visual: "cards",
  });
  add(
    "orders.change_word",
    "Orders, direction",
    changeWord(ordersChange, "rose", "fell"),
    changeWord(ordersChange, "rose", "fell"),
    ordersNow,
    {
      visual: "cards",
    },
  );
  const costNow = span(
    rowsNow,
    ["Fulfilment cost", "Orders"],
    "SUM(Fulfilment cost) / SUM(Orders)",
    thisWeek,
  );
  add("cpo.current", "Cost per order, this week", now.cpo, money(now.cpo), costNow, {
    visual: "cards",
  });
  add(
    "cpo.previous",
    "Cost per order, last week",
    before.cpo,
    money(before.cpo),
    span(rowsBefore, ["Fulfilment cost", "Orders"], "SUM(Fulfilment cost) / SUM(Orders)", lastWeek),
    {
      visual: "cards",
      week: previous,
    },
  );
  add(
    "cpo.target",
    "Cost per order target",
    dataset.targets.cpo,
    money(dataset.targets.cpo),
    null,
    { visual: "cards" },
  );
  const returnsNow = span(rowsNow, ["Returns", "Shipped"], "SUM(Returns) / SUM(Shipped)", thisWeek);
  add(
    "returns.current",
    "Returns rate, this week",
    now.returnsRate,
    percent(now.returnsRate),
    returnsNow,
    { visual: "cards" },
  );
  add(
    "returns.previous",
    "Returns rate, last week",
    before.returnsRate,
    percent(before.returnsRate),
    span(rowsBefore, ["Returns", "Shipped"], "SUM(Returns) / SUM(Shipped)", lastWeek),
    {
      visual: "cards",
      week: previous,
    },
  );
  add(
    "returns.target",
    "Returns rate target",
    dataset.targets.returns,
    percent(dataset.targets.returns),
    null,
    { visual: "cards" },
  );
  const backlogNow = span(rowsNow, ["Backlog"], "SUM(Backlog)", thisWeek);
  add("backlog.current", "Backlog, this week", now.backlog, count(now.backlog), backlogNow, {
    visual: "cards",
  });
  add(
    "backlog.previous",
    "Backlog, last week",
    before.backlog,
    count(before.backlog),
    span(rowsBefore, ["Backlog"], "SUM(Backlog)", lastWeek),
    {
      visual: "cards",
      week: previous,
    },
  );
  const backlogChange = before.backlog > 0 ? now.backlog / before.backlog - 1 : 0;
  add(
    "backlog.delta_pct",
    "Backlog, change",
    backlogChange,
    signedPercent(backlogChange),
    backlogNow,
    { visual: "cards" },
  );
  add(
    "backlog.change_word",
    "Backlog, direction",
    changeWord(backlogChange, "grew", "fell"),
    changeWord(backlogChange, "grew", "fell"),
    backlogNow,
    {
      visual: "cards",
    },
  );
  add(
    "backlog.target",
    "Backlog limit",
    dataset.targets.backlog,
    count(dataset.targets.backlog),
    null,
    { visual: "cards" },
  );

  for (const region of REGIONS) {
    const a = dataset.rows.filter((row) => row.Week === week && row.Region === region);
    const b = dataset.rows.filter((row) => row.Week === previous && row.Region === region);
    const ta = totals(a);
    const tb = totals(b);
    const key = region.toLowerCase();
    add(
      `region.${key}.otd`,
      `On-time delivery, ${region}`,
      ta.otd,
      percent(ta.otd),
      span(
        a,
        ["On time", "Shipped"],
        "SUM(On time) / SUM(Shipped)",
        `${thisWeek}, Region = ${region}`,
      ),
      {
        visual: "otd-by-region",
        region,
      },
    );
    add(
      `region.${key}.delta`,
      `On-time delivery change, ${region}`,
      ta.otd - tb.otd,
      points(ta.otd - tb.otd),
      span(
        a,
        ["On time", "Shipped"],
        "SUM(On time) / SUM(Shipped)",
        `${thisWeek}, Region = ${region}`,
      ),
      {
        visual: "otd-by-region",
        region,
      },
    );
  }

  if (previous) {
    const { segments } = decompose(dataset, week, previous);
    const describe = (rank, segment) => {
      if (!segment) return;
      const label = `${segment.region} · ${segment.carrier}`;
      const rowNow = rowsNow.filter((row) => row.rowNumber === segment.rowNumber);
      const rowBefore = rowsBefore.filter((row) => row.rowNumber === segment.previousRowNumber);
      const where = `${thisWeek}, Region = ${segment.region}, Carrier = ${segment.carrier}`;
      const link = { visual: "decomposition", region: segment.region, carrier: segment.carrier };
      const source = span(rowNow, ["On time", "Shipped"], "On time / Shipped", where);
      add(
        `driver.${rank}.label`,
        `Contributor ${rank === "top" ? "1" : "2"}`,
        label,
        label,
        source,
        link,
      );
      add(
        `driver.${rank}.share`,
        `Contributor ${rank === "top" ? "1" : "2"}, share of the change`,
        segment.share,
        `${Math.round(segment.share * 100)}%`,
        source,
        link,
      );
      add(
        `driver.${rank}.otd.current`,
        `${label}, on-time this week`,
        segment.otd,
        percent(segment.otd),
        source,
        link,
      );
      add(
        `driver.${rank}.otd.previous`,
        `${label}, on-time last week`,
        segment.otdBefore,
        percent(segment.otdBefore),
        span(
          rowBefore,
          ["On time", "Shipped"],
          "On time / Shipped",
          `${lastWeek}, Region = ${segment.region}, Carrier = ${segment.carrier}`,
        ),
        {
          ...link,
          week: previous,
        },
      );
      add(
        `driver.${rank}.late.current`,
        `${label}, late shipments this week`,
        segment.late,
        count(segment.late),
        span(rowNow, ["Shipped", "On time"], "Shipped − On time", where),
        link,
      );
      add(
        `driver.${rank}.late.previous`,
        `${label}, late shipments last week`,
        segment.lateBefore,
        count(segment.lateBefore),
        span(
          rowBefore,
          ["Shipped", "On time"],
          "Shipped − On time",
          `${lastWeek}, Region = ${segment.region}, Carrier = ${segment.carrier}`,
        ),
        {
          ...link,
          week: previous,
        },
      );
    };
    describe("top", segments[0]);
    describe("second", segments[1]);
    const top = segments[0];
    if (top) {
      const rest = rowsNow.filter(
        (row) => !(row.Region === top.region && row.Carrier === top.carrier),
      );
      const restTotals = totals(rest);
      add(
        "excl_top.otd.current",
        `On-time delivery without ${top.region} · ${top.carrier}`,
        restTotals.otd,
        percent(restTotals.otd),
        span(
          rest,
          ["On time", "Shipped"],
          "SUM(On time) / SUM(Shipped)",
          `${thisWeek}, excluding ${top.region} · ${top.carrier}`,
        ),
        {
          visual: "decomposition",
        },
      );
    }
  }
  return Object.fromEntries(list.map((figure) => [figure.key, figure]));
}
