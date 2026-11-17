import { ConnectionId, ProviderInstanceId } from "@codenine/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type AgentDraft,
  agentAbilitiesLine,
  agentConnectorsLine,
  agentModelGroups,
  agentModelLine,
  agentUsesLine,
  checkAgentDraft,
  copyTitle,
  modelInfoLine,
  NO_ABILITIES,
} from "./agents.logic";

const gmail = ConnectionId.make("gmail");
const github = ConnectionId.make("github");
const claude = ProviderInstanceId.make("claudeAgent");
const draft: AgentDraft = {
  title: "Code reviewer",
  description: " Reviews a change for bugs. ",
  instructions: "Most serious first.",
  model: { instanceId: claude, model: "claude-sonnet-5-5", effort: "high" },
  skills: ["review-code"],
  connectors: [{ id: github, approvals: {} }],
  abilities: { ...NO_ABILITIES, readFiles: true },
};

describe("checkAgentDraft", () => {
  it("names the agent after its title, as skills are named", () => {
    expect(checkAgentDraft(draft, true)).toEqual({
      agent: {
        name: "code-reviewer",
        title: "Code reviewer",
        description: "Reviews a change for bugs.",
        instructions: "Most serious first.",
        model: draft.model,
        skills: ["review-code"],
        connectors: [{ id: github, approvals: {} }],
        abilities: draft.abilities,
      },
    });
  });

  it("holds the form until the agent can be saved and run", () => {
    expect(checkAgentDraft({ ...draft, title: " ", description: "" }, true).errors).toEqual({
      title: "Give the agent a name.",
      description: "Say what to use it for.",
    });
    expect(checkAgentDraft({ ...draft, title: "!!!" }, true).errors).toEqual({
      title: "Use letters or numbers in the name.",
    });
    expect(checkAgentDraft({ ...draft, title: "a ".repeat(41) }, true).errors).toEqual({
      title: "Use a shorter name.",
    });
    expect(checkAgentDraft({ ...draft, description: "x".repeat(1025) }, null).errors).toEqual({
      description: "Keep this under 1,024 characters.",
    });
    expect(checkAgentDraft(draft, false).errors).toEqual({
      model: "This model can't use connectors. Choose another model or remove the connectors.",
    });
    expect(checkAgentDraft({ ...draft, connectors: [] }, false)).toMatchObject({
      agent: { name: "code-reviewer" },
    });
  });
});

it("titles a copy so its name is free", () => {
  expect(copyTitle("Gmail", ["gmail"])).toBe("Gmail copy");
  expect(copyTitle("Gmail", ["gmail", "gmail-copy", "gmail-copy-2"])).toBe("Gmail copy 3");
});

describe("an agent's summary lines", () => {
  it("names the model with its effort and account, leaving out an effort the model lacks", () => {
    expect(
      agentModelLine({ name: "Claude Sonnet 5.5", effort: "medium", account: "Claude (Work)" }),
    ).toBe("Claude Sonnet 5.5 · Medium effort · Claude (Work)");
    expect(agentModelLine({ name: "Gemini 4", effort: null, account: "OpenRouter" })).toBe(
      "Gemini 4 · OpenRouter",
    );
    expect(agentModelLine(null)).toBe("None yet");
  });

  it("says which of a connector's actions ask first once that differs from the start", () => {
    const connections = [
      {
        id: gmail,
        name: "Gmail",
        approvals: { read: "auto", change: "auto", irreversible: "ask" },
      },
      {
        id: github,
        name: "GitHub",
        approvals: { read: "auto", change: "ask", irreversible: "ask" },
      },
    ] as const;
    expect(
      agentConnectorsLine(
        [
          { id: gmail, approvals: {} },
          { id: github, approvals: {} },
        ],
        connections,
      ),
    ).toBe("Gmail, GitHub · asks before changes and what can't be undone");
    expect(
      agentConnectorsLine(
        [
          { id: gmail, approvals: { irreversible: "auto" } },
          { id: github, approvals: { read: "ask" } },
          { id: ConnectionId.make("linear"), approvals: {} },
        ],
        connections,
      ),
    ).toBe("Gmail · never asks, GitHub · asks before every action, linear (not connected)");
    expect(agentConnectorsLine([], connections)).toBe("None");
  });

  it("lists what the agent may do on the computer", () => {
    expect(agentAbilitiesLine(NO_ABILITIES)).toBe("Nothing: no files, commands or web");
    expect(agentAbilitiesLine({ ...NO_ABILITIES, readFiles: true, runCommands: true })).toBe(
      "Reads files and runs commands",
    );
    expect(
      agentAbilitiesLine({ readFiles: true, editFiles: true, runCommands: false, searchWeb: true }),
    ).toBe("Reads files, edits files and searches the web");
  });

  it("says what a chat's agent uses", () => {
    expect(agentUsesLine(["Gmail"], ["write-clear-emails", "our-email-tone"])).toBe(
      "Uses Gmail · Write clear emails, Our email tone",
    );
    expect(agentUsesLine([], [])).toBe("No connectors or skills");
  });
});

it("describes a model from what its account says, and nothing it does not", () => {
  expect(
    modelInfoLine({ usesTools: true, readsImages: true, price: { input: 3, output: 15 } }),
  ).toBe("Uses tools · Reads images · $3 / $15 per million tokens");
  expect(modelInfoLine({ usesTools: false, readsImages: null, price: null })).toBe(
    "Can't use tools",
  );
  expect(modelInfoLine({ usesTools: null, readsImages: false, price: null })).toBe("");
  expect(modelInfoLine(undefined)).toBe("");
});

describe("agentModelGroups", () => {
  const openRouter = ProviderInstanceId.make("openrouter");
  const accounts = [
    {
      instanceId: claude,
      name: "Claude (Work)",
      models: [
        { slug: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", info: null },
        { slug: "claude-haiku-5-5", name: "Claude Haiku 5.5", info: null },
      ],
    },
    {
      instanceId: openRouter,
      name: "OpenRouter",
      models: [
        {
          slug: "google/gemini-4",
          name: "Gemini 4",
          info: { usesTools: true, readsImages: true, price: null },
        },
        {
          slug: "acme/plain",
          name: "Plain",
          info: { usesTools: false, readsImages: false, price: null },
        },
      ],
    },
  ];

  it("keeps a model that can't use tools out of reach only when the agent has connectors", () => {
    const reasons = (needsTools: boolean) =>
      agentModelGroups(accounts, { query: "", needsTools })
        .flatMap((group) => group.models)
        .map((model) => [model.slug, model.disabledReason]);
    expect(reasons(true)).toEqual([
      ["claude-sonnet-5-5", null],
      ["claude-haiku-5-5", null],
      ["google/gemini-4", null],
      ["acme/plain", "Can't use connectors, which this agent needs"],
    ]);
    expect(reasons(false).every(([, reason]) => reason === null)).toBe(true);
  });

  it("searches model names and accounts, dropping accounts with no match", () => {
    const names = (query: string) =>
      agentModelGroups(accounts, { query, needsTools: false }).map((group) => [
        group.name,
        group.models.map((model) => model.name),
      ]);
    expect(names(" haiku")).toEqual([["Claude (Work)", ["Claude Haiku 5.5"]]]);
    expect(names("openrouter")).toEqual([["OpenRouter", ["Gemini 4", "Plain"]]]);
    expect(names("nothing")).toEqual([]);
  });
});
