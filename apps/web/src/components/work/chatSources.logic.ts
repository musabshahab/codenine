import { classifyToolActivity, collectToolFilePaths } from "@codenine/shared/toolActivity";

/** A turn item as the thread records it, read by field so older and newer shapes both work. */
export interface SourceTurnItem {
  readonly type: string;
  readonly [field: string]: unknown;
}

export interface SourceAttachment {
  readonly id: string;
  readonly name: string;
  readonly [field: string]: unknown;
}

export interface ChatSources {
  /** Workspace-relative where the file is in the workspace, else the path as the agent named it. */
  readonly files: ReadonlyArray<{ readonly path: string; readonly inWorkspace: boolean }>;
  readonly attachments: ReadonlyArray<SourceAttachment>;
  readonly pages: ReadonlyArray<{ readonly url: string; readonly title: string | null }>;
  /** Web searches that named no page. */
  readonly searches: ReadonlyArray<string>;
  readonly connectors: ReadonlyArray<{
    readonly name: string;
    readonly tools: ReadonlyArray<string>;
  }>;
}

const CODENINE_SERVERS = new Set(["codenine", "codenine-direct", "codenine_direct"]);
// Codenine's own tools that read a workspace document named by `path`.
const DOCUMENT_READ_TOOL = /^codenine_(spreadsheet|pdf|deck)_read$/;
const FETCH_TOOL = /^(webfetch|web_fetch|fetch|fetch_url|open_url|browser_navigate)$/i;

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

/** The server and tool of an MCP call, as Claude (`mcp__a__b`) and Codex (`a.b`) name it. */
function mcpCall(toolName: string): { readonly server: string; readonly tool: string } | null {
  const claude = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (claude) return { server: claude[1]!, tool: claude[2]! };
  const codex = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_.-]+)$/.exec(toolName);
  return codex ? { server: codex[1]!, tool: codex[2]! } : null;
}

const webAddress = (value: unknown): string | null => {
  const address = text(value);
  return address !== null && /^https?:\/\//i.test(address) ? address : null;
};

/**
 * What a chat read or cited, from its recorded turn items: files the agent read, files the user
 * attached, web pages it fetched or found, and connectors it used. Each appears once, in the
 * order it was first used.
 */
export function deriveChatSources(
  items: ReadonlyArray<SourceTurnItem>,
  workspaceRoot: string | undefined,
): ChatSources {
  const files = new Map<string, { path: string; inWorkspace: boolean }>();
  const attachments = new Map<string, SourceAttachment>();
  const pages = new Map<string, { url: string; title: string | null }>();
  const searches = new Set<string>();
  const connectors = new Map<string, Set<string>>();

  const root = workspaceRoot?.replaceAll("\\", "/").replace(/\/+$/, "");
  const addFile = (named: string) => {
    const normalized = named.replaceAll("\\", "/");
    const absolute = /^([A-Za-z]:\/|\/)/.test(normalized);
    const inside = root !== undefined && normalized.startsWith(`${root}/`);
    // A relative path is relative to the chat's folder, which is the workspace.
    const path = inside ? normalized.slice(root.length + 1) : normalized.replace(/^\.\//, "");
    if (path === "" || (!absolute && root === undefined)) return;
    if (!files.has(path)) files.set(path, { path, inWorkspace: inside || !absolute });
  };
  const addPage = (url: string, title: string | null) => {
    const known = pages.get(url);
    if (known === undefined) pages.set(url, { url, title });
    else if (known.title === null && title !== null) known.title = title;
  };

  for (const item of items) {
    switch (item.type) {
      case "user_message":
        for (const attachment of Array.isArray(item.attachments) ? item.attachments : []) {
          const entry = record(attachment);
          const id = text(entry?.id);
          const name = text(entry?.name);
          if (entry && id !== null && name !== null && !attachments.has(id)) {
            attachments.set(id, { ...entry, id, name });
          }
        }
        break;
      case "web_search": {
        const results = Array.isArray(item.results) ? item.results : [];
        let found = false;
        for (const result of results) {
          const url = webAddress(record(result)?.url);
          if (url === null) continue;
          found = true;
          addPage(url, text(record(result)?.title));
        }
        if (!found) {
          for (const pattern of Array.isArray(item.patterns) ? item.patterns : []) {
            const query = text(pattern);
            if (query !== null) searches.add(query);
          }
        }
        break;
      }
      case "dynamic_tool": {
        const toolName = text(item.toolName);
        if (toolName === null) break;
        const input = record(item.input);
        const call = mcpCall(toolName);
        if (call !== null && !CODENINE_SERVERS.has(call.server.toLowerCase())) {
          const tools = connectors.get(call.server) ?? new Set<string>();
          connectors.set(call.server, tools.add(call.tool));
          break;
        }
        const bare = call?.tool ?? toolName;
        if (DOCUMENT_READ_TOOL.test(bare)) {
          const path = text(input?.path);
          if (path !== null) addFile(path);
          break;
        }
        if (FETCH_TOOL.test(bare)) {
          const url = webAddress(input?.url);
          if (url !== null) addPage(url, null);
          break;
        }
        const viewed = text(item.viewedImagePath);
        if (viewed !== null) addFile(viewed);
        if (
          classifyToolActivity({ itemType: "dynamic_tool_call", data: { toolName, input } }) ===
          "read"
        ) {
          for (const path of collectToolFilePaths({ input })) addFile(path);
        }
        break;
      }
    }
  }
  return {
    files: [...files.values()],
    attachments: [...attachments.values()],
    pages: [...pages.values()],
    searches: [...searches],
    connectors: [...connectors].map(([name, tools]) => ({ name, tools: [...tools] })),
  };
}

export const chatSourcesCount = (sources: ChatSources) =>
  sources.files.length +
  sources.attachments.length +
  sources.pages.length +
  sources.searches.length +
  sources.connectors.length;
