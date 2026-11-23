import { WorkspaceKind } from "@codenine/contracts";
import { describe, expect, it } from "vite-plus/test";

import { WORKSPACE_PRESETS, workspacePreset } from "./workspacePreset.ts";

describe("workspacePreset", () => {
  it("gives code workspaces, and projects without a type, the chat as it was before types", () => {
    expect(workspacePreset("code")).toEqual({
      startScreen: {
        headline: "What would you like to do?",
        teamHeadline: "What should the team build?",
        subline: "Ask anything about this workspace.",
        examples: [
          { prompt: "Add sign-in with tests, then have a stronger model review it", team: true },
          { prompt: "Explain how this workspace is structured", team: false },
          { prompt: "Fix the failing test and explain the cause", team: false },
        ],
      },
      composerControls: { checkout: true, gitActions: true },
      rightPanelTabs: ["terminal", "files", "diff", "side-chat", "task", "workflow"],
      agentAbilities: { readFiles: false, editFiles: false, runCommands: false, searchWeb: false },
      suggestedConnectors: ["github", "linear", "sentry", "context7"],
      suggestedSkills: ["review-code", "write-release-notes", "plan-a-project"],
    });
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
  });

  it.each(["work", "create"] as const)("keeps Git and commands out of a %s workspace", (kind) => {
    const preset = workspacePreset(kind);
    expect(preset.composerControls).toEqual({ checkout: false, gitActions: false });
    expect(preset.agentAbilities.runCommands).toBe(false);
  });
});
