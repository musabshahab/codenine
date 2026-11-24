// Source data: import a workbook, browse and correct rows, see every version and correction.

import { h, api, act, int, money, when, simTag, avatar, toast } from "./ui.js";

function importCard(ctx) {
  const input = h("input", {
    type: "file",
    accept: ".xlsx",
    hidden: true,
    onchange: async (event) => {
      const file = event.target.files[0];
      if (!file) return;
      const result = await act(() =>
        api("POST", "/api/data/import", file, {
          raw: true,
          headers: { "x-file-name": encodeURIComponent(file.name) },
        }),
      );
      if (result) toast(`Imported ${file.name} as data v${result.version}`);
      event.target.value = "";
    },
  });
  return h(
    "div",
    { class: "card stack" },
    h("h2", null, "Import a workbook"),
    h(
      "p",
      { class: "muted", style: { margin: 0 } },
      'Excel (.xlsx) with a "Shipments" sheet: Week, Week start, Region, Carrier, Orders, Shipped, On time, Late, Returns, Fulfilment cost, Backlog. A "Targets" sheet is optional.',
    ),
    h(
      "div",
      { class: "grid-2" },
      h(
        "div",
        { class: "dest", style: { flexDirection: "column" } },
        h("strong", null, ctx.client === "desktop" ? "From this PC" : "From your computer"),
        h(
          "span",
          { class: "small muted" },
          ctx.client === "desktop"
            ? "The desktop app reads the file locally and uploads it to the workspace, so web users see it at once."
            : "Upload a workbook. Desktop users see it at once.",
        ),
        input,
        h(
          "button",
          { class: "btn", disabled: !ctx.can("data.import"), onclick: () => input.click() },
          "Choose a file…",
        ),
        h(
          "a",
          { class: "small", href: "/sample/contoso-fulfilment-2026-W47.xlsx", download: true },
          "Download the sample workbook to try an upload",
        ),
      ),
      h(
        "div",
        { class: "dest", style: { flexDirection: "column" } },
        h("div", { class: "row" }, h("strong", null, "From SharePoint"), simTag()),
        h("span", { class: "small muted" }, "Operations site › Documents › Weekly data"),
        ctx.state.library.map((file) =>
          h(
            "div",
            { class: "row", style: { justifyContent: "space-between", width: "100%" } },
            h(
              "span",
              null,
              "📗 ",
              file.name,
              h("div", { class: "small muted" }, `${file.modifiedBy} · ${when(file.modifiedAt)}`),
            ),
            h(
              "button",
              {
                class: "btn small primary",
                disabled: !ctx.can("data.import"),
                onclick: () =>
                  act(
                    () => api("POST", "/api/data/import-library", { libraryId: file.id }),
                    `Imported ${file.name}`,
                  ),
              },
              "Import",
            ),
          ),
        ),
        ctx.state.upcoming.map((file) =>
          h(
            "div",
            { class: "small muted" },
            `${file.name} arrives with the next scheduled export.`,
          ),
        ),
      ),
    ),
    ctx.can("data.import")
      ? null
      : h("p", { class: "small muted" }, "Only owners and editors can import data."),
  );
}

export function dataPage(ctx) {
  const dataset = ctx.state.dataset;
  if (!dataset) {
    return h(
      "div",
      null,
      h(
        "div",
        { class: "page-head" },
        h(
          "div",
          null,
          h("h1", null, "Data"),
          h("p", null, "Bring in this week's operations workbook to start the review."),
        ),
      ),
      importCard(ctx),
    );
  }
  const params = ctx.route.params;
  const week = params.get("week") || ctx.ui.dataWeek || dataset.weeks.at(-1);
  const region = ctx.ui.dataRegion ?? "";
  const highlightRows = new Set((params.get("rows") ?? "").split(",").filter(Boolean).map(Number));
  const highlightCells = new Set((params.get("cells") ?? "").split(",").filter(Boolean));
  const columns = dataset.columns;
  const letter = (index) => String.fromCharCode(65 + index);
  const editedCells = new Set(
    ctx.state.overrides.map((o) => `${o.week}|${o.region}|${o.carrier}|${o.column}`),
  );
  const rows = dataset.rows.filter(
    (row) => row.Week === week && (!region || row.Region === region),
  );
  const editing = ctx.ui.editCell;
  if (highlightRows.size) {
    ctx.afterRender = () => document.querySelector("tr.hl")?.scrollIntoView({ block: "center" });
  }
  const figureKey = params.get("figure");
  const figure =
    figureKey &&
    Object.values(ctx.state.figures)
      .map((f) => f[figureKey])
      .find(Boolean);

  return h(
    "div",
    null,
    h(
      "div",
      { class: "page-head" },
      h(
        "div",
        null,
        h("h1", null, "Data"),
        h(
          "p",
          null,
          `${dataset.fileName} · data v${dataset.version} · ${dataset.rows.length} rows, ${dataset.weeks[0]} to ${dataset.weeks.at(-1)} · imported ${when(dataset.importedAt)} by ${ctx.user(dataset.importedBy)?.name ?? "the scheduled workflow"} from ${dataset.source}`,
        ),
      ),
      h(
        "div",
        { class: "row" },
        h(
          "a",
          { class: "btn", href: "/api/data/workbook.xlsx" },
          "Download workbook with corrections",
        ),
      ),
    ),
    figure
      ? h(
          "div",
          { class: "banner info", style: { marginBottom: "12px" } },
          h(
            "span",
            null,
            "Source cells for ",
            h("strong", null, `${figure.label} = ${figure.display}`),
            `: ${figure.provenance.formula}${figure.provenance.filter ? ` where ${figure.provenance.filter}` : ""}. Highlighted below.`,
          ),
          h("span", { style: { flex: 1 } }),
          h("button", { class: "btn small", onclick: () => history.back() }, "Back"),
        )
      : null,
    dataset.quality.length
      ? h(
          "div",
          { class: "banner warn", style: { marginBottom: "12px" } },
          h("span", null, h("strong", null, "Data quality: "), dataset.quality.join(" ")),
        )
      : h(
          "div",
          { class: "banner good", style: { marginBottom: "12px" } },
          "✓ Data quality checks passed: On time never exceeds Shipped, and Late equals Shipped minus On time on every row.",
        ),
    editing ? editPanel(ctx, editing) : null,
    h(
      "div",
      { class: "card" },
      h(
        "div",
        { class: "card-head" },
        h(
          "div",
          { class: "row" },
          h("strong", null, "Shipments"),
          h(
            "select",
            {
              "aria-label": "Week",
              onchange: (event) => {
                ctx.ui.dataWeek = event.target.value;
                ctx.navigate("#/data");
              },
            },
            [...dataset.weeks]
              .reverse()
              .map((value) => h("option", { value, selected: value === week }, value)),
          ),
          h(
            "select",
            {
              "aria-label": "Region",
              onchange: (event) => {
                ctx.ui.dataRegion = event.target.value;
                ctx.render();
              },
            },
            ["", "North", "South", "East", "West"].map((value) =>
              h("option", { value, selected: value === region }, value || "All regions"),
            ),
          ),
        ),
        h(
          "span",
          { class: "small muted" },
          ctx.can("data.edit")
            ? "Select a number to correct it. Corrections carry forward to later imports."
            : "Read only for your role.",
        ),
      ),
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
              h("th", { class: "ref" }, "#"),
              columns.map((column, index) =>
                h(
                  "th",
                  { class: typeof rows[0]?.[column] === "number" ? "num" : null },
                  column,
                  h("div", { class: "ref" }, letter(index)),
                ),
              ),
            ),
          ),
          h(
            "tbody",
            null,
            rows.map((row) =>
              h(
                "tr",
                { class: highlightRows.has(row.rowNumber) ? "hl" : null },
                h("td", { class: "ref" }, row.rowNumber),
                columns.map((column, index) => {
                  const value = row[column];
                  const ref = `${letter(index)}${row.rowNumber}`;
                  const isEditable =
                    ctx.can("data.edit") && ctx.state.editableColumns.includes(column);
                  const edited = editedCells.has(
                    `${row.Week}|${row.Region}|${row.Carrier}|${column}`,
                  );
                  return h(
                    "td",
                    {
                      class: [
                        typeof value === "number" && "num",
                        highlightCells.has(ref) && "cell-hl",
                        isEditable && "editable",
                        edited && "edited",
                      ],
                      title: edited ? "Corrected in this workspace" : ref,
                      onclick: isEditable
                        ? () => {
                            ctx.ui.editCell = { rowNumber: row.rowNumber, column, ref };
                            ctx.forget("cell-value", "cell-note");
                            ctx.render();
                          }
                        : null,
                    },
                    typeof value === "number"
                      ? column === "Fulfilment cost"
                        ? money(value)
                        : int(value)
                      : value,
                  );
                }),
              ),
            ),
          ),
        ),
      ),
    ),
    h(
      "div",
      { class: "grid-2", style: { marginTop: "16px" } },
      h(
        "div",
        { class: "card" },
        h("h3", null, "Corrections"),
        ctx.state.overrides.length === 0
          ? h(
              "p",
              { class: "muted small" },
              "None. Corrections made here keep their reason, show in the briefing's change notes, and are re-applied when the next export still has the old value.",
            )
          : h(
              "ul",
              { class: "feed" },
              ctx.state.overrides.map((o) =>
                h(
                  "li",
                  null,
                  avatar(ctx.user(o.by), { small: true }),
                  h(
                    "div",
                    { style: { flex: 1 } },
                    h(
                      "div",
                      null,
                      `${o.week} · ${o.region} · ${o.carrier} · ${o.column}: `,
                      h("strong", null, `${int(o.before)} → ${int(o.after)}`),
                    ),
                    h("div", { class: "small muted" }, `“${o.note}” · ${when(o.at)}`),
                  ),
                  ctx.can("data.edit")
                    ? h(
                        "button",
                        {
                          class: "btn small",
                          onclick: () =>
                            act(
                              () => api("POST", `/api/data/corrections/${o.id}/revert`),
                              "Correction reverted",
                            ),
                        },
                        "Revert",
                      )
                    : null,
                ),
              ),
            ),
      ),
      h(
        "div",
        { class: "card" },
        h("h3", null, "Versions"),
        h(
          "ul",
          { class: "feed" },
          ctx.state.datasetHistory.map((entry) =>
            h(
              "li",
              null,
              h("span", { class: "chip" }, `v${entry.version}`),
              h(
                "div",
                { style: { flex: 1 } },
                entry.kind === "import"
                  ? h(
                      "div",
                      null,
                      `Imported ${entry.fileName} from ${entry.source} (${entry.rows} rows, ${entry.weeks})`,
                    )
                  : h(
                      "div",
                      null,
                      `Correction: ${entry.change.where} ${int(entry.change.before)} → ${int(entry.change.after)}`,
                    ),
                entry.carried?.length
                  ? h(
                      "div",
                      { class: "small muted" },
                      entry.carried
                        .map((c) => `${c.week} ${c.region} ${c.carrier} ${c.column}: ${c.outcome}`)
                        .join("; "),
                    )
                  : null,
                h(
                  "div",
                  { class: "small muted" },
                  `${ctx.user(entry.by)?.name ?? "Scheduled workflow"} · ${when(entry.at)}`,
                ),
              ),
              entry.fileId
                ? h(
                    "a",
                    { class: "btn small", href: `/api/data/versions/${entry.version}/file` },
                    "Original file",
                  )
                : null,
            ),
          ),
        ),
      ),
    ),
    h("div", { style: { marginTop: "16px" } }, importCard(ctx)),
  );
}

function editPanel(ctx, editing) {
  const row = ctx.state.dataset.rows.find((candidate) => candidate.rowNumber === editing.rowNumber);
  if (!row) return null;
  const close = () => {
    ctx.ui.editCell = null;
    ctx.forget("cell-value", "cell-note");
    ctx.render();
  };
  const save = async () => {
    const result = await act(() =>
      api("POST", "/api/data/cell", {
        rowNumber: row.rowNumber,
        column: editing.column,
        value: Number(ctx.draft("cell-value", String(row[editing.column]))),
        note: ctx.draft("cell-note", ""),
      }),
    );
    if (result) {
      toast(
        result.unchanged
          ? "No change"
          : `Saved as data v${result.version}. The report and briefings now use it.`,
      );
      close();
    }
  };
  return h(
    "div",
    { class: "card stack", style: { marginBottom: "12px", borderColor: "var(--accent)" } },
    h(
      "div",
      { class: "card-head" },
      h("h3", null, `Correct Shipments!${editing.ref}`),
      h(
        "span",
        { class: "small muted" },
        `${row.Week} · ${row.Region} · ${row.Carrier} · ${editing.column}`,
      ),
    ),
    h(
      "div",
      { class: "row", style: { alignItems: "flex-end" } },
      h(
        "label",
        { class: "field" },
        `New value (now ${row[editing.column]})`,
        h("input", {
          type: "number",
          min: 0,
          step: editing.column === "Fulfilment cost" ? "0.01" : "1",
          ...ctx.keep("cell-value", String(row[editing.column])),
          onkeydown: (event) => event.key === "Enter" && save(),
        }),
      ),
      h(
        "label",
        { class: "field", style: { flex: 1, minWidth: "260px" } },
        "Why it changed (reviewers see this)",
        h("input", {
          type: "text",
          placeholder: "e.g. Warehouse scan logs confirm 410 more on-time deliveries",
          ...ctx.keep("cell-note"),
          onkeydown: (event) => event.key === "Enter" && save(),
        }),
      ),
      h("button", { class: "btn primary", onclick: save }, "Save correction"),
      h("button", { class: "btn", onclick: close }, "Cancel"),
    ),
    editing.column === "On time" || editing.column === "Shipped"
      ? h(
          "p",
          { class: "small muted", style: { margin: 0 } },
          `Late (column H) recalculates as Shipped − On time. Shipped is ${row.Shipped}.`,
        )
      : null,
  );
}
