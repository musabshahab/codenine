// Hand-drawn SVG charts: thin marks, recessive axes, a hover tooltip on every mark.

import { h, tooltip, pct, pp } from "./ui.js";

const svg = (width, height, ...children) =>
  h("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", svg: true }, ...children);

/** Weekly on-time delivery with the target as a dashed reference line. */
export function trendChart({ points, target, selected, label = "On-time delivery", onSelect }) {
  const width = 640;
  const height = 230;
  const pad = { left: 44, right: 14, top: 14, bottom: 28 };
  const values = points.map((point) => point.value);
  const min = Math.floor(Math.min(...values, target) * 100 - 1) / 100;
  const max = Math.ceil(Math.max(...values, target) * 100 + 0.5) / 100;
  const x = (index) =>
    pad.left + (index * (width - pad.left - pad.right)) / Math.max(1, points.length - 1);
  const y = (value) => pad.top + ((max - value) * (height - pad.top - pad.bottom)) / (max - min);
  const ticks = [];
  for (let value = min; value <= max + 1e-9; value += (max - min) / 4) ticks.push(value);
  const line = points.map((point, index) => `${x(index)},${y(point.value)}`).join(" ");
  const cross = h("line", {
    x1: 0,
    x2: 0,
    y1: pad.top,
    y2: height - pad.bottom,
    stroke: "var(--text-3)",
    "stroke-width": 1,
    visibility: "hidden",
  });
  const marks = points.map((point, index) =>
    h("circle", {
      cx: x(index),
      cy: y(point.value),
      r: point.week === selected ? 5 : 3,
      fill: point.week === selected ? "var(--series-1)" : "var(--surface)",
      stroke: "var(--series-1)",
      "stroke-width": 2,
    }),
  );
  const hit = h("rect", {
    x: pad.left - 10,
    y: pad.top,
    width: width - pad.left - pad.right + 20,
    height: height - pad.top - pad.bottom,
    fill: "transparent",
    style: { cursor: onSelect ? "pointer" : "default" },
  });
  const nearest = (event) => {
    const box = event.currentTarget.ownerSVGElement.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * width;
    let best = 0;
    for (let index = 1; index < points.length; index += 1) {
      if (Math.abs(x(index) - px) < Math.abs(x(best) - px)) best = index;
    }
    return best;
  };
  hit.addEventListener("pointermove", (event) => {
    const index = nearest(event);
    cross.setAttribute("x1", x(index));
    cross.setAttribute("x2", x(index));
    cross.setAttribute("visibility", "visible");
    const point = points[index];
    const before = points[index - 1];
    tooltip.show(event, [
      h("strong", null, point.week),
      h("div", null, `${label}: ${pct(point.value)}`),
      before
        ? h("div", { class: "muted" }, `vs previous week: ${pp(point.value - before.value)}`)
        : null,
      h("div", { class: "muted" }, `Target ${pct(target)}`),
    ]);
  });
  hit.addEventListener("pointerleave", () => {
    cross.setAttribute("visibility", "hidden");
    tooltip.hide();
  });
  if (onSelect) hit.addEventListener("click", (event) => onSelect(points[nearest(event)].week));
  return h(
    "div",
    { class: "chart" },
    h(
      "div",
      { class: "legend" },
      h("span", null, h("i", { style: { background: "var(--series-1)" } }), label),
      h(
        "span",
        null,
        h("i", {
          style: {
            background: "transparent",
            borderTop: "2px dashed var(--text-3)",
            height: "0",
            borderRadius: "0",
          },
        }),
        `Target ${pct(target)}`,
      ),
    ),
    svg(
      width,
      height,
      h(
        "g",
        { class: "grid" },
        ticks.map((value) =>
          h("line", { x1: pad.left, x2: width - pad.right, y1: y(value), y2: y(value) }),
        ),
      ),
      ticks.map((value) =>
        h("text", { x: pad.left - 6, y: y(value) + 4, "text-anchor": "end" }, pct(value, 0)),
      ),
      points.map((point, index) =>
        index % 2 === points.length % 2 || point.week === selected
          ? h(
              "text",
              {
                x: x(index),
                y: height - 8,
                "text-anchor": "middle",
                "font-weight": point.week === selected ? 700 : 400,
              },
              `W${point.week.split("-W")[1]}`,
            )
          : null,
      ),
      h("line", {
        x1: pad.left,
        x2: width - pad.right,
        y1: y(target),
        y2: y(target),
        stroke: "var(--text-3)",
        "stroke-dasharray": "5 4",
        "stroke-width": 1.5,
      }),
      h("polyline", {
        points: line,
        fill: "none",
        stroke: "var(--series-1)",
        "stroke-width": 2,
        "stroke-linejoin": "round",
      }),
      cross,
      marks,
      hit,
    ),
  );
}

/** Last week to this week per region: a dot for each week joined by a line. */
export function dumbbellChart({ rows, target, onSelect, highlight }) {
  const width = 420;
  const rowHeight = 38;
  const pad = { left: 64, right: 56, top: 6, bottom: 24 };
  const height = pad.top + rows.length * rowHeight + pad.bottom;
  const all = rows.flatMap((row) => [row.before, row.now]).concat(target);
  const min = Math.floor(Math.min(...all) * 50) / 50;
  const max = Math.min(1, Math.ceil(Math.max(...all) * 50) / 50);
  const x = (value) => pad.left + ((value - min) * (width - pad.left - pad.right)) / (max - min);
  const ticks = [min, (min + max) / 2, max];
  return h(
    "div",
    { class: "chart" },
    h(
      "div",
      { class: "legend" },
      h("span", null, h("i", { style: { background: "var(--series-prev)" } }), "Last week"),
      h("span", null, h("i", { style: { background: "var(--series-1)" } }), "This week"),
    ),
    svg(
      width,
      height,
      ticks.map((value) =>
        h(
          "g",
          { class: "grid" },
          h("line", { x1: x(value), x2: x(value), y1: pad.top, y2: height - pad.bottom }),
          h("text", { x: x(value), y: height - 6, "text-anchor": "middle" }, pct(value, 0)),
        ),
      ),
      h("line", {
        x1: x(target),
        x2: x(target),
        y1: pad.top,
        y2: height - pad.bottom,
        stroke: "var(--text-3)",
        "stroke-dasharray": "4 4",
      }),
      rows.map((row, index) => {
        const cy = pad.top + index * rowHeight + rowHeight / 2;
        const group = h(
          "g",
          { style: { cursor: onSelect ? "pointer" : "default" } },
          h("rect", {
            x: 0,
            y: cy - rowHeight / 2,
            width,
            height: rowHeight,
            fill: row.label === highlight ? "var(--highlight)" : "transparent",
          }),
          h(
            "text",
            { x: 0, y: cy + 4, "font-weight": row.label === highlight ? 700 : 400 },
            row.label,
          ),
          h("line", {
            x1: x(row.before),
            x2: x(row.now),
            y1: cy,
            y2: cy,
            stroke: "var(--series-prev)",
            "stroke-width": 2,
          }),
          h("circle", {
            cx: x(row.before),
            cy,
            r: 5,
            fill: "var(--series-prev)",
            stroke: "var(--surface)",
            "stroke-width": 2,
          }),
          h("circle", {
            cx: x(row.now),
            cy,
            r: 6,
            fill: "var(--series-1)",
            stroke: "var(--surface)",
            "stroke-width": 2,
          }),
          h("text", { x: width - pad.right + 8, y: cy + 4, fill: "var(--text)" }, pct(row.now)),
        );
        group.addEventListener("pointermove", (event) =>
          tooltip.show(event, [
            h("strong", null, row.label),
            h("div", null, `This week ${pct(row.now)}`),
            h("div", null, `Last week ${pct(row.before)}`),
            h("div", { class: "muted" }, `Change ${pp(row.now - row.before)}`),
          ]),
        );
        group.addEventListener("pointerleave", () => tooltip.hide());
        if (onSelect) group.addEventListener("click", () => onSelect(row.label));
        return group;
      }),
    ),
  );
}

/** Signed bars around zero: each segment's contribution to the change, in percentage points. */
export function divergingBar(value, extent) {
  const width = 200;
  const height = 16;
  const mid = width / 2;
  const length = Math.min(mid - 2, (Math.abs(value) / extent) * (mid - 2));
  return h(
    "svg",
    {
      viewBox: `0 0 ${width} ${height}`,
      svg: true,
      style: { width: "100%", height: "16px" },
      "aria-hidden": "true",
    },
    h("line", { x1: mid, x2: mid, y1: 0, y2: height, stroke: "var(--border)" }),
    h("rect", {
      x: value < 0 ? mid - length : mid,
      y: 3,
      width: Math.max(1, length),
      height: height - 6,
      rx: 2,
      fill: value < 0 ? "var(--neg)" : "var(--pos)",
    }),
  );
}

/** A tiny trend line for one segment. */
export function sparkline(values, { width = 220, height = 48, highlightLast = true } = {}) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const x = (index) => 4 + (index * (width - 8)) / Math.max(1, values.length - 1);
  const y = (value) => 4 + ((max - value) * (height - 8)) / Math.max(1e-9, max - min);
  return h(
    "svg",
    {
      viewBox: `0 0 ${width} ${height}`,
      svg: true,
      style: { width: `${width}px`, height: `${height}px` },
      "aria-hidden": "true",
    },
    h("polyline", {
      points: values.map((value, index) => `${x(index)},${y(value)}`).join(" "),
      fill: "none",
      stroke: "var(--series-1)",
      "stroke-width": 2,
    }),
    highlightLast
      ? h("circle", {
          cx: x(values.length - 1),
          cy: y(values.at(-1)),
          r: 3.5,
          fill: "var(--series-1)",
        })
      : null,
  );
}
