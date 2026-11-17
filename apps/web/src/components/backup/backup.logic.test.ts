import type {
  BackupFileInfo,
  BackupFolderSuggestion,
  BackupRestoreSummary,
  BackupSettings,
  BackupStatus,
} from "@codenine/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatBytes } from "../../lib/formatBytes";
import {
  backupAttentionMessage,
  cloudFoldersLine,
  dayAndTime,
  folderLabel,
  initialFolderChoice,
  keepOptions,
  nextRestoreFlow,
  OTHER_CHOICE,
  restoreContentLines,
  restoreStepIndex,
  scheduleTimeOptions,
  settingsForSetup,
  setupErrors,
  startRestoreFlow,
  summarizeBackupStatus,
  timeAgo,
  undoAvailability,
  type BackupDateFormat,
} from "./backup.logic";

// Local times, so the labels hold in any time zone the tests run in.
const at = (month: number, day: number, hour: number, minute = 0, year = 2026) =>
  new Date(year, month - 1, day, hour, minute).toISOString();
const NOW = Date.parse(at(11, 17, 15));

const format: BackupDateFormat = {
  time: (date) => {
    const hour = date.getHours() % 12 || 12;
    const suffix = date.getHours() < 12 ? "AM" : "PM";
    return `${hour}:${String(date.getMinutes()).padStart(2, "0")} ${suffix}`;
  },
  date: (date, withYear) =>
    `${date.getMonth() + 1}/${date.getDate()}${withYear ? `/${date.getFullYear()}` : ""}`,
};

const settings: BackupSettings = {
  folder: "~/Library/Mobile Documents/com~apple~CloudDocs/Codenine Backups",
  schedule: { frequency: "daily", time: "03:00", weekday: 0 },
  keep: 7,
  includeWorktrees: false,
};

const file = (createdAt: string): BackupFileInfo => ({
  path: "/backups/codenine.c9backup",
  fileName: "codenine.c9backup",
  createdAt,
  computerName: "Studio",
  codenineVersion: "0.1.7",
  kind: "automatic",
  sizeBytes: 214 * 1024 * 1024,
});

const status = (overrides: Partial<BackupStatus> = {}): BackupStatus => ({
  configured: true,
  passwordSet: true,
  settings,
  folderPath: "/Users/me/Library/Mobile Documents/com~apple~CloudDocs/Codenine Backups",
  lastSuccessAt: null,
  lastAttemptAt: null,
  lastError: null,
  lastFile: null,
  nextRunAt: null,
  running: null,
  needsAttention: false,
  ...overrides,
});

const summarize = (value: BackupStatus) => summarizeBackupStatus(value, NOW, format, formatBytes);

describe("timeAgo", () => {
  const minutes = 60_000;
  it.each([
    [0.5 * minutes, "just now"],
    [2 * minutes, "2 minutes ago"],
    [61 * minutes, "1 hour ago"],
    [125 * minutes, "2 hours ago"],
    [25 * 60 * minutes, "1 day ago"],
    [7 * 24 * 60 * minutes, "7 days ago"],
  ])("reads %d ms ago as %s", (elapsed, label) => {
    expect(timeAgo(new Date(NOW - elapsed).toISOString(), NOW)).toBe(label);
  });
});

describe("dayAndTime", () => {
  it.each([
    [at(11, 17, 3), "today at 3:00 AM"],
    [at(11, 16, 3), "yesterday at 3:00 AM"],
    [at(11, 18, 3), "tomorrow at 3:00 AM"],
    [at(11, 22, 3), "Sunday at 3:00 AM"],
    [at(11, 24, 3), "11/24 at 3:00 AM"],
    [at(11, 10, 3), "11/10 at 3:00 AM"],
    [at(12, 30, 3, 0, 2025), "12/30/2025 at 3:00 AM"],
  ])("labels %s", (iso, label) => {
    expect(dayAndTime(iso, NOW, format)).toBe(label);
  });
});

describe("summarizeBackupStatus", () => {
  it("says when the last backup ran, its size, and when the next one runs", () => {
    expect(
      summarize(
        status({
          lastSuccessAt: at(11, 17, 13),
          lastAttemptAt: at(11, 17, 13),
          lastFile: file(at(11, 17, 13)),
          nextRunAt: at(11, 18, 3),
        }),
      ),
    ).toEqual({
      tone: "healthy",
      title: "Backed up 2 hours ago",
      detail: "Today at 1:00 PM · 214 MB · Next backup tomorrow at 3:00 AM",
      percent: null,
    });
  });

  it("shows progress while a backup runs, with or without a percentage", () => {
    const running = (percent: number | null) =>
      status({
        running: {
          phase: "running",
          kind: "manual",
          percent,
          detail: "Copying workspaces",
          error: null,
          startedAt: at(11, 17, 14),
          endedAt: null,
          file: null,
        },
      });
    expect(summarize(running(42))).toMatchObject({
      tone: "running",
      title: "Backing up… 42%",
      detail: "Copying workspaces",
      percent: 42,
    });
    expect(summarize(running(null)).title).toBe("Backing up…");
  });

  it("shows the error of a failed attempt, but not one an earlier success left behind", () => {
    const failed = status({
      lastSuccessAt: at(11, 16, 3),
      lastAttemptAt: at(11, 17, 3),
      lastError: "The backup folder is not available.",
      needsAttention: true,
    });
    expect(summarize(failed)).toMatchObject({
      tone: "failed",
      detail: "The backup folder is not available.",
    });
    expect(backupAttentionMessage(failed)).toBe("The backup folder is not available.");

    const recovered = status({
      lastSuccessAt: at(11, 17, 3),
      lastAttemptAt: at(11, 17, 3),
      lastError: "The backup folder is not available.",
    });
    expect(summarize(recovered).tone).toBe("healthy");
  });

  it("flags automatic backups that stopped without an error", () => {
    const stale = status({ lastSuccessAt: at(11, 13, 3), needsAttention: true });
    expect(summarize(stale)).toMatchObject({
      tone: "attention",
      title: "Last backed up 4 days ago",
      detail: "No automatic backup has finished in 3 days.",
    });
    expect(backupAttentionMessage({ ...stale, configured: false })).toBeNull();
  });

  it("points to the first backup, or says automatic backups are off", () => {
    expect(summarize(status({ nextRunAt: at(11, 18, 3) }))).toMatchObject({
      tone: "empty",
      detail: "Next backup tomorrow at 3:00 AM",
    });
    const manual = status({
      settings: { ...settings, schedule: { ...settings.schedule, frequency: "off" } },
      lastSuccessAt: at(11, 17, 13),
    });
    expect(summarize(manual).detail).toBe("Today at 1:00 PM · Automatic backups are off");
  });
});

describe("settingsForSetup", () => {
  it.each([
    ["daily", { frequency: "daily", time: "03:00", weekday: 0 }],
    ["weekly", { frequency: "weekly", time: "03:00", weekday: 0 }],
    ["manual", { frequency: "off", time: "22:00", weekday: 3 }],
  ] as const)("saves %s with the folder and the rest unchanged", (cadence, schedule) => {
    const current: BackupSettings = {
      ...settings,
      folder: "",
      keep: 14,
      schedule: { frequency: "daily", time: "22:00", weekday: 3 },
    };
    expect(settingsForSetup(current, { folder: "  ~/Backups ", cadence })).toEqual({
      ...current,
      folder: "~/Backups",
      schedule,
    });
  });
});

describe("schedule choices", () => {
  it("keeps a saved value the menus do not list", () => {
    expect(scheduleTimeOptions("03:00")).toHaveLength(24);
    const times = scheduleTimeOptions("03:30");
    expect(times.slice(3, 5)).toEqual(["03:00", "03:30"]);
    expect(keepOptions(7)).toEqual([7, 14, 30]);
    expect(keepOptions(10)).toEqual([7, 10, 14, 30]);
  });
});

describe("backup folders", () => {
  const suggestions: ReadonlyArray<BackupFolderSuggestion> = [
    {
      kind: "local",
      label: "Documents",
      folder: "~/Documents/Codenine Backups",
      recommended: false,
    },
    { kind: "icloud", label: "iCloud Drive", folder: settings.folder, recommended: true },
    { kind: "dropbox", label: "Dropbox", folder: "~/Dropbox/Codenine Backups", recommended: false },
  ];

  it("starts on the saved folder, else the recommended one", () => {
    expect(initialFolderChoice(suggestions, "")).toBe(settings.folder);
    expect(initialFolderChoice(suggestions, "~/Dropbox/Codenine Backups")).toBe(
      "~/Dropbox/Codenine Backups",
    );
    expect(initialFolderChoice(suggestions, "/Volumes/Drive/Backups")).toBe(OTHER_CHOICE);
    expect(initialFolderChoice([], "")).toBe(OTHER_CHOICE);
  });

  it("names a suggested folder by its place", () => {
    expect(folderLabel(settings.folder, suggestions)).toBe("iCloud Drive › Codenine Backups");
    expect(folderLabel("/Volumes/Drive/Backups", suggestions)).toBe("/Volumes/Drive/Backups");
  });

  it("lists the cloud folders it found", () => {
    expect(cloudFoldersLine(suggestions)).toBe("Found iCloud Drive and Dropbox on this computer.");
    expect(cloudFoldersLine(suggestions.slice(0, 1))).toBe(
      "No synced cloud folder found on this computer.",
    );
  });
});

describe("setupErrors", () => {
  it("asks for a folder, a long enough matching password, and the saved checkbox", () => {
    expect(
      setupErrors({ folder: " ", password: "short", confirmation: "short", saved: false }),
    ).toEqual({
      folder: "Choose a folder for your backups.",
      password: "Use at least 8 characters.",
      saved: "Save the password somewhere safe first.",
    });
    expect(
      setupErrors({
        folder: "~/B",
        password: "long enough",
        confirmation: "long enuf",
        saved: true,
      }),
    ).toEqual({ confirmation: "The passwords do not match." });
    expect(
      setupErrors({
        folder: "~/B",
        password: "long enough",
        confirmation: "long enough",
        saved: true,
      }),
    ).toEqual({});
  });
});

describe("restore flow", () => {
  const summary = {
    file: file(at(11, 16, 3)),
    contents: { workspaces: 1, chats: 12, accounts: 2, savedKeys: 1, skills: 0 },
    fromThisComputer: false,
    blockedReason: null,
  } satisfies BackupRestoreSummary;

  it("walks choose, unlock and review, and starts at unlock for a known file", () => {
    let flow = startRestoreFlow(null);
    expect(restoreStepIndex(flow)).toBe(0);
    flow = nextRestoreFlow(flow, { type: "chose", path: "/b/one" });
    expect(flow).toEqual({ step: "unlock", path: "/b/one" });
    flow = nextRestoreFlow(flow, { type: "unlocked", password: "secret12", summary });
    expect(restoreStepIndex(flow)).toBe(2);
    expect(startRestoreFlow("/b/two")).toEqual({ step: "unlock", path: "/b/two" });
  });

  it("goes back to choose with the file still picked and the password dropped", () => {
    const review = nextRestoreFlow(
      { step: "unlock", path: "/b/one" },
      { type: "unlocked", password: "secret12", summary },
    );
    expect(nextRestoreFlow(review, { type: "chooseAnother" })).toEqual({
      step: "choose",
      path: "/b/one",
    });
  });

  it("only leaves review for a restart, and ignores events out of order", () => {
    const review = nextRestoreFlow(
      { step: "unlock", path: "/b/one" },
      { type: "unlocked", password: "secret12", summary },
    );
    const restarting = nextRestoreFlow(review, { type: "restarting" });
    expect(restarting).toEqual({ step: "restarting" });
    expect(nextRestoreFlow(restarting, { type: "notBack" })).toEqual({ step: "notBack" });
    expect(nextRestoreFlow(restarting, { type: "chooseAnother" })).toBe(restarting);
    expect(nextRestoreFlow(review, { type: "finishByHand" })).toEqual({ step: "finishByHand" });
    expect(nextRestoreFlow(startRestoreFlow(null), { type: "restarting" })).toEqual({
      step: "choose",
      path: null,
    });
  });
});

describe("restore report", () => {
  it("counts what comes back, singular and plural, and leaves out what is empty", () => {
    expect(
      restoreContentLines({ workspaces: 1, chats: 12, accounts: 2, savedKeys: 1, skills: 3 }),
    ).toEqual(["1 workspace", "12 chats", "2 accounts and 1 saved key", "Settings and 3 skills"]);
    expect(
      restoreContentLines({ workspaces: 2, chats: 0, accounts: 0, savedKeys: 1, skills: 0 }),
    ).toEqual(["2 workspaces", "No chats", "1 saved key", "Settings"]);
    expect(
      restoreContentLines({ workspaces: 1, chats: 1, accounts: 0, savedKeys: 0, skills: 1 }),
    ).toEqual(["1 workspace", "1 chat", "No accounts", "Settings and 1 skill"]);
  });

  it("offers undo until the window closes", () => {
    expect(undoAvailability(at(11, 24, 15), NOW)).toBe("Available for 7 days.");
    expect(undoAvailability(at(11, 17, 16), NOW)).toBe("Available for 1 day.");
    expect(undoAvailability(at(11, 17, 14), NOW)).toBeNull();
    expect(undoAvailability(null, NOW)).toBeNull();
  });
});
