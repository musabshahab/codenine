// Automations, inbox, activity, members and connections.

import { h, api, act, when, avatar, dateTime, simTag, statusChip } from "./ui.js";
import { scheduleDialog } from "./briefing.js";

const DAYS = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const RUN_TEXT = {
  waiting_for_review: "Waiting for review",
  no_new_data: "No new data",
  failed: "Failed",
  running: "Running",
};

export function automationsPage(ctx) {
  const canManage = ctx.can("automation.manage");
  const automations = ctx.state.automations;
  return h(
    "div",
    null,
    h(
      "div",
      { class: "page-head" },
      h(
        "div",
        null,
        h("h1", null, "Automations"),
        h(
          "p",
          null,
          "Recurring work the workspace runs for you. Schedules run on the server, so they do not need anyone's computer to be on.",
        ),
      ),
    ),
    automations.length === 0
      ? h(
          "div",
          { class: "card empty" },
          h(
            "p",
            null,
            "Nothing scheduled. Approve a briefing, then choose “Run this review every week”.",
          ),
          h("a", { class: "btn", href: "#/briefings" }, "Briefings"),
        )
      : automations.map((a) => {
          const template = ctx.state.briefings.find((b) => b.id === a.templateBriefingId);
          const runs = ctx.state.runs.filter((r) => r.automationId === a.id);
          return h(
            "div",
            { class: "card stack", style: { marginBottom: "16px" } },
            h(
              "div",
              { class: "card-head" },
              h(
                "div",
                null,
                h("h2", null, a.name),
                h(
                  "div",
                  { class: "small muted" },
                  `Owner ${ctx.user(a.owner)?.name} · every ${DAYS[a.weekday]} at ${a.time} (${a.timeZone})`,
                ),
              ),
              h(
                "div",
                { class: "row" },
                a.enabled
                  ? h("span", { class: "chip done" }, "On")
                  : h("span", { class: "chip" }, "Paused"),
                canManage
                  ? h(
                      "button",
                      { class: "btn", onclick: () => scheduleDialog(ctx, template, a) },
                      "Edit",
                    )
                  : null,
                canManage
                  ? h(
                      "button",
                      {
                        class: "btn",
                        onclick: () =>
                          act(
                            () => api("PATCH", `/api/automations/${a.id}`, { enabled: !a.enabled }),
                            a.enabled ? "Paused" : "Resumed",
                          ),
                      },
                      a.enabled ? "Pause" : "Resume",
                    )
                  : null,
                canManage
                  ? h(
                      "button",
                      {
                        class: "btn danger",
                        onclick: () =>
                          confirm("Delete this schedule? Past runs stay in the activity log.") &&
                          act(() => api("DELETE", `/api/automations/${a.id}`), "Schedule deleted"),
                      },
                      "Delete",
                    )
                  : null,
              ),
            ),
            h(
              "div",
              { class: "grid-2" },
              h(
                "div",
                null,
                h("div", { class: "small muted" }, "Next run"),
                h(
                  "div",
                  { style: { fontSize: "18px", fontWeight: 600 } },
                  a.nextRunAt ? dateTime(a.nextRunAt, a.timeZone) : "Paused",
                ),
                h(
                  "ol",
                  { class: "small", style: { paddingLeft: "18px" } },
                  h("li", null, `Look for a new workbook in SharePoint › ${a.source} `, simTag()),
                  h("li", null, "Import it and re-apply corrections that the export still lacks"),
                  h("li", null, "Refresh the Power BI semantic model ", simTag()),
                  h("li", null, "Stop if the data quality checks fail"),
                  h(
                    "li",
                    null,
                    "Draft the briefing from ",
                    template
                      ? h("a", { href: `#/briefing/${template.id}` }, "the approved layout")
                      : "the approved layout",
                    ", with this week's figures",
                  ),
                  h(
                    "li",
                    null,
                    `Ask ${a.reviewers.map((id) => ctx.user(id)?.name).join(", ") || "an approver"} to review`,
                  ),
                  h(
                    "li",
                    null,
                    a.autoShare
                      ? "Share to SharePoint, Teams and Outlook once approved "
                      : "You share it after approval",
                    a.autoShare ? simTag() : null,
                  ),
                ),
                canManage
                  ? h(
                      "div",
                      { class: "row" },
                      h(
                        "button",
                        {
                          class: "btn primary",
                          onclick: () =>
                            act(() => api("POST", `/api/automations/${a.id}/run`), "Run finished"),
                        },
                        "Run now",
                      ),
                      h(
                        "span",
                        { class: "small muted" },
                        ctx.state.upcoming.length
                          ? `Next week's export (${ctx.state.upcoming[0].name}) is waiting in the simulated library, so “Run now” plays next Monday's run.`
                          : "No newer export is waiting, so a run will stop at step 1.",
                      ),
                    )
                  : null,
              ),
              h(
                "div",
                null,
                h("div", { class: "small muted" }, "Run history"),
                runs.length === 0 ? h("p", { class: "muted small" }, "No runs yet.") : null,
                runs.map((r) =>
                  h(
                    "details",
                    { class: "runs", open: r === runs[0] },
                    h(
                      "summary",
                      null,
                      h("span", { class: ["chip", r.status] }, RUN_TEXT[r.status] ?? r.status),
                      " ",
                      r.trigger,
                      " · ",
                      when(r.startedAt),
                    ),
                    r.steps.map((s) =>
                      h(
                        "div",
                        { class: "step-line" },
                        h("span", { class: ["chip", s.status] }, s.status),
                        h("span", null, s.name, h("div", { class: "small muted" }, s.detail)),
                      ),
                    ),
                    r.briefingId
                      ? h(
                          "a",
                          { class: "btn small", href: `#/briefing/${r.briefingId}` },
                          "Open the draft",
                        )
                      : null,
                  ),
                ),
              ),
            ),
          );
        }),
  );
}

export function inboxPage(ctx) {
  const list = ctx.state.notifications;
  return h(
    "div",
    null,
    h(
      "div",
      { class: "page-head" },
      h(
        "div",
        null,
        h("h1", null, "Inbox"),
        h(
          "p",
          null,
          "Review requests, comments, approvals, shares and workflow runs. Production also sends these to Teams and email.",
        ),
      ),
      list.some((n) => !n.read)
        ? h(
            "button",
            { class: "btn", onclick: () => act(() => api("POST", "/api/notifications/read", {})) },
            "Mark all read",
          )
        : null,
    ),
    list.length === 0
      ? h("div", { class: "card empty" }, "You're all caught up.")
      : h(
          "div",
          { class: "card" },
          h(
            "ul",
            { class: "feed" },
            list.map((n) =>
              h(
                "li",
                { class: n.read ? null : "unread" },
                h(
                  "span",
                  { style: { flex: 1 } },
                  h(
                    "a",
                    {
                      href: n.link ?? "#/home",
                      onclick: () => api("POST", "/api/notifications/read", { id: n.id }),
                    },
                    n.text,
                  ),
                ),
                h("span", { class: "when", "data-when": n.at }, when(n.at)),
              ),
            ),
          ),
        ),
  );
}

const FILTERS = {
  all: () => true,
  data: (a) => a.kind.startsWith("data"),
  briefings: (a) =>
    ["briefing", "review", "comment", "approval", "changes"].some((p) => a.kind.startsWith(p)),
  automation: (a) => a.kind.startsWith("automation"),
  people: (a) => a.kind.startsWith("member") || a.kind === "signin",
};

export function activityPage(ctx) {
  const filter = ctx.ui.activityFilter ?? "all";
  const list = ctx.state.activity.filter(FILTERS[filter]);
  return h(
    "div",
    null,
    h(
      "div",
      { class: "page-head" },
      h(
        "div",
        null,
        h("h1", null, "Activity"),
        h("p", null, "Everything that changed in this workspace, who did it, and when."),
      ),
    ),
    h(
      "div",
      { class: "seg", style: { marginBottom: "12px" } },
      Object.keys(FILTERS).map((key) =>
        h(
          "button",
          {
            class: filter === key ? "on" : null,
            onclick: () => {
              ctx.ui.activityFilter = key;
              ctx.render();
            },
          },
          key[0].toUpperCase() + key.slice(1),
        ),
      ),
    ),
    h(
      "div",
      { class: "card" },
      h(
        "ul",
        { class: "feed" },
        list.map((a) =>
          h(
            "li",
            null,
            avatar(ctx.user(a.actor), { small: true }),
            h(
              "span",
              { style: { flex: 1 } },
              h("strong", null, ctx.user(a.actor)?.name ?? "Scheduled workflow"),
              " ",
              a.text,
              a.briefingId
                ? h("span", null, " · ", h("a", { href: `#/briefing/${a.briefingId}` }, "open"))
                : null,
            ),
            h("span", { class: "when", title: a.at, "data-when": a.at }, when(a.at)),
          ),
        ),
      ),
    ),
  );
}

const PERMISSION_TEXT = {
  "data.import": "Import workbooks",
  "data.edit": "Correct source figures",
  "briefing.edit": "Draft and edit briefings",
  "briefing.requestReview": "Request review",
  "briefing.comment": "Comment",
  "briefing.approve": "Approve (not their own)",
  "briefing.share": "Share approved briefings",
  "report.pin": "Pin to the dashboard",
  "automation.manage": "Schedule workflows",
  "members.manage": "Manage members",
};
const MATRIX = {
  owner: Object.keys(PERMISSION_TEXT),
  editor: [
    "data.import",
    "data.edit",
    "briefing.edit",
    "briefing.requestReview",
    "briefing.comment",
    "briefing.share",
    "report.pin",
    "automation.manage",
  ],
  approver: ["briefing.comment", "briefing.approve", "report.pin"],
  viewer: ["briefing.comment", "report.pin"],
};

export function membersPage(ctx) {
  const canManage = ctx.can("members.manage");
  const members = ctx.state.workspace.members;
  const outside = ctx.state.directory.filter((user) => !members.some((m) => m.userId === user.id));
  const roles = ctx.state.roles;
  return h(
    "div",
    null,
    h(
      "div",
      { class: "page-head" },
      h(
        "div",
        null,
        h("h1", null, "Members"),
        h(
          "p",
          null,
          "Who can see and change this workspace. Roles are enforced on the server for every action.",
        ),
      ),
    ),
    h(
      "div",
      { class: "card", style: { padding: 0, marginBottom: "16px" } },
      h(
        "table",
        { class: "data" },
        h(
          "thead",
          null,
          h("tr", null, h("th", null, "Person"), h("th", null, "Role"), h("th", null, "")),
        ),
        h(
          "tbody",
          null,
          members.map((m) =>
            h(
              "tr",
              null,
              h(
                "td",
                null,
                h(
                  "div",
                  { class: "row" },
                  avatar(m.user, { small: true }),
                  h(
                    "div",
                    null,
                    h("strong", null, m.user.name),
                    h("div", { class: "small muted" }, `${m.user.title} · ${m.user.email}`),
                  ),
                ),
              ),
              h(
                "td",
                null,
                canManage
                  ? h(
                      "select",
                      {
                        "aria-label": `Role for ${m.user.name}`,
                        onchange: (e) =>
                          act(
                            () =>
                              api("POST", "/api/members", {
                                userId: m.userId,
                                role: e.target.value,
                              }),
                            "Role changed",
                          ),
                      },
                      Object.entries(roles).map(([id, label]) =>
                        h("option", { value: id, selected: m.role === id }, label),
                      ),
                    )
                  : roles[m.role],
              ),
              h(
                "td",
                null,
                canManage && m.userId !== ctx.state.me.id
                  ? h(
                      "button",
                      {
                        class: "btn small danger",
                        onclick: () =>
                          confirm(`Remove ${m.user.name}?`) &&
                          act(
                            () => api("POST", "/api/members", { userId: m.userId, role: null }),
                            "Removed",
                          ),
                      },
                      "Remove",
                    )
                  : null,
              ),
            ),
          ),
        ),
      ),
    ),
    canManage && outside.length
      ? h(
          "div",
          { class: "card stack", style: { marginBottom: "16px" } },
          h(
            "div",
            { class: "row" },
            h("h3", null, "Add people from the directory"),
            simTag("Simulated Entra directory"),
          ),
          outside.map((user) =>
            h(
              "div",
              { class: "row" },
              avatar(user, { small: true }),
              h("span", { style: { flex: 1 } }, `${user.name} · ${user.title}`),
              Object.entries(roles)
                .filter(([id]) => id !== "owner")
                .map(([id, label]) =>
                  h(
                    "button",
                    {
                      class: "btn small",
                      onclick: () =>
                        act(
                          () => api("POST", "/api/members", { userId: user.id, role: id }),
                          `${user.name} added as ${label}`,
                        ),
                    },
                    `Add as ${label}`,
                  ),
                ),
            ),
          ),
        )
      : null,
    h(
      "div",
      { class: "card" },
      h("h3", null, "What each role can do"),
      h(
        "table",
        { class: "data matrix" },
        h(
          "thead",
          null,
          h(
            "tr",
            null,
            h("th", null, "Action"),
            Object.values(roles).map((r) => h("th", null, r)),
          ),
        ),
        h(
          "tbody",
          null,
          Object.entries(PERMISSION_TEXT).map(([permission, text]) =>
            h(
              "tr",
              null,
              h("td", null, text),
              Object.keys(roles).map((role) =>
                h("td", null, MATRIX[role].includes(permission) ? "✓" : "–"),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

export function connectionsPage(ctx) {
  const open = ctx.ui.openRequest;
  return h(
    "div",
    null,
    h(
      "div",
      { class: "page-head" },
      h(
        "div",
        null,
        h("h1", null, "Connections"),
        h(
          "p",
          null,
          "Microsoft 365 and Power BI connections. In this demo each one is simulated; the log shows the request production would send.",
        ),
      ),
    ),
    h(
      "div",
      { class: "grid-2", style: { marginBottom: "16px" } },
      ctx.state.connections.map((c) =>
        h(
          "div",
          { class: "card stack" },
          h("div", { class: "card-head" }, h("h3", null, c.name), simTag()),
          h("div", { class: "small" }, c.purpose),
          h("div", { class: "small" }, h("strong", null, "In the demo: "), c.demo),
          h("div", { class: "small" }, h("strong", null, "In production: "), c.production),
          h("div", { class: "small mono" }, c.scopes.join(" · ")),
        ),
      ),
    ),
    h(
      "div",
      { class: "card" },
      h(
        "div",
        { class: "card-head" },
        h("h3", null, "Request log"),
        h("span", { class: "small muted" }, "Most recent first. Nothing leaves this machine."),
      ),
      ctx.state.requests.length === 0
        ? h(
            "p",
            { class: "muted small" },
            "No calls yet. Import from SharePoint, open the report, or share a briefing.",
          )
        : null,
      h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          { class: "data" },
          h(
            "thead",
            null,
            h(
              "tr",
              null,
              h("th", null, "When"),
              h("th", null, "Connector"),
              h("th", null, "Request"),
              h("th", { class: "num" }, "Status"),
            ),
          ),
          h(
            "tbody",
            null,
            ctx.state.requests.map((r) =>
              h(
                "tr",
                {
                  style: { cursor: r.body ? "pointer" : "default" },
                  onclick: () => {
                    ctx.ui.openRequest = open === r.id ? null : r.id;
                    ctx.render();
                  },
                },
                h("td", { class: "small", "data-when": r.at }, when(r.at)),
                h("td", { class: "small" }, r.connector),
                h(
                  "td",
                  null,
                  h("div", { class: "small" }, r.summary),
                  h(
                    "div",
                    { class: "mono", style: { wordBreak: "break-all" } },
                    `${r.method} ${r.url}`,
                  ),
                  open === r.id && r.body
                    ? h("pre", { class: "log-body" }, JSON.stringify(r.body, null, 2))
                    : null,
                ),
                h("td", { class: "num mono" }, r.status),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

export { statusChip };
