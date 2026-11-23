import { type AgentDefinition, ConnectionId, ProviderInstanceId } from "@codenine/contracts";
import { describe, expect, it } from "@effect/vitest";

import { NO_ABILITIES, parseAgentFile, renderAgentFile } from "./AgentFile.ts";

const reviewer: AgentDefinition = {
  name: "code-reviewer",
  title: "Code reviewer",
  description: "Reviews pull requests: correctness first, then style.",
  instructions: "Read the diff before the description.\n\n---\n\nNever approve your own work.",
  model: { instanceId: ProviderInstanceId.make("claude_work"), model: "claude-x", effort: "high" },
  skills: ["review-code"],
  connectors: [{ id: ConnectionId.make("github"), approvals: { change: "ask", read: "auto" } }],
  abilities: {
    readFiles: true,
    editFiles: false,
    runCommands: true,
    searchWeb: false,
    makeImages: true,
  },
};

describe("AGENT.md", () => {
  it("reads back what it writes, and keeps keys it does not know", () => {
    expect(parseAgentFile("code-reviewer", renderAgentFile(reviewer))).toEqual(reviewer);

    const edited = renderAgentFile(
      { ...reviewer, model: null, instructions: "" },
      `---\nname: code-reviewer\nteam: platform # who owns it\n---\n\nOld instructions.\n`,
    );
    expect(edited).toContain("team: platform");
    expect(edited).not.toContain("model:");
    expect(edited).not.toContain("Old instructions.");
    expect(parseAgentFile("code-reviewer", edited)).toEqual({
      ...reviewer,
      model: null,
      instructions: "",
    });
  });

  it("gives a hand-edited agent less, never more, where it cannot read a value", () => {
    const parsed = parseAgentFile(
      "triager",
      [
        "---",
        "title: '   '",
        "model: { instanceId: codex, model: gpt-x, effort: extreme }",
        "skills: [triage, Not A Skill, triage, 7]",
        "connectors:",
        "  - id: github",
        "    approvals: { read: auto, change: sometimes }",
        "  - id: Bad Id",
        "  - github",
        "  - id: github",
        "abilities: { readFiles: yes, editFiles: true, runCommands: 'true' }",
        "---",
        "Sort new issues.",
      ].join("\n"),
    );
    expect(parsed).toEqual({
      name: "triager",
      title: "triager",
      description: "triager",
      instructions: "Sort new issues.",
      model: null,
      skills: ["triage"],
      connectors: [{ id: "github", approvals: { read: "auto", change: "ask" } }],
      abilities: { ...NO_ABILITIES, editFiles: true },
    });
  });

  it("cannot read a file without a frontmatter map", () => {
    expect(parseAgentFile("broken", "Just instructions.\n")).toBeUndefined();
    expect(parseAgentFile("broken", "---\n- a list\n---\nBody\n")).toBeUndefined();
    expect(parseAgentFile("broken", "---\ntitle: [unclosed\n---\nBody\n")).toBeUndefined();
  });
});
