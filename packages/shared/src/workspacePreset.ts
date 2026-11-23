import type { AgentAbilities, WorkspaceKind } from "@codenine/contracts";

/** A right-panel tab a workspace can offer; an open file counts as "files". */
export type WorkspacePanelTab =
  | "terminal"
  | "files"
  | "diff"
  | "side-chat"
  | "task"
  | "workflow"
  | "sources"
  | "activity";

export interface WorkspaceExample {
  readonly prompt: string;
  /** Picking it also turns Team on. */
  readonly team: boolean;
}

/**
 * What a workspace type changes about the chat. Readers take the preset, never the kind, so a
 * type is changed here and nowhere else.
 */
export interface WorkspacePreset {
  readonly startScreen: {
    readonly headline: string;
    /** The headline while Team is on. */
    readonly teamHeadline: string;
    /** The line under the question: it shows as the empty composer's hint. */
    readonly subline: string;
    readonly examples: ReadonlyArray<WorkspaceExample>;
  };
  readonly composerControls: {
    /** The branch and worktree toolbar. Without it a chat works in the folder as it is. */
    readonly checkout: boolean;
    /** Commit, push, and creating or linking a pull request. */
    readonly gitActions: boolean;
  };
  readonly rightPanelTabs: ReadonlyArray<WorkspacePanelTab>;
  /** What a new agent made in the workspace starts able to do. */
  readonly agentAbilities: AgentAbilities;
  /** Connector catalog ids. */
  readonly suggestedConnectors: ReadonlyArray<string>;
  /** Skill library names. */
  readonly suggestedSkills: ReadonlyArray<string>;
}

const WITHOUT_GIT = {
  composerControls: { checkout: false, gitActions: false },
  rightPanelTabs: ["terminal", "files", "side-chat", "task", "workflow"],
} as const satisfies Partial<WorkspacePreset>;

export const WORKSPACE_PRESETS: Readonly<Record<WorkspaceKind, WorkspacePreset>> = {
  code: {
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
  },
  work: {
    startScreen: {
      headline: "What do you need done?",
      teamHeadline: "What should the team get done?",
      subline: "Describe the task, and add any files it needs.",
      examples: [
        {
          prompt: "Prepare me for tomorrow's meetings: who I am meeting and what to read first",
          team: false,
        },
        { prompt: "Summarise this week's emails from my team into a table", team: false },
        {
          prompt: "Every morning, send me a digest of new messages and calendar changes",
          team: false,
        },
      ],
    },
    composerControls: WITHOUT_GIT.composerControls,
    // Listed first where tabs are offered: what the chat read, and what changed in the folder.
    rightPanelTabs: ["sources", "activity", ...WITHOUT_GIT.rightPanelTabs],
    // Editing is how an agent fills in a spreadsheet, a form or a deck when asked.
    agentAbilities: { readFiles: true, editFiles: true, runCommands: false, searchWeb: true },
    suggestedConnectors: ["gmail", "google-calendar", "google-drive", "slack", "notion"],
    suggestedSkills: [
      "work-with-documents",
      "write-clear-emails",
      "triage-an-inbox",
      "summarise-a-meeting",
      "research-with-sources",
      "plan-a-project",
    ],
  },
  create: {
    startScreen: {
      headline: "What do you want to make?",
      teamHeadline: "What should the team make?",
      subline: "Describe what you want to make, and add any references.",
      examples: [
        { prompt: "Design a poster for a summer music festival", team: false },
        { prompt: "Write a storyboard for a 30 second product video", team: false },
        { prompt: "Make three logo ideas for a small bakery", team: false },
      ],
    },
    ...WITHOUT_GIT,
    agentAbilities: {
      readFiles: true,
      editFiles: true,
      runCommands: false,
      searchWeb: false,
      makeImages: true,
    },
    suggestedConnectors: ["fal", "youtube", "postiz", "wordpress-com"],
    suggestedSkills: ["research-with-sources", "plan-a-project"],
  },
};

const inWorktree = (preset: WorkspacePreset): WorkspacePreset => ({
  ...preset,
  composerControls: WORKSPACE_PRESETS.code.composerControls,
  rightPanelTabs: [
    ...preset.rightPanelTabs.filter((tab) => !WORKSPACE_PRESETS.code.rightPanelTabs.includes(tab)),
    ...WORKSPACE_PRESETS.code.rightPanelTabs,
  ],
});

const WORKTREE_PRESETS: Readonly<Record<WorkspaceKind, WorkspacePreset>> = {
  code: WORKSPACE_PRESETS.code,
  work: inWorktree(WORKSPACE_PRESETS.work),
  create: inWorktree(WORKSPACE_PRESETS.create),
};

/**
 * A project without a type, such as one from an older server, is a code workspace. A chat that
 * already runs in a worktree keeps Git and the Diff tab in every type: its work is on a branch
 * that nothing else would show or land.
 */
export function workspacePreset(
  kind: WorkspaceKind | null | undefined,
  worktreePath?: string | null,
): WorkspacePreset {
  return (worktreePath == null ? WORKSPACE_PRESETS : WORKTREE_PRESETS)[kind ?? "code"];
}
