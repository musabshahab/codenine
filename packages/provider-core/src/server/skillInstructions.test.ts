import { assert, describe, it } from "@effect/vitest";

import {
  attachedSkillContext,
  buildSkillsInstructions,
  keptOnSkillsContext,
} from "./skillInstructions.ts";

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

describe("buildSkillsInstructions", () => {
  it("adds nothing when there are no skills, and lists each skill on one line", () => {
    assert.equal(buildSkillsInstructions([]), "");
    const instructions = buildSkillsInstructions([
      { name: "review-code", description: "Reviews a change.\nUse when asked for a review." },
      { name: "plan-a-project", description: "" },
    ]);
    assert.include(instructions, "codenine_skill_read");
    assert.include(instructions, "- review-code: Reviews a change. Use when asked for a review.");
    assert.include(instructions, "- plan-a-project: (no description)");
  });

  it("stays within one Codex context entry and points to the list for the rest", () => {
    const skills = Array.from({ length: 60 }, (_, index) => ({
      name: `skill-${index}`,
      description: `Does task ${index} ${"carefully ".repeat(60)}`,
    }));
    const instructions = buildSkillsInstructions(skills);
    assert.isAtMost(utf8Bytes(instructions), 4_000);
    assert.include(instructions, "- skill-0: Does task 0 carefully");
    assert.include(instructions, "…");
    const listed = instructions.split("\n").filter((line) => line.startsWith("- skill-")).length;
    assert.include(instructions, `- ${60 - listed} more: list them with \`codenine_skill_list\`.`);
  });
});

describe("skill context", () => {
  it("attaches a named skill with its folder and files, cutting a very long one short", () => {
    const context = attachedSkillContext({
      name: "deploy",
      folder: '/home/user/acme "app"/.agents/skills/deploy',
      files: ["scripts/deploy.sh"],
      instructions: `# Deploy\n${"x".repeat(70_000)}`,
    });
    assert.include(
      context,
      '<codenine_skill name="deploy" folder="/home/user/acme &quot;app&quot;/.agents/skills/deploy">',
    );
    assert.include(context, "Its folder also holds scripts/deploy.sh.");
    assert.include(context, "[Cut short here. Read the rest in SKILL.md in the folder above.]");
    assert.isBelow(context.length, 61_000);
  });

  it("names kept-on skills without their text", () => {
    assert.equal(
      keptOnSkillsContext(["review-code", "write-clear-emails"]),
      "<codenine_skills_on>The user keeps these skills on for this chat: review-code, write-clear-emails. Read any you have not read in this conversation with `codenine_skill_read`, then follow them wherever they apply.</codenine_skills_on>",
    );
  });
});
