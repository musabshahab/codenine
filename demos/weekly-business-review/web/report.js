// The simulated Power BI report: KPI cards, trend, regions and an exact breakdown of the change.

import { h, api, act, pct, pp, money, int, signedPct, simTag, toast } from "./ui.js";
import { trendChart, dumbbellChart, divergingBar, sparkline } from "./charts.js";

/** Report data for a week and region, fetched once per data version. */
export function getReport(ctx, week, region) {
  const key = `${ctx.state.dataset?.version}|${week ?? ""}|${region ?? ""}`;
  const entry = ctx.cache.get(key);
  if (entry?.data) return entry.data;
  if (!entry) {
    ctx.cache.set(key, { loading: true });
    const params = new URLSearchParams();
    if (week) params.set("week", week);
    if (region) params.set("region", region);
    api("GET", `/api/report?${params}`)
      .then((data) => {
        ctx.cache.set(key, { data });
        ctx.render();
      })
      .catch((error) => {
        ctx.cache.delete(key);
        toast(error.message, "error");
      });
  }
  return null;
}

const KPIS = {
  otd: {
    label: "On-time delivery",
    value: (k) => k.otd,
    format: pct,
    delta: (a, b) => pp(a - b),
    better: "up",
    target: (t) => t.otd,
  },
  orders: {
    label: "Orders",
    value: (k) => k.orders,
    format: int,
    delta: (a, b) => signedPct(a / b - 1),
  },
  cpo: {
    label: "Cost per order",
    value: (k) => k.cpo,
    format: money,
    delta: (a, b) => signedPct(a / b - 1),
    better: "down",
    target: (t) => t.cpo,
  },
  returns: {
    label: "Returns rate",
    value: (k) => k.returnsRate,
    format: pct,
    delta: (a, b) => pp(a - b),
    better: "down",
    target: (t) => t.returns,
  },
  backlog: {
    label: "Backlog",
    value: (k) => k.backlog,
    format: int,
    delta: (a, b) => signedPct(a / b - 1),
    better: "down",
    target: (t) => t.backlog,
  },
};

export function kpiTile(ctx, report, id, { pinnable = true } = {}) {
  const kpi = KPIS[id];
  const now = kpi.value(report.kpis.now);
  const before = report.kpis.before ? kpi.value(report.kpis.before) : null;
  const target = kpi.target?.(report.targets);
  const onTarget =
    target === undefined ? null : kpi.better === "up" ? now >= target : now <= target;
  return h(
    "div",
    { class: "kpi", "data-visual": `kpi.${id}` },
    h("span", { class: "label" }, kpi.label),
    h("span", { class: "value" }, kpi.format(now)),
    before !== null
      ? h("span", { class: "delta" }, `${kpi.delta(now, before)} vs ${report.previous}`)
      : null,
    onTarget === null
      ? null
      : h(
          "span",
          { class: ["status", onTarget ? "good" : "bad"] },
          onTarget ? "✓ On target" : "✕ Off target",
          h(
            "span",
            { class: "muted", style: { fontWeight: 400 } },
            ` (${kpi.label === "Backlog" ? "limit" : "target"} ${kpi.format(target)})`,
          ),
        ),
    pinnable ? pinButton(ctx, `kpi.${id}`) : null,
  );
}

export function pinButton(ctx, visual) {
  const pinned = ctx.state.pins.some((pin) => pin.visual === visual);
  return h(
    "button",
    {
      class: "btn ghost small pin",
      title: pinned ? "Unpin from Home" : "Pin to the workspace dashboard on Home",
      "aria-pressed": String(pinned),
      onclick: () =>
        act(
          () => api("POST", "/api/pins", { visual, on: !pinned }),
          pinned ? "Unpinned from Home" : "Pinned to Home",
        ),
    },
    pinned ? "★ Pinned" : "☆ Pin",
  );
}

export function trendCard(ctx, report, { pinnable = true } = {}) {
  return h(
    "div",
    { class: "card", "data-visual": "otd-trend" },
    h(
      "div",
      { class: "card-head" },
      h("h3", null, `On-time delivery by week${report.region ? ` · ${report.region}` : ""}`),
      pinnable ? pinButton(ctx, "chart.trend") : null,
    ),
    trendChart({
      points: report.trend.map((point) => ({ week: point.week, value: point.otd })),
      target: report.targets.otd,
      selected: report.week,
      onSelect: (week) => setParam(ctx, "week", week),
    }),
  );
}

export function regionCard(ctx, report, { pinnable = true } = {}) {
  return h(
    "div",
    { class: "card", "data-visual": "otd-by-region" },
    h(
      "div",
      { class: "card-head" },
      h("h3", null, "On-time delivery by region"),
      pinnable ? pinButton(ctx, "chart.regions") : null,
    ),
    dumbbellChart({
      rows: report.regions.map((row) => ({
        label: row.region,
        now: row.otd,
        before: row.otdBefore,
      })),
      target: report.targets.otd,
      highlight: report.region,
      onSelect: (region) => setParam(ctx, "region", report.region === region ? "" : region),
    }),
  );
}

function setParam(ctx, name, value) {
  const params = new URLSearchParams(ctx.route.params);
  if (value) params.set(name, value);
  else params.delete(name);
  for (const transient of ["figure", "visual", "carrier"])
    if (name !== transient) params.delete(transient);
  ctx.navigate(`#/report?${params}`);
}

function segmentTrend(ctx, region, carrier) {
  const rows = ctx.state.dataset.rows.filter(
    (row) => row.Region === region && row.Carrier === carrier,
  );
  return rows.map((row) => ({
    week: row.Week,
    otd: row.Shipped ? row["On time"] / row.Shipped : 0,
    row,
  }));
}

export function explanation(report) {
  const change = report.breakdown.change;
  const all = report.breakdown.segments;
  const top = all[0];
  if (!top || !report.previous) return null;
  const now = report.kpis.now.otd;
  const rate = all.reduce((sum, s) => sum + s.rateEffect, 0);
  const mix = all.reduce((sum, s) => sum + s.mixEffect, 0);
  return { change, top, second: all[1], now, rate, mix };
}

export function reportPage(ctx) {
  const dataset = ctx.state.dataset;
  if (!dataset) {
    return h(
      "div",
      { class: "card empty" },
      h("h2", null, "No data yet"),
      h("p", null, "The report reads the workspace's imported workbook."),
      h("a", { class: "btn primary", href: "#/data" }, "Import a workbook"),
    );
  }
  const params = ctx.route.params;
  const week = params.get("week") || dataset.weeks.at(-1);
  const region = params.get("region") || null;
  const report = getReport(ctx, week, region);
  const head = h(
    "div",
    { class: "page-head" },
    h(
      "div",
      null,
      h(
        "div",
        { class: "row" },
        h("h1", null, "Operations performance"),
        simTag("Simulated Power BI report"),
      ),
      h(
        "p",
        null,
        `Semantic model built from ${dataset.fileName}, data v${dataset.version}. Production embeds the organization's real Power BI report here.`,
      ),
    ),
    h(
      "div",
      { class: "row" },
      h(
        "label",
        { class: "field" },
        "Week",
        h(
          "select",
          { onchange: (event) => setParam(ctx, "week", event.target.value), "aria-label": "Week" },
          [...dataset.weeks]
            .reverse()
            .map((value) => h("option", { value, selected: value === week }, value)),
        ),
      ),
      h(
        "label",
        { class: "field" },
        "Region",
        h(
          "div",
          { class: "seg" },
          ["All", "North", "South", "East", "West"].map((name) =>
            h(
              "button",
              {
                class: (name === "All" ? !region : region === name) ? "on" : null,
                onclick: () => setParam(ctx, "region", name === "All" ? "" : name),
              },
              name,
            ),
          ),
        ),
      ),
    ),
  );
  if (!report) return h("div", null, head, h("p", { class: "muted" }, "Loading the report…"));

  const figureKey = params.get("figure");
  const figure =
    figureKey &&
    Object.values(ctx.state.figures)
      .map((f) => f[figureKey])
      .find(Boolean);
  const focusCarrier = params.get("carrier");
  const focusRegion = params.get("region");
  ctx.ui.segment = focusCarrier && focusRegion ? `${focusRegion}|${focusCarrier}` : ctx.ui.segment;
  const selectedSegment =
    report.breakdown.segments.find((s) => `${s.region}|${s.carrier}` === ctx.ui.segment) ??
    report.breakdown.segments[0];
  const extent = Math.max(0.001, ...report.breakdown.segments.map((s) => Math.abs(s.contribution)));
  const story = explanation(report);
  const latestDraft = ctx.state.briefings.find(
    (b) => b.week === report.week && ["draft", "changes_requested"].includes(b.status),
  );

  const visual = params.get("visual");
  if (visual) {
    ctx.afterRender = () => {
      const node = document.querySelector(`[data-visual="${CSS.escape(visual)}"]`);
      node?.classList.add("flash");
      node?.scrollIntoView({ block: "center" });
    };
  }

  return h(
    "div",
    null,
    head,
    figure
      ? h(
          "div",
          { class: "banner info", style: { marginBottom: "14px" } },
          h(
            "span",
            null,
            "Opened from a briefing figure: ",
            h("strong", null, `${figure.label} = ${figure.display}`),
            figure.provenance
              ? ` · ${figure.provenance.formula}${figure.provenance.filter ? ` where ${figure.provenance.filter}` : ""}`
              : "",
          ),
          h("span", { class: "spacer", style: { flex: 1 } }),
          h("button", { class: "btn small", onclick: () => history.back() }, "Back"),
        )
      : null,
    h(
      "div",
      { class: "report" },
      h(
        "div",
        { class: "span-12 tiles" },
        Object.keys(KPIS).map((id) => kpiTile(ctx, report, id)),
      ),
      h("div", { class: "span-7" }, trendCard(ctx, report)),
      h("div", { class: "span-5" }, regionCard(ctx, report)),
      h(
        "div",
        { class: "card span-7", "data-visual": "decomposition" },
        h(
          "div",
          { class: "card-head" },
          h("h3", null, `What drove the change: ${report.previous} → ${report.week}`),
          h("span", { class: "small muted" }, `Overall ${pp(report.breakdown.change)}`),
        ),
        h(
          "p",
          { class: "small muted", style: { marginTop: 0 } },
          "Each row is a region and carrier. Contributions add up exactly to the overall change. Select a row for its trend.",
        ),
        h(
          "div",
          { class: "table-wrap", style: { maxHeight: "none" } },
          h(
            "table",
            { class: "data segments" },
            h(
              "thead",
              null,
              h(
                "tr",
                null,
                h("th", null, "Segment"),
                h("th", { class: "num" }, "On time, last → this"),
                h("th", { class: "num" }, "Late"),
                h("th", { class: "bar-cell" }, "Contribution"),
                h("th", { class: "num" }, "Share"),
              ),
            ),
            h(
              "tbody",
              null,
              report.breakdown.segments.map((s) =>
                h(
                  "tr",
                  {
                    class: selectedSegment === s ? "hl" : null,
                    onclick: () => {
                      ctx.ui.segment = `${s.region}|${s.carrier}`;
                      ctx.render();
                    },
                  },
                  h("td", null, `${s.region} · ${s.carrier}`),
                  h("td", { class: "num" }, `${pct(s.otdBefore)} → ${pct(s.otd)}`),
                  h("td", { class: "num" }, `${int(s.lateBefore)} → ${int(s.late)}`),
                  h(
                    "td",
                    { class: "bar-cell", title: pp(s.contribution) },
                    divergingBar(s.contribution, extent),
                  ),
                  h("td", { class: "num" }, `${Math.round(s.share * 100)}%`),
                ),
              ),
            ),
          ),
        ),
      ),
      h(
        "div",
        { class: "span-5 stack" },
        story
          ? h(
              "div",
              { class: "card explain", "data-visual": "explain" },
              h(
                "div",
                { class: "card-head" },
                h("h3", null, "Explain this change"),
                h("span", { class: "small muted" }, "Calculated, not generated"),
              ),
              h(
                "p",
                null,
                `On-time delivery ${story.change < 0 ? "fell" : "rose"} ${Math.abs(story.change * 100).toFixed(1)} pp to ${pct(story.now)} in ${report.week}.`,
              ),
              h(
                "p",
                null,
                h("strong", null, `${story.top.region} · ${story.top.carrier}`),
                ` explains ${Math.round(story.top.share * 100)}% of it: its on-time rate went from ${pct(story.top.otdBefore)} to ${pct(story.top.otd)} and late shipments from ${int(story.top.lateBefore)} to ${int(story.top.late)}.`,
              ),
              story.second
                ? h(
                    "p",
                    null,
                    `Next is ${story.second.region} · ${story.second.carrier} (${Math.round(story.second.share * 100)}%).`,
                  )
                : null,
              h(
                "p",
                { class: "small muted" },
                `Rate changes account for ${pp(story.rate)} and shifts in shipment mix for ${pp(story.mix)}.`,
              ),
              ctx.can("briefing.edit")
                ? h(
                    "div",
                    { class: "row" },
                    latestDraft
                      ? h(
                          "button",
                          {
                            class: "btn",
                            onclick: () =>
                              act(async () => {
                                const last =
                                  latestDraft.blocks.find((b) => b.type === "bullets") ??
                                  latestDraft.blocks.at(-1);
                                await api("POST", `/api/briefings/${latestDraft.id}/blocks`, {
                                  afterBlockId: last.id,
                                  type: "paragraph",
                                  text: "[[driver.top.label]] explains [[driver.top.share]] of the change: on-time delivery went from [[driver.top.otd.previous]] to [[driver.top.otd.current]]. Without it, on-time delivery would have been [[excl_top.otd.current]].",
                                });
                                ctx.navigate(`#/briefing/${latestDraft.id}`);
                              }, "Added to the briefing"),
                          },
                          "Add to the draft briefing",
                        )
                      : null,
                    h(
                      "button",
                      {
                        class: latestDraft ? "btn" : "btn primary",
                        onclick: () =>
                          act(async () => {
                            const { id } = await api("POST", "/api/briefings", {
                              week: report.week,
                            });
                            ctx.navigate(`#/briefing/${id}`);
                          }, "Briefing drafted"),
                      },
                      `Draft a briefing for ${report.week}`,
                    ),
                  )
                : null,
            )
          : null,
        selectedSegment ? segmentCard(ctx, report, selectedSegment) : null,
      ),
    ),
  );
}

function segmentCard(ctx, report, segment) {
  const trend = segmentTrend(ctx, segment.region, segment.carrier);
  const current = trend.find((point) => point.week === report.week);
  return h(
    "div",
    { class: "card" },
    h("h3", null, `${segment.region} · ${segment.carrier}`),
    h(
      "div",
      { class: "row", style: { alignItems: "flex-end", marginTop: "8px" } },
      sparkline(trend.map((point) => point.otd)),
      h(
        "div",
        null,
        h(
          "div",
          { class: "kpi-value", style: { fontSize: "22px", fontWeight: 650 } },
          pct(segment.otd),
        ),
        h("div", { class: "small muted" }, `on time in ${report.week}`),
      ),
    ),
    h(
      "p",
      { class: "small" },
      `${trend[0].week} to ${trend.at(-1).week}. Contribution to the change: ${pp(segment.contribution)} (rate ${pp(segment.rateEffect)}, mix ${pp(segment.mixEffect)}).`,
    ),
    current
      ? h(
          "a",
          { class: "btn small", href: `#/data?week=${report.week}&rows=${current.row.rowNumber}` },
          `View source row ${current.row.rowNumber}`,
        )
      : null,
  );
}
