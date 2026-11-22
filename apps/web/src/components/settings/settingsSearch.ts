import { HOSTED_APP_CHANNEL } from "~/branding";
import { isElectron } from "~/env";
import { isMacPlatform, isWindowsPlatform, normalizeSearchText } from "~/lib/utils";
import { STATIC_KEYBINDING_COMMANDS, type KeybindingCommand } from "@codenine/contracts";
import type { EnvironmentId } from "@codenine/contracts";
import type { EnvironmentConnectionPhase } from "@codenine/client-runtime/connection";
import {
  sourceControlClients,
  type SourceControlDefinition,
} from "@codenine/client-runtime/source-control-clients";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@codenine/shared/keybindings";
import {
  commandLabel,
  normalizeShortcutSearchText,
  shortcutSearchForms,
} from "./KeybindingsSettings.logic";
import type { ResolvedSettingsScope } from "./settingsScope";

export type SettingsPath =
  | "/settings/projects"
  | "/settings/general"
  | "/settings/diagnostics"
  | "/settings/appearance"
  | "/settings/chat"
  | "/settings/diffs"
  | "/settings/keybindings"
  | "/settings/providers"
  | "/settings/threads"
  | "/settings/source-control"
  | "/settings/worktrees"
  | "/settings/connections"
  | "/settings/access"
  | "/settings/backup"
  | "/settings/maintenance"
  | "/settings/labs"
  | "/settings/about";

export type SettingsSearchScope =
  | "environment"
  | "environment-defaults"
  | "project-defaults"
  | "project"
  | "checkout"
  | "connections";

export interface SettingsSearchItem {
  readonly id: string;
  readonly title: string;
  readonly to: SettingsPath;
  readonly targetId?: string;
  readonly searchTerms?: ReadonlyArray<string>;
  /** A keybinding's chords, spelled by normalizeShortcutSearchText. */
  readonly shortcuts?: ReadonlyArray<string>;
  readonly scope?: SettingsSearchScope;
  readonly desktopOnly?: boolean;
  readonly macOnly?: boolean;
  readonly windowsOnly?: boolean;
  readonly releaseChannelOnly?: boolean;
  readonly cloudOnly?: boolean;
  readonly environmentOnly?: boolean;
  readonly providerSettingsOnly?: boolean;
  readonly localBackendManagementOnly?: boolean;
  readonly localEnvironmentOnly?: boolean;
  readonly primaryEnvironmentOnly?: boolean;
  readonly wslAvailableOnly?: boolean;
  readonly managedTunnelOnly?: boolean;
  readonly fastWorktreeCheckoutOnly?: boolean;
  readonly textGeneratorsOnly?: boolean;
  /** Only builds with a stage of their own, such as Dev or Nightly, can mark it. */
  readonly appStageOnly?: boolean;
  readonly secondary?: boolean;
  readonly requiresThreadAutoSettlement?: boolean;
}

export interface SettingsSearchAvailability {
  readonly localEnvironmentDisabled?: boolean;
  readonly hasCloudPublicConfig: boolean;
  readonly hasEnvironment: boolean;
  readonly hasProviderSettingsEnvironment: boolean;
  readonly canManageLocalBackend: boolean;
  readonly isWslSettingsRowVisible: boolean;
  readonly hasThreadAutoSettlement: boolean;
  readonly managedTunnelActive?: boolean;
  readonly hasFastWorktreeCheckoutEnvironment?: boolean;
  /** An environment without a provider allow-list, which hides text generators. */
  readonly hasTextGeneratorsEnvironment?: boolean;
  readonly hasPrimaryEnvironment?: boolean;
  readonly hasAppStage?: boolean;
}

export const SETTINGS_SECTION_LABELS: Readonly<Record<SettingsPath, string>> = {
  "/settings/diagnostics": "Diagnostics",
  "/settings/projects": "Workspaces",
  "/settings/general": "General",
  "/settings/appearance": "Appearance",
  "/settings/chat": "Chat",
  "/settings/diffs": "Diffs",
  "/settings/keybindings": "Keybindings",
  "/settings/providers": "Accounts",
  "/settings/threads": "Chats",
  "/settings/source-control": "Source control",
  "/settings/worktrees": "Worktrees",
  "/settings/connections": "Environments",
  "/settings/access": "Sharing & access",
  "/settings/backup": "Backup",
  "/settings/maintenance": "Maintenance",
  "/settings/labs": "Labs",
  "/settings/about": "About",
};

/** Sidebar order. A group without a heading is set apart by space alone. */
export const SETTINGS_NAV_GROUPS: ReadonlyArray<{
  readonly heading: string | null;
  readonly paths: ReadonlyArray<SettingsPath>;
}> = [
  {
    heading: null,
    paths: [
      "/settings/general",
      "/settings/appearance",
      "/settings/chat",
      "/settings/diffs",
      "/settings/keybindings",
    ],
  },
  {
    heading: null,
    paths: ["/settings/providers", "/settings/threads"],
  },
  {
    heading: "Code",
    paths: ["/settings/projects", "/settings/source-control", "/settings/worktrees"],
  },
  {
    heading: "Connections",
    paths: ["/settings/connections", "/settings/access"],
  },
  {
    heading: null,
    paths: ["/settings/backup", "/settings/maintenance", "/settings/labs", "/settings/about"],
  },
];

export function keybindingSearchAnchorId<Command extends KeybindingCommand>(command: Command) {
  return `keybinding-${command}` as const;
}

const KEYBINDING_SEARCH_ITEMS = STATIC_KEYBINDING_COMMANDS.toSorted((left, right) =>
  commandLabel(left).localeCompare(commandLabel(right)),
).map((command) => ({
  id: keybindingSearchAnchorId(command),
  title: commandLabel(command),
  to: "/settings/keybindings" as const,
  searchTerms: [command],
  shortcuts: DEFAULT_RESOLVED_KEYBINDINGS.filter((binding) => binding.command === command).flatMap(
    (binding) => shortcutSearchForms(binding.shortcut),
  ),
  secondary: true,
}));

export function sourceControlHostSettingsSearchId(kind: string) {
  return `source-control-host-${kind}` as const;
}

/** Each host's own settings: its accounts and token, or the fields of its settings form. */
export function sourceControlHostSearchItems(
  definitions: ReadonlyArray<SourceControlDefinition>,
): ReadonlyArray<
  SettingsSearchItem & { readonly id: ReturnType<typeof sourceControlHostSettingsSearchId> }
> {
  return definitions.flatMap((definition) => {
    if (!definition.settings) return [];
    const names = [definition.label, ...(definition.searchKeywords ?? [])].join(" ");
    const { credentials } = definition;
    return [
      {
        id: sourceControlHostSettingsSearchId(definition.kind),
        title: credentials
          ? `${definition.label} accounts and token`
          : `${definition.label} credentials`,
        to: "/settings/source-control" as const,
        searchTerms: [
          credentials
            ? `${names} ${credentials.cliName} account login user host switch multiple accounts disable sign in token personal access token pat api key credential`
            : `${names} ${Object.keys(definition.settings.fields).join(" ")} token credentials sign in`,
        ],
        environmentOnly: true,
        scope: "environment-defaults" as const,
      },
    ];
  });
}

/** For settings that apply to every host. */
const SOURCE_CONTROL_HOST_LABELS = sourceControlClients.definitions
  .map((definition) => definition.label)
  .join(" ");
const SOURCE_CONTROL_HOST_TERMS = sourceControlClients.definitions
  .flatMap((definition) => [definition.label, ...(definition.searchKeywords ?? [])])
  .join(" ");

export const SETTINGS_SEARCH_ITEMS = [
  {
    id: "storage-worktree-keep-when",
    targetId: "storage-worktrees",
    title: "Keep worktrees with local changes",
    to: "/settings/worktrees",
    scope: "project-defaults",
    searchTerms: [
      "any local files uncommitted changes edited tracked files ignored env build output cleanup",
    ],
  },
  {
    id: "storage-delete-now",
    title: "Run cleanup now",
    to: "/settings/worktrees",
    scope: "environment-defaults",
    searchTerms: [
      "storage cleanup delete now run now last run results report removed kept failed rotated logs",
    ],
  },
  {
    id: "storage-worktrees",
    title: "Worktree cleanup",
    to: "/settings/worktrees",
    scope: "project-defaults",
    searchTerms: [
      "disk storage automatic delete deleted archived chats threads old inactive merged done settled unchanged worktrees retention days workspace inherit off custom",
    ],
  },
  {
    id: "storage-worktrees-location",
    title: "Worktree location",
    to: "/settings/worktrees",
    scope: "environment-defaults",
    searchTerms: ["worktree location folder directory path drive external disk"],
  },
  {
    id: "storage-artifacts",
    title: "Logs",
    to: "/settings/maintenance",
    scope: "environment-defaults",
    searchTerms: ["disk storage delete old rotated logs cleanup retention"],
  },
  {
    id: "project-defaults",
    title: "Workspace defaults and overrides",
    to: "/settings/threads",
    scope: "project-defaults",
    searchTerms: ["model workspace environments projects inheritance checkout"],
  },
  {
    id: "project-overview",
    title: "Workspace overview",
    to: "/settings/projects",
    searchTerms: ["name icon emoji image checkout remove delete"],
  },
  {
    id: "default-model",
    title: "Default account and model",
    to: "/settings/threads",
    scope: "project-defaults",
    searchTerms: ["new chat thread project workspace provider account reasoning effort"],
  },
  {
    id: "fallback-model",
    title: "Fallback model",
    to: "/settings/threads",
    scope: "environment-defaults",
    searchTerms: ["fallback agent account provider out of usage new chats threads"],
    environmentOnly: true,
  },
  {
    id: "default-permissions",
    title: "Permissions",
    to: "/settings/threads",
    scope: "project-defaults",
    searchTerms: [
      "new chat thread default runtime mode supervised approvals auto accept edits full access",
    ],
  },
  {
    id: "color-scheme",
    title: "Color scheme",
    to: "/settings/appearance",
    searchTerms: ["appearance light dark system mode"],
    targetId: "appearance",
  },
  {
    id: "theme",
    title: "Themes",
    to: "/settings/appearance",
    searchTerms: ["appearance colors palette custom import"],
    targetId: "appearance",
  },
  {
    // Prefixed because the slider control already owns the `appearance-contrast` id.
    id: "setting-appearance-contrast",
    title: "Contrast",
    to: "/settings/appearance",
    searchTerms: ["colors borders interface"],
  },
  {
    // Prefixed because the slider control already owns the `glass-opacity` id.
    id: "setting-glass-opacity",
    title: "Glass opacity",
    to: "/settings/appearance",
    searchTerms: ["transparent transparency solid menus dialogs composer"],
  },
  {
    id: "diff-color-scheme",
    title: "Diff colors",
    to: "/settings/diffs",
    searchTerms: ["red green blue orange additions deletions changes counts palette colorblind"],
  },
  {
    id: "chat-width",
    title: "Chat width",
    to: "/settings/appearance",
    searchTerms: ["wide full width column layout messages composer monitor"],
  },
  {
    id: "thread-details-items",
    title: "Chat details",
    to: "/settings/appearance",
    searchTerms: [
      "thread customize show hide panel card environment editor scripts branch pull request git changes servers lineage usage limits 5 hour weekly quota tokens context window",
    ],
  },
  {
    id: "effort-display",
    title: "Effort display",
    to: "/settings/appearance",
    searchTerms: ["reasoning effort thinking bars graph word label level composer"],
  },
  {
    id: "math-rendering",
    title: "Render math",
    to: "/settings/appearance",
    searchTerms: ["latex tex katex equations formulas markdown"],
  },
  {
    id: "panel-animations",
    title: "Panel animations",
    to: "/settings/appearance",
  },
  {
    id: "environment-identification",
    title: "Environment identification",
    to: "/settings/appearance",
    searchTerms: ["dev nightly channel artwork badge pill label hide none"],
    targetId: "appearance-interface",
    appStageOnly: true,
  },
  {
    id: "interface-font",
    title: "Interface font",
    to: "/settings/appearance",
    searchTerms: ["typography family size system sans"],
  },
  {
    id: "prompt-font",
    title: "Prompt font",
    to: "/settings/appearance",
    searchTerms: ["typography family size composer input"],
  },
  {
    id: "code-font",
    title: "Code font",
    to: "/settings/appearance",
    searchTerms: ["typography family size monospace code blocks diffs file previews"],
  },
  {
    id: "terminal-font",
    title: "Terminal font",
    to: "/settings/appearance",
    searchTerms: ["typography family size monospace output"],
  },
  {
    id: "separate-fonts",
    title: "Separate fonts",
    to: "/settings/appearance",
    searchTerms: ["typography advanced prompt code terminal font family size individually"],
  },
  {
    id: "font-smoothing",
    title: "Font smoothing",
    to: "/settings/appearance",
    searchTerms: ["typography text grayscale anti aliasing macos thin"],
    macOnly: true,
  },
  {
    id: "word-wrap",
    title: "Word wrap",
    to: "/settings/appearance",
    searchTerms: ["long lines code blocks diffs file previews"],
  },
  {
    id: "composer-context",
    title: "Composer context",
    to: "/settings/appearance",
  },
  {
    id: "project-grouping",
    title: "Workspace grouping",
    to: "/settings/general",
    searchTerms: ["combine matching repositories environments sidebar"],
  },
  {
    id: "project-order",
    title: "Workspace order",
    to: "/settings/general",
    searchTerms: ["sort projects sidebar folders newest chat created recent message"],
  },
  {
    id: "snooze-options",
    title: "Snooze options",
    to: "/settings/threads",
    searchTerms: ["snooze presets times later tonight tomorrow next week remind"],
    environmentOnly: true,
    scope: "environment-defaults",
  },
  {
    id: "snooze-limited-threads",
    title: "Snooze until limits reset",
    to: "/settings/threads",
    searchTerms: ["usage quota rate limit reset wake recover continue"],
  },
  {
    id: "auto-resume-limited-threads",
    title: "Resume after usage limits",
    to: "/settings/threads",
    searchTerms: ["usage quota rate limit reset recover continue"],
  },
  {
    id: "sidebar-group-by-project",
    title: "Group chats by workspace",
    to: "/settings/general",
    searchTerms: ["sidebar folders project tree flat list needs you tasks boring"],
  },
  {
    id: "working-shelf",
    title: "Working section",
    to: "/settings/general",
    searchTerms: ["hide fold running monitoring chats threads inbox sidebar shelf"],
  },
  {
    id: "sidebar-two-line-rows",
    title: "Two-line chat rows",
    to: "/settings/general",
    searchTerms: ["sidebar project folder rows multiline branch pull request details"],
  },
  {
    id: "tool-call-visibility",
    title: "Tool calls in chat",
    to: "/settings/chat",
    searchTerms: [
      "hide tool calls commands edits searches work log activity quiet chat zen final answers only",
    ],
  },
  {
    id: "prompt-suggestions-beta",
    title: "Suggest next prompt",
    to: "/settings/labs",
    scope: "environment-defaults",
    searchTerms: ["beta tab autocomplete predict next message claude codex ghost text"],
  },
  {
    id: "worktree-fast-checkout",
    title: "Fast worktree checkout",
    to: "/settings/labs",
    scope: "environment-defaults",
    fastWorktreeCheckoutOnly: true,
    searchTerms: ["beta fast worktree checkout clone apfs copy-on-write cache macos speed"],
  },
  {
    id: "auto-settle-inactive-threads",
    title: "Mark inactive chats done",
    to: "/settings/threads",
    searchTerms: [
      "threads sidebar inactivity days no activity automatically auto-settle settle settled",
    ],
    requiresThreadAutoSettlement: true,
    scope: "project-defaults",
  },
  {
    id: "compact-idle-threads",
    title: "Compact idle chats",
    to: "/settings/providers",
    scope: "environment-defaults",
    searchTerms: ["threads claude context compaction idle cache tokens usage summary resume"],
  },
  {
    id: "auto-settle-merged-threads",
    title: "Mark merged chats done",
    to: "/settings/threads",
    searchTerms: [
      "threads pull request merge closed automatically sidebar auto-settle settle settled",
    ],
    requiresThreadAutoSettlement: true,
    scope: "project-defaults",
  },
  {
    id: "keep-threads-with-pull-requests",
    title: "Keep chats with a PR",
    to: "/settings/threads",
    targetId: "auto-settle-inactive-threads",
    searchTerms: ["threads pull request inactivity done auto-settle merge close sidebar"],
    requiresThreadAutoSettlement: true,
    scope: "project-defaults",
  },
  {
    id: "days-before-auto-settle",
    title: "Days of inactivity before marking done",
    to: "/settings/threads",
    targetId: "auto-settle-inactive-threads",
    searchTerms: ["chat thread timeout activity sidebar auto-settle settle settled"],
    requiresThreadAutoSettlement: true,
    scope: "project-defaults",
  },
  {
    id: "thread-notifications",
    title: "System notifications",
    to: "/settings/general",
    searchTerms: ["chat notification alert background completion input approval desktop"],
  },
  {
    id: "notification-sound",
    title: "Sound",
    to: "/settings/general",
    searchTerms: ["notification sound audio chime alert chat completion input approval"],
  },
  {
    id: "codenine-folder",
    title: "Codenine folder",
    to: "/settings/general",
    searchTerms: [
      "data folder files location open finder explorer .codenine home workspaces accounts skills logs backup",
    ],
  },
  {
    id: "in-app-notifications",
    title: "In-app toasts",
    to: "/settings/general",
    searchTerms: ["notification toast popup chat completion input approval failure"],
  },
  {
    id: "time-format",
    title: "Time format",
    to: "/settings/general",
    searchTerms: ["timestamp clock locale system browser os 12 hour 24 hour"],
  },
  {
    id: "response-streaming",
    title: "Response streaming",
    to: "/settings/chat",
    scope: "project-defaults",
    searchTerms: ["output token paragraph buffered wait turn legacy"],
  },
  {
    id: "hide-whitespace-changes",
    title: "Hide whitespace changes",
    to: "/settings/diffs",
    searchTerms: ["diff ignore spaces indentation edits default"],
  },
  {
    id: "default-diff-file-state",
    title: "Default diff file state",
    to: "/settings/diffs",
    searchTerms: ["collapsed expanded collapse expand files pull request pr code tab"],
  },
  {
    id: "diff-layout",
    title: "Diff layout",
    to: "/settings/diffs",
    searchTerms: ["stacked split side by side unified inline view"],
  },
  {
    id: "proactive-panels",
    title: "Open the changes panel proactively",
    to: "/settings/diffs",
    searchTerms: ["proactive automatically open diff right panel agent completion"],
  },
  {
    id: "composer-rich-text",
    title: "Rich text composer",
    to: "/settings/chat",
    searchTerms: ["composer rich text tiptap bold italic markdown styled wysiwyg"],
  },
  {
    id: "send-shortcut",
    title: "Send shortcut",
    to: "/settings/chat",
    searchTerms: ["enter return command ctrl multiline prompt new line composer"],
  },
  {
    id: "follow-up-behavior",
    title: "Follow-up behavior",
    to: "/settings/chat",
    searchTerms: ["queue steer running turn send default behavior composer"],
  },
  {
    id: "backup-status",
    title: "Back up now",
    to: "/settings/backup",
    searchTerms: ["backup copy save recover move new computer migrate export last backup"],
  },
  {
    id: "backup-restore",
    title: "Restore from a backup",
    to: "/settings/backup",
    targetId: "backup-status",
    searchTerms: ["restore recover import move new computer migrate backup file undo"],
  },
  {
    id: "backup-schedule",
    title: "Automatic backups",
    to: "/settings/backup",
    searchTerms: ["backup schedule how often daily weekly off time zone day keep last older"],
  },
  {
    id: "backup-folder",
    title: "Where to keep backups",
    to: "/settings/backup",
    searchTerms: [
      "backup folder location path icloud dropbox onedrive google drive external drive open",
    ],
  },
  {
    id: "backup-password",
    title: "Backup password",
    to: "/settings/backup",
    searchTerms: ["backup encryption encrypted protection change password"],
  },
  {
    id: "backup-worktrees",
    title: "Back up unfinished task copies",
    to: "/settings/backup",
    searchTerms: ["backup worktrees include what a backup holds contents size"],
  },
  {
    id: "backup-recent",
    title: "Recent backups",
    to: "/settings/backup",
    searchTerms: ["backup list history download delete restore show all"],
  },
  {
    id: "provider-update-checks",
    title: "Provider update checks",
    to: "/settings/maintenance",
    searchTerms: ["installed cli versions newer available codex claude"],
    scope: "environment-defaults",
  },
  {
    id: "continue-threads-after-server-update",
    title: "Continue chats after restarts",
    to: "/settings/threads",
    scope: "project-defaults",
    searchTerms: [
      "resume running active interrupted chats threads work restart reboot machine crash desktop update automatically",
    ],
  },
  {
    id: "background-activity",
    title: "Background activity",
    to: "/settings/maintenance",
    scope: "environment-defaults",
    searchTerms: [
      "balanced performance battery saver advanced git fetch provider health refresh host power monitor idle policy",
    ],
  },
  {
    id: "new-threads",
    title: "New chats",
    to: "/settings/threads",
    scope: "project-defaults",
    searchTerms: ["default workspace mode draft local worktree"],
  },
  {
    id: "worktree-submodules",
    title: "Submodules",
    to: "/settings/worktrees",
    scope: "project-defaults",
    searchTerms: ["git submodule init recursive top-level none worktree codenine.json"],
  },
  {
    id: "start-from-origin",
    title: "Start from remote",
    to: "/settings/worktrees",
    scope: "project-defaults",
    searchTerms: ["new worktrees start remote origin latest fetched branch local"],
  },
  {
    id: "add-project-starts-in",
    title: "Start folder",
    to: "/settings/projects",
    scope: "environment-defaults",
    searchTerms: ["add workspace starts in base directory folder browse path home clone"],
  },
  {
    id: "ghq-clone-layout",
    title: "Clone into host folders",
    to: "/settings/projects",
    scope: "environment-defaults",
    searchTerms: ["ghq clone destination host owner repository root layout"],
  },
  {
    id: "unpin-confirmation",
    title: "Unpin confirmation",
    to: "/settings/general",
    searchTerms: ["ask before chat thread pinned section"],
  },
  {
    id: "archive-confirmation",
    title: "Archive confirmation",
    to: "/settings/general",
    searchTerms: ["ask before chat thread"],
  },
  {
    id: "delete-confirmation",
    title: "Delete confirmation",
    to: "/settings/general",
    searchTerms: ["ask before chat thread conversation history"],
  },
  {
    id: "quit-confirmation",
    title: "Quit shortcut",
    to: "/settings/general",
    searchTerms: ["confirmation desktop app exit direct hold double click press twice"],
    desktopOnly: true,
  },
  {
    id: "text-generation-model",
    title: "Text generation model",
    to: "/settings/threads",
    scope: "project-defaults",
    searchTerms: ["generated chat thread titles source control content default provider"],
  },
  {
    id: "thread-title-instructions",
    title: "Chat title instructions",
    to: "/settings/threads",
    scope: "project-defaults",
    searchTerms: ["generated chat thread titles prompt custom style naming rename regenerate"],
  },
  {
    id: "app-version",
    title: "Version",
    to: "/settings/about",
    searchTerms: ["about check for updates download install upgrade release"],
  },
  {
    id: "update-track",
    title: "Update track",
    to: "/settings/about",
    searchTerms: ["release channel stable latest nightly prerelease"],
    releaseChannelOnly: true,
  },
  {
    id: "cli-command",
    title: "codenine command",
    to: "/settings/about",
    searchTerms: ["cli terminal shell path install command line"],
    desktopOnly: true,
  },
  {
    id: "welcome-page",
    title: "Welcome page",
    to: "/settings/about",
    primaryEnvironmentOnly: true,
    searchTerms: ["onboarding setup first run getting started agents"],
  },
  {
    id: "telemetry-export",
    title: "OpenTelemetry export",
    to: "/settings/diagnostics",
    targetId: "telemetry-export",
    scope: "environment",
    searchTerms: ["OTel OTLP telemetry export endpoints logs traces metrics Grafana"],
  },
  {
    id: "diagnostics",
    title: "Diagnostics",
    to: "/settings/maintenance",
    searchTerms: ["logs traces failures spans"],
  },
  {
    id: "open-source-licenses",
    title: "Open source licenses",
    to: "/settings/about",
  },
  {
    id: "keybindings",
    title: "Keybindings",
    to: "/settings/keybindings",
    searchTerms: ["keyboard shortcuts hotkeys commands bindings json"],
  },
  ...KEYBINDING_SEARCH_ITEMS,
  {
    id: "providers",
    title: "Accounts",
    to: "/settings/providers",
    searchTerms: [
      "accounts providers add account sign in with claude chatgpt codex cli login command line fast agents codex claude sign in sign out install subscription instances authentication api key models configuration binary path config directory codex_home shadow home endpoint arguments environment variables display name accent color custom favorite hidden auto compact native sessions import resume",
    ],
  },
  {
    id: "usage-providers",
    title: "Usage sources",
    to: "/settings/providers",
    searchTerms: [
      "usage providers sources CLIProxyAPI CLI proxy hub quota subscription limits management key add remove",
    ],
    providerSettingsOnly: true,
  },
  {
    id: "text-generators",
    title: "Text generators",
    to: "/settings/providers",
    searchTerms: [
      "model api api key openai openrouter anthropic ollama lm studio custom endpoint base url chat thread titles commit messages",
    ],
    providerSettingsOnly: true,
    textGeneratorsOnly: true,
  },
  {
    id: "provider-health-check-interval",
    title: "Health check interval",
    to: "/settings/providers",
    searchTerms: ["refresh availability versions auth state models background probes seconds off"],
    providerSettingsOnly: true,
  },
  {
    id: "automatic-pull",
    title: "Automatically pull",
    to: "/settings/source-control",
    scope: "project-defaults",
    searchTerms: ["auto pull default branch current checkout fast forward upstream"],
  },
  {
    id: "source-control",
    title: "Source control",
    to: "/settings/source-control",
    scope: "environment-defaults",
    searchTerms: [
      `version control git ${SOURCE_CONTROL_HOST_TERMS} hosting integrations credentials scan server environment`,
    ],
  },
  {
    id: "git-fetch-interval",
    title: "Git fetch interval",
    to: "/settings/maintenance",
    targetId: "background-activity",
    searchTerms: [
      "automatic remote branch refresh background credentials security keys seconds off",
    ],
    environmentOnly: true,
    scope: "environment-defaults",
  },
  {
    id: "worktree-branch-naming",
    title: "Worktree branch naming",
    to: "/settings/worktrees",
    searchTerms: ["static semantic prefix custom prompt instructions feat fix refactor chore"],
    environmentOnly: true,
    scope: "project-defaults",
  },
  ...sourceControlHostSearchItems(sourceControlClients.definitions),
  {
    id: "source-control-writing-style",
    title: "Source control writing style",
    to: "/settings/source-control",
    searchTerms: [
      "repository conventions conventional commits custom instructions commit messages change descriptions pull request titles",
    ],
    environmentOnly: true,
    scope: "project-defaults",
  },
  {
    id: "follow-change-request-templates",
    title: "Follow pull request templates",
    to: "/settings/source-control",
    searchTerms: ["repository pr pull request change request description structure"],
    environmentOnly: true,
    scope: "project-defaults",
  },
  {
    id: "source-control-writer-model",
    title: "Source control writer model",
    to: "/settings/source-control",
    searchTerms: [
      "override generated commit change request pr titles descriptions branch bookmark",
    ],
    environmentOnly: true,
    scope: "project-defaults",
  },
  {
    id: "project-actions",
    title: "Actions",
    to: "/settings/projects",
    searchTerms: ["commands scripts setup run dev server checkout worktree codenine.json import"],
  },
  {
    id: "environment-icon",
    title: "Environment icon",
    to: "/settings/access",
    targetId: "connections-environment",
    searchTerms: ["machine glyph sidebar mac mini studio laptop desktop server cloud vm"],
  },
  {
    id: "local-environment",
    title: "Local environment",
    to: "/settings/connections",
    searchTerms: ["turn off on disable enable local server agents remote only restart"],
    desktopOnly: true,
  },
  {
    id: "network-access",
    title: "Network access",
    to: "/settings/access",
    targetId: "connections-environment",
    searchTerms: ["expose backend remote pairing local machine interfaces host restart"],
    localBackendManagementOnly: true,
  },
  {
    id: "tailscale-https",
    title: "Tailscale HTTPS",
    to: "/settings/access",
    targetId: "connections-environment",
    searchTerms: ["serve magicdns endpoint remote secure network"],
    desktopOnly: true,
    localBackendManagementOnly: true,
  },
  {
    id: "wsl-backend",
    title: "WSL backend",
    to: "/settings/access",
    searchTerms: [
      "windows subsystem linux distro second server workspaces stop windows backend restart wsl only",
    ],
    desktopOnly: true,
    windowsOnly: true,
    localBackendManagementOnly: true,
    wslAvailableOnly: true,
  },
  {
    id: "codenine-connect",
    localEnvironmentOnly: true,
    title: "Codenine Connect",
    to: "/settings/access",
    targetId: "connections-environment",
    searchTerms: ["managed tunnel cloud other devices remote tunnels limit codenine chat"],
    desktopOnly: true,
    cloudOnly: true,
  },
  {
    id: "hold-webhooks-while-offline",
    localEnvironmentOnly: true,
    title: "Hold webhooks while offline",
    to: "/settings/access",
    targetId: "connections-environment",
    searchTerms: ["webhook automations offline queue mailbox codenine connect"],
    cloudOnly: true,
    managedTunnelOnly: true,
  },
  {
    id: "publish-agent-activity",
    localEnvironmentOnly: true,
    title: "Publish agent activity",
    to: "/settings/access",
    targetId: "connections-environment",
    searchTerms: ["mobile push notifications live activities cloud tunnel"],
    cloudOnly: true,
  },
  {
    id: "connections-environment",
    title: "Environment access",
    to: "/settings/access",
    searchTerms: [
      "this machine connections server backend local remote access administrative permissions scope pairing links qr code authorized clients sessions revoke endpoint mcp another app",
    ],
  },
  {
    id: "remote-environments",
    title: "Environments",
    to: "/settings/connections",
    searchTerms: [
      "add pair backend host code ssh config agent tunnel saved codenine connect tailscale magicdns",
    ],
  },
  {
    id: "load-balancing",
    title: "Load balancing",
    to: "/settings/connections",
    searchTerms: [
      "automatic machine environment resources cpu memory capacity preference weight shared workspaces",
    ],
  },
  {
    id: "pull-request-routing",
    title: "Pull request sharing",
    to: "/settings/connections",
    searchTerms: [
      `pull request routing trusted environments shared credentials permissions read actions source control ${SOURCE_CONTROL_HOST_LABELS}`,
    ],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export type SettingsSearchItemId = (typeof SETTINGS_SEARCH_ITEMS)[number]["id"];

const SEARCH_ITEMS_BY_ID = new Map(SETTINGS_SEARCH_ITEMS.map((item) => [item.id, item] as const));

const SETTINGS_CATEGORY_SCOPES: Readonly<Record<SettingsPath, SettingsSearchScope | null>> = {
  "/settings/diagnostics": "environment",
  "/settings/projects": "project",
  "/settings/general": null,
  "/settings/appearance": null,
  "/settings/chat": null,
  "/settings/diffs": null,
  "/settings/keybindings": null,
  "/settings/providers": null,
  "/settings/threads": null,
  "/settings/source-control": "environment-defaults",
  "/settings/worktrees": "project-defaults",
  "/settings/connections": "connections",
  "/settings/access": "connections",
  // The page picks its machine itself.
  "/settings/backup": null,
  "/settings/maintenance": null,
  "/settings/labs": null,
  "/settings/about": null,
};

const WORKSPACE_OVERRIDE_SCOPES: ReadonlySet<SettingsSearchScope> = new Set([
  "project",
  "project-defaults",
  "checkout",
]);

/** Pages with rows a workspace can override; Accounts' switches are per workspace too. */
export const SETTINGS_WORKSPACE_SCOPE_PATHS: ReadonlySet<string> = new Set([
  "/settings/providers",
  ...(SETTINGS_SEARCH_ITEMS as readonly SettingsSearchItem[]).flatMap((item) => {
    const scope = item.scope ?? SETTINGS_CATEGORY_SCOPES[item.to];
    return scope !== null && WORKSPACE_OVERRIDE_SCOPES.has(scope) ? [item.to] : [];
  }),
]);

const RENAMED_SETTINGS_PATHS: Readonly<Record<string, SettingsPath>> = {
  "/settings/storage": "/settings/maintenance",
  "/settings/beta": "/settings/labs",
  "/settings/integrations": "/settings/general",
};
const SPLIT_SETTINGS_PATHS: ReadonlySet<string> = new Set([
  "/settings/general",
  "/settings/appearance",
  "/settings/source-control",
  "/settings/connections",
  "/settings/threads",
  "/settings/maintenance",
  "/settings/labs",
  ...Object.keys(RENAMED_SETTINGS_PATHS),
]);
// Section anchors that moved but are not search results themselves.
const MOVED_SECTION_ANCHORS: Readonly<Record<string, SettingsPath>> = {
  "authorized-clients": "/settings/access",
  "text-generation": "/settings/threads",
  "new-projects": "/settings/projects",
  about: "/settings/about",
};

/** Where an old settings link now lives. Its anchor finds the page its row moved to. */
export function movedSettingsPath(pathname: string, hash: string): SettingsPath | null {
  if (!SPLIT_SETTINGS_PATHS.has(pathname)) return null;
  const items: readonly SettingsSearchItem[] = SETTINGS_SEARCH_ITEMS;
  const anchored = hash
    ? (items.find((item) => item.id === hash) ?? items.find((item) => item.targetId === hash))
    : undefined;
  const to =
    anchored?.to ?? MOVED_SECTION_ANCHORS[hash] ?? RENAMED_SETTINGS_PATHS[pathname] ?? null;
  return to === pathname ? null : to;
}

export function getSettingsSearchTargetScope(targetId: string) {
  const items: readonly SettingsSearchItem[] = SETTINGS_SEARCH_ITEMS;
  const item =
    items.find((candidate) => candidate.id === targetId) ??
    items.find((candidate) => candidate.targetId === targetId);
  return item
    ? {
        title: item.title,
        scope: item.scope ?? SETTINGS_CATEGORY_SCOPES[item.to],
        ...(item.requiresThreadAutoSettlement ? { requiresThreadAutoSettlement: true } : {}),
      }
    : null;
}

interface AutoSettlementSearchEnvironment {
  readonly environmentId: EnvironmentId;
  readonly connection: { readonly phase: EnvironmentConnectionPhase };
  readonly serverConfig: object | null;
}

export function getThreadAutoSettlementSearchAvailability(
  environments: readonly AutoSettlementSearchEnvironment[],
  scope?: Pick<ResolvedSettingsScope, "kind" | "environmentIds">,
) {
  const connected = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" && environment.serverConfig !== null,
  );
  const eligibleEnvironmentIds = connected.map((environment) => environment.environmentId);
  const selected = connected.filter((environment) =>
    scope?.environmentIds.includes(environment.environmentId),
  );
  return {
    eligibleEnvironmentIds,
    isTargetAvailable:
      scope !== undefined &&
      scope.kind !== "unavailable" &&
      selected.length > 0 &&
      selected.every((environment) => eligibleEnvironmentIds.includes(environment.environmentId)),
  };
}

export function isSettingsSearchScopeAvailable(
  requiredScope: SettingsSearchScope | null,
  scopeKind: ResolvedSettingsScope["kind"],
): boolean {
  switch (requiredScope) {
    case null:
    case "connections":
      return true;
    case "environment":
    case "checkout":
      return requiredScope === scopeKind;
    case "project":
      return scopeKind === "project" || scopeKind === "checkout";
    case "environment-defaults":
      return scopeKind === "environment" || scopeKind === "all";
    case "project-defaults":
      return (
        scopeKind === "environment" ||
        scopeKind === "all" ||
        scopeKind === "project" ||
        scopeKind === "checkout"
      );
  }
}

export function searchableSetting(id: SettingsSearchItemId): {
  readonly id: string;
  readonly title: string;
} {
  const { id: anchorId, title } = SEARCH_ITEMS_BY_ID.get(id)!;
  return { id: anchorId, title };
}

export function filterAvailableSettingsSearchItems(
  availability: SettingsSearchAvailability,
): ReadonlyArray<SettingsSearchItem> {
  const items: ReadonlyArray<SettingsSearchItem> = SETTINGS_SEARCH_ITEMS;
  return items.filter(
    (item) =>
      (!item.cloudOnly || availability.hasCloudPublicConfig) &&
      (!item.environmentOnly || availability.hasEnvironment) &&
      (!item.providerSettingsOnly || availability.hasProviderSettingsEnvironment) &&
      (!item.localBackendManagementOnly || availability.canManageLocalBackend) &&
      (!item.localEnvironmentOnly || !availability.localEnvironmentDisabled) &&
      (!item.primaryEnvironmentOnly || availability.hasPrimaryEnvironment === true) &&
      (!item.wslAvailableOnly || availability.isWslSettingsRowVisible) &&
      (!item.requiresThreadAutoSettlement || availability.hasThreadAutoSettlement) &&
      (!item.managedTunnelOnly || availability.managedTunnelActive === true) &&
      (!item.fastWorktreeCheckoutOnly ||
        availability.hasFastWorktreeCheckoutEnvironment === true) &&
      (!item.textGeneratorsOnly || availability.hasTextGeneratorsEnvironment === true) &&
      (!item.appStageOnly || availability.hasAppStage === true),
  );
}

/** The settings that exist on this platform and app channel. */
export function settingsForThisPlatform(
  items: ReadonlyArray<SettingsSearchItem>,
): ReadonlyArray<SettingsSearchItem> {
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  return items.filter(
    (item) =>
      (isElectron || item.desktopOnly !== true) &&
      (!item.releaseChannelOnly || isElectron || HOSTED_APP_CHANNEL !== null) &&
      (!item.macOnly || isMacPlatform(platform)) &&
      (!item.windowsOnly || isWindowsPlatform(platform)),
  );
}

export function searchSettings(
  query: string,
  items: ReadonlyArray<SettingsSearchItem> = SETTINGS_SEARCH_ITEMS,
): ReadonlyArray<SettingsSearchItem> {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) return [];
  const queryTokens = normalizedQuery.split(" ");
  const shortcutQuery = normalizeShortcutSearchText(query);

  return settingsForThisPlatform(items)
    .flatMap((item, index) => {
      const title = normalizeSearchText(item.title);
      const pageLabel = normalizeSearchText(SETTINGS_SECTION_LABELS[item.to]);
      const fields = [title, pageLabel, ...(item.searchTerms ?? []).map(normalizeSearchText)];
      const matchesShortcut =
        item.shortcuts?.some((shortcut) => shortcut.includes(shortcutQuery)) === true;
      if (
        !matchesShortcut &&
        !queryTokens.every((token) => fields.some((field) => field.includes(token)))
      ) {
        return [];
      }

      const exactPhraseField = fields.findIndex((field) => field.includes(normalizedQuery));
      const rank =
        pageLabel === normalizedQuery || pageLabel === `${normalizedQuery}s`
          ? 6
          : title === normalizedQuery
            ? 5
            : title.startsWith(normalizedQuery)
              ? 4
              : title.includes(normalizedQuery)
                ? 3
                : queryTokens.every((token) => title.includes(token))
                  ? 2
                  : matchesShortcut || exactPhraseField >= 0
                    ? 1
                    : 0;
      return [{ item, index, rank }];
    })
    .toSorted(
      (left, right) =>
        Number(left.item.secondary ?? false) - Number(right.item.secondary ?? false) ||
        right.rank - left.rank ||
        left.index - right.index,
    )
    .map(({ item }) => item);
}
