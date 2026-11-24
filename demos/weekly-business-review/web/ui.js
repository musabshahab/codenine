// Small DOM and formatting helpers shared by every page.

export function h(tag, attrs, ...children) {
  const node = document.createElementNS(
    attrs?.svg || ["svg", "g", "path", "line", "rect", "circle", "text", "polyline"].includes(tag)
      ? "http://www.w3.org/2000/svg"
      : "http://www.w3.org/1999/xhtml",
    tag,
  );
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false || key === "svg") continue;
    if (key.startsWith("on") && typeof value === "function")
      node.addEventListener(key.slice(2), value);
    else if (key === "class")
      node.setAttribute("class", Array.isArray(value) ? value.filter(Boolean).join(" ") : value);
    else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
    else if (key === "value" && "value" in node) node.value = value;
    else if (key === "checked" || key === "selected" || key === "disabled")
      node[key] = Boolean(value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(node, child);
    else node.append(child instanceof Node ? child : String(child));
  }
}

export async function api(method, path, body, { raw, headers } = {}) {
  const init = {
    method,
    headers: {
      ...(method === "GET" ? {} : { "x-requested-with": "wbr" }),
      ...(body && !raw ? { "content-type": "application/json" } : {}),
      ...headers,
    },
  };
  if (body) init.body = raw ? body : JSON.stringify(body);
  const response = await fetch(path, init);
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(json.error ?? `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return json;
}

let toastTimer;
export function toast(message, kind = "info") {
  document.querySelector(".toast")?.remove();
  const node = h("div", { class: ["toast", kind === "error" && "error"], role: "status" }, message);
  document.body.append(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), kind === "error" ? 6000 : 3500);
}

/** Runs a server action and reports failure; the SSE refresh shows the result. */
export async function act(work, success) {
  try {
    const result = await work();
    if (success) toast(success);
    return result;
  } catch (error) {
    toast(error.message, "error");
    return undefined;
  }
}

export const tooltip = {
  show(event, content) {
    const node = document.getElementById("tooltip");
    node.replaceChildren(...(Array.isArray(content) ? content : [content]));
    node.hidden = false;
    const x = Math.min(event.clientX + 14, window.innerWidth - node.offsetWidth - 8);
    const y = Math.min(event.clientY + 14, window.innerHeight - node.offsetHeight - 8);
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
  },
  hide() {
    document.getElementById("tooltip").hidden = true;
  },
};

export const pct = (value, digits = 1) => `${(value * 100).toFixed(digits)}%`;
export const pp = (value) =>
  Math.abs(value) < 0.0005
    ? "0.0 pp"
    : `${value >= 0 ? "+" : "−"}${Math.abs(value * 100).toFixed(1)} pp`;
export const money = (value) =>
  `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const int = (value) => Math.round(value).toLocaleString("en-US");
export const signedPct = (value) => `${value >= 0 ? "+" : "−"}${Math.abs(value * 100).toFixed(1)}%`;

export function when(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  const seconds = (Date.now() - date.getTime()) / 1000;
  if (seconds < 45 && seconds > -45) return "just now";
  if (seconds > 0 && seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds > 0 && seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return date.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function dateTime(iso, timeZone) {
  return new Date(iso).toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
    timeZoneName: timeZone ? "short" : undefined,
  });
}

export function avatar(user, { small, client } = {}) {
  if (!user)
    return h("span", { class: ["avatar", small && "sm"], style: { background: "#75746f" } }, "⚙");
  return h(
    "span",
    { class: ["avatar", small && "sm"], style: { background: user.color }, title: user.name },
    user.initials,
    client ? h("span", { class: "client" }, client === "desktop" ? "PC" : "web") : null,
  );
}

export const STATUS_TEXT = {
  draft: "Draft",
  in_review: "In review",
  changes_requested: "Changes requested",
  approved: "Approved",
  shared: "Shared",
};

export function statusChip(status) {
  return h("span", { class: ["chip", status] }, STATUS_TEXT[status] ?? status.replaceAll("_", " "));
}

export function simTag(text = "Simulated") {
  return h(
    "span",
    { class: "sim-tag", title: "Runs locally without a Microsoft 365 tenant" },
    "◇ ",
    text,
  );
}

export function modal(title, body, actions) {
  const back = h("div", {
    class: "modal-back",
    onclick: (event) => event.target === back && close(),
  });
  const close = () => {
    back.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (event) => event.key === "Escape" && close();
  document.addEventListener("keydown", onKey);
  back.append(
    h(
      "div",
      { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": title },
      h(
        "div",
        { class: "card-head" },
        h("h2", null, title),
        h("button", { class: "btn ghost", onclick: close, "aria-label": "Close" }, "✕"),
      ),
      body,
      h("div", { class: "row", style: { justifyContent: "flex-end" } }, actions(close)),
    ),
  );
  document.body.append(back);
  back.querySelector("input, select, textarea")?.focus();
  return close;
}

let openPopover = null;
export function popover(anchor, content) {
  closePopover();
  const node = h("div", { class: "popover", role: "dialog" }, content);
  document.body.append(node);
  const rect = anchor.getBoundingClientRect();
  const top =
    rect.bottom + 6 + node.offsetHeight > window.innerHeight
      ? rect.top - node.offsetHeight - 6
      : rect.bottom + 6;
  node.style.top = `${Math.max(8, top)}px`;
  node.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - node.offsetWidth - 8))}px`;
  openPopover = node;
  setTimeout(() => document.addEventListener("pointerdown", outside), 0);
  return node;
}
function outside(event) {
  if (openPopover && !openPopover.contains(event.target)) closePopover();
}
export function closePopover() {
  openPopover?.remove();
  openPopover = null;
  document.removeEventListener("pointerdown", outside);
}

const TOKEN = /\[\[([a-z0-9_.]+)\]\]/g;

/** Text with figure tokens rendered as clickable chips. */
export function richText(text, figures, { changes, onFigure } = {}) {
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const figure = figures[match[1]];
    const change = changes?.find((c) => c.key === match[1]);
    parts.push(
      figure
        ? h(
            "button",
            {
              class: ["fig", change && "changed"],
              type: "button",
              "data-figure": figure.key,
              title: `${figure.label}${change ? ` (was ${change.before})` : ""}`,
              onclick: (event) => onFigure?.(event.currentTarget, figure),
            },
            String(figure.display),
            change ? h("span", { class: "was" }, change.before) : null,
          )
        : h("span", { class: "fig missing", title: "Not a figure" }, `[[${match[1]}]]`),
    );
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function plainText(text, figures) {
  return text.replace(TOKEN, (token, key) => figures[key]?.display ?? token);
}

export function figureParams(figure) {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(figure.link ?? {})) if (value) params.set(name, value);
  params.set("figure", figure.key);
  return params;
}
