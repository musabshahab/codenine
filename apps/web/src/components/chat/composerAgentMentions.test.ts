import { AgentName } from "@codenine/contracts";
import { describe, expect, it } from "vite-plus/test";

import { matchComposerAgentItems } from "./composerAgentMentions";
import type { ModelPickerAgents } from "./ModelPickerAgentRow";

const agents = (selected: AgentName | null): ModelPickerAgents => ({
  items: [
    {
      name: AgentName.make("gmail"),
      title: "Gmail",
      detail: "Reads and drafts email",
      disabledReason: null,
    },
    {
      name: AgentName.make("code-reviewer"),
      title: "Code reviewer",
      detail: "Reviews a change",
      disabledReason: null,
    },
    {
      name: AgentName.make("researcher"),
      title: "Researcher",
      detail: "Answers with sources",
      disabledReason: "Choose a model to use it",
    },
  ],
  selected,
  selectedTitle: null,
  onPick: () => true,
});
const names = (items: ReturnType<typeof matchComposerAgentItems>) => items.map((item) => item.name);

describe("matchComposerAgentItems", () => {
  it("lists the agents a chat can hand off to, and No agent once it has one", () => {
    expect(names(matchComposerAgentItems(agents(null), ""))).toEqual(["gmail", "code-reviewer"]);
    expect(names(matchComposerAgentItems(agents(AgentName.make("gmail")), ""))).toEqual([
      null,
      "gmail",
      "code-reviewer",
    ]);
    expect(matchComposerAgentItems(undefined, "")).toEqual([]);
  });

  it("matches the starts of the words in an agent's title or name", () => {
    expect(names(matchComposerAgentItems(agents(null), "rev"))).toEqual(["code-reviewer"]);
    expect(names(matchComposerAgentItems(agents(null), "code-rev"))).toEqual(["code-reviewer"]);
    expect(names(matchComposerAgentItems(agents(null), "mail"))).toEqual([]);
    expect(names(matchComposerAgentItems(agents(null), "src/app.ts"))).toEqual([]);
    expect(names(matchComposerAgentItems(agents(AgentName.make("gmail")), "no"))).toEqual([null]);
  });
});
