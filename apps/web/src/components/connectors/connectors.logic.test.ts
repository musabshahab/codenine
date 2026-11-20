import {
  ConnectorCatalogId,
  type ConnectorCatalogEntry,
  type ConnectorTool,
} from "@codenine/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  agentAlwaysScope,
  approvalChoiceLabels,
  approvalOutcomeLabel,
  customConnectRequest,
  groupToolsByRisk,
  libraryConnectRequest,
  servicesAcceptOrigin,
  signInReturnOrigin,
  splitCommandLine,
  webPageUrl,
} from "./connectors.logic";

const gmail: ConnectorCatalogEntry = {
  id: ConnectorCatalogId.make("gmail"),
  name: "Gmail",
  description: "Search, read and draft email.",
  category: "email-calendar",
  auth: "own-app",
  ownApp: "google",
  inputs: [],
  runsLocally: false,
};

const emptyValues = { inputs: {}, token: "", clientId: "", clientSecret: "" };

describe("sign-in addresses", () => {
  it.each([
    ["https://codenine.example.com", true],
    ["http://localhost:3773", true],
    ["http://127.0.0.1:3773", true],
    ["http://[::1]:3773", true],
    ["http://192.168.1.20:3773", false],
    ["http://studio.tailnet.ts.net", false],
    ["codenine://app", false],
  ])("services accept %s: %s", (origin, accepted) => {
    expect(servicesAcceptOrigin(origin)).toBe(accepted);
  });

  it("opens only web pages a server names for signing in", () => {
    expect(webPageUrl("https://accounts.google.com/o/oauth2/auth?x=1")).toBe(
      "https://accounts.google.com/o/oauth2/auth?x=1",
    );
    expect(webPageUrl("javascript:alert(1)")).toBeNull();
    expect(webPageUrl("not a url")).toBeNull();
    expect(webPageUrl(undefined)).toBeNull();
  });

  it("returns to the page's address, or the desktop app's server", () => {
    expect(signInReturnOrigin("http://localhost:5733", "http://127.0.0.1:3773")).toBe(
      "http://localhost:5733",
    );
    expect(signInReturnOrigin("codenine://app", "http://127.0.0.1:3773/")).toBe(
      "http://127.0.0.1:3773",
    );
    expect(signInReturnOrigin("codenine://app", null)).toBeNull();
    // Another computer's sign-in comes back to that computer, not to the page's server.
    expect(signInReturnOrigin("https://desk.example", "https://laptop.example:3773/", false)).toBe(
      "https://laptop.example:3773",
    );
  });
});

describe("libraryConnectRequest", () => {
  it("asks for the Google app only until one is saved", () => {
    expect(
      libraryConnectRequest(gmail, emptyValues, {
        savedApps: [],
        returnOrigin: "http://localhost:3773",
      }).errors,
    ).toEqual({ clientId: "Paste the client ID.", clientSecret: "Paste the client secret." });

    expect(
      libraryConnectRequest(
        gmail,
        { ...emptyValues, clientId: " id ", clientSecret: "secret" },
        { savedApps: [], returnOrigin: "http://localhost:3773" },
      ).input,
    ).toEqual({
      catalogId: "gmail",
      ownApp: { clientId: "id", clientSecret: "secret" },
      redirectOrigin: "http://localhost:3773",
    });

    expect(
      libraryConnectRequest(gmail, emptyValues, {
        savedApps: ["google"],
        returnOrigin: "http://localhost:3773",
      }).input,
    ).toEqual({ catalogId: "gmail", redirectOrigin: "http://localhost:3773" });
  });

  it("sends the token with the catalogue's answers and needs required ones", () => {
    const postgres: ConnectorCatalogEntry = {
      ...gmail,
      id: ConnectorCatalogId.make("postgres"),
      auth: "token",
      ownApp: undefined,
      tokenLabel: "Password",
      inputs: [
        { key: "url", label: "Database address", secret: false, required: true },
        { key: "schema", label: "Schema", secret: false, required: false },
      ],
    };
    const options = { savedApps: [], returnOrigin: null };
    expect(libraryConnectRequest(postgres, emptyValues, options).errors).toEqual({
      url: "Enter database address.",
      token: "Paste the password.",
    });
    expect(
      libraryConnectRequest(
        postgres,
        { ...emptyValues, inputs: { url: "postgres://db", schema: " " }, token: "pw" },
        options,
      ).input,
    ).toEqual({ catalogId: "postgres", inputs: { url: "postgres://db", token: "pw" } });
  });
});

describe("custom connectors", () => {
  it("splits a command the way a shell would", () => {
    expect(splitCommandLine(`npx -y server "my folder" 'a b'  ''`)).toEqual([
      "npx",
      "-y",
      "server",
      "my folder",
      "a b",
      "",
    ]);
  });

  it("connects a web address over http and anything else as a command", () => {
    expect(
      customConnectRequest(
        { name: "Docs", address: "https://mcp.example.com/mcp", auth: "none", token: "" },
        null,
      ).input,
    ).toEqual({
      custom: {
        name: "Docs",
        transport: { type: "http", url: "https://mcp.example.com/mcp" },
        auth: "none",
      },
    });
    expect(
      customConnectRequest(
        { name: "Files", address: "npx -y files-server /tmp", auth: "token", token: "t" },
        null,
      ).input,
    ).toEqual({
      custom: {
        name: "Files",
        transport: { type: "stdio", command: "npx", args: ["-y", "files-server", "/tmp"] },
        auth: "token",
      },
      inputs: { token: "t" },
    });
  });
});

describe("approvals", () => {
  it("words the buttons after what the action does", () => {
    expect(approvalChoiceLabels({ action: "send a draft" })).toEqual({
      allow: "Send",
      always: "Always send without asking",
      decline: "Don't send",
    });
    expect(approvalChoiceLabels({ action: "delete a thread" }).allow).toBe("Allow");
    // An agent's "always" covers more than the one action, sending included.
    expect(approvalChoiceLabels({ action: "send a draft", agent: "mail-helper" })).toEqual({
      allow: "Send",
      always: "Always allow for this agent",
      decline: "Don't send",
    });
    expect(agentAlwaysScope({ risk: "irreversible", connectorName: "Gmail" })).toBe(
      "Always lets it do anything that can't be undone on Gmail without asking.",
    );
    expect(approvalChoiceLabels({ action: "sending reports" }).allow).toBe("Allow");
  });

  it("says how an answered card ended", () => {
    expect(approvalOutcomeLabel({ approvalStatus: "pending" })).toBeNull();
    expect(approvalOutcomeLabel({ approvalStatus: "allowed", remembered: true })).toBe(
      "Allowed, won't ask again",
    );
    expect(approvalOutcomeLabel({ approvalStatus: "declined" })).toBe("Declined");
  });
});

it("groups actions by how far they reach, leaving out empty groups", () => {
  const tool = (name: string, risk: ConnectorTool["risk"]) => ({ name, risk });
  const groups = groupToolsByRisk([
    tool("send_draft", "irreversible"),
    tool("search", "read"),
    tool("get", "read"),
  ]);
  expect(groups.map((group) => [group.title, group.tools.map((entry) => entry.name)])).toEqual([
    ["Read", ["search", "get"]],
    ["Can't be undone", ["send_draft"]],
  ]);
});
