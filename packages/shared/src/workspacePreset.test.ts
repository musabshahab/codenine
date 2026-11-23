import { WorkspaceKind } from "@codenine/contracts";
import { describe, expect, it } from "vite-plus/test";

import { WORKSPACE_PRESETS, workspacePreset } from "./workspacePreset.ts";

describe("workspacePreset", () => {
  it("treats a project without a type as a code workspace", () => {
    expect(workspacePreset(null)).toBe(WORKSPACE_PRESETS.code);
    expect(workspacePreset(undefined)).toBe(WORKSPACE_PRESETS.code);
  });

  it.each(WorkspaceKind.literals)("has a complete %s preset", (kind) => {
    const preset = workspacePreset(kind);
    const { headline, teamHeadline, subline, examples } = preset.startScreen;
    for (const text of [headline, teamHeadline, subline, ...examples.map((e) => e.prompt)]) {
      expect(text.trim()).not.toBe("");
      expect(text).not.toMatch(/[—–]/);
    }
    expect(examples).toHaveLength(3);
    expect(preset.rightPanelTabs).toEqual(expect.arrayContaining(["files", "task", "workflow"]));
    expect(preset.rightPanelTabs.includes("diff")).toBe(preset.composerControls.checkout);
    expect(preset.suggestedConnectors.length).toBeGreaterThan(0);
    // Documents open as the page with the chat beside them; code opens beside the chat.
    expect(preset.fileView).toBe(kind === "code" ? "chat" : "document");
    expect(workspacePreset(kind, "/repo-worktrees/a").fileView).toBe(preset.fileView);
  });

  it("suits a Work workspace to documents: its agents may edit, and the document skill leads", () => {
    const { agentAbilities, suggestedSkills } = workspacePreset("work");
    expect(agentAbilities).toMatchObject({ readFiles: true, editFiles: true, runCommands: false });
    expect(suggestedSkills[0]).toBe("work-with-documents");
    expect(workspacePreset("code").rightPanelTabs).not.toContain("sources");
  });

  it("lets only a Create workspace's new agents pay for images", () => {
    expect(
      WorkspaceKind.literals.filter((kind) => workspacePreset(kind).agentAbilities.makeImages),
    ).toEqual(["create"]);
  });

  it.each(["work", "create"] as const)("keeps Git and commands out of a %s workspace", (kind) => {
    const preset = workspacePreset(kind);
    expect(preset.composerControls).toEqual({ checkout: false, gitActions: false });
    expect(preset.agentAbilities.runCommands).toBe(false);
    // Only a Work workspace lists the tabs for what a chat read and changed, in a worktree too.
    const documentTabs = kind === "work" ? ["sources", "activity"] : [];
    expect(preset.rightPanelTabs.slice(0, documentTabs.length)).toEqual(documentTabs);
    expect(workspacePreset(kind, "/repo-worktrees/a").rightPanelTabs.slice(0, 2)).toEqual(
      kind === "work" ? documentTabs : ["terminal", "files"],
    );
    // A chat that already runs in a worktree keeps the controls that show and land its branch.
    const inWorktree = workspacePreset(kind, "/repo-worktrees/a");
    expect(inWorktree.composerControls).toEqual({ checkout: true, gitActions: true });
    expect(inWorktree.rightPanelTabs).toContain("diff");
    expect(inWorktree.startScreen).toBe(preset.startScreen);
    expect(workspacePreset(kind, null)).toBe(preset);
  });
});
