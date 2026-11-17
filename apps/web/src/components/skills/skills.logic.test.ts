import { skillTitle } from "@codenine/contracts";
import { describe, expect, it } from "vite-plus/test";

import { checkSkillDraft, skillNameFromTitle } from "./skills.logic";

describe("skill names", () => {
  it.each([
    ["Our email tone", "our-email-tone"],
    ["  Release -- checklist! ", "release-checklist"],
    ["Café notes 2", "cafe-notes-2"],
    ["write-clear-emails", "write-clear-emails"],
  ])("saves %j as %s", (title, name) => {
    expect(skillNameFromTitle(title)).toBe(name);
  });

  it("shows a saved name as a title that saves back to the same name", () => {
    expect(skillTitle("write-clear-emails")).toBe("Write clear emails");
    expect(skillNameFromTitle(skillTitle("write-clear-emails"))).toBe("write-clear-emails");
  });

  it("holds the form until it has a usable name and a description", () => {
    expect(checkSkillDraft({ title: "", description: "" }).errors).toEqual({
      title: "Give the skill a name.",
      description: "Say when agents should use it.",
    });
    expect(checkSkillDraft({ title: "!!!", description: "When writing" }).errors).toEqual({
      title: "Use letters or numbers in the name.",
    });
    expect(checkSkillDraft({ title: "a".repeat(65), description: "x" }).errors).toEqual({
      title: "Use a shorter name.",
    });
    expect(checkSkillDraft({ title: "Tone", description: "x".repeat(1025) }).errors).toEqual({
      description: "Keep this under 1,024 characters.",
    });
    expect(checkSkillDraft({ title: "Our email tone", description: " Writing email " })).toEqual({
      name: "our-email-tone",
    });
  });
});
