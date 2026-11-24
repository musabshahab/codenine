// Writes the Contoso Fulfilment sample workbooks (fictional data). Re-running gives identical files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { writeXlsx } from "../server/office/xlsx.mjs";

const SEED = 20261123;
const FIRST_WEEK = 35;
const LAST_WEEK = 48;
const YEAR = 2026;
const WEEKLY_TREND = 0.004;
const CARRIERS = ["Northwind Freight", "Fabrikam Logistics", "Tailspin Parcel"];
// Northwind runs the northern hub, so it carries more of North's volume.
const REGIONS = [
  { name: "North", orders: 5200, split: [0.52, 0.31, 0.17] },
  { name: "South", orders: 4100, split: [0.43, 0.36, 0.21] },
  { name: "East", orders: 6300, split: [0.43, 0.36, 0.21] },
  { name: "West", orders: 3800, split: [0.43, 0.36, 0.21] },
];
const BASE_ORDERS = REGIONS.reduce((sum, region) => sum + region.orders, 0);
// Pre-holiday demand lift.
const DEMAND = { 47: 1.055, 48: 1.075 };
// On-time rate that the unaffected rows of a week average to; other weeks draw one at random.
const ON_TIME_LEVEL = { 46: 0.943, 47: 0.937, 48: 0.9395 };

// Week 47: a winter storm shuts the northern hub; Northwind Freight takes the hit. Week 48: recovery.
function incident(week, region, carrier) {
  if (region !== "North" || week < 47) return undefined;
  const northwind = carrier === "Northwind Freight";
  if (week === 47) {
    return northwind
      ? { onTime: [0.66, 0.672], shipped: [0.945, 0.955], costPerOrder: [5.75, 5.85], backlog: 3 }
      : { onTime: [0.912, 0.918], backlog: 1.5 };
  }
  return northwind
    ? { onTime: [0.84, 0.85], shipped: [0.96, 0.97], costPerOrder: [5.15, 5.3], backlog: 2 }
    : { onTime: [0.92, 0.926], backlog: 1.15 };
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function isoWeekMonday(year, week) {
  const DAY = 86_400_000;
  const jan4 = Date.UTC(year, 0, 4);
  const daysSinceMonday = (new Date(jan4).getUTCDay() + 6) % 7;
  return new Date(jan4 + ((week - 1) * 7 - daysSinceMonday) * DAY).toISOString().slice(0, 10);
}

const weekLabel = (week) => `${YEAR}-W${String(week).padStart(2, "0")}`;
const round2 = (value) => Math.round(value * 100) / 100;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function generateShipments() {
  const random = mulberry32(SEED);
  const between = ([min, max]) => min + (max - min) * random();
  const baselineBacklog = new Map();
  const shipments = [];

  for (let week = FIRST_WEEK; week <= LAST_WEEK; week++) {
    const level = ON_TIME_LEVEL[week] ?? between([0.9408, 0.9452]);
    const total =
      BASE_ORDERS *
      (1 + WEEKLY_TREND * (week - FIRST_WEEK)) *
      (DEMAND[week] ?? 1) *
      (1 + between([-0.006, 0.006]));
    // Region noise moves volume between regions without changing the week's total.
    const noise = REGIONS.map(() => between([-0.04, 0.04]));
    const meanNoise = REGIONS.reduce((sum, r, i) => sum + r.orders * noise[i], 0) / BASE_ORDERS;

    const rows = [];
    REGIONS.forEach((region, r) => {
      const regionOrders = (total * region.orders * (1 + noise[r] - meanNoise)) / BASE_ORDERS;
      const nw = region.split[0] + between([-0.015, 0.015]);
      const fab = region.split[1] + between([-0.015, 0.015]);
      [nw, fab, 1 - nw - fab].forEach((share, c) => {
        const carrier = CARRIERS[c];
        const event = incident(week, region.name, carrier);
        const orders = Math.round(regionOrders * share);
        const shipped = Math.round(orders * between(event?.shipped ?? [0.97, 0.99]));
        const key = `${region.name}/${carrier}`;
        // Bigger lanes carry more open orders: 60-140 per row in a normal week.
        let backlog = Math.round(60 + 80 * Math.min(1, orders / 2800) * between([0.85, 1]));
        if (event)
          backlog = Math.round(baselineBacklog.get(key) * event.backlog * between([0.95, 1.05]));
        else baselineBacklog.set(key, backlog);
        rows.push({
          week: weekLabel(week),
          weekStart: isoWeekMonday(YEAR, week),
          region: region.name,
          carrier,
          orders,
          shipped,
          onTimeRate: event ? between(event.onTime) : undefined,
          noise: between([-0.006, 0.006]),
          returns: Math.round(shipped * between([0.025, 0.032])),
          cost: round2(orders * between(event?.costPerOrder ?? [4.4, 4.8])),
          backlog,
        });
      });
    });

    // Centre the row noise so the unaffected rows land on the week's level.
    const normal = rows.filter((row) => row.onTimeRate === undefined);
    const shippedSum = normal.reduce((sum, row) => sum + row.shipped, 0);
    const offset = normal.reduce((sum, row) => sum + row.shipped * row.noise, 0) / shippedSum;
    for (const row of rows) {
      const rate = row.onTimeRate ?? clamp(level + row.noise - offset, 0.935, 0.955);
      const { onTimeRate: _rate, noise: _noise, ...shipment } = row;
      shipments.push({ ...shipment, onTime: Math.round(row.shipped * rate) });
    }
  }
  return shipments;
}

const SHIPMENT_COLUMNS = [
  { header: "Week", format: "text" },
  { header: "Week start", format: "text" },
  { header: "Region", format: "text" },
  { header: "Carrier", format: "text" },
  { header: "Orders", format: "integer" },
  { header: "Shipped", format: "integer" },
  { header: "On time", format: "integer" },
  { header: "Late", format: "integer" },
  { header: "Returns", format: "integer" },
  { header: "Fulfilment cost", format: "currency2" },
  { header: "Backlog", format: "integer" },
];

export function buildWorkbook(shipments, lastWeek) {
  const rows = shipments.filter((row) => row.week <= weekLabel(lastWeek));
  const extracted = `${isoWeekMonday(YEAR, lastWeek + 1)}T06:00:00Z`;
  return writeXlsx({
    properties: {
      title: `Contoso Fulfilment weekly operations ${weekLabel(lastWeek)}`,
      creator: "Fulfilment Analytics",
      created: extracted,
    },
    sheets: [
      {
        name: "Shipments",
        columns: SHIPMENT_COLUMNS,
        freezeHeader: true,
        autoFilter: true,
        rows: rows.map((row, i) => [
          row.week,
          row.weekStart,
          row.region,
          row.carrier,
          row.orders,
          row.shipped,
          row.onTime,
          { formula: `F${i + 2}-G${i + 2}`, value: row.shipped - row.onTime },
          row.returns,
          row.cost,
          row.backlog,
        ]),
      },
      {
        name: "Targets",
        columns: [{ header: "KPI" }, { header: "Target" }, { header: "Unit" }],
        rows: [
          ["On-time delivery", { value: 0.95, format: "percent1" }, "percent"],
          ["Cost per order", { value: 4.8, format: "currency2" }, "currency"],
          ["Returns rate", { value: 0.03, format: "percent1" }, "percent"],
          ["Backlog", { value: 1500, format: "integer" }, "integer"],
        ],
      },
      {
        name: "About",
        columns: [{ header: "Field" }, { header: "Value", width: 64 }],
        rows: [
          ["Source system", "Contoso WMS weekly extract (fictional demo data)"],
          ["Extracted", extracted.replace("T", " ").replace(":00Z", " UTC")],
          ["Owner", "Fulfilment Analytics"],
          ["Notes", "Late is a formula (Shipped - On time); figures are fictional."],
        ],
      },
    ],
  });
}

export const SAMPLE_FILES = [
  { lastWeek: 47, file: "contoso-fulfilment-2026-W47.xlsx" },
  { lastWeek: 48, file: "contoso-fulfilment-2026-W48.xlsx" },
];

function printSummary(shipments) {
  const byWeek = Map.groupBy(shipments, (row) => row.week);
  const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);
  const otd = (rows) => sum(rows, "onTime") / sum(rows, "shipped");
  const pct = (value) => `${(value * 100).toFixed(2)}%`;
  console.log("Week      Orders  On time  Cost/order  Backlog");
  for (const [week, rows] of byWeek) {
    const costPerOrder = (sum(rows, "cost") / sum(rows, "orders")).toFixed(2);
    console.log(
      `${week}  ${String(sum(rows, "orders")).padStart(6)}  ${pct(otd(rows))}  $${costPerOrder}       ${sum(rows, "backlog")}`,
    );
  }
  const before = byWeek.get("2026-W46");
  const after = byWeek.get("2026-W47");
  const drop = otd(before) - otd(after);
  const isNorthwind = (row) => row.region === "North" && row.carrier === "Northwind Freight";
  const lane47 = after.find(isNorthwind);
  const lane46 = before.find(isNorthwind);
  // Share of the drop recovered if this row had kept its week-46 on-time rate.
  const recovered = (lane47.shipped * (otd([lane46]) - otd([lane47]))) / sum(after, "shipped");
  console.log(
    `W47 drop ${(drop * 100).toFixed(2)} pp; North x Northwind Freight explains ${pct(recovered / drop)} (on time ${pct(otd([lane47]))})`,
  );
}

const isMain =
  process.argv[1] &&
  NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const shipments = generateShipments();
  const directory = NodeURL.fileURLToPath(new URL("../sample-data/", import.meta.url));
  NodeFS.mkdirSync(directory, { recursive: true });
  for (const { lastWeek, file } of SAMPLE_FILES) {
    NodeFS.writeFileSync(NodePath.join(directory, file), buildWorkbook(shipments, lastWeek));
    console.log(`Wrote ${NodePath.join(directory, file)}`);
  }
  printSummary(shipments);
}
