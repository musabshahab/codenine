#!/usr/bin/env node
// Weekly business review demo server: plain Node, no dependencies.
//   node demos/weekly-business-review/server/main.mjs [--port 4317] [--host 127.0.0.1] [--reset]

import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as NodeCrypto from "node:crypto";
import { createAuth } from "./auth.mjs";
import { createStore, logActivity } from "./store.mjs";
import { createWorkspace, HttpError } from "./workspace.mjs";
import { report } from "./model.mjs";
import { recordEmbedToken } from "./integrations.mjs";
import { aiConfig, rewriteBlock } from "./ai.mjs";

const root = NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const { values: options } = NodeUtil.parseArgs({
  options: {
    port: { type: "string", default: process.env.PORT ?? "4317" },
    host: { type: "string", default: process.env.HOST ?? "127.0.0.1" },
    data: { type: "string", default: process.env.WBR_DATA_DIR ?? NodePath.join(root, ".data") },
    reset: { type: "boolean", default: false },
  },
});

const store = createStore(options.data);
if (options.reset) store.reset();
const auth = createAuth(options.data);
const workspace = createWorkspace({ store, sampleDir: NodePath.join(root, "sample-data") });
const ai = aiConfig();

const presence = new Map();
const streams = new Map();
const embedded = new Set();

const STATIC_FILE = /^\/([\w-]+\.(?:js|css))$/;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function send(response, status, body, headers = {}) {
  const payload =
    typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body);
  response.writeHead(status, {
    "content-type":
      typeof body === "object" && !(body instanceof Uint8Array) ? "application/json" : "text/plain",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(payload);
}

function download(response, bytes, name, type) {
  send(response, 200, bytes, {
    "content-type": type,
    "content-disposition": `attachment; filename="${name.replace(/"/g, "")}"`,
  });
}

async function readBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit)
      throw new HttpError(413, "That file is too large for the demo (20 MB limit).");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const json = async (request) => {
  const body = await readBody(request, 1_000_000);
  return body.length ? JSON.parse(body.toString("utf8")) : {};
};

const originOf = (request) =>
  `${request.headers["x-forwarded-proto"] ?? "http"}://${request.headers.host}`;

function broadcastPresence() {
  const list = [...presence.values()].map(({ userId, client, page }) => ({ userId, client, page }));
  for (const stream of streams.values())
    stream.write(`event: presence\ndata: ${JSON.stringify(list)}\n\n`);
}

store.subscribe((rev) => {
  for (const stream of streams.values()) stream.write(`event: rev\ndata: ${rev}\n\n`);
});

const routes = [];
const route = (method, pattern, handler, { auth: needsAuth = true } = {}) =>
  routes.push({
    method,
    pattern: new RegExp(`^${pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)")}$`),
    handler,
    needsAuth,
  });

route(
  "GET",
  "/api/session",
  ({ userId }) => ({
    user: userId ? store.user(userId) : null,
    accounts: store.users.map((user) => ({ ...user, member: Boolean(store.roleOf(user.id)) })),
    org: store.state.org,
    ai: Boolean(ai),
  }),
  { auth: false },
);

route(
  "POST",
  "/api/auth/signin",
  async ({ request, response }) => {
    const { userId, client } = await json(request);
    if (!store.user(userId)) throw new HttpError(404, "Unknown account.");
    store.update((state) =>
      logActivity(state, {
        actor: userId,
        kind: "signin",
        text: `Signed in on ${client === "desktop" ? "the desktop app" : "the web"}`,
      }),
    );
    response.setHeader("set-cookie", auth.cookieFor(userId));
    return { ok: true };
  },
  { auth: false },
);

route(
  "POST",
  "/api/auth/signout",
  ({ response }) => {
    response.setHeader("set-cookie", auth.clearCookie);
    return { ok: true };
  },
  { auth: false },
);

route("GET", "/api/state", ({ userId }) => {
  if (!store.roleOf(userId))
    throw new HttpError(403, "You are not a member of this workspace. Ask an owner to add you.");
  return { ...workspace.view(userId), ai: Boolean(ai) };
});

route("GET", "/api/report", ({ userId, url }) => {
  const dataset = store.state.dataset;
  if (!dataset) throw new HttpError(404, "Import a workbook first.");
  const key = `${userId}:${dataset.version}`;
  if (!embedded.has(key)) {
    embedded.add(key);
    store.update((state) => recordEmbedToken(state, store.user(userId).email));
  }
  return report(dataset, url.searchParams.get("week"), url.searchParams.get("region") || null);
});

route("POST", "/api/presence", async ({ request, userId }) => {
  const { connection, page } = await json(request);
  const entry = presence.get(connection);
  if (entry && entry.userId === userId) {
    entry.page = String(page ?? "").slice(0, 60);
    broadcastPresence();
  }
  return { ok: true };
});

route("POST", "/api/data/import", async ({ request, userId }) => {
  const bytes = await readBody(request, 20_000_000);
  const fileName = decodeURIComponent(request.headers["x-file-name"] ?? "workbook.xlsx");
  return workspace.importWorkbook(userId, { bytes, fileName, source: "an upload" });
});
route("POST", "/api/data/import-library", async ({ request, userId }) =>
  workspace.importFromLibrary(userId, (await json(request)).libraryId),
);
route("POST", "/api/data/cell", async ({ request, userId }) =>
  workspace.editCell(userId, await json(request)),
);
route("POST", "/api/data/corrections/:id/revert", ({ userId, params }) =>
  workspace.revertCorrection(userId, params.id),
);
route("GET", "/api/data/workbook.xlsx", ({ response }) => {
  const dataset = store.state.dataset;
  download(
    response,
    workspace.workbookBytes(),
    dataset.fileName.replace(/\.xlsx$/, `-v${dataset.version}.xlsx`),
    XLSX,
  );
});
route("GET", "/api/data/versions/:version/file", ({ response, params }) => {
  const entry = store.state.datasetHistory.find(
    (candidate) => String(candidate.version) === params.version,
  );
  if (!entry?.fileId) throw new HttpError(404, "That version has no original file.");
  download(response, store.readFile(entry.fileId), entry.fileName, XLSX);
});

route("POST", "/api/briefings", async ({ request, userId }) => ({
  id: workspace.generateBriefing(userId, await json(request)),
}));
route("PATCH", "/api/briefings/:id/blocks/:block", async ({ request, userId, params }) =>
  workspace.updateBlock(userId, params.id, params.block, await json(request)),
);
route("POST", "/api/briefings/:id/blocks", async ({ request, userId, params }) =>
  workspace.insertBlock(userId, params.id, await json(request)),
);
route("DELETE", "/api/briefings/:id/blocks/:block", ({ userId, params }) =>
  workspace.removeBlock(userId, params.id, params.block),
);
route("POST", "/api/briefings/:id/blocks/:block/rewrite", async ({ request, userId, params }) => {
  if (!ai) throw new HttpError(400, "No model is configured. Set WBR_AI_MODEL to try rewriting.");
  const { instruction } = await json(request);
  const view = workspace.view(userId);
  const briefing = view.briefings.find((candidate) => candidate.id === params.id);
  const block = briefing?.blocks.find((candidate) => candidate.id === params.block);
  if (!block || block.text === undefined)
    throw new HttpError(400, "Only paragraphs can be rewritten.");
  let text;
  try {
    text = await rewriteBlock({
      text: block.text,
      instruction,
      figures: view.figures[briefing.week],
      config: ai,
    });
  } catch (error) {
    throw new HttpError(502, error.message);
  }
  return { text };
});
route("POST", "/api/briefings/:id/restore", async ({ request, userId, params }) =>
  workspace.restoreVersion(userId, params.id, (await json(request)).n),
);
route("POST", "/api/briefings/:id/review", async ({ request, userId, params }) =>
  workspace.requestReview(userId, params.id, await json(request)),
);
route("POST", "/api/briefings/:id/review/withdraw", ({ userId, params }) =>
  workspace.withdrawReview(userId, params.id),
);
route("POST", "/api/briefings/:id/comments", async ({ request, userId, params }) =>
  workspace.addComment(userId, params.id, await json(request)),
);
route("POST", "/api/briefings/:id/comments/:comment/resolve", async ({ request, userId, params }) =>
  workspace.resolveComment(userId, params.id, params.comment, (await json(request)).resolved),
);
route("POST", "/api/briefings/:id/approve", ({ userId, params }) =>
  workspace.approve(userId, params.id),
);
route("POST", "/api/briefings/:id/request-changes", async ({ request, userId, params }) =>
  workspace.requestChanges(userId, params.id, await json(request)),
);
route("POST", "/api/briefings/:id/approval/withdraw", ({ userId, params }) =>
  workspace.withdrawApproval(userId, params.id),
);
route("GET", "/api/briefings/:id/docx", ({ request, response, userId, params }) => {
  if (!workspace.canRead(userId, params.id))
    throw new HttpError(404, "That briefing is not available to you.");
  const { bytes, briefing } = workspace.briefingDocx(params.id, originOf(request));
  download(response, bytes, `WBR ${briefing.week}${briefing.approval ? "" : " DRAFT"}.docx`, DOCX);
});
route("POST", "/api/briefings/:id/share", async ({ request, userId, params }) =>
  workspace.shareBriefing(userId, params.id, {
    ...(await json(request)),
    origin: originOf(request),
  }),
);
route("POST", "/api/briefings/:id/shares/:share/revoke", ({ userId, params }) =>
  workspace.unshare(userId, params.id, params.share),
);
route("GET", "/api/briefings/:id/shares/:share/docx", ({ response, userId, params }) => {
  if (!workspace.canRead(userId, params.id))
    throw new HttpError(404, "That briefing is not available to you.");
  const { bytes, name } = workspace.sharedFile(params.id, params.share);
  download(response, bytes, name, DOCX);
});

route("POST", "/api/automations", async ({ request, userId }) => ({
  id: workspace.createAutomation(userId, await json(request)),
}));
route("PATCH", "/api/automations/:id", async ({ request, userId, params }) =>
  workspace.updateAutomation(userId, params.id, await json(request)),
);
route("DELETE", "/api/automations/:id", ({ userId, params }) =>
  workspace.deleteAutomation(userId, params.id),
);
route("POST", "/api/automations/:id/run", ({ request, userId, params }) =>
  workspace.runAutomation(userId, params.id, { trigger: "run now", origin: originOf(request) }),
);

route("POST", "/api/pins", async ({ request, userId }) =>
  workspace.setPin(userId, await json(request)),
);
route("POST", "/api/members", async ({ request, userId }) =>
  workspace.setMember(userId, await json(request)),
);
route("POST", "/api/notifications/read", async ({ request, userId }) =>
  workspace.markRead(userId, (await json(request)).id),
);
route("POST", "/api/demo/reset", () => {
  store.reset();
  embedded.clear();
  return { ok: true };
});

function openStream(request, response, userId, url) {
  const connection = NodeCrypto.randomUUID();
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  response.write(`event: hello\ndata: ${JSON.stringify({ connection, rev: store.state.rev })}\n\n`);
  streams.set(connection, response);
  presence.set(connection, {
    userId,
    client: url.searchParams.get("client") === "desktop" ? "desktop" : "web",
    page: "",
  });
  broadcastPresence();
  const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 25_000);
  request.on("close", () => {
    clearInterval(keepAlive);
    streams.delete(connection);
    presence.delete(connection);
    broadcastPresence();
  });
}

const server = NodeHttp.createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  try {
    const asset = url.pathname === "/" ? "index.html" : STATIC_FILE.exec(url.pathname)?.[1];
    if (request.method === "GET" && asset && NodeFS.existsSync(NodePath.join(root, "web", asset))) {
      const file = NodePath.join(root, "web", asset);
      return send(response, 200, NodeFS.readFileSync(file), {
        "content-type": TYPES[NodePath.extname(file)],
      });
    }
    const sample = /^\/sample\/(contoso-fulfilment-2026-W4[78]\.xlsx)$/.exec(url.pathname);
    if (request.method === "GET" && sample) {
      return download(
        response,
        NodeFS.readFileSync(NodePath.join(root, "sample-data", sample[1])),
        sample[1],
        XLSX,
      );
    }
    const userId = auth.userIdFrom(request);
    if (request.method === "GET" && url.pathname === "/api/events") {
      if (!userId) throw new HttpError(401, "Sign in first.");
      return openStream(request, response, userId, url);
    }
    // Mutations need a header a cross-site form cannot send.
    if (request.method !== "GET" && request.headers["x-requested-with"] !== "wbr") {
      throw new HttpError(403, "Missing request header.");
    }
    for (const candidate of routes) {
      if (candidate.method !== request.method) continue;
      const match = candidate.pattern.exec(url.pathname);
      if (!match) continue;
      if (candidate.needsAuth && !userId) throw new HttpError(401, "Sign in first.");
      const result = await candidate.handler({
        request,
        response,
        url,
        userId,
        params: match.groups ?? {},
      });
      if (!response.headersSent) send(response, 200, result ?? { ok: true });
      return;
    }
    throw new HttpError(404, "Not found.");
  } catch (error) {
    const status =
      error instanceof HttpError ? error.status : error instanceof SyntaxError ? 400 : 500;
    if (status === 500) console.error(error);
    if (!response.headersSent)
      send(response, status, {
        error: status === 500 ? "Something went wrong on the server." : error.message,
      });
  }
});

const port = Number(options.port);
server.listen(port, options.host, () => {
  const shown = options.host === "0.0.0.0" ? "localhost" : options.host;
  console.log(`Weekly business review demo: http://${shown}:${port}`);
  console.log(
    `Data: ${options.data}${NodeFS.existsSync(NodePath.join(root, "sample-data")) ? "" : " (sample data missing: run scripts/make-sample-data.mjs)"}`,
  );
  if (ai) console.log(`Rewrite with a model: on (${ai.url})`);
});

setInterval(() => {
  try {
    workspace.runDue(`http://${options.host === "0.0.0.0" ? "localhost" : options.host}:${port}`);
  } catch (error) {
    console.error("Scheduled run failed:", error);
  }
}, 30_000).unref();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const stream of streams.values()) stream.end();
    server.close(() => process.exit(0));
  });
}
