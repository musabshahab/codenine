// Home: where this week's review stands, what needs you, and the pinned dashboard.

import { h, when, avatar, statusChip, api } from "./ui.js";
import { getReport, kpiTile, trendCard, regionCard } from "./report.js";

function steps(ctx) {
  const dataset = ctx.state.dataset;
  const week = dataset?.weeks.at(-1);
  const briefing = ctx.state.briefings.find((b) => b.week === week);
  const automation = ctx.state.automations[0];
  const list = [
    {
      title: "Import data",
      detail: dataset
        ? `${dataset.fileName}, v${dataset.version}`
        : "Bring in this week's workbook",
      done: Boolean(dataset),
      href: "#/data",
    },
    {
      title: "Investigate",
      detail: dataset ? `Explain the change in ${week}` : "Open the report",
      done: Boolean(briefing),
      href: "#/report",
    },
    {
      title: "Draft briefing",
      detail: briefing ? "Draft ready" : "Generate it from the report",
      done: Boolean(briefing),
      href: briefing ? `#/briefing/${briefing.id}` : "#/report",
    },
    {
      title: "Review",
      detail: briefing?.approval
        ? `Approved by ${ctx.user(briefing.approval.by)?.name}`
        : briefing?.status === "in_review"
          ? "Waiting for the approver"
          : "Comment and approve",
      done: Boolean(briefing?.approval),
      href: briefing ? `#/briefing/${briefing.id}` : "#/briefings",
    },
    {
      title: "Share",
      detail: briefing?.shares.some((s) => !s.revoked) ? "Shared" : "SharePoint, Teams, Outlook",
      done: Boolean(briefing?.shares.some((s) => !s.revoked && !s.outdated)),
      href: briefing ? `#/briefing/${briefing.id}` : "#/briefings",
    },
    {
      title: "Schedule",
      detail: automation ? `Next ${when(automation.nextRunAt)}` : "Run it again next week",
      done: Boolean(automation),
      href: "#/automations",
    },
  ];
  const current = list.findIndex((step) => !step.done);
  return { list, current, week };
}

export function homePage(ctx) {
  const me = ctx.state.me;
  const { list, current, week } = steps(ctx);
  const attention = [
    ...ctx.state.briefings
      .filter((b) => b.status === "in_review" && b.reviewers.includes(me.id))
      .map((b) => ({
        text: `Review “${b.title}”`,
        href: `#/briefing/${b.id}`,
        chip: statusChip(b.status),
      })),
    ...ctx.state.briefings
      .filter(
        (b) =>
          b.createdBy === me.id &&
          ["changes_requested", "approved"].includes(b.status) &&
          ctx.can("briefing.share"),
      )
      .map((b) => ({
        text:
          b.status === "approved"
            ? `Share “${b.title}”`
            : `Address the requested changes to “${b.title}”`,
        href: `#/briefing/${b.id}`,
        chip: statusChip(b.status),
      })),
  ];
  const notifications = ctx.state.notifications.filter((n) => !n.read).slice(0, 5);
  const report = ctx.state.dataset ? getReport(ctx, week, null) : null;
  const pins = ctx.state.pins;

  return h(
    "div",
    { class: "stack", style: { gap: "18px" } },
    h(
      "div",
      { class: "page-head" },
      h(
        "div",
        null,
        h("h1", null, `Good to see you, ${me.name.split(" ")[0]}`),
        h(
          "p",
          null,
          `${ctx.state.roles[ctx.state.role]} in ${ctx.state.workspace.name}${week ? ` · current week ${week}` : ""}`,
        ),
      ),
    ),
    ctx.state.role === "viewer"
      ? null
      : h(
          "section",
          { class: "stack" },
          h("h2", null, "This week's review"),
          h(
            "div",
            { class: "stepper" },
            list.map((step, index) =>
              h(
                "a",
                {
                  class: ["step", step.done && "done", index === current && "current"],
                  href: step.href,
                },
                h("span", { class: "n" }, `Step ${index + 1}`),
                h("strong", null, step.title),
                h("span", { class: "small muted" }, step.detail),
              ),
            ),
          ),
        ),
    h(
      "div",
      { class: "grid-2" },
      h(
        "div",
        { class: "card" },
        h("h2", null, "Needs you"),
        attention.length === 0 && notifications.length === 0
          ? h(
              "p",
              { class: "muted" },
              "Nothing waiting. ",
              current >= 0 && ctx.state.role !== "viewer"
                ? h("a", { href: list[current].href }, `Next: ${list[current].title.toLowerCase()}`)
                : null,
            )
          : h(
              "ul",
              { class: "feed" },
              attention.map((item) =>
                h("li", null, item.chip, h("a", { href: item.href }, item.text)),
              ),
              notifications.map((n) =>
                h(
                  "li",
                  { class: "unread" },
                  h(
                    "a",
                    {
                      href: n.link ?? "#/inbox",
                      onclick: () => api("POST", "/api/notifications/read", { id: n.id }),
                    },
                    n.text,
                  ),
                  h("span", { class: "when", "data-when": n.at }, when(n.at)),
                ),
              ),
            ),
      ),
      h(
        "div",
        { class: "card" },
        h("h2", null, "Recent activity"),
        h(
          "ul",
          { class: "feed" },
          ctx.state.activity
            .slice(0, 6)
            .map((a) =>
              h(
                "li",
                null,
                avatar(ctx.user(a.actor), { small: true }),
                h("span", { style: { flex: 1 } }, a.text),
                h("span", { class: "when", "data-when": a.at }, when(a.at)),
              ),
            ),
        ),
        h("a", { href: "#/activity", class: "small" }, "All activity"),
      ),
    ),
    h(
      "section",
      { class: "stack" },
      h(
        "div",
        { class: "card-head" },
        h("h2", null, "Dashboard"),
        h(
          "span",
          { class: "small muted" },
          "Pin visuals from the report. Pins are shared with the workspace.",
        ),
      ),
      !ctx.state.dataset
        ? h("div", { class: "card empty" }, "Import data to see the dashboard.")
        : !report
          ? h("p", { class: "muted" }, "Loading…")
          : pins.length === 0
            ? h(
                "div",
                { class: "card empty" },
                h("p", null, "Nothing pinned yet."),
                h("a", { class: "btn", href: "#/report" }, "Open the report"),
              )
            : h(
                "div",
                { class: "stack" },
                h(
                  "div",
                  { class: "tiles" },
                  pins
                    .filter((p) => p.visual.startsWith("kpi."))
                    .map((p) => kpiTile(ctx, report, p.visual.slice(4))),
                ),
                h(
                  "div",
                  { class: "grid-2" },
                  pins.some((p) => p.visual === "chart.trend") ? trendCard(ctx, report) : null,
                  pins.some((p) => p.visual === "chart.regions") ? regionCard(ctx, report) : null,
                ),
              ),
    ),
  );
}
