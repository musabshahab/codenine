import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { createStore } from "../server/store.mjs";
import { createWorkspace } from "../server/workspace.mjs";
import { nextWeekly } from "../server/schedule.mjs";
import { rejectRewrite } from "../server/ai.mjs";
import { readZip } from "../server/office/zip.mjs";

const root = NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const ORIGIN = "http://wbr.test";

function setup(t) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "wbr-test-"));
  t.after(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
  const store = createStore(dir);
  const ws = createWorkspace({ store, sampleDir: NodePath.join(root, "sample-data") });
  return { store, ws };
}

const northwindW47 = (store) =>
  store.state.dataset.rows.find(
    (r) => r.Week === "2026-W47" && r.Region === "North" && r.Carrier === "Northwind Freight",
  );

function draftInReview({ store, ws }) {
  ws.importFromLibrary("priya", "lib-w47");
  const id = ws.generateBriefing("priya", { week: "2026-W47" });
  ws.requestReview("priya", id, { reviewerIds: ["marcus"] });
  return { id, briefing: () => store.state.briefings.find((b) => b.id === id) };
}

NodeTest.test("a corrected source figure reaches the report figures and the briefing", (t) => {
  const env = setup(t);
  const { id } = draftInReview(env);
  const before = env.ws.view("priya");
  NodeAssert.equal(before.figures["2026-W47"]["otd.current"].display, "89.8%");
  NodeAssert.equal(
    before.figures["2026-W47"]["driver.top.label"].display,
    "North · Northwind Freight",
  );

  const row = northwindW47(env.store);
  env.ws.editCell("priya", {
    rowNumber: row.rowNumber,
    column: "On time",
    value: row["On time"] + 410,
    note: "Scan logs",
  });

  const after = env.ws.view("priya");
  const briefing = after.briefings.find((b) => b.id === id);
  NodeAssert.equal(after.figures["2026-W47"]["otd.current"].display, "91.7%");
  NodeAssert.equal(northwindW47(env.store).Late, row.Shipped - row["On time"]);
  NodeAssert.equal(briefing.snapshot["otd.current"], "91.7%");
  NodeAssert.deepEqual(
    briefing.figureChanges.changes.find((c) => c.key === "otd.current"),
    { key: "otd.current", before: "89.8%", after: "91.7%" },
  );
  NodeAssert.equal(after.dataset.version, 2);
});

NodeTest.test("an approval is withdrawn only when a figure it covers changes", (t) => {
  const env = setup(t);
  const { id, briefing } = draftInReview(env);
  env.ws.approve("marcus", id);
  NodeAssert.equal(briefing().status, "approved");

  const old = env.store.state.dataset.rows.find((r) => r.Week === "2026-W40");
  env.ws.editCell("priya", {
    rowNumber: old.rowNumber,
    column: "Orders",
    value: old.Orders + 5,
    note: "Late order",
  });
  NodeAssert.equal(
    briefing().status,
    "approved",
    "a change outside the briefing's figures keeps the approval",
  );

  const row = northwindW47(env.store);
  env.ws.editCell("priya", {
    rowNumber: row.rowNumber,
    column: "On time",
    value: row["On time"] + 410,
    note: "Scan logs",
  });
  NodeAssert.equal(briefing().status, "in_review");
  NodeAssert.equal(briefing().approval, null);
  NodeAssert.match(briefing().approvalHistory[0].reason, /figures changed after approval/);
  NodeAssert.ok(
    env.store.state.notifications.some(
      (n) => n.userId === "marcus" && n.kind === "approval.withdrawn",
    ),
  );
});

NodeTest.test("roles and separation of duties are enforced on the server", (t) => {
  const env = setup(t);
  NodeAssert.throws(() => env.ws.importFromLibrary("dana", "lib-w47"), { status: 403 });
  const { id, briefing } = draftInReview(env);
  NodeAssert.throws(() => env.ws.approve("priya", id), { status: 403, message: /you wrote/ });
  NodeAssert.throws(
    () => env.ws.updateBlock("marcus", id, briefing().blocks[0].id, { text: "x" }),
    {
      status: 403,
    },
  );
  NodeAssert.throws(
    () => env.ws.shareBriefing("priya", id, { teams: "ops-weekly", origin: ORIGIN }),
    {
      status: 409,
    },
  );

  env.ws.addComment("marcus", id, {
    blockId: briefing().blocks[1].id,
    text: "Check the scan logs",
  });
  NodeAssert.throws(() => env.ws.approve("marcus", id), { status: 409, message: /open comment/ });
  env.ws.resolveComment("marcus", id, briefing().comments[0].id, true);
  NodeAssert.equal(env.ws.view("dana").briefings.length, 0, "viewers do not see unshared drafts");
  env.ws.approve("marcus", id);
  env.ws.shareBriefing("priya", id, { sharepoint: "ops-wbr", teams: "ops-weekly", origin: ORIGIN });
  NodeAssert.equal(env.ws.view("dana").briefings.length, 1);
  NodeAssert.equal(briefing().status, "shared");
});

NodeTest.test(
  "the shared Word file links each figure back to the report and carries the approval",
  (t) => {
    const env = setup(t);
    const { id } = draftInReview(env);
    env.ws.approve("marcus", id);
    const { shareId } = env.ws.shareBriefing("priya", id, {
      sharepoint: "ops-wbr",
      origin: ORIGIN,
    });
    const files = readZip(env.ws.sharedFile(id, shareId).bytes);
    const rels = new TextDecoder().decode(files.get("word/_rels/document.xml.rels"));
    const header = new TextDecoder().decode(files.get("word/header1.xml"));
    NodeAssert.match(
      rels,
      /Target="http:\/\/wbr\.test\/#\/report\?week=2026-W47&amp;visual=otd-trend&amp;figure=otd\.current"/,
    );
    NodeAssert.match(rels, /#\/data\?figure=otd\.current&amp;rows=/);
    NodeAssert.match(header, /Approved by Marcus Lee/);
    NodeAssert.ok(
      env.store.state.requests.some((r) => r.connector === "sharepoint" && r.method === "PUT"),
    );
  },
);

NodeTest.test(
  "a scheduled run imports next week, keeps corrections, drafts from the approved layout and shares after approval",
  (t) => {
    const env = setup(t);
    const { id, briefing } = draftInReview(env);
    const row = northwindW47(env.store);
    const exported = row["On time"];
    env.ws.editCell("priya", {
      rowNumber: row.rowNumber,
      column: "On time",
      value: exported + 410,
      note: "Scan logs",
    });
    env.ws.updateBlock("priya", id, briefing().blocks.at(-2).id, {
      items: ["Keep the daily carrier call for [[driver.top.label]]."],
    });
    env.ws.approve("marcus", id);
    env.ws.shareBriefing("priya", id, { teams: "ops-weekly", origin: ORIGIN });
    const automationId = env.ws.createAutomation("priya", {
      briefingId: id,
      reviewerIds: ["marcus"],
      autoShare: { teams: "ops-weekly" },
    });

    const run = env.ws.runAutomation("priya", automationId, { trigger: "run now", origin: ORIGIN });
    NodeAssert.equal(run.status, "waiting_for_review", JSON.stringify(run.steps));
    NodeAssert.equal(env.store.state.dataset.fileName, "contoso-fulfilment-2026-W48.xlsx");
    NodeAssert.equal(
      northwindW47(env.store)["On time"],
      exported + 410,
      "the correction is carried into the new import",
    );
    NodeAssert.equal(
      briefing().status,
      "shared",
      "last week's briefing keeps its approval because its figures did not change",
    );

    const next = env.store.state.briefings.find((b) => b.id === run.briefingId);
    NodeAssert.equal(next.week, "2026-W48");
    NodeAssert.equal(next.status, "in_review");
    NodeAssert.deepEqual(next.blocks.at(-2).items, [
      "Keep the daily carrier call for [[driver.top.label]].",
    ]);
    env.ws.approve("marcus", next.id);
    NodeAssert.equal(next.status, "shared");
    NodeAssert.ok(next.shares[0].automated);

    const again = env.ws.runAutomation("priya", automationId, {
      trigger: "run now",
      origin: ORIGIN,
    });
    NodeAssert.equal(again.status, "no_new_data");
  },
);

NodeTest.test(
  "a correction is dropped once the source export already has the corrected value",
  (t) => {
    const env = setup(t);
    env.ws.importFromLibrary("priya", "lib-w47");
    const row = northwindW47(env.store);
    const exported = row["On time"];
    env.ws.editCell("priya", {
      rowNumber: row.rowNumber,
      column: "On time",
      value: exported + 410,
      note: "Scan logs",
    });
    env.store.update((state) => {
      state.overrides[0].before = 1;
    });
    const result = env.ws.importFromLibrary("priya", "lib-w47");
    NodeAssert.match(result.carried[0].outcome, /source changed to/);
    NodeAssert.equal(env.store.state.overrides.length, 0);
    NodeAssert.equal(northwindW47(env.store)["On time"], exported);
  },
);

NodeTest.test("weekly schedules use the owner's time zone across daylight saving", () => {
  const tuesday = new Date("2026-11-24T12:00:00Z");
  NodeAssert.equal(
    nextWeekly(tuesday, 1, "07:30", "Europe/London").toISOString(),
    "2026-11-30T07:30:00.000Z",
  );
  const beforeClocksChange = new Date("2026-03-25T12:00:00Z");
  NodeAssert.equal(
    nextWeekly(beforeClocksChange, 1, "07:30", "Europe/London").toISOString(),
    "2026-03-30T06:30:00.000Z",
  );
  NodeAssert.equal(
    nextWeekly(tuesday, 1, "07:30", "America/New_York").toISOString(),
    "2026-11-30T12:30:00.000Z",
  );
});

NodeTest.test("a model rewrite may change wording but not numbers", () => {
  const figures = { "otd.current": { key: "otd.current" } };
  NodeAssert.equal(rejectRewrite("On-time delivery is [[otd.current]].", figures), null);
  NodeAssert.match(rejectRewrite("On-time delivery is 91.7%.", figures), /typed a number/);
  NodeAssert.match(rejectRewrite("Up [[otd.made_up]].", figures), /unknown figure/);
});
