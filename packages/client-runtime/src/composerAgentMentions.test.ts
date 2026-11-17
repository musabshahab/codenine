import { describe, expect, it } from "vite-plus/test";

import {
  collectComposerAgentMentions,
  formatComposerAgentMention,
} from "./composerAgentMentions.ts";

describe("collectComposerAgentMentions", () => {
  it("finds the agent references the @ menu writes, and nothing that only looks like one", () => {
    const text = `${formatComposerAgentMention("gmail")} sort my inbox, then ask (agent:code-reviewer).`;
    expect(collectComposerAgentMentions(text)).toEqual([
      { name: "gmail", source: "agent:gmail", start: 0, end: 11 },
      { name: "code-reviewer", source: "agent:code-reviewer", start: 37, end: 56 },
    ]);
    expect(collectComposerAgentMentions("useragent:gmail agent:Gmail agent:gmail- agent:")).toEqual(
      [],
    );
  });
});
