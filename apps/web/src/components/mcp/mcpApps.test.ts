import { describe, expect, it } from "vite-plus/test";

import { agentsCanSignInAt, MCP_APPS, mcpHandoffAction } from "./mcpApps";

const MCP_URL = "https://prod-a1.codeninerelay.com/mcp?x=1&y=two words";

describe("MCP app links", () => {
  it("fill in Codenine and the encoded URL", () => {
    const opened = (id: string) => {
      const app = MCP_APPS.find((candidate) => candidate.id === id)!;
      return new URL(mcpHandoffAction(app, MCP_URL)!.link);
    };
    const poke = opened("poke");
    expect(poke.searchParams.get("name")).toBe("Codenine");
    expect(poke.searchParams.get("url")).toBe(MCP_URL);
    const claude = opened("claude");
    expect(claude.searchParams.get("connectorName")).toBe("Codenine");
    expect(claude.searchParams.get("connectorUrl")).toBe(MCP_URL);
  });

  // The desktop app opens only http and https links.
  it.each(MCP_APPS.map((app) => [app.name, app] as const))("%s opens only https", (_, app) => {
    const link = mcpHandoffAction(app, MCP_URL)?.link;
    for (const url of [link, app.docs].filter((value) => value != null)) {
      expect(new URL(url).protocol).toBe("https:");
    }
  });
});

describe("agent sign-in", () => {
  it.each([
    ["https://machine.tailnet.ts.net/mcp", true],
    ["http://localhost:3773/mcp", true],
    ["http://127.0.0.1:3773/mcp", true],
    ["http://[::1]:3773/mcp", true],
    ["http://192.168.4.53:3773/mcp", false],
    ["http://100.115.1.44:3773/mcp", false],
    ["http://machine.local:3773/mcp", false],
  ])("%s can sign in: %s", (url, expected) => {
    expect(agentsCanSignInAt(url)).toBe(expected);
  });
});
