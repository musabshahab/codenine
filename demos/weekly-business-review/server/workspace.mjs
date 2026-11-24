// Every user action is a method here: it checks the actor's role, changes the state through
// the store, and records activity. HTTP routes and the scheduler only call these.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { can, ROLES, PERMISSIONS } from "./auth.mjs";
import {
  checks,
  cloneBlocks,
  defaultBlocks,
  diff,
  docxBlocks,
  plainText,
  snapshot,
} from "./briefing.mjs";
import {
  CONNECTIONS,
  DESTINATIONS,
  recordDownload,
  recordListFolder,
  recordRefresh,
  recordUnshare,
  share as shareToDestinations,
} from "./integrations.mjs";
import {
  dataQuality,
  datasetFromWorkbook,
  EDITABLE_COLUMNS,
  figures as figuresFor,
  weekLabel,
  weekStart,
  weeksOf,
} from "./model.mjs";
import { buildDocx } from "./office/docx.mjs";
import { readXlsx, writeXlsx } from "./office/xlsx.mjs";
import { nextWeekly, DAY_NAMES } from "./schedule.mjs";
import { id, logActivity, notify } from "./store.mjs";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const SYSTEM = { id: "automation", name: "Scheduled workflow" };

export function createWorkspace({ store, sampleDir, clock = () => new Date() }) {
  const now = () => clock().toISOString();
  const userName = (userId) => store.user(userId)?.name ?? SYSTEM.name;

  function require(actorId, permission) {
    const role = store.roleOf(actorId);
    if (!role) throw new HttpError(403, "You are not a member of this workspace.");
    if (!can(role, permission)) {
      throw new HttpError(403, `${ROLES[role]}s cannot do this. It needs ${describe(permission)}.`);
    }
    return role;
  }

  const describe = (permission) => PERMISSIONS[permission].map((role) => ROLES[role]).join(" or ");

  function briefingOf(state, briefingId) {
    const briefing = state.briefings.find((candidate) => candidate.id === briefingId);
    if (!briefing) throw new HttpError(404, "That briefing no longer exists.");
    return briefing;
  }

  const figuresCache = new Map();
  function figuresOf(state, week) {
    if (!state.dataset || !weeksOf(state.dataset).includes(week)) return {};
    const key = `${state.dataset.version}:${week}`;
    if (!figuresCache.has(key)) figuresCache.set(key, figuresFor(state.dataset, week));
    return figuresCache.get(key);
  }

  const approvers = (state, exclude) =>
    state.workspace.members
      .filter((member) => can(member.role, "briefing.approve") && member.userId !== exclude)
      .map((member) => member.userId);

  // Called after every data change: figures in each briefing follow the data, and an
  // approval given for values that have since changed is withdrawn.
  function revalidate(state, actorId, reason) {
    for (const briefing of state.briefings) {
      const next = snapshot(briefing.blocks, figuresOf(state, briefing.week));
      const changes = diff(briefing.snapshot, next);
      briefing.snapshot = next;
      if (changes.length === 0) continue;
      briefing.figureChanges = { at: now(), by: actorId, reason, changes };
      if (briefing.approval) {
        withdrawApprovalIn(
          state,
          briefing,
          actorId,
          `${changes.length} figure${changes.length === 1 ? "" : "s"} changed after approval`,
        );
      }
      for (const shared of briefing.shares) if (!shared.revoked) shared.outdated = true;
    }
  }

  function withdrawApprovalIn(state, briefing, actorId, reason) {
    briefing.approvalHistory.unshift({
      ...briefing.approval,
      withdrawnAt: now(),
      withdrawnBy: actorId,
      reason,
    });
    const approver = briefing.approval.by;
    briefing.approval = null;
    briefing.status = "in_review";
    logActivity(state, {
      actor: actorId,
      kind: "approval.withdrawn",
      text: `Approval of “${briefing.title}” withdrawn: ${reason}`,
      briefingId: briefing.id,
    });
    notify(
      state,
      [approver, briefing.createdBy].filter((userId) => userId !== actorId),
      {
        kind: "approval.withdrawn",
        text: `Approval of “${briefing.title}” was withdrawn: ${reason}. It needs approval again.`,
        link: `#/briefing/${briefing.id}`,
      },
    );
  }

  function addVersion(briefing, actorId, note) {
    const last = briefing.versions[0];
    const recent = last && last.by === actorId && Date.parse(now()) - Date.parse(last.at) < 120_000;
    if (recent && last.note === note) {
      last.at = now();
      last.blocks = structuredClone(briefing.blocks);
      return;
    }
    briefing.versions.unshift({
      n: (last?.n ?? 0) + 1,
      at: now(),
      by: actorId,
      note,
      blocks: structuredClone(briefing.blocks),
    });
  }

  function applyOverrides(state, dataset) {
    const carried = [];
    state.overrides = (state.overrides ?? []).filter((override) => {
      const row = dataset.rows.find(
        (candidate) =>
          candidate.Week === override.week &&
          candidate.Region === override.region &&
          candidate.Carrier === override.carrier,
      );
      if (!row) return true;
      if (row[override.column] === override.after) {
        carried.push({ ...override, outcome: "already in the source" });
        return false;
      }
      if (row[override.column] !== override.before) {
        carried.push({
          ...override,
          outcome: `source changed to ${row[override.column]}; correction dropped`,
        });
        return false;
      }
      setCell(row, override.column, override.after);
      carried.push({ ...override, outcome: "carried forward" });
      return true;
    });
    return carried;
  }

  function setCell(row, column, value) {
    row[column] = value;
    row.Late = row.Shipped - row["On time"];
  }

  function importWorkbook(actorId, { bytes, fileName, source }) {
    if (actorId !== SYSTEM.id) require(actorId, "data.import");
    let workbook;
    try {
      workbook = readXlsx(bytes);
    } catch {
      throw new HttpError(400, `${fileName} is not an Excel workbook (.xlsx).`);
    }
    let dataset;
    try {
      dataset = datasetFromWorkbook(workbook, { fileName });
    } catch (error) {
      throw new HttpError(400, error.message);
    }
    const fileId = store.saveFile(bytes, "xlsx");
    return store.update((state) => {
      const version = (state.datasetHistory[0]?.version ?? 0) + 1;
      const carried = applyOverrides(state, dataset);
      state.dataset = {
        ...dataset,
        version,
        fileId,
        importedAt: now(),
        importedBy: actorId,
        source,
      };
      const weeks = weeksOf(dataset);
      state.datasetHistory.unshift({
        version,
        kind: "import",
        fileName,
        fileId,
        source,
        at: now(),
        by: actorId,
        rows: dataset.rows.length,
        weeks: `${weeks[0]} to ${weeks.at(-1)}`,
        carried,
      });
      const carriedText = carried.filter((c) => c.outcome === "carried forward").length;
      logActivity(state, {
        actor: actorId,
        kind: "data.imported",
        text: `Imported ${fileName} from ${source} (${dataset.rows.length} rows, ${weeks.at(-1)}) as data v${version}${carriedText ? `; ${carriedText} correction carried forward` : ""}`,
      });
      revalidate(state, actorId, `the import of ${fileName}`);
      return { version, carried, quality: dataQuality(state.dataset) };
    });
  }

  function importFromLibrary(actorId, libraryId) {
    const file = store.state.library.find((candidate) => candidate.id === libraryId);
    if (!file || (file.arrivesOnRun && !file.arrived))
      throw new HttpError(404, "That file is not in the library.");
    const bytes = NodeFS.readFileSync(NodePath.join(sampleDir, file.sample));
    store.update((state) => {
      recordListFolder(state, file.folder);
      recordDownload(state, file);
    });
    return importWorkbook(actorId, {
      bytes,
      fileName: file.name,
      source: `SharePoint › ${file.folder}`,
    });
  }

  function editCell(actorId, { rowNumber, column, value, note }) {
    require(actorId, "data.edit");
    if (!EDITABLE_COLUMNS.includes(column)) throw new HttpError(400, `${column} cannot be edited.`);
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0)
      throw new HttpError(400, "Enter a number of zero or more.");
    if (!note?.trim())
      throw new HttpError(400, "Say why the figure changed. Reviewers see the note.");
    return store.update((state) => {
      const row = state.dataset?.rows.find((candidate) => candidate.rowNumber === rowNumber);
      if (!row) throw new HttpError(404, "That row is not in the current data.");
      const before = row[column];
      if (before === number) return { unchanged: true };
      if (column === "On time" && number > row.Shipped) {
        throw new HttpError(400, `On time cannot be more than Shipped (${row.Shipped}).`);
      }
      state.overrides ??= [];
      const existing = state.overrides.find(
        (o) =>
          o.week === row.Week &&
          o.region === row.Region &&
          o.carrier === row.Carrier &&
          o.column === column,
      );
      if (existing) Object.assign(existing, { after: number, note, by: actorId, at: now() });
      else {
        state.overrides.push({
          id: id("fix"),
          week: row.Week,
          region: row.Region,
          carrier: row.Carrier,
          column,
          rowNumber,
          before,
          after: number,
          note,
          by: actorId,
          at: now(),
        });
      }
      setCell(row, column, number);
      const version = state.datasetHistory[0].version + 1;
      state.dataset.version = version;
      const where = `${row.Week} · ${row.Region} · ${row.Carrier} · ${column}`;
      state.datasetHistory.unshift({
        version,
        kind: "correction",
        fileName: state.dataset.fileName,
        at: now(),
        by: actorId,
        change: { where, before, after: number, note, cell: rowNumber },
      });
      logActivity(state, {
        actor: actorId,
        kind: "data.corrected",
        text: `Corrected ${where}: ${before} → ${number} (“${note}”), data v${version}`,
      });
      revalidate(state, actorId, `the correction to ${where}`);
      return { version };
    });
  }

  function revertCorrection(actorId, overrideId) {
    require(actorId, "data.edit");
    const override = store.state.overrides?.find((candidate) => candidate.id === overrideId);
    if (!override) throw new HttpError(404, "That correction no longer exists.");
    const row = store.state.dataset.rows.find(
      (candidate) =>
        candidate.Week === override.week &&
        candidate.Region === override.region &&
        candidate.Carrier === override.carrier,
    );
    const result = editCell(actorId, {
      rowNumber: row.rowNumber,
      column: override.column,
      value: override.before,
      note: `Reverted correction: ${override.note}`,
    });
    store.update((state) => {
      state.overrides = state.overrides.filter((candidate) => candidate.id !== overrideId);
    });
    return result;
  }

  function workbookBytes(state) {
    const dataset = state.dataset;
    if (!dataset) throw new HttpError(404, "No data has been imported yet.");
    const columns = dataset.columns.map((header) => ({
      header,
      width: header === "Carrier" ? 20 : header.length > 10 ? 16 : 12,
      format:
        header === "Fulfilment cost"
          ? "currency2"
          : ["Week", "Week start", "Region", "Carrier"].includes(header)
            ? "text"
            : "integer",
    }));
    const late = dataset.columns.indexOf("Late");
    const shipped = dataset.columns.indexOf("Shipped");
    const onTime = dataset.columns.indexOf("On time");
    const letter = (index) => String.fromCharCode(65 + index);
    const rows = dataset.rows.map((row) =>
      dataset.columns.map((column, index) =>
        index === late
          ? {
              formula: `${letter(shipped)}${row.rowNumber}-${letter(onTime)}${row.rowNumber}`,
              value: row.Late,
            }
          : row[column],
      ),
    );
    return writeXlsx({
      properties: {
        title: `${dataset.fileName} (data v${dataset.version})`,
        creator: "Operations workspace",
      },
      sheets: [
        { name: "Shipments", columns, rows, freezeHeader: true, autoFilter: true },
        {
          name: "Targets",
          columns: [
            { header: "KPI", width: 20 },
            { header: "Target", width: 10 },
          ],
          rows: [
            ["On-time delivery", { value: dataset.targets.otd, format: "percent1" }],
            ["Cost per order", { value: dataset.targets.cpo, format: "currency2" }],
            ["Returns rate", { value: dataset.targets.returns, format: "percent1" }],
            ["Backlog", { value: dataset.targets.backlog, format: "integer" }],
          ],
        },
        {
          name: "Corrections",
          columns: [
            { header: "Week", width: 10 },
            { header: "Region", width: 10 },
            { header: "Carrier", width: 20 },
            { header: "Column", width: 12 },
            { header: "Was", format: "integer" },
            { header: "Now", format: "integer" },
            { header: "Why", width: 50 },
            { header: "By", width: 16 },
            { header: "When", width: 22 },
          ],
          rows: (state.overrides ?? []).map((o) => [
            o.week,
            o.region,
            o.carrier,
            o.column,
            o.before,
            o.after,
            o.note,
            userName(o.by),
            o.at,
          ]),
        },
      ],
    });
  }

  function createBriefing(state, actorId, { week, blocks, origin, automationId }) {
    const label = weekLabel(week, weekStart(state.dataset, week));
    const briefing = {
      id: id("brf"),
      title: `Weekly business review: ${label}`,
      week,
      createdBy: actorId,
      createdAt: now(),
      origin,
      automationId: automationId ?? null,
      status: "draft",
      blocks,
      snapshot: snapshot(blocks, figuresOf(state, week)),
      versions: [],
      reviewers: [],
      approval: null,
      approvalHistory: [],
      comments: [],
      shares: [],
      figureChanges: null,
      autoShare: null,
    };
    addVersion(
      briefing,
      actorId,
      origin === "automation" ? "Drafted by the scheduled workflow" : "Drafted from the report",
    );
    state.briefings.unshift(briefing);
    logActivity(state, {
      actor: actorId,
      kind: "briefing.created",
      text: `Drafted “${briefing.title}”`,
      briefingId: briefing.id,
    });
    return briefing;
  }

  function generateBriefing(actorId, { week }) {
    require(actorId, "briefing.edit");
    return store.update((state) => {
      if (!state.dataset) throw new HttpError(400, "Import a workbook first.");
      const weeks = weeksOf(state.dataset);
      const target = weeks.includes(week) ? week : weeks.at(-1);
      return createBriefing(state, actorId, {
        week: target,
        blocks: defaultBlocks(),
        origin: "manual",
      }).id;
    });
  }

  function editable(state, briefing, actorId) {
    require(actorId, "briefing.edit");
    if (briefing.approval)
      withdrawApprovalIn(state, briefing, actorId, "the text was edited after approval");
  }

  function updateBlock(actorId, briefingId, blockId, patch) {
    return store.update((state) => {
      const briefing = briefingOf(state, briefingId);
      const block = briefing.blocks.find((candidate) => candidate.id === blockId);
      if (!block) throw new HttpError(404, "That part of the briefing was removed.");
      editable(state, briefing, actorId);
      if (block.type === "bullets")
        block.items = (patch.items ?? []).map(String).filter((item) => item.trim());
      else if (block.type === "table") block.rows = patch.rows ?? block.rows;
      else block.text = String(patch.text ?? "");
      briefing.snapshot = snapshot(briefing.blocks, figuresOf(state, briefing.week));
      addVersion(briefing, actorId, "Edited text");
      return { ok: true };
    });
  }

  function insertBlock(actorId, briefingId, { afterBlockId, type, text, style }) {
    return store.update((state) => {
      const briefing = briefingOf(state, briefingId);
      editable(state, briefing, actorId);
      const block =
        type === "bullets"
          ? { id: id("blk"), type, items: [text ?? ""] }
          : type === "heading"
            ? { id: id("blk"), type, level: 2, text: text ?? "New section" }
            : { id: id("blk"), type: "paragraph", style: style ?? "Normal", text: text ?? "" };
      const index = briefing.blocks.findIndex((candidate) => candidate.id === afterBlockId);
      briefing.blocks.splice(index === -1 ? briefing.blocks.length : index + 1, 0, block);
      briefing.snapshot = snapshot(briefing.blocks, figuresOf(state, briefing.week));
      addVersion(briefing, actorId, "Added a section");
      return { blockId: block.id };
    });
  }

  function removeBlock(actorId, briefingId, blockId) {
    return store.update((state) => {
      const briefing = briefingOf(state, briefingId);
      editable(state, briefing, actorId);
      briefing.blocks = briefing.blocks.filter((candidate) => candidate.id !== blockId);
      briefing.snapshot = snapshot(briefing.blocks, figuresOf(state, briefing.week));
      addVersion(briefing, actorId, "Removed a section");
      return { ok: true };
    });
  }

  function restoreVersion(actorId, briefingId, n) {
    return store.update((state) => {
      const briefing = briefingOf(state, briefingId);
      const version = briefing.versions.find((candidate) => candidate.n === Number(n));
      if (!version) throw new HttpError(404, "That version no longer exists.");
      editable(state, briefing, actorId);
      briefing.blocks = structuredClone(version.blocks);
      briefing.snapshot = snapshot(briefing.blocks, figuresOf(state, briefing.week));
      addVersion(briefing, actorId, `Restored version ${n}`);
      return { ok: true };
    });
  }

  function requestReview(actorId, briefingId, { reviewerIds, message }) {
    if (actorId !== SYSTEM.id) require(actorId, "briefing.requestReview");
    return store.update((state) => {
      const briefing = briefingOf(state, briefingId);
      if (actorId !== SYSTEM.id && !["draft", "changes_requested"].includes(briefing.status)) {
        throw new HttpError(409, "This briefing is already with reviewers.");
      }
      const allowed = approvers(state, briefing.createdBy);
      const reviewers = (reviewerIds ?? []).filter((userId) => allowed.includes(userId));
      if (reviewers.length === 0)
        throw new HttpError(400, "Choose an approver other than the author.");
      const unknown = checks(briefing.blocks, figuresOf(state, briefing.week)).filter(
        (p) => p.kind === "unknown-figure",
      );
      if (unknown.length > 0)
        throw new HttpError(400, `Fix broken figure links first: ${unknown[0].detail}`);
      briefing.reviewers = reviewers;
      briefing.status = "in_review";
      briefing.reviewRequestedAt = now();
      briefing.figureChanges = null;
      logActivity(state, {
        actor: actorId,
        kind: "review.requested",
        text: `Asked ${reviewers.map(userName).join(", ")} to review “${briefing.title}”`,
        briefingId,
      });
      notify(state, reviewers, {
        kind: "review.requested",
        text: `${userName(actorId)} asked you to review “${briefing.title}”${message ? `: “${message}”` : ""}`,
        link: `#/briefing/${briefingId}`,
      });
      return { ok: true };
    });
  }

  function withdrawReview(actorId, briefingId) {
    require(actorId, "briefing.requestReview");
    return store.update((state) => {
      const briefing = briefingOf(state, briefingId);
      if (briefing.status !== "in_review")
        throw new HttpError(409, "This briefing is not with reviewers.");
      briefing.status = "draft";
      logActivity(state, {
        actor: actorId,
        kind: "review.withdrawn",
        text: `Took “${briefing.title}” back to draft`,
        briefingId,
      });
      notify(state, briefing.reviewers, {
        kind: "review.withdrawn",
        text: `${userName(actorId)} took “${briefing.title}” back to draft. No review needed for now.`,
        link: `#/briefing/${briefingId}`,
      });
      return { ok: true };
    });
  }

  function addComment(actorId, briefingId, { blockId, text, quote, parentId }) {
    require(actorId, "briefing.comment");
    if (!text?.trim()) throw new HttpError(400, "Write a comment first.");
    return store.update((state) => {
      const briefing = briefingOf(state, briefingId);
      const entry = { id: id("cmt"), author: actorId, at: now(), text: text.trim() };
      if (parentId) {
        const parent = briefing.comments.find((candidate) => candidate.id === parentId);
        if (!parent) throw new HttpError(404, "That comment was deleted.");
        parent.replies.push(entry);
        if (parent.resolved) parent.resolved = null;
      } else {
        briefing.comments.push({
          ...entry,
          blockId: blockId ?? null,
          quote: quote ?? null,
          resolved: null,
          replies: [],
        });
      }
      const people = [
        briefing.createdBy,
        ...briefing.reviewers,
        ...briefing.comments.map((c) => c.author),
      ];
      notify(
        state,
        people.filter((userId) => userId !== actorId && userId !== SYSTEM.id),
        {
          kind: "comment",
          text: `${userName(actorId)} commented on “${briefing.title}”: “${text.trim().slice(0, 120)}”`,
          link: `#/briefing/${briefingId}`,
        },
      );
      logActivity(state, {
        actor: actorId,
        kind: "comment",
        text: `${parentId ? "Replied" : "Commented"} on “${briefing.title}”`,
        briefingId,
      });
      return { ok: true };
    });
  }

  function resolveComment(actorId, briefingId, commentId, resolved) {
    require(actorId, "briefing.comment");
    return store.update((state) => {
      const briefing = briefingOf(state, briefingId);
      const comment = briefing.comments.find((candidate) => candidate.id === commentId);
      if (!comment) throw new HttpError(404, "That comment was deleted.");
      const role = store.roleOf(actorId);
      if (comment.author !== actorId && !can(role, "briefing.edit")) {
        throw new HttpError(403, "Only the commenter or an editor can resolve this.");
      }
      comment.resolved = resolved ? { by: actorId, at: now() } : null;
      logActivity(state, {
        actor: actorId,
        kind: resolved ? "comment.resolved" : "comment.reopened",
        text: `${resolved ? "Resolved" : "Reopened"} a comment on “${briefing.title}”`,
        briefingId,
      });
      return { ok: true };
    });
  }

  function approve(actorId, briefingId) {
    require(actorId, "briefing.approve");
    const result = store.update((state) => {
      const briefing = briefingOf(state, briefingId);
      if (briefing.createdBy === actorId)
        throw new HttpError(403, "You cannot approve a briefing you wrote.");
      if (briefing.status !== "in_review")
        throw new HttpError(409, "Only a briefing in review can be approved.");
      const open = briefing.comments.filter((comment) => !comment.resolved);
      if (open.length > 0) {
        throw new HttpError(
          409,
          `Resolve the ${open.length} open comment${open.length === 1 ? "" : "s"} first.`,
        );
      }
      briefing.approval = {
        by: actorId,
        at: now(),
        snapshot: { ...briefing.snapshot },
        datasetVersion: state.dataset.version,
        version: briefing.versions[0].n,
      };
      briefing.status = "approved";
      briefing.figureChanges = null;
      logActivity(state, {
        actor: actorId,
        kind: "briefing.approved",
        text: `Approved “${briefing.title}” (version ${briefing.versions[0].n}, data v${state.dataset.version})`,
        briefingId,
      });
      notify(
        state,
        [briefing.createdBy].filter((userId) => userId !== SYSTEM.id),
        {
          kind: "briefing.approved",
          text: `${userName(actorId)} approved “${briefing.title}”.${briefing.autoShare ? " The workflow is sharing it now." : " You can share it now."}`,
          link: `#/briefing/${briefingId}`,
        },
      );
      return { autoShare: briefing.autoShare, owner: briefing.autoShareOwner };
    });
    if (result.autoShare) {
      shareBriefing(result.owner, briefingId, {
        ...result.autoShare,
        origin: result.autoShare.origin,
        automated: true,
      });
    }
    return { ok: true };
  }

  function requestChanges(actorId, briefingId, { note }) {
    require(actorId, "briefing.approve");
    if (!note?.trim()) throw new HttpError(400, "Say what needs to change.");
    store.update((state) => {
      const briefing = briefingOf(state, briefingId);
      if (briefing.status !== "in_review")
        throw new HttpError(409, "Only a briefing in review can be sent back.");
      briefing.status = "changes_requested";
      briefing.comments.push({
        id: id("cmt"),
        author: actorId,
        at: now(),
        text: note.trim(),
        blockId: null,
        quote: null,
        resolved: null,
        replies: [],
        changeRequest: true,
      });
      logActivity(state, {
        actor: actorId,
        kind: "changes.requested",
        text: `Asked for changes to “${briefing.title}”`,
        briefingId,
      });
      notify(state, [briefing.createdBy], {
        kind: "changes.requested",
        text: `${userName(actorId)} asked for changes to “${briefing.title}”: “${note.trim()}”`,
        link: `#/briefing/${briefingId}`,
      });
    });
    return { ok: true };
  }

  function withdrawApproval(actorId, briefingId) {
    require(actorId, "briefing.approve");
    return store.update((state) => {
      const briefing = briefingOf(state, briefingId);
      if (!briefing.approval) throw new HttpError(409, "This briefing is not approved.");
      if (briefing.approval.by !== actorId && store.roleOf(actorId) !== "owner") {
        throw new HttpError(403, "Only the approver or an owner can withdraw this approval.");
      }
      withdrawApprovalIn(state, briefing, actorId, `${userName(actorId)} withdrew it`);
      return { ok: true };
    });
  }

  function briefingDocx(state, briefing, origin) {
    const figures = figuresOf(state, briefing.week);
    const stamp = briefing.approval
      ? `Approved by ${userName(briefing.approval.by)} on ${formatTime(briefing.approval.at)} · data v${briefing.approval.datasetVersion}`
      : "DRAFT · not approved";
    return buildDocx({
      title: plainText(
        briefing.blocks.find((b) => b.type === "heading")?.text ?? briefing.title,
        figures,
      ),
      blocks: docxBlocks(briefing, figures, origin),
      header: [
        {
          text: `${store.state.org.name} · ${stamp}`,
          color: briefing.approval ? "047857" : "B91C1C",
          bold: true,
        },
      ],
      footer: [
        {
          text: `Figures from ${state.dataset.fileName}, data v${state.dataset.version}. Links open the live report.`,
        },
      ],
      core: {
        title: briefing.title,
        creator: userName(briefing.createdBy),
        lastModifiedBy: userName(briefing.versions[0]?.by ?? briefing.createdBy),
        created: briefing.createdAt,
        modified: briefing.versions[0]?.at ?? briefing.createdAt,
      },
    });
  }

  function shareBriefing(actorId, briefingId, { sharepoint, teams, outlook, origin, automated }) {
    if (actorId !== SYSTEM.id) require(actorId, "briefing.share");
    if (!sharepoint && !teams && !outlook)
      throw new HttpError(400, "Choose at least one place to share to.");
    return store.update((state) => {
      const briefing = briefingOf(state, briefingId);
      if (!briefing.approval) throw new HttpError(409, "Only an approved briefing can be shared.");
      const bytes = briefingDocx(state, briefing, origin);
      const fileName = `WBR ${briefing.week} v${briefing.versions[0].n}.docx`;
      const fileId = store.saveFile(bytes, "docx");
      const figures = figuresOf(state, briefing.week);
      const summary = plainText(
        briefing.blocks.find((block) => block.style === "Callout")?.text ?? "",
        figures,
      );
      const shareId = id("shr");
      const link = `${origin}/#/briefing/${briefingId}`;
      const by = automated ? `${userName(actorId)} (scheduled workflow)` : userName(actorId);
      const results = shareToDestinations(state, {
        fileName,
        sizeBytes: bytes.length,
        title: briefing.title,
        summary,
        destinations: { sharepoint, teams, outlook },
        sharedBy: by,
        link,
      });
      briefing.shares.unshift({
        id: shareId,
        at: now(),
        by: actorId,
        automated: Boolean(automated),
        fileId,
        fileName,
        version: briefing.versions[0].n,
        datasetVersion: state.dataset.version,
        results,
        revoked: null,
        outdated: false,
      });
      briefing.status = "shared";
      logActivity(state, {
        actor: actorId,
        kind: "briefing.shared",
        text: `Shared “${briefing.title}” to ${results.map((r) => r.target).join("; ")}${automated ? " (scheduled workflow)" : ""}`,
        briefingId,
      });
      const everyone = state.workspace.members.map((member) => member.userId);
      notify(
        state,
        everyone.filter((userId) => userId !== actorId),
        {
          kind: "briefing.shared",
          text: `${by} shared “${briefing.title}”`,
          link: `#/briefing/${briefingId}`,
        },
      );
      return { shareId, results };
    });
  }

  function unshare(actorId, briefingId, shareId) {
    require(actorId, "briefing.share");
    return store.update((state) => {
      const briefing = briefingOf(state, briefingId);
      const shared = briefing.shares.find((candidate) => candidate.id === shareId);
      if (!shared || shared.revoked) throw new HttpError(404, "That share is already removed.");
      recordUnshare(state);
      shared.revoked = { by: actorId, at: now() };
      if (!briefing.shares.some((candidate) => !candidate.revoked)) {
        briefing.status = briefing.approval ? "approved" : "in_review";
      }
      logActivity(state, {
        actor: actorId,
        kind: "briefing.unshared",
        text: `Removed the sharing link for “${briefing.title}”`,
        briefingId,
      });
      return { ok: true };
    });
  }

  function nextRun(automation) {
    return nextWeekly(
      clock(),
      automation.weekday,
      automation.time,
      automation.timeZone,
    ).toISOString();
  }

  function createAutomation(
    actorId,
    { briefingId, weekday = 1, time = "07:30", timeZone = "Europe/London", reviewerIds, autoShare },
  ) {
    require(actorId, "automation.manage");
    return store.update((state) => {
      const briefing = briefingOf(state, briefingId);
      if (!briefing.approval)
        throw new HttpError(
          409,
          "Schedule a briefing after it is approved, so the next run starts from an approved layout.",
        );
      const reviewers = (reviewerIds ?? briefing.reviewers).filter((userId) =>
        approvers(state, actorId).includes(userId),
      );
      const automation = {
        id: id("aut"),
        name: "Weekly business review",
        owner: actorId,
        createdAt: now(),
        enabled: true,
        weekday: Number(weekday),
        time,
        timeZone,
        templateBriefingId: briefingId,
        source: "Operations / Weekly data",
        reviewers,
        autoShare: autoShare ?? null,
        nextRunAt: null,
      };
      automation.nextRunAt = nextRun(automation);
      state.automations.unshift(automation);
      logActivity(state, {
        actor: actorId,
        kind: "automation.created",
        text: `Scheduled “${automation.name}” every ${DAY_NAMES[automation.weekday]} at ${time} (${timeZone})`,
      });
      return automation.id;
    });
  }

  function updateAutomation(actorId, automationId, patch) {
    require(actorId, "automation.manage");
    return store.update((state) => {
      const automation = state.automations.find((candidate) => candidate.id === automationId);
      if (!automation) throw new HttpError(404, "That schedule was deleted.");
      for (const key of ["enabled", "weekday", "time", "timeZone", "reviewers", "autoShare"]) {
        if (key in patch) automation[key] = key === "weekday" ? Number(patch[key]) : patch[key];
      }
      automation.nextRunAt = automation.enabled ? nextRun(automation) : null;
      logActivity(state, {
        actor: actorId,
        kind: "automation.updated",
        text: automation.enabled
          ? `Updated “${automation.name}”: every ${DAY_NAMES[automation.weekday]} at ${automation.time} (${automation.timeZone})`
          : `Paused “${automation.name}”`,
      });
      return { ok: true };
    });
  }

  function deleteAutomation(actorId, automationId) {
    require(actorId, "automation.manage");
    return store.update((state) => {
      const automation = state.automations.find((candidate) => candidate.id === automationId);
      if (!automation) throw new HttpError(404, "That schedule was already deleted.");
      state.automations = state.automations.filter((candidate) => candidate !== automation);
      logActivity(state, {
        actor: actorId,
        kind: "automation.deleted",
        text: `Deleted the schedule “${automation.name}”`,
      });
      return { ok: true };
    });
  }

  /** One run of the weekly workflow. Steps stop at the first failure and say why. */
  function runAutomation(actorId, automationId, { trigger, origin }) {
    if (actorId !== SYSTEM.id) require(actorId, "automation.manage");
    const automation = store.state.automations.find((candidate) => candidate.id === automationId);
    if (!automation) throw new HttpError(404, "That schedule was deleted.");
    const run = {
      id: id("run"),
      automationId,
      trigger,
      startedBy: actorId,
      startedAt: now(),
      finishedAt: null,
      status: "running",
      steps: [],
      briefingId: null,
    };
    const step = (name, work) => {
      if (run.status !== "running") return;
      try {
        const detail = work();
        run.steps.push({ name, status: "done", detail });
      } catch (error) {
        run.steps.push({ name, status: error.skip ? "skipped" : "failed", detail: error.message });
        run.status = error.skip ? "no_new_data" : "failed";
      }
    };
    let file;
    step(`Look for a new workbook in SharePoint › ${automation.source}`, () => {
      store.update((state) => {
        for (const candidate of state.library) if (candidate.arrivesOnRun) candidate.arrived = true;
        recordListFolder(state, automation.source);
      });
      const latest = store.state.dataset ? weeksOf(store.state.dataset).at(-1) : "";
      file = store.state.library
        .filter((candidate) => candidate.week > latest)
        .sort((a, b) => a.week.localeCompare(b.week))[0];
      if (!file) {
        const error = new Error(`No workbook newer than ${latest}. Nothing to do this week.`);
        error.skip = true;
        throw error;
      }
      return `Found ${file.name}`;
    });
    let imported;
    step("Import the workbook and carry corrections forward", () => {
      imported = importFromLibrary(SYSTEM.id, file.id);
      const carried = imported.carried.filter((c) => c.outcome === "carried forward").length;
      return `Data v${imported.version}${carried ? `; ${carried} correction carried forward` : ""}`;
    });
    step("Refresh the Power BI semantic model", () => {
      store.update((state) => recordRefresh(state));
      return "Refresh accepted";
    });
    step("Check data quality", () => {
      if (imported.quality.length > 0)
        throw new Error(`${imported.quality.length} problem(s): ${imported.quality[0]}`);
      return "No problems found";
    });
    step("Draft the briefing from the last approved layout", () => {
      const briefingId = store.update((state) => {
        const template = state.briefings.find((b) => b.id === automation.templateBriefingId);
        const blocks = template
          ? cloneBlocks(template.approval ? template.blocks : template.versions.at(-1).blocks)
          : defaultBlocks();
        const week = weeksOf(state.dataset).at(-1);
        const briefing = createBriefing(state, SYSTEM.id, {
          week,
          blocks,
          origin: "automation",
          automationId,
        });
        briefing.createdBy = automation.owner;
        briefing.autoShare = automation.autoShare ? { ...automation.autoShare, origin } : null;
        briefing.autoShareOwner = automation.owner;
        return briefing.id;
      });
      run.briefingId = briefingId;
      return "Draft ready";
    });
    step("Ask for review", () => {
      requestReview(SYSTEM.id, run.briefingId, {
        reviewerIds: automation.reviewers,
        message: "Drafted automatically from this week's data.",
      });
      return `Sent to ${automation.reviewers.map(userName).join(", ")}`;
    });
    if (run.status === "running") {
      run.steps.push({
        name: "Share after approval",
        status: automation.autoShare ? "waiting" : "manual",
        detail: automation.autoShare
          ? "Shares automatically when approved"
          : "The owner shares it after approval",
      });
      run.status = "waiting_for_review";
    }
    run.finishedAt = now();
    store.update((state) => {
      state.runs.unshift(run);
      state.runs.length = Math.min(state.runs.length, 50);
      const current = state.automations.find((candidate) => candidate.id === automationId);
      if (current) {
        current.lastRunAt = run.startedAt;
        current.nextRunAt = current.enabled ? nextRun(current) : null;
      }
      logActivity(state, {
        actor: actorId,
        kind: "automation.ran",
        text: `“${automation.name}” ran (${trigger}): ${runStatusText(run.status)}`,
      });
      notify(state, [automation.owner], {
        kind: "automation.ran",
        text: `“${automation.name}” ran: ${runStatusText(run.status)}`,
        link: run.briefingId ? `#/briefing/${run.briefingId}` : "#/automations",
      });
    });
    return run;
  }

  function runDue(origin) {
    const due = store.state.automations.filter(
      (automation) =>
        automation.enabled &&
        automation.nextRunAt &&
        Date.parse(automation.nextRunAt) <= clock().getTime(),
    );
    return due.map((automation) =>
      runAutomation(SYSTEM.id, automation.id, { trigger: "schedule", origin }),
    );
  }

  function setPin(actorId, { visual, on }) {
    require(actorId, "report.pin");
    return store.update((state) => {
      state.pins = state.pins.filter((pin) => pin.visual !== visual);
      if (on) state.pins.push({ id: id("pin"), visual, by: actorId, at: now() });
      return { ok: true };
    });
  }

  function setMember(actorId, { userId, role }) {
    require(actorId, "members.manage");
    if (!store.user(userId)) throw new HttpError(404, "That person is not in the directory.");
    if (role && !ROLES[role]) throw new HttpError(400, "Unknown role.");
    return store.update((state) => {
      const members = state.workspace.members;
      const existing = members.find((member) => member.userId === userId);
      const owners = members.filter((member) => member.role === "owner");
      if (existing?.role === "owner" && role !== "owner" && owners.length === 1) {
        throw new HttpError(409, "A workspace needs at least one owner.");
      }
      if (!role) state.workspace.members = members.filter((member) => member.userId !== userId);
      else if (existing) existing.role = role;
      else members.push({ userId, role, addedAt: now(), addedBy: actorId });
      logActivity(state, {
        actor: actorId,
        kind: "member.changed",
        text: role
          ? `${existing ? "Changed" : "Added"} ${userName(userId)} ${existing ? "to" : "as"} ${ROLES[role]}`
          : `Removed ${userName(userId)} from the workspace`,
      });
      if (role && !existing) {
        notify(state, [userId], {
          kind: "member.added",
          text: `${userName(actorId)} added you to ${state.workspace.name} as ${ROLES[role]}`,
          link: "#/home",
        });
      }
      return { ok: true };
    });
  }

  function markRead(actorId, notificationId) {
    return store.update((state) => {
      for (const entry of state.notifications) {
        if (entry.userId === actorId && (!notificationId || entry.id === notificationId))
          entry.read = true;
      }
      return { ok: true };
    });
  }

  /** What one signed-in person sees. Viewers see briefings only once they are shared. */
  function view(userId) {
    const state = store.state;
    const role = store.roleOf(userId);
    const visible = state.briefings.filter(
      (b) => role !== "viewer" || b.shares.some((s) => !s.revoked),
    );
    const weeks = state.dataset ? weeksOf(state.dataset) : [];
    const figureWeeks = new Set([...visible.map((b) => b.week), weeks.at(-1)].filter(Boolean));
    return {
      rev: state.rev,
      me: store.user(userId),
      role,
      permissions: Object.keys(PERMISSIONS).filter((permission) => can(role, permission)),
      roles: ROLES,
      org: state.org,
      workspace: {
        ...state.workspace,
        members: state.workspace.members.map((member) => ({
          ...member,
          user: store.user(member.userId),
        })),
      },
      directory: store.users,
      library: state.library.filter((file) => !file.arrivesOnRun || file.arrived),
      upcoming: state.library.filter((file) => file.arrivesOnRun && !file.arrived),
      dataset: state.dataset && {
        ...state.dataset,
        weeks,
        quality: dataQuality(state.dataset),
      },
      datasetHistory: state.datasetHistory,
      overrides: state.overrides ?? [],
      editableColumns: EDITABLE_COLUMNS,
      figures: Object.fromEntries([...figureWeeks].map((week) => [week, figuresOf(state, week)])),
      briefings: visible.map((briefing) => ({
        ...briefing,
        versions: briefing.versions.map(({ blocks: _blocks, ...rest }) => rest),
        checks: checks(briefing.blocks, figuresOf(state, briefing.week)),
        approvalCurrent: briefing.approval
          ? diff(briefing.approval.snapshot, briefing.snapshot).length === 0
          : false,
      })),
      automations: state.automations,
      runs: state.runs,
      pins: state.pins,
      activity: state.activity.slice(0, 150),
      notifications: state.notifications.filter((entry) => entry.userId === userId).slice(0, 100),
      requests: state.requests.slice(0, 80),
      destinations: DESTINATIONS,
      connections: CONNECTIONS,
    };
  }

  return {
    view,
    importWorkbook,
    importFromLibrary,
    editCell,
    revertCorrection,
    workbookBytes: () => workbookBytes(store.state),
    generateBriefing,
    updateBlock,
    insertBlock,
    removeBlock,
    restoreVersion,
    requestReview,
    withdrawReview,
    addComment,
    resolveComment,
    approve,
    requestChanges,
    withdrawApproval,
    briefingDocx: (briefingId, origin) => {
      const briefing = briefingOf(store.state, briefingId);
      return { bytes: briefingDocx(store.state, briefing, origin), briefing };
    },
    sharedFile: (briefingId, shareId) => {
      const briefing = briefingOf(store.state, briefingId);
      const shared = briefing.shares.find((candidate) => candidate.id === shareId);
      if (!shared) throw new HttpError(404, "That share no longer exists.");
      return { bytes: store.readFile(shared.fileId), name: shared.fileName };
    },
    shareBriefing,
    unshare,
    createAutomation,
    updateAutomation,
    deleteAutomation,
    runAutomation,
    runDue,
    setPin,
    setMember,
    markRead,
    canRead: (userId, briefingId) => view(userId).briefings.some((b) => b.id === briefingId),
    system: SYSTEM,
  };
}

function runStatusText(status) {
  return (
    {
      waiting_for_review: "draft is waiting for review",
      no_new_data: "no new data",
      failed: "failed",
    }[status] ?? status
  );
}

function formatTime(iso) {
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
    timeZoneName: "short",
  });
}
