import { describe, expect, it } from "@effect/vitest";

import { isSkillName, parseSkillFile, renderSkillFile, slugifySkillName } from "./SkillFile.ts";
import { SKILL_LIBRARY } from "./SkillLibrary.ts";

describe("SKILL.md", () => {
  it("keeps every other frontmatter key, and its comments, when a skill is edited", () => {
    const existing = `---
# Owned by the platform team
name: old-name
description: Old text
license: Apache-2.0
allowed-tools: Bash(git:*) Read
metadata:
  author: acme
  codenine-library: review-code
---

# Old instructions
`;
    const rendered = renderSkillFile({
      existing,
      name: "review-code",
      description: "Reviews a change. Use when: asked for a review.",
      instructions: "\n# New instructions\n\n1. Read the diff.\n",
    });
    expect(rendered).toBe(`---
# Owned by the platform team
name: review-code
description: "Reviews a change. Use when: asked for a review."
license: Apache-2.0
allowed-tools: Bash(git:*) Read
metadata:
  author: acme
  codenine-library: review-code
---

# New instructions

1. Read the diff.
`);
    expect(parseSkillFile(rendered)).toEqual({
      name: "review-code",
      description: "Reviews a change. Use when: asked for a review.",
      fromLibrary: "review-code",
      instructions: "# New instructions\n\n1. Read the diff.",
    });
  });

  it.each([
    {
      case: "an unquoted colon, which agents accept",
      contents: "---\nname: deploy\ndescription: Ships it. Use when: deploying\n---\nSteps\n",
      expected: { name: "deploy", description: "Ships it. Use when: deploying" },
    },
    {
      case: "frontmatter that is not YAML",
      contents: "---\nname: [deploy\n  description: {{\n---\nSteps\n",
      expected: { name: undefined, description: undefined },
    },
    {
      case: "no frontmatter",
      contents: "Steps\n",
      expected: { name: undefined, description: undefined },
    },
    {
      case: "empty frontmatter",
      contents: "---\n---\nSteps\n",
      expected: { name: undefined, description: undefined },
    },
  ])("reads what it can from $case", ({ contents, expected }) => {
    expect(parseSkillFile(contents)).toEqual({
      ...expected,
      fromLibrary: undefined,
      instructions: "Steps",
    });
  });

  it("writes a new skill's name and description first", () => {
    expect(
      renderSkillFile({
        name: "triage-an-inbox",
        description: "Sorts messages.",
        instructions: "",
        fromLibrary: "triage-an-inbox",
      }),
    ).toBe(
      "---\nname: triage-an-inbox\ndescription: Sorts messages.\nmetadata:\n  codenine-library: triage-an-inbox\n---\n",
    );
  });

  it.each([
    ["plugin:Review Code", "plugin-review-code"],
    ["Café notes", "cafe-notes"],
    ["--", "skill"],
    [`${"a".repeat(63)}-b`, "a".repeat(63)],
  ])("makes a valid name from %j", (label, slug) => {
    expect(slugifySkillName(label)).toBe(slug);
    expect(isSkillName(slug)).toBe(true);
  });
});

describe("Codenine's skill library", () => {
  it.each(SKILL_LIBRARY.map((skill) => [skill.name, skill] as const))(
    "%s is a valid skill that survives a round trip",
    (name, skill) => {
      expect(isSkillName(name)).toBe(true);
      expect(skill.description.length).toBeGreaterThan(80);
      expect(skill.description.length).toBeLessThanOrEqual(1024);
      expect(skill.description).toMatch(/Use when/);
      expect(skill.instructions.split("\n").length).toBeLessThan(500);
      const parsed = parseSkillFile(renderSkillFile({ ...skill, fromLibrary: skill.name }));
      expect(parsed).toEqual({
        name,
        description: skill.description,
        fromLibrary: name,
        instructions: skill.instructions,
      });
    },
  );
});
