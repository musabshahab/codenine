import type {
  BackupContents,
  BackupFolderSuggestion,
  BackupKind,
  BackupRestoreSummary,
  BackupSettings,
  BackupStatus,
} from "@codenine/contracts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Formats dates and times; passed in so labels read the same in any locale and time zone. */
export interface BackupDateFormat {
  /** A time of day, such as "3:00 AM". */
  readonly time: (date: Date) => string;
  /** A day, such as "Nov 14", with the year when it is not this year. */
  readonly date: (date: Date, withYear: boolean) => string;
}

export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export const BACKUP_KIND_LABELS: Readonly<Record<BackupKind, string>> = {
  automatic: "Automatic",
  manual: "Made by you",
  "before-restore": "Before a restore",
};

const KEEP_OPTIONS = [7, 14, 30] as const;

const MIN_PASSWORD_LENGTH = 8;

/** Automatic backups run at this local time unless the user picks another. */
const DEFAULT_TIME = "03:00";

function plural(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "just now", "5 minutes ago", "2 hours ago", "3 days ago". */
export function timeAgo(iso: string, nowMs: number): string {
  const elapsed = Math.max(0, nowMs - Date.parse(iso));
  if (elapsed < MINUTE_MS) return "just now";
  if (elapsed < HOUR_MS) return `${plural(Math.floor(elapsed / MINUTE_MS), "minute")} ago`;
  if (elapsed < DAY_MS) return `${plural(Math.floor(elapsed / HOUR_MS), "hour")} ago`;
  return `${plural(Math.floor(elapsed / DAY_MS), "day")} ago`;
}

function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * "today at 3:00 AM", "yesterday at …", "tomorrow at …", a weekday within the coming week,
 * otherwise the date. Lowercase, to sit inside a sentence; `capitalize` starts one.
 */
export function dayAndTime(iso: string, nowMs: number, format: BackupDateFormat): string {
  const date = new Date(iso);
  // Rounded, since a day across a daylight saving change is 23 or 25 hours.
  const days = Math.round((startOfDay(date.getTime()) - startOfDay(nowMs)) / DAY_MS);
  const time = format.time(date);
  if (days === 0) return `today at ${time}`;
  if (days === -1) return `yesterday at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  if (days > 1 && days < 7) return `${WEEKDAY_NAMES[date.getDay()]} at ${time}`;
  const withYear = date.getFullYear() !== new Date(nowMs).getFullYear();
  return `${format.date(date, withYear)} at ${time}`;
}

/** A time of day saved as "HH:MM", in the user's clock format. */
export function wallTimeLabel(time: string, format: BackupDateFormat): string {
  const [hours = 0, minutes = 0] = time.split(":").map(Number);
  const date = new Date(2000, 0, 1, hours, minutes);
  return format.time(date);
}

/** Every hour, plus the saved time when it is not on the hour. */
export function scheduleTimeOptions(current: string): ReadonlyArray<string> {
  const hours = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, "0")}:00`);
  return hours.includes(current) ? hours : [...hours, current].toSorted();
}

/** The keep choices, plus the saved count when it is not one of them. */
export function keepOptions(current: number): ReadonlyArray<number> {
  const options: ReadonlyArray<number> = KEEP_OPTIONS;
  return options.includes(current) ? options : [...options, current].toSorted((a, b) => a - b);
}

export function keepLabel(keep: number): string {
  return keep === 1 ? "The last backup" : `The last ${keep} backups`;
}

function lastAttemptFailed(status: BackupStatus): boolean {
  if (status.lastError === null) return false;
  // An error left from before a later success is history, not the current state.
  return !(
    status.lastSuccessAt !== null &&
    status.lastAttemptAt !== null &&
    Date.parse(status.lastSuccessAt) >= Date.parse(status.lastAttemptAt)
  );
}

/** What a backup that needs attention says, for the Backup page and the banner. */
export function backupAttentionMessage(status: BackupStatus): string | null {
  if (!status.configured || !status.needsAttention) return null;
  return lastAttemptFailed(status) && status.lastError !== null
    ? status.lastError
    : "No automatic backup has finished in 3 days.";
}

function nextBackupLabel(
  status: BackupStatus,
  nowMs: number,
  format: BackupDateFormat,
): string | null {
  if (status.settings.schedule.frequency === "off") return "Automatic backups are off";
  return status.nextRunAt === null
    ? null
    : `Next backup ${dayAndTime(status.nextRunAt, nowMs, format)}`;
}

export type BackupTone = "healthy" | "running" | "failed" | "attention" | "empty";

export interface BackupStatusSummary {
  readonly tone: BackupTone;
  readonly title: string;
  readonly detail: string | null;
  /** 0 to 100 while a backup runs and reports how far it is. */
  readonly percent: number | null;
}

export function summarizeBackupStatus(
  status: BackupStatus,
  nowMs: number,
  format: BackupDateFormat,
  formatSize: (bytes: number) => string,
): BackupStatusSummary {
  const running = status.running?.phase === "running" ? status.running : null;
  if (running !== null) {
    return {
      tone: "running",
      title: running.percent === null ? "Backing up…" : `Backing up… ${running.percent}%`,
      detail: running.detail,
      percent: running.percent,
    };
  }
  if (lastAttemptFailed(status)) {
    return {
      tone: "failed",
      title: "The last backup failed",
      detail: status.lastError,
      percent: null,
    };
  }
  const next = nextBackupLabel(status, nowMs, format);
  const lastSuccessAt = status.lastSuccessAt;
  if (status.needsAttention) {
    return {
      tone: "attention",
      title:
        lastSuccessAt === null
          ? "Not backed up yet"
          : `Last backed up ${timeAgo(lastSuccessAt, nowMs)}`,
      detail: backupAttentionMessage(status),
      percent: null,
    };
  }
  if (lastSuccessAt === null) {
    return { tone: "empty", title: "No backups yet", detail: next, percent: null };
  }
  const madeAt = status.lastFile?.createdAt ?? lastSuccessAt;
  const detail = [
    capitalize(dayAndTime(madeAt, nowMs, format)),
    status.lastFile === null ? null : formatSize(status.lastFile.sizeBytes),
    next,
  ].filter((part) => part !== null);
  return {
    tone: "healthy",
    title: `Backed up ${timeAgo(lastSuccessAt, nowMs)}`,
    detail: detail.join(" · "),
    percent: null,
  };
}

/** How often backups run, as the setup dialog offers it. */
export type BackupCadence = "daily" | "weekly" | "manual";

export function cadenceOf(settings: BackupSettings): BackupCadence {
  const { frequency } = settings.schedule;
  return frequency === "off" ? "manual" : frequency;
}

export function cadenceLabel(cadence: BackupCadence, format: BackupDateFormat): string {
  const time = wallTimeLabel(DEFAULT_TIME, format);
  switch (cadence) {
    case "daily":
      return `Every day at ${time}`;
    case "weekly":
      return `Every week, ${WEEKDAY_NAMES[0]} at ${time}`;
    case "manual":
      return "Only when I ask";
  }
}

/** The whole `backup` setting the setup dialog saves. */
export function settingsForSetup(
  current: BackupSettings,
  choice: { readonly folder: string; readonly cadence: BackupCadence },
): BackupSettings {
  return {
    ...current,
    folder: choice.folder.trim(),
    schedule:
      choice.cadence === "manual"
        ? { ...current.schedule, frequency: "off" }
        : { frequency: choice.cadence, time: DEFAULT_TIME, weekday: 0 },
  };
}

/** A radio value no path can take, for the choice that types one. */
export const OTHER_CHOICE = ":other";

/** The suggestion to start on: the current folder, else the recommended one, else the first. */
export function initialFolderChoice(
  suggestions: ReadonlyArray<BackupFolderSuggestion>,
  currentFolder: string,
): string {
  if (currentFolder !== "") {
    return suggestions.some((suggestion) => suggestion.folder === currentFolder)
      ? currentFolder
      : OTHER_CHOICE;
  }
  return (
    suggestions.find((suggestion) => suggestion.recommended)?.folder ??
    suggestions[0]?.folder ??
    OTHER_CHOICE
  );
}

function lastSegment(folder: string): string {
  return folder.split(/[\\/]+/).findLast((segment) => segment !== "") ?? folder;
}

/** "iCloud Drive › Codenine Backups" for a suggested folder; the path itself otherwise. */
export function folderLabel(
  folder: string,
  suggestions: ReadonlyArray<BackupFolderSuggestion>,
): string {
  const suggestion = suggestions.find((candidate) => candidate.folder === folder);
  if (suggestion === undefined) return folder;
  const name = lastSegment(folder);
  return suggestion.label.includes(name) ? suggestion.label : `${suggestion.label} › ${name}`;
}

/** Names the synced folders found, so the user knows which are on offer. */
export function cloudFoldersLine(suggestions: ReadonlyArray<BackupFolderSuggestion>): string {
  const names = [
    ...new Set(
      suggestions
        .filter((suggestion) => suggestion.kind !== "local")
        .map((suggestion) => suggestion.label),
    ),
  ];
  if (names.length === 0) return "No synced cloud folder found on this computer.";
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Found ${list} on this computer.`;
}

export interface PasswordErrors {
  readonly password?: string;
  readonly confirmation?: string;
}

export function passwordErrors(password: string, confirmation: string): PasswordErrors {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { password: `Use at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  return password === confirmation ? {} : { confirmation: "The passwords do not match." };
}

export interface SetupErrors extends PasswordErrors {
  readonly folder?: string;
  readonly saved?: string;
}

export function setupErrors(input: {
  readonly folder: string;
  readonly password: string;
  readonly confirmation: string;
  readonly saved: boolean;
}): SetupErrors {
  return {
    ...(input.folder.trim() === "" ? { folder: "Choose a folder for your backups." } : {}),
    ...passwordErrors(input.password, input.confirmation),
    ...(input.saved ? {} : { saved: "Save the password somewhere safe first." }),
  };
}

export const RESTORE_STEPS = ["Choose backup", "Unlock", "Review"] as const;

/** Where the restore dialog is. The password lives only until the restore is sent. */
export type RestoreFlow =
  | { readonly step: "choose"; readonly path: string | null }
  | { readonly step: "unlock"; readonly path: string }
  | {
      readonly step: "review";
      readonly path: string;
      readonly password: string;
      readonly summary: BackupRestoreSummary;
    }
  | { readonly step: "restarting" }
  | { readonly step: "notBack" }
  | { readonly step: "finishByHand" };

export type RestoreFlowEvent =
  | { readonly type: "chose"; readonly path: string }
  | { readonly type: "unlocked"; readonly password: string; readonly summary: BackupRestoreSummary }
  | { readonly type: "chooseAnother" }
  | { readonly type: "restarting" }
  | { readonly type: "notBack" }
  | { readonly type: "finishByHand" };

export function startRestoreFlow(path: string | null): RestoreFlow {
  return path === null ? { step: "choose", path: null } : { step: "unlock", path };
}

export function nextRestoreFlow(flow: RestoreFlow, event: RestoreFlowEvent): RestoreFlow {
  switch (event.type) {
    case "chose":
      return flow.step === "choose" ? { step: "unlock", path: event.path } : flow;
    case "unlocked":
      return flow.step === "unlock"
        ? { step: "review", path: flow.path, password: event.password, summary: event.summary }
        : flow;
    case "chooseAnother":
      // Keeps the file picked, so going back shows where the user was.
      return flow.step === "unlock" || flow.step === "review"
        ? { step: "choose", path: flow.path }
        : flow;
    case "restarting":
      return flow.step === "review" ? { step: "restarting" } : flow;
    case "notBack":
      return flow.step === "restarting" ? { step: "notBack" } : flow;
    case "finishByHand":
      return flow.step === "review" ? { step: "finishByHand" } : flow;
  }
}

/** The step the header marks; the waits after a restore stay on Review. */
export function restoreStepIndex(flow: RestoreFlow): number {
  switch (flow.step) {
    case "choose":
      return 0;
    case "unlock":
      return 1;
    default:
      return 2;
  }
}

/** The four counts of what a restore brings back, in reading order for a 2 by 2 grid. */
export function restoreContentLines(contents: BackupContents): ReadonlyArray<string> {
  const accounts = [
    contents.accounts > 0 ? plural(contents.accounts, "account") : null,
    contents.savedKeys > 0 ? plural(contents.savedKeys, "saved key") : null,
  ].filter((part) => part !== null);
  return [
    plural(contents.workspaces, "workspace"),
    contents.chats > 0 ? plural(contents.chats, "chat") : "No chats",
    accounts.length > 0 ? accounts.join(" and ") : "No accounts",
    contents.skills > 0 ? `Settings and ${plural(contents.skills, "skill")}` : "Settings",
  ];
}

/** "Available for 7 days.", or null once the undo window has closed. */
export function undoAvailability(undoUntil: string | null, nowMs: number): string | null {
  if (undoUntil === null) return null;
  const left = Date.parse(undoUntil) - nowMs;
  if (!(left > 0)) return null;
  return `Available for ${plural(Math.ceil(left / DAY_MS), "day")}.`;
}
