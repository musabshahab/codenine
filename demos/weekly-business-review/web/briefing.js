// Briefings: a document whose figures stay bound to the data, with review, approval and sharing.

import {
  h,
  api,
  act,
  toast,
  when,
  avatar,
  statusChip,
  simTag,
  modal,
  popover,
  closePopover,
  richText,
  figureParams,
  plainText,
} from "./ui.js";
import { summarizeCells } from "./cells.js";

const TOKEN = /\[\[([a-z0-9_.]+)\]\]/g;

export function briefingsPage(ctx) {
  const dataset = ctx.state.dataset;
  const briefings = ctx.state.briefings;
  return h(
    "div",
    null,
    h(
      "div",
      { class: "page-head" },
      h(
        "div",
        null,
        h("h1", null, "Briefings"),
        h(
          "p",
          null,
          "Word briefings whose figures stay linked to the data. Viewers see a briefing once it is shared.",
        ),
      ),
      ctx.can("briefing.edit") && dataset
        ? h(
            "button",
            {
              class: "btn primary",
              onclick: () =>
                act(async () => {
                  const { id } = await api("POST", "/api/briefings", {
                    week: dataset.weeks.at(-1),
                  });
                  ctx.navigate(`#/briefing/${id}`);
                }, "Briefing drafted"),
            },
            `New briefing for ${dataset.weeks.at(-1)}`,
          )
        : null,
    ),
    briefings.length === 0
      ? h(
          "div",
          { class: "card empty" },
          h(
            "p",
            null,
            ctx.state.role === "viewer"
              ? "Nothing has been shared with you yet."
              : "No briefings yet. Draft one from the report once the data is in.",
          ),
          dataset
            ? h("a", { class: "btn", href: "#/report" }, "Open the report")
            : h("a", { class: "btn", href: "#/data" }, "Import data"),
        )
      : h(
          "div",
          { class: "card", style: { padding: 0 } },
          h(
            "table",
            { class: "data" },
            h(
              "thead",
              null,
              h(
                "tr",
                null,
                h("th", null, "Briefing"),
                h("th", null, "Status"),
                h("th", null, "Author"),
                h("th", null, "Updated"),
                h("th", null, "Comments"),
              ),
            ),
            h(
              "tbody",
              null,
              briefings.map((b) =>
                h(
                  "tr",
                  {
                    style: { cursor: "pointer" },
                    onclick: () => ctx.navigate(`#/briefing/${b.id}`),
                  },
                  h(
                    "td",
                    null,
                    h("a", { href: `#/briefing/${b.id}` }, b.title),
                    b.origin === "automation"
                      ? h("div", { class: "small muted" }, "Drafted by the scheduled workflow")
                      : null,
                  ),
                  h(
                    "td",
                    null,
                    statusChip(b.status),
                    b.approval && !b.approvalCurrent
                      ? h("div", { class: "small muted" }, "figures changed")
                      : null,
                  ),
                  h("td", null, ctx.user(b.createdBy)?.name),
                  h("td", { "data-when": b.versions[0]?.at }, when(b.versions[0]?.at)),
                  h("td", null, `${b.comments.filter((c) => !c.resolved).length} open`),
                ),
              ),
            ),
          ),
        ),
  );
}

function figurePopover(ctx, anchor, figure, briefing) {
  const p = figure.provenance;
  const change = briefing.figureChanges?.changes.find((c) => c.key === figure.key);
  const reportHash = `#/report?${figureParams(figure)}`;
  const dataParams = new URLSearchParams({ figure: figure.key });
  if (p?.rows?.length) dataParams.set("rows", p.rows.join(","));
  if (p?.cells?.length) dataParams.set("cells", p.cells.join(","));
  const week = figure.link?.week;
  if (week) dataParams.set("week", week);
  popover(anchor, [
    h("strong", null, figure.label),
    h("div", { style: { fontSize: "22px", fontWeight: 650 } }, String(figure.display)),
    change
      ? h(
          "div",
          { class: "banner warn small" },
          `Was ${change.before} before ${briefing.figureChanges.reason}.`,
        )
      : null,
    h(
      "dl",
      null,
      h("dt", null, "As of"),
      h("dd", null, `Data v${ctx.state.dataset.version} (${ctx.state.dataset.fileName})`),
      p ? [h("dt", null, "Calculation"), h("dd", { class: "mono" }, p.formula)] : null,
      p?.filter ? [h("dt", null, "Where"), h("dd", null, p.filter)] : null,
      p?.cells?.length
        ? [
            h("dt", null, "Source"),
            h("dd", { class: "mono" }, `${p.sheet}!${summarizeCells(p.cells)}`),
          ]
        : null,
      h("dt", null, "Token"),
      h("dd", { class: "mono" }, `[[${figure.key}]]`),
    ),
    h(
      "div",
      { class: "row" },
      h(
        "a",
        { class: "btn small primary", href: reportHash, onclick: closePopover },
        "Open in report",
      ),
      p?.cells?.length
        ? h(
            "a",
            { class: "btn small", href: `#/data?${dataParams}`, onclick: closePopover },
            "Show source cells",
          )
        : null,
    ),
  ]);
}

function blockText(block) {
  if (block.type === "bullets") return block.items.join("\n");
  if (block.type === "table") return block.rows.map((row) => row.join(" | ")).join("\n");
  return block.text;
}

function blockView(ctx, block, figures, briefing) {
  const options = {
    changes: briefing.figureChanges?.changes,
    onFigure: (anchor, figure) => figurePopover(ctx, anchor, figure, briefing),
  };
  const rich = (text) => richText(text, figures, options);
  if (block.type === "heading") return h(block.level === 1 ? "h1" : "h2", null, rich(block.text));
  if (block.type === "paragraph")
    return h("p", { class: block.style ?? "Normal" }, rich(block.text));
  if (block.type === "bullets")
    return h(
      "ul",
      null,
      block.items.map((item) => h("li", null, rich(item))),
    );
  if (block.type === "table") {
    return h(
      "table",
      null,
      h(
        "thead",
        null,
        h(
          "tr",
          null,
          block.header.map((cell) => h("th", null, rich(cell))),
        ),
      ),
      h(
        "tbody",
        null,
        block.rows.map((row) =>
          h(
            "tr",
            null,
            row.map((cell) => h("td", null, rich(cell))),
          ),
        ),
      ),
    );
  }
  return null;
}

function figureOptions(figures) {
  const groups = new Map();
  for (const figure of Object.values(figures)) {
    const group = figure.key.split(".")[0];
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(figure);
  }
  return [...groups].map(([group, list]) =>
    h(
      "optgroup",
      { label: group },
      list.map((figure) =>
        h("option", { value: figure.key }, `${figure.label} = ${figure.display}`),
      ),
    ),
  );
}

function blockEditor(ctx, block, briefing, figures) {
  const key = `blk-${block.id}`;
  const textarea = h("textarea", {
    rows: block.type === "heading" ? 2 : 5,
    ...ctx.keep(key, blockText(block)),
    "aria-label": "Block text",
  });
  const close = () => {
    ctx.ui.editBlock = null;
    ctx.forget(key);
    ctx.render();
  };
  const save = async () => {
    const value = ctx.draft(key, blockText(block));
    const patch =
      block.type === "bullets"
        ? { items: value.split("\n") }
        : block.type === "table"
          ? {
              rows: value
                .split("\n")
                .filter((line) => line.trim())
                .map((line) => line.split("|").map((cell) => cell.trim())),
            }
          : { text: value };
    if (
      briefing.approval &&
      !confirm("Editing an approved briefing withdraws its approval. Continue?")
    )
      return;
    const ok = await act(
      () => api("PATCH", `/api/briefings/${briefing.id}/blocks/${block.id}`, patch),
      "Saved",
    );
    if (ok) close();
  };
  const insert = h(
    "select",
    {
      "aria-label": "Insert a figure",
      onchange: (event) => {
        const token = `[[${event.target.value}]]`;
        const start = textarea.selectionStart ?? textarea.value.length;
        textarea.setRangeText(token, start, textarea.selectionEnd ?? start, "end");
        ctx.drafts.set(key, textarea.value);
        event.target.value = "";
        textarea.focus();
      },
    },
    h("option", { value: "" }, "Insert a figure…"),
    figureOptions(figures),
  );
  const preview = richText(ctx.draft(key, blockText(block)).split("\n").join(" ⏎ "), figures);
  return h(
    "div",
    { class: "editor" },
    textarea,
    h("div", { class: "small muted" }, "Preview: ", preview),
    h(
      "div",
      { class: "small muted" },
      block.type === "bullets"
        ? "One bullet per line. "
        : block.type === "table"
          ? "One row per line, cells separated by |. "
          : "",
      "Figures are tokens like [[otd.current]]. Typed numbers are flagged because they will not update.",
    ),
    h(
      "div",
      { class: "row" },
      insert,
      h("span", { style: { flex: 1 } }),
      h("button", { class: "btn", onclick: close }, "Cancel"),
      h("button", { class: "btn primary", onclick: save }, "Save"),
    ),
  );
}

function rewriteDialog(ctx, block, briefing, figures) {
  let instruction = "Make it shorter and lead with the cause.";
  const result = h("div", { class: "stack" });
  const input = h("input", {
    type: "text",
    value: instruction,
    oninput: (event) => (instruction = event.target.value),
    style: { width: "100%" },
  });
  modal(
    "Rewrite with a model",
    h(
      "div",
      { class: "stack" },
      h(
        "p",
        { class: "small muted", style: { margin: 0 } },
        "The model sees figure tokens, not numbers. A rewrite that types a number or uses an unknown figure is rejected.",
      ),
      input,
      h("div", { class: "block" }, h("p", null, richText(block.text, figures))),
      result,
    ),
    (close) => [
      h("button", { class: "btn", onclick: close }, "Close"),
      h(
        "button",
        {
          class: "btn primary",
          onclick: async (event) => {
            event.target.disabled = true;
            result.replaceChildren(h("p", { class: "muted" }, "Rewriting…"));
            try {
              const { text } = await api(
                "POST",
                `/api/briefings/${briefing.id}/blocks/${block.id}/rewrite`,
                { instruction },
              );
              result.replaceChildren(
                h("strong", null, "Proposed"),
                h("div", { class: "block" }, h("p", null, richText(text, figures))),
                h(
                  "div",
                  { class: "row" },
                  h(
                    "button",
                    {
                      class: "btn primary",
                      onclick: async () => {
                        if (
                          await act(
                            () =>
                              api("PATCH", `/api/briefings/${briefing.id}/blocks/${block.id}`, {
                                text,
                              }),
                            "Rewrite applied",
                          )
                        )
                          close();
                      },
                    },
                    "Use this",
                  ),
                ),
              );
            } catch (error) {
              result.replaceChildren(h("div", { class: "banner bad" }, error.message));
            }
            event.target.disabled = false;
          },
        },
        "Rewrite",
      ),
    ],
  );
}

function shareDialog(ctx, briefing, figures) {
  const d = ctx.state.destinations;
  const last = briefing.shares[0]?.results ?? [];
  const choice = {
    sharepoint: d.sharepoint[0].id,
    teams: last.some((r) => r.channel === "teams") || !last.length ? d.teams[0].id : null,
    outlook: last.some((r) => r.channel === "outlook") || !last.length ? d.outlook[0].id : null,
  };
  const summary = plainText(
    briefing.blocks.find((b) => b.style === "Callout")?.text ?? "",
    figures,
  );
  const destination = (key, title, list, note) =>
    h(
      "label",
      { class: "dest" },
      h("input", {
        type: "checkbox",
        checked: Boolean(choice[key]),
        onchange: (event) => (choice[key] = event.target.checked ? list[0].id : null),
      }),
      h(
        "div",
        { style: { flex: 1 } },
        h("strong", null, title),
        " ",
        simTag(),
        h("div", { class: "small muted" }, note),
        h(
          "select",
          { onchange: (event) => (choice[key] = event.target.value) },
          list.map((item) => h("option", { value: item.id }, item.label)),
        ),
      ),
    );
  modal(
    `Share “${briefing.title}”`,
    h(
      "div",
      { class: "stack" },
      h(
        "div",
        { class: "banner good small" },
        `Approved by ${ctx.user(briefing.approval.by).name} ${when(briefing.approval.at)}. The shared file carries this approval and links back to the live report.`,
      ),
      destination(
        "sharepoint",
        "Save to SharePoint",
        d.sharepoint,
        "Saves the .docx and creates an organization-wide view link.",
      ),
      destination(
        "teams",
        "Post in Teams",
        d.teams,
        "Posts a card with the summary and a link to the file.",
      ),
      destination(
        "outlook",
        "Email with Outlook",
        d.outlook,
        "Sends the summary with the link (link-first, no attachment).",
      ),
      h(
        "div",
        { class: "grid-2" },
        h(
          "div",
          null,
          h("div", { class: "small muted" }, "Teams card preview"),
          h(
            "div",
            { class: "teams-card" },
            h("strong", null, briefing.title),
            h("p", null, summary),
            h("div", { class: "small muted" }, `Approved and shared by ${ctx.state.me.name}`),
            h("button", { class: "btn small", disabled: true }, "Open briefing"),
          ),
        ),
        h(
          "div",
          null,
          h("div", { class: "small muted" }, "Email preview"),
          h(
            "div",
            { class: "mail" },
            h("strong", null, `Subject: ${briefing.title}`),
            "\n\n",
            summary,
            "\n\nOpen the briefing: (link)",
          ),
        ),
      ),
    ),
    (close) => [
      h("button", { class: "btn", onclick: close }, "Cancel"),
      h(
        "button",
        {
          class: "btn primary",
          onclick: async () => {
            const result = await act(() =>
              api("POST", `/api/briefings/${briefing.id}/share`, choice),
            );
            if (result) {
              toast(
                `Shared to ${result.results.length} place${result.results.length === 1 ? "" : "s"}`,
              );
              ctx.ui.briefingTab = "review";
              close();
            }
          },
        },
        "Share",
      ),
    ],
  );
}

export function scheduleDialog(ctx, briefing, automation) {
  const last = briefing?.shares.find((s) => !s.revoked);
  const form = {
    weekday: automation?.weekday ?? 1,
    time: automation?.time ?? "07:30",
    timeZone: automation?.timeZone ?? "Europe/London",
    reviewers: automation?.reviewers ?? briefing?.reviewers ?? [],
    autoShare: automation
      ? automation.autoShare
      : last
        ? {
            sharepoint: last.results.some((r) => r.channel === "sharepoint")
              ? ctx.state.destinations.sharepoint[0].id
              : null,
            teams: last.results.some((r) => r.channel === "teams")
              ? ctx.state.destinations.teams[0].id
              : null,
            outlook: last.results.some((r) => r.channel === "outlook")
              ? ctx.state.destinations.outlook[0].id
              : null,
          }
        : null,
  };
  const approvers = ctx.state.workspace.members.filter(
    (m) =>
      ["owner", "approver"].includes(m.role) &&
      m.userId !== (briefing?.createdBy ?? automation?.owner),
  );
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  modal(
    automation ? "Edit the weekly schedule" : "Run this review every week",
    h(
      "div",
      { class: "stack" },
      automation
        ? null
        : h(
            "p",
            { style: { margin: 0 } },
            "Each run imports the newest workbook from SharePoint, carries your corrections forward, refreshes the report, drafts the briefing from this approved layout with the new week's figures, and sends it for review.",
          ),
      h(
        "div",
        { class: "row", style: { alignItems: "flex-end" } },
        h(
          "label",
          { class: "field" },
          "Every",
          h(
            "select",
            { onchange: (e) => (form.weekday = Number(e.target.value)) },
            days.map((day, index) =>
              h("option", { value: index + 1, selected: form.weekday === index + 1 }, day),
            ),
          ),
        ),
        h(
          "label",
          { class: "field" },
          "At",
          h("input", {
            type: "time",
            value: form.time,
            onchange: (e) => (form.time = e.target.value),
          }),
        ),
        h(
          "label",
          { class: "field" },
          "Time zone",
          h(
            "select",
            { onchange: (e) => (form.timeZone = e.target.value) },
            [
              "Europe/London",
              "America/New_York",
              "America/Los_Angeles",
              "Asia/Kolkata",
              "Australia/Sydney",
            ].map((zone) => h("option", { value: zone, selected: form.timeZone === zone }, zone)),
          ),
        ),
      ),
      h(
        "div",
        null,
        h("div", { class: "small muted" }, "Send each draft for review to"),
        approvers.map((member) =>
          h(
            "label",
            { class: "row" },
            h("input", {
              type: "checkbox",
              checked: form.reviewers.includes(member.userId),
              onchange: (e) =>
                (form.reviewers = e.target.checked
                  ? [...form.reviewers, member.userId]
                  : form.reviewers.filter((id) => id !== member.userId)),
            }),
            `${member.user.name} (${ctx.state.roles[member.role]})`,
          ),
        ),
      ),
      h(
        "label",
        { class: "dest" },
        h("input", {
          type: "checkbox",
          checked: Boolean(form.autoShare),
          onchange: (e) =>
            (form.autoShare = e.target.checked
              ? {
                  sharepoint: ctx.state.destinations.sharepoint[0].id,
                  teams: ctx.state.destinations.teams[0].id,
                  outlook: ctx.state.destinations.outlook[0].id,
                }
              : null),
        }),
        h(
          "div",
          null,
          h("strong", null, "Share automatically once approved"),
          h(
            "div",
            { class: "small muted" },
            "To the same places as this week. Nothing is shared before an approver approves it. Production posts through the workspace's Teams bot or a customer-created Workflows webhook, because Graph does not allow unattended channel posts.",
          ),
        ),
      ),
    ),
    (close) => [
      h("button", { class: "btn", onclick: close }, "Cancel"),
      h(
        "button",
        {
          class: "btn primary",
          onclick: async () => {
            const body = {
              weekday: form.weekday,
              time: form.time,
              timeZone: form.timeZone,
              reviewerIds: form.reviewers,
              reviewers: form.reviewers,
              autoShare: form.autoShare,
            };
            const ok = automation
              ? await act(
                  () => api("PATCH", `/api/automations/${automation.id}`, body),
                  "Schedule updated",
                )
              : await act(
                  () => api("POST", "/api/automations", { ...body, briefingId: briefing.id }),
                  "Scheduled",
                );
            if (ok) {
              close();
              if (!automation) ctx.navigate("#/automations");
            }
          },
        },
        automation ? "Save" : "Schedule",
      ),
    ],
  );
}

function reviewTab(ctx, briefing, figures) {
  const me = ctx.state.me.id;
  const isAuthor = briefing.createdBy === me;
  const canEdit = ctx.can("briefing.edit");
  const canApprove = ctx.can("briefing.approve") && !isAuthor;
  const open = briefing.comments.filter((c) => !c.resolved);
  const approvers = ctx.state.workspace.members.filter(
    (m) => ["owner", "approver"].includes(m.role) && m.userId !== briefing.createdBy,
  );
  const chosen = ctx.ui.reviewers ?? approvers.slice(0, 1).map((m) => m.userId);
  const scheduled = ctx.state.automations.find((a) => a.templateBriefingId === briefing.id);
  const typed = briefing.checks.filter((c) => c.kind === "typed-number");
  const broken = briefing.checks.filter((c) => c.kind === "unknown-figure");
  return h(
    "div",
    { class: "stack" },
    h(
      "div",
      { class: "row" },
      statusChip(briefing.status),
      briefing.reviewers.length
        ? h(
            "span",
            { class: "small muted" },
            `Reviewer: ${briefing.reviewers.map((id) => ctx.user(id)?.name).join(", ")}`,
          )
        : null,
    ),
    canEdit && ["draft", "changes_requested"].includes(briefing.status)
      ? h(
          "div",
          { class: "stack" },
          h("strong", null, "Ask for approval"),
          approvers.map((m) =>
            h(
              "label",
              { class: "row small" },
              h("input", {
                type: "checkbox",
                checked: chosen.includes(m.userId),
                onchange: (e) => {
                  ctx.ui.reviewers = e.target.checked
                    ? [...chosen, m.userId]
                    : chosen.filter((id) => id !== m.userId);
                },
              }),
              avatar(m.user, { small: true }),
              `${m.user.name} · ${ctx.state.roles[m.role]}`,
            ),
          ),
          h("textarea", {
            rows: 2,
            placeholder: "Message to the reviewer (optional)",
            ...ctx.keep(`review-msg-${briefing.id}`),
          }),
          h(
            "button",
            {
              class: "btn primary",
              onclick: async () => {
                if (
                  await act(
                    () =>
                      api("POST", `/api/briefings/${briefing.id}/review`, {
                        reviewerIds: chosen,
                        message: ctx.draft(`review-msg-${briefing.id}`),
                      }),
                    "Review requested",
                  )
                )
                  ctx.forget(`review-msg-${briefing.id}`);
              },
            },
            "Request review",
          ),
        )
      : null,
    canEdit && briefing.status === "in_review" && !canApprove
      ? h(
          "button",
          {
            class: "btn",
            onclick: () =>
              act(
                () => api("POST", `/api/briefings/${briefing.id}/review/withdraw`),
                "Back to draft",
              ),
          },
          "Take back to draft",
        )
      : null,
    canApprove && briefing.status === "in_review"
      ? h(
          "div",
          { class: "stack" },
          h("strong", null, "Your decision"),
          open.length
            ? h(
                "div",
                { class: "banner warn small" },
                `${open.length} open comment${open.length === 1 ? "" : "s"}. Resolve ${open.length === 1 ? "it" : "them"} before approving.`,
              )
            : null,
          h(
            "button",
            {
              class: "btn primary",
              disabled: open.length > 0,
              onclick: () =>
                act(() => api("POST", `/api/briefings/${briefing.id}/approve`), "Approved"),
            },
            "Approve",
          ),
          h("textarea", {
            rows: 2,
            placeholder: "What needs to change?",
            ...ctx.keep(`changes-${briefing.id}`),
          }),
          h(
            "button",
            {
              class: "btn",
              onclick: async () => {
                if (
                  await act(
                    () =>
                      api("POST", `/api/briefings/${briefing.id}/request-changes`, {
                        note: ctx.draft(`changes-${briefing.id}`),
                      }),
                    "Sent back with your note",
                  )
                )
                  ctx.forget(`changes-${briefing.id}`);
              },
            },
            "Request changes",
          ),
        )
      : null,
    isAuthor && ctx.can("briefing.approve") && briefing.status === "in_review"
      ? h(
          "p",
          { class: "small muted" },
          "You wrote this briefing, so someone else must approve it.",
        )
      : null,
    briefing.approval
      ? h(
          "div",
          { class: "banner good small" },
          h(
            "div",
            null,
            h("strong", null, `Approved by ${ctx.user(briefing.approval.by)?.name}`),
            ` ${when(briefing.approval.at)} · version ${briefing.approval.version} · data v${briefing.approval.datasetVersion}. A change to any of its ${Object.keys(briefing.approval.snapshot).length} figures withdraws it.`,
            briefing.approval.by === me || ctx.state.role === "owner"
              ? h(
                  "div",
                  null,
                  h(
                    "button",
                    {
                      class: "btn small",
                      style: { marginTop: "6px" },
                      onclick: () =>
                        act(
                          () => api("POST", `/api/briefings/${briefing.id}/approval/withdraw`),
                          "Approval withdrawn",
                        ),
                    },
                    "Withdraw approval",
                  ),
                )
              : null,
          ),
        )
      : null,
    briefing.approval && ctx.can("briefing.share")
      ? h(
          "button",
          { class: "btn primary", onclick: () => shareDialog(ctx, briefing, figures) },
          briefing.shares.some((s) => !s.revoked) ? "Share again…" : "Share…",
        )
      : null,
    briefing.approval &&
      ctx.can("automation.manage") &&
      !scheduled &&
      briefing.origin !== "automation"
      ? h(
          "button",
          { class: "btn", onclick: () => scheduleDialog(ctx, briefing) },
          "Run this review every week…",
        )
      : null,
    scheduled
      ? h(
          "a",
          { class: "small", href: "#/automations" },
          `Scheduled: every ${["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][scheduled.weekday]} at ${scheduled.time}`,
        )
      : null,
    h(
      "div",
      null,
      h("strong", null, "Checks"),
      broken.length === 0 && typed.length === 0
        ? h(
            "div",
            { class: "small", style: { color: "var(--good)" } },
            `✓ All ${Object.keys(briefing.snapshot).length} figures are linked to the data`,
          )
        : h(
            "ul",
            { class: "small", style: { paddingLeft: "18px", margin: "4px 0" } },
            [...broken, ...typed].map((c) =>
              h(
                "li",
                {
                  style: { cursor: "pointer" },
                  onclick: () =>
                    document
                      .querySelector(`[data-block="${c.blockId}"]`)
                      ?.scrollIntoView({ block: "center" }),
                },
                c.detail,
              ),
            ),
          ),
    ),
    briefing.shares.length
      ? h(
          "div",
          { class: "stack" },
          h("strong", null, "Shared"),
          briefing.shares.map((s) =>
            h(
              "div",
              { class: "thread" },
              h(
                "div",
                { class: "small" },
                `${s.automated ? "Scheduled workflow for " : ""}${ctx.user(s.by)?.name} · ${when(s.at)} · version ${s.version}, data v${s.datasetVersion}`,
              ),
              s.revoked
                ? h("div", { class: "small muted" }, `Link removed ${when(s.revoked.at)}`)
                : null,
              s.outdated && !s.revoked
                ? h(
                    "div",
                    { class: "banner warn small" },
                    "Figures changed after this was shared. Get it approved again and share the update.",
                  )
                : null,
              s.results.map((r) =>
                h(
                  "div",
                  { class: "small" },
                  `${{ sharepoint: "SharePoint", teams: "Teams", outlook: "Outlook" }[r.channel]}: ${r.target}`,
                ),
              ),
              h(
                "div",
                { class: "row" },
                h(
                  "a",
                  { class: "btn small", href: `/api/briefings/${briefing.id}/shares/${s.id}/docx` },
                  "Shared file",
                ),
                !s.revoked && ctx.can("briefing.share")
                  ? h(
                      "button",
                      {
                        class: "btn small danger",
                        onclick: () =>
                          act(
                            () =>
                              api("POST", `/api/briefings/${briefing.id}/shares/${s.id}/revoke`),
                            "Sharing link removed",
                          ),
                      },
                      "Stop sharing",
                    )
                  : null,
              ),
            ),
          ),
        )
      : null,
  );
}

function commentsTab(ctx, briefing, figures) {
  const blockId = ctx.ui.commentBlock;
  const block = briefing.blocks.find((b) => b.id === blockId);
  const canComment = ctx.can("briefing.comment");
  const composerKey = `comment-${briefing.id}-${blockId ?? "general"}`;
  const threads = [...briefing.comments].sort((a, b) => Boolean(a.resolved) - Boolean(b.resolved));
  const post = async () => {
    const quote = block ? plainText(blockText(block), figures).slice(0, 160) : null;
    if (
      await act(
        () =>
          api("POST", `/api/briefings/${briefing.id}/comments`, {
            blockId: blockId ?? null,
            quote,
            text: ctx.draft(composerKey),
          }),
        "Comment added",
      )
    ) {
      ctx.forget(composerKey);
      ctx.ui.commentBlock = null;
    }
  };
  return h(
    "div",
    { class: "stack" },
    canComment
      ? h(
          "div",
          { class: "stack" },
          block
            ? h(
                "div",
                { class: "small muted" },
                "On: ",
                h("span", { class: "quote" }, richText(blockText(block).slice(0, 140), figures)),
              )
            : h(
                "div",
                { class: "small muted" },
                "General comment (or hover a paragraph and choose Comment)",
              ),
          h("textarea", { rows: 3, placeholder: "Add a comment", ...ctx.keep(composerKey) }),
          h(
            "div",
            { class: "row" },
            h("button", { class: "btn primary small", onclick: post }, "Comment"),
            block
              ? h(
                  "button",
                  {
                    class: "btn small",
                    onclick: () => {
                      ctx.ui.commentBlock = null;
                      ctx.render();
                    },
                  },
                  "Cancel",
                )
              : null,
          ),
        )
      : null,
    threads.length === 0 ? h("p", { class: "muted small" }, "No comments yet.") : null,
    threads.map((c) => {
      const replyKey = `reply-${c.id}`;
      return h(
        "div",
        {
          class: ["thread", c.resolved && "resolved", ctx.ui.activeThread === c.id && "active"],
          onmouseenter: () =>
            document.querySelector(`[data-block="${c.blockId}"]`)?.classList.add("focus"),
          onmouseleave: () =>
            document.querySelector(`[data-block="${c.blockId}"]`)?.classList.remove("focus"),
        },
        c.changeRequest ? h("span", { class: "chip changes_requested" }, "Change request") : null,
        c.quote
          ? h(
              "div",
              {
                class: "quote",
                style: { cursor: "pointer" },
                onclick: () =>
                  document
                    .querySelector(`[data-block="${c.blockId}"]`)
                    ?.scrollIntoView({ block: "center" }),
              },
              c.quote,
            )
          : null,
        [c, ...c.replies].map((m) =>
          h(
            "div",
            { class: "msg" },
            avatar(ctx.user(m.author), { small: true }),
            h(
              "div",
              null,
              h("span", { class: "who" }, ctx.user(m.author)?.name ?? "Scheduled workflow"),
              " ",
              h("span", { class: "small muted", "data-when": m.at }, when(m.at)),
              h("div", null, m.text),
            ),
          ),
        ),
        c.resolved
          ? h(
              "div",
              { class: "small muted" },
              `Resolved by ${ctx.user(c.resolved.by)?.name} ${when(c.resolved.at)}`,
            )
          : null,
        canComment
          ? h(
              "div",
              { class: "row" },
              c.resolved
                ? null
                : h("input", {
                    type: "text",
                    placeholder: "Reply",
                    style: { flex: 1 },
                    ...ctx.keep(replyKey),
                    onkeydown: async (e) => {
                      if (e.key === "Enter" && ctx.draft(replyKey).trim()) {
                        if (
                          await act(() =>
                            api("POST", `/api/briefings/${briefing.id}/comments`, {
                              parentId: c.id,
                              text: ctx.draft(replyKey),
                            }),
                          )
                        )
                          ctx.forget(replyKey);
                      }
                    },
                  }),
              h(
                "button",
                {
                  class: "btn small",
                  onclick: () =>
                    act(() =>
                      api("POST", `/api/briefings/${briefing.id}/comments/${c.id}/resolve`, {
                        resolved: !c.resolved,
                      }),
                    ),
                },
                c.resolved ? "Reopen" : "Resolve",
              ),
            )
          : null,
      );
    }),
  );
}

function figuresTab(ctx, briefing, figures) {
  const keys = Object.keys(briefing.snapshot);
  return h(
    "div",
    { class: "stack" },
    h(
      "p",
      { class: "small muted", style: { margin: 0 } },
      `${keys.length} figures from data v${ctx.state.dataset?.version}. Each links to the report and to its cells.`,
    ),
    h(
      "table",
      { class: "data" },
      h(
        "tbody",
        null,
        keys.map((key) => {
          const figure = figures[key];
          const change = briefing.figureChanges?.changes.find((c) => c.key === key);
          return h(
            "tr",
            null,
            h("td", { class: "small" }, figure?.label ?? key),
            h(
              "td",
              { class: "num" },
              figure
                ? h(
                    "button",
                    {
                      class: ["fig", change && "changed"],
                      onclick: (e) => figurePopover(ctx, e.currentTarget, figure, briefing),
                    },
                    String(figure.display),
                    change ? h("span", { class: "was" }, change.before) : null,
                  )
                : h("span", { class: "fig missing" }, "missing"),
            ),
          );
        }),
      ),
    ),
  );
}

function historyTab(ctx, briefing) {
  const activity = ctx.state.activity.filter((a) => a.briefingId === briefing.id);
  return h(
    "div",
    { class: "stack" },
    h("strong", null, "Versions"),
    h(
      "ul",
      { class: "feed" },
      briefing.versions.map((v, index) =>
        h(
          "li",
          null,
          h("span", { class: "chip" }, `v${v.n}`),
          h(
            "div",
            { style: { flex: 1 } },
            h("div", { class: "small" }, v.note),
            h(
              "div",
              { class: "small muted" },
              `${ctx.user(v.by)?.name ?? "Scheduled workflow"} · ${when(v.at)}`,
            ),
          ),
          index > 0 && ctx.can("briefing.edit")
            ? h(
                "button",
                {
                  class: "btn small",
                  onclick: () =>
                    act(
                      () => api("POST", `/api/briefings/${briefing.id}/restore`, { n: v.n }),
                      `Restored version ${v.n}`,
                    ),
                },
                "Restore",
              )
            : null,
        ),
      ),
    ),
    briefing.approvalHistory.length ? h("strong", null, "Earlier approvals") : null,
    briefing.approvalHistory.map((a) =>
      h(
        "div",
        { class: "small" },
        `${ctx.user(a.by)?.name} approved ${when(a.at)}; withdrawn ${when(a.withdrawnAt)}: ${a.reason}`,
      ),
    ),
    h("strong", null, "Activity"),
    h(
      "ul",
      { class: "feed" },
      activity.map((a) =>
        h(
          "li",
          null,
          avatar(ctx.user(a.actor), { small: true }),
          h(
            "div",
            null,
            h("div", { class: "small" }, a.text),
            h("div", { class: "small muted" }, when(a.at)),
          ),
        ),
      ),
    ),
  );
}

export function briefingPage(ctx) {
  const briefing = ctx.state.briefings.find((b) => b.id === ctx.route.id);
  if (!briefing) {
    return h(
      "div",
      { class: "card empty" },
      h("h2", null, "Briefing not available"),
      h(
        "p",
        null,
        ctx.state.role === "viewer"
          ? "Viewers see briefings once they are shared."
          : "It may have been removed, or the demo was reset.",
      ),
      h("a", { class: "btn", href: "#/briefings" }, "All briefings"),
    );
  }
  const figures = ctx.state.figures[briefing.week] ?? {};
  const canEdit = ctx.can("briefing.edit");
  const canComment = ctx.can("briefing.comment");
  const tab = ctx.ui.briefingTab ?? "review";
  const openByBlock = new Map();
  for (const c of briefing.comments)
    if (!c.resolved && c.blockId) openByBlock.set(c.blockId, (openByBlock.get(c.blockId) ?? 0) + 1);
  const problemBlocks = new Set(briefing.checks.map((c) => c.blockId));
  const changes = briefing.figureChanges;
  const withdrawn =
    !briefing.approval &&
    briefing.approvalHistory[0]?.withdrawnAt &&
    briefing.status === "in_review"
      ? briefing.approvalHistory[0]
      : null;
  const label = (key) => figures[key]?.label ?? key;

  return h(
    "div",
    null,
    h(
      "div",
      { class: "page-head" },
      h(
        "div",
        null,
        h("div", { class: "row" }, h("a", { href: "#/briefings", class: "small" }, "← Briefings")),
        h("h1", null, briefing.title),
        h(
          "p",
          null,
          `By ${ctx.user(briefing.createdBy)?.name}${briefing.origin === "automation" ? " (drafted by the scheduled workflow)" : ""} · ${when(briefing.createdAt)}`,
        ),
      ),
      h(
        "div",
        { class: "row" },
        statusChip(briefing.status),
        h(
          "a",
          { class: "btn", href: `/api/briefings/${briefing.id}/docx` },
          briefing.approval ? "Download .docx" : "Download draft .docx",
        ),
      ),
    ),
    h(
      "div",
      { class: "doc-layout" },
      h(
        "div",
        { class: "stack" },
        changes
          ? h(
              "div",
              { class: "banner warn" },
              h(
                "div",
                null,
                h(
                  "strong",
                  null,
                  `${changes.changes.length} figure${changes.changes.length === 1 ? "" : "s"} updated`,
                ),
                ` after ${changes.reason} by ${ctx.user(changes.by)?.name ?? "the scheduled workflow"} ${when(changes.at)}:`,
                h(
                  "ul",
                  { style: { margin: "4px 0 0", paddingLeft: "18px" } },
                  changes.changes
                    .slice(0, 6)
                    .map((c) =>
                      h("li", { class: "small" }, `${label(c.key)}: ${c.before} → ${c.after}`),
                    ),
                ),
                changes.changes.length > 6
                  ? h(
                      "div",
                      { class: "small muted" },
                      `and ${changes.changes.length - 6} more (highlighted below)`,
                    )
                  : null,
              ),
            )
          : null,
        withdrawn
          ? h(
              "div",
              { class: "banner bad" },
              `Approval by ${ctx.user(withdrawn.by)?.name} was withdrawn: ${withdrawn.reason}. It needs approval again before it can be shared.`,
            )
          : null,
        briefing.status === "changes_requested"
          ? h(
              "div",
              { class: "banner bad" },
              "Changes requested. See the change request in Comments, edit, then request review again.",
            )
          : null,
        h(
          "article",
          { class: "paper", "aria-label": "Briefing" },
          briefing.blocks.map((block) => {
            const editing = ctx.ui.editBlock === block.id;
            return h(
              "div",
              {
                class: [
                  "block",
                  openByBlock.has(block.id) && "commented",
                  problemBlocks.has(block.id) && "problem",
                  ctx.ui.commentBlock === block.id && "focus",
                ],
                "data-block": block.id,
              },
              openByBlock.has(block.id)
                ? h(
                    "button",
                    {
                      class: "badge-count",
                      title: "Open comments",
                      onclick: () => {
                        ctx.ui.briefingTab = "comments";
                        ctx.render();
                      },
                    },
                    openByBlock.get(block.id),
                  )
                : null,
              editing
                ? blockEditor(ctx, block, briefing, figures)
                : blockView(ctx, block, figures, briefing),
              editing
                ? null
                : h(
                    "div",
                    { class: "block-tools" },
                    canEdit
                      ? h(
                          "button",
                          {
                            class: "btn small ghost",
                            onclick: () => {
                              ctx.ui.editBlock = block.id;
                              ctx.render();
                            },
                          },
                          "Edit",
                        )
                      : null,
                    canComment
                      ? h(
                          "button",
                          {
                            class: "btn small ghost",
                            onclick: () => {
                              ctx.ui.commentBlock = block.id;
                              ctx.ui.briefingTab = "comments";
                              ctx.render();
                              document.querySelector(".side textarea")?.focus();
                            },
                          },
                          "Comment",
                        )
                      : null,
                    canEdit &&
                      ctx.state.ai &&
                      block.text !== undefined &&
                      block.type === "paragraph"
                      ? h(
                          "button",
                          {
                            class: "btn small ghost",
                            onclick: () => rewriteDialog(ctx, block, briefing, figures),
                          },
                          "Rewrite",
                        )
                      : null,
                    canEdit && ["paragraph", "bullets", "heading"].includes(block.type)
                      ? h(
                          "button",
                          {
                            class: "btn small ghost",
                            title: "Add a paragraph below",
                            onclick: () =>
                              act(async () => {
                                const { blockId } = await api(
                                  "POST",
                                  `/api/briefings/${briefing.id}/blocks`,
                                  { afterBlockId: block.id, type: "paragraph", text: "" },
                                );
                                ctx.ui.editBlock = blockId;
                              }),
                          },
                          "+",
                        )
                      : null,
                    canEdit
                      ? h(
                          "button",
                          {
                            class: "btn small ghost danger",
                            title: "Remove",
                            onclick: () =>
                              confirm("Remove this part of the briefing?") &&
                              act(
                                () =>
                                  api("DELETE", `/api/briefings/${briefing.id}/blocks/${block.id}`),
                                "Removed. Restore it from History.",
                              ),
                          },
                          "✕",
                        )
                      : null,
                  ),
            );
          }),
        ),
      ),
      h(
        "aside",
        { class: "side" },
        h(
          "div",
          { class: "card" },
          h(
            "div",
            { class: "tabs", role: "tablist" },
            [
              ["review", "Review"],
              ["comments", `Comments (${briefing.comments.filter((c) => !c.resolved).length})`],
              ["figures", "Figures"],
              ["history", "History"],
            ].map(([id, text]) =>
              h(
                "button",
                {
                  class: tab === id ? "on" : null,
                  role: "tab",
                  "aria-selected": String(tab === id),
                  onclick: () => {
                    ctx.ui.briefingTab = id;
                    ctx.render();
                  },
                },
                text,
              ),
            ),
          ),
          tab === "review"
            ? reviewTab(ctx, briefing, figures)
            : tab === "comments"
              ? commentsTab(ctx, briefing, figures)
              : tab === "figures"
                ? figuresTab(ctx, briefing, figures)
                : historyTab(ctx, briefing),
        ),
      ),
    ),
  );
}

export { TOKEN };
