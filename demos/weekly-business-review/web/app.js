// App shell: session, live sync over server-sent events, routing and the page frame.

import { h, api, act, toast, avatar, when, simTag } from "./ui.js";
import { homePage } from "./home.js";
import { dataPage } from "./data.js";
import { reportPage } from "./report.js";
import { briefingPage, briefingsPage } from "./briefing.js";
import { automationsPage, inboxPage, activityPage, membersPage, connectionsPage } from "./more.js";

const client = new URLSearchParams(location.search).get("client") === "desktop" ? "desktop" : "web";
const root = document.getElementById("app");

const ctx = {
  client,
  session: null,
  state: null,
  presence: [],
  connected: false,
  connection: null,
  drafts: new Map(),
  cache: new Map(),
  ui: {},
  route: parseRoute(),
  user: (id) => ctx.state?.directory.find((user) => user.id === id) ?? null,
  can: (permission) => Boolean(ctx.state?.permissions.includes(permission)),
  navigate(hash) {
    if (location.hash === hash) render();
    else location.hash = hash;
  },
  refresh,
  render: () => render(),
  draft(key, fallback = "") {
    return ctx.drafts.has(key) ? ctx.drafts.get(key) : fallback;
  },
  keep(key, fallback = "") {
    return {
      "data-keep": key,
      value: ctx.draft(key, fallback),
      oninput: (event) => ctx.drafts.set(key, event.target.value),
    };
  },
  forget: (...keys) => keys.forEach((key) => ctx.drafts.delete(key)),
};

function parseRoute() {
  const [path, query = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const [name = "home", id] = path.split("/");
  return { name: name || "home", id, params: new URLSearchParams(query) };
}

const PAGES = {
  home: homePage,
  data: dataPage,
  report: reportPage,
  briefings: briefingsPage,
  briefing: briefingPage,
  automations: automationsPage,
  inbox: inboxPage,
  activity: activityPage,
  members: membersPage,
  connections: connectionsPage,
};

const NAV = [
  ["home", "Home"],
  ["data", "Data"],
  ["report", "Report"],
  ["briefings", "Briefings"],
  ["automations", "Automations"],
  ["inbox", "Inbox"],
  null,
  ["activity", "Activity"],
  ["members", "Members"],
  ["connections", "Connections"],
];

async function boot() {
  ctx.session = await api("GET", "/api/session");
  if (!ctx.session.user) return renderSignIn();
  try {
    ctx.state = await api("GET", "/api/state");
  } catch (error) {
    return renderNoAccess(error.message);
  }
  connect();
  render();
}

async function refresh() {
  try {
    ctx.state = await api("GET", "/api/state");
    render();
  } catch (error) {
    if (error.status === 403) renderNoAccess(error.message);
    else if (error.status === 401) boot();
  }
}

let events;
function connect() {
  events?.close();
  events = new EventSource(`/api/events?client=${client}`);
  events.addEventListener("hello", (event) => {
    const { connection, rev } = JSON.parse(event.data);
    ctx.connection = connection;
    ctx.connected = true;
    reportPresence();
    if (rev !== ctx.state?.rev) refresh();
    else renderSync();
  });
  events.addEventListener("rev", (event) => {
    if (Number(event.data) !== ctx.state?.rev) refresh();
  });
  events.addEventListener("presence", (event) => {
    ctx.presence = JSON.parse(event.data);
    renderPresence();
  });
  events.onerror = () => {
    ctx.connected = false;
    renderSync();
  };
}

function reportPresence() {
  if (!ctx.connection) return;
  api("POST", "/api/presence", { connection: ctx.connection, page: ctx.route.name }).catch(
    () => {},
  );
}

window.addEventListener("hashchange", () => {
  const previous = ctx.route.name;
  ctx.route = parseRoute();
  if (ctx.route.name !== previous) window.scrollTo(0, 0);
  reportPresence();
  if (ctx.state) render();
});

function renderSignIn() {
  const accounts = ctx.session.accounts;
  root.replaceChildren(
    h(
      "div",
      { class: "signin" },
      h(
        "div",
        { class: "signin-card" },
        h(
          "div",
          { class: "ms-logo", "aria-hidden": "true" },
          ["#f25022", "#7fba00", "#00a4ef", "#ffb900"].map((color) =>
            h("span", { style: { background: color } }),
          ),
        ),
        h("h1", null, "Pick an account"),
        h("p", { class: "muted" }, `to continue to ${ctx.session.org.name} · Operations workspace`),
        h(
          "div",
          { class: "banner sim", style: { margin: "12px 0" } },
          simTag("Simulated Microsoft Entra ID"),
          h(
            "span",
            { class: "small" },
            "Production signs in with OpenID Connect and your organization's single sign-on. Here, pick a person to act as.",
          ),
        ),
        accounts.map((account) =>
          h(
            "button",
            {
              class: "account",
              onclick: async () => {
                await act(() => api("POST", "/api/auth/signin", { userId: account.id, client }));
                boot();
              },
            },
            avatar(account),
            h(
              "span",
              null,
              h("strong", null, account.name),
              h("div", { class: "small muted" }, `${account.email} · ${account.title}`),
              account.member
                ? null
                : h("div", { class: "small muted" }, "Not a member of this workspace yet"),
            ),
          ),
        ),
        h(
          "p",
          { class: "small muted", style: { marginTop: "16px" } },
          client === "desktop" ? "Signing in to the desktop app." : "Signing in on the web.",
        ),
      ),
    ),
  );
}

function renderNoAccess(message) {
  root.replaceChildren(
    h(
      "div",
      { class: "signin" },
      h(
        "div",
        { class: "signin-card stack" },
        h("h1", null, "No access yet"),
        h("p", null, message),
        h("button", { class: "btn", onclick: signOut }, "Use another account"),
      ),
    ),
  );
}

async function signOut() {
  events?.close();
  await api("POST", "/api/auth/signout");
  ctx.state = null;
  boot();
}

function unread() {
  return ctx.state.notifications.filter((entry) => !entry.read).length;
}

function renderPresence() {
  const node = document.getElementById("presence");
  if (!node) return;
  const seen = new Map();
  for (const entry of ctx.presence) seen.set(`${entry.userId}:${entry.client}`, entry);
  node.replaceChildren(
    ...[...seen.values()].map((entry) => {
      const person = ctx.user(entry.userId);
      const badge = avatar(person, { small: true, client: entry.client });
      badge.title = `${person?.name} on ${entry.client === "desktop" ? "the desktop app" : "the web"}${entry.page ? ` · ${entry.page}` : ""}`;
      return badge;
    }),
  );
}

function renderSync() {
  const node = document.getElementById("sync");
  if (!node) return;
  node.replaceChildren(
    h("span", { class: ["dot", !ctx.connected && "off"] }),
    ctx.connected ? `Synced · rev ${ctx.state.rev}` : "Reconnecting…",
  );
}

function userMenu() {
  const me = ctx.state.me;
  const wrap = h("div", { class: "menu" });
  const button = h(
    "button",
    {
      class: "btn ghost row",
      "aria-haspopup": "menu",
      onclick: () => {
        const open = wrap.querySelector(".menu-pop");
        if (open) return open.remove();
        wrap.append(
          h(
            "div",
            { class: "menu-pop", role: "menu" },
            h(
              "div",
              { style: { padding: "8px 10px" } },
              h("strong", null, me.name),
              h("div", { class: "small muted" }, `${me.email}`),
              h("div", { class: "small" }, `${ctx.state.roles[ctx.state.role]} in this workspace`),
            ),
            h("button", { onclick: signOut }, "Sign out / switch account"),
            h(
              "button",
              {
                onclick: async () => {
                  if (
                    !confirm(
                      "Reset the demo for everyone? This deletes imported data, briefings and schedules.",
                    )
                  )
                    return;
                  await act(() => api("POST", "/api/demo/reset"), "Demo reset");
                  ctx.drafts.clear();
                  location.hash = "#/home";
                },
              },
              "Reset demo data",
            ),
          ),
        );
      },
    },
    avatar(me),
    h("span", null, me.name.split(" ")[0]),
  );
  wrap.append(button);
  return wrap;
}

function render() {
  if (!ctx.state) return;
  const focused = document.activeElement?.getAttribute?.("data-keep");
  const selection = focused
    ? [document.activeElement.selectionStart, document.activeElement.selectionEnd]
    : null;
  const scroll = window.scrollY;
  const page = PAGES[ctx.route.name] ?? homePage;
  let content;
  try {
    content = page(ctx);
  } catch (error) {
    console.error(error);
    content = h(
      "div",
      { class: "card" },
      h("h2", null, "This page failed to load"),
      h("p", { class: "mono" }, error.message),
    );
  }
  const count = unread();
  root.replaceChildren(
    h(
      "div",
      { class: "shell" },
      h(
        "nav",
        { class: "nav", "aria-label": "Workspace" },
        h(
          "div",
          { class: "brand" },
          h("div", { class: "brand-mark" }, "C9"),
          h("div", null, h("strong", null, "Operations"), h("small", null, ctx.state.org.name)),
        ),
        NAV.map((item) =>
          item
            ? h(
                "a",
                {
                  href: `#/${item[0]}`,
                  class:
                    ctx.route.name === item[0] ||
                    (item[0] === "briefings" && ctx.route.name === "briefing")
                      ? "active"
                      : null,
                },
                h("span", null, item[1]),
                item[0] === "inbox" && count ? h("span", { class: "count" }, count) : null,
              )
            : h("div", { class: "section" }, "Workspace"),
        ),
        h(
          "div",
          { class: "nav-foot" },
          "Demo of a work-focused Codenine workspace. Microsoft 365 parts are simulated.",
        ),
      ),
      h(
        "div",
        { class: "main" },
        h(
          "header",
          { class: "topbar" },
          h("span", { class: "title" }, ctx.state.workspace.name),
          h(
            "span",
            {
              class: "client-badge",
              title:
                "Open the same workspace with ?client=desktop or without it to see both clients stay in sync",
            },
            client === "desktop" ? "Desktop app" : "Web",
          ),
          h("span", { class: "spacer" }),
          h("span", { id: "sync", class: "sync" }),
          h("span", { id: "presence", class: "presence", "aria-label": "People here now" }),
          userMenu(),
        ),
        h("main", { class: "page" }, content),
      ),
    ),
  );
  renderPresence();
  renderSync();
  window.scrollTo(0, scroll);
  if (focused) {
    const node = root.querySelector(`[data-keep="${CSS.escape(focused)}"]`);
    node?.focus();
    if (selection && node?.setSelectionRange) node.setSelectionRange(...selection);
  }
  ctx.afterRender?.();
  ctx.afterRender = null;
}

window.addEventListener("unhandledrejection", (event) =>
  toast(event.reason?.message ?? "Something went wrong", "error"),
);
setInterval(
  () =>
    document
      .querySelectorAll("[data-when]")
      .forEach((node) => (node.textContent = when(node.dataset.when))),
  30_000,
);

boot();
