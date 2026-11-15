import type {
  ControlEffectiveProfile,
  ControlProfilePreview,
  ControlProfileScalar,
  ControlProfileSettings,
} from "@codenine/contracts/control";

/** What a workspace gets where no layer says otherwise: the installation's settings. */
export interface ProfileDefaults {
  readonly cpus: number;
  readonly memoryGb: number;
  readonly sleepMinutes: number;
}

/** Whether `wide`, a host or a domain with a leading dot, covers `host`. */
export const coversHost = (wide: string, host: string) =>
  wide === host || (wide.startsWith(".") && (host === wide.slice(1) || host.endsWith(wide)));

/**
 * Applies layers from the top: the company's, the department's, its teams',
 * then the person's exceptions. A layer changes only what the layers above left
 * open: it cannot change a setting they locked, lift a blocked terminal, or
 * allow a host they blocked. Blocks and allowed hosts add up from every layer.
 */
export const resolveProfile = (
  layers: ReadonlyArray<ControlProfileSettings>,
  defaults: ProfileDefaults,
): ControlEffectiveProfile => {
  let image: string | null = null;
  let { cpus, memoryGb, sleepMinutes } = defaults;
  let terminal = true;
  const locked = new Set<ControlProfileScalar>();
  const allow = new Set<string>();
  const block = new Set<string>();
  for (const layer of layers) {
    if (layer.image !== undefined && !locked.has("image")) image = layer.image;
    if (layer.cpus !== undefined && !locked.has("cpus")) cpus = layer.cpus;
    if (layer.memoryGb !== undefined && !locked.has("memoryGb")) memoryGb = layer.memoryGb;
    if (layer.sleepMinutes !== undefined && !locked.has("sleepMinutes")) {
      sleepMinutes = layer.sleepMinutes;
    }
    for (const key of layer.lock ?? []) locked.add(key);
    if (layer.terminal === "block") terminal = false;
    for (const host of layer.allowHosts ?? []) allow.add(host);
    for (const host of layer.blockHosts ?? []) block.add(host);
  }
  const blockHosts = [...block].toSorted();
  return {
    image,
    cpus,
    memoryGb,
    sleepMinutes,
    terminal,
    allowHosts: [...allow]
      .filter((host) => !blockHosts.some((blocked) => coversHost(blocked, host)))
      .toSorted(),
    blockHosts,
  };
};

const shown = (setting: string, value: unknown) => {
  if (setting === "terminal") return value ? "allowed" : "blocked";
  if (setting === "image" && value === null) return "the installation's image";
  return String(value);
};

const SCALAR_SETTINGS = ["image", "cpus", "memoryGb", "sleepMinutes", "terminal"] as const;
const HOST_SETTINGS = ["allowHosts", "blockHosts"] as const;

/**
 * How a change would land: for each person, every workspace they have before
 * and after it. A person counts once per setting however many of their
 * workspaces change.
 */
export const summarizeChanges = (
  people: ReadonlyArray<
    ReadonlyArray<{
      readonly before: ControlEffectiveProfile;
      readonly after: ControlEffectiveProfile;
    }>
  >,
): ControlProfilePreview => {
  const affected = new Set<number>();
  const changes: Array<ControlProfilePreview["changes"][number]> = [];
  for (const setting of SCALAR_SETTINGS) {
    const removed = new Set<string>();
    const added = new Set<string>();
    let count = 0;
    people.forEach((workspaces, index) => {
      let changed = false;
      for (const { before, after } of workspaces) {
        const from = shown(setting, before[setting]);
        const to = shown(setting, after[setting]);
        if (from !== to) {
          changed = true;
          removed.add(from);
          added.add(to);
        }
      }
      if (changed) {
        count += 1;
        affected.add(index);
      }
    });
    if (count > 0)
      changes.push({ setting, people: count, removed: [...removed], added: [...added] });
  }
  for (const setting of HOST_SETTINGS) {
    const removed = new Set<string>();
    const added = new Set<string>();
    let count = 0;
    people.forEach((workspaces, index) => {
      let changed = false;
      for (const { before, after } of workspaces) {
        for (const host of before[setting]) {
          if (!after[setting].includes(host)) {
            changed = true;
            removed.add(host);
          }
        }
        for (const host of after[setting]) {
          if (!before[setting].includes(host)) {
            changed = true;
            added.add(host);
          }
        }
      }
      if (changed) {
        count += 1;
        affected.add(index);
      }
    });
    if (count > 0) {
      changes.push({
        setting,
        people: count,
        removed: [...removed].toSorted(),
        added: [...added].toSorted(),
      });
    }
  }
  return { people: people.length, affected: affected.size, changes };
};

const LAYER_KEYS = [
  "image",
  "cpus",
  "memoryGb",
  "sleepMinutes",
  "terminal",
  "allowHosts",
  "blockHosts",
  "lock",
] as const satisfies ReadonlyArray<keyof ControlProfileSettings>;

const settingText = (value: unknown) =>
  value === undefined ? "unset" : Array.isArray(value) ? value.join(" ") || "none" : String(value);

/** What a new version of one layer changes, as `key: before → after` for the audit log. */
export const describeLayerChange = (
  before: ControlProfileSettings | null,
  after: ControlProfileSettings,
) =>
  LAYER_KEYS.flatMap((key) => {
    const from = settingText(before?.[key]);
    const to = settingText(after[key]);
    return from === to ? [] : [`${key}: ${from} → ${to}`];
  }).join("; ");
