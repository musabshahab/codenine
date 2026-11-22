import type { SearchMiddleware } from "@tanstack/react-router";

import { validateSettingsScopeSearch, type SettingsScopeSearch } from "./settingsScope";

export function validateSettingsRouteSearch(raw: Record<string, unknown>) {
  return validateSettingsScopeSearch(
    typeof raw.environmentId === "string" && raw.machine === undefined && raw.project === undefined
      ? { ...raw, machine: raw.environmentId }
      : raw,
  );
}

const SCOPE_KEYS = [
  "project",
  "machine",
  "checkout",
] as const satisfies readonly (keyof SettingsScopeSearch)[];
const TARGET_INPUT_KEYS = [...SCOPE_KEYS, "environmentId"];

/** Pages with rows a workspace can override; only these show the workspace in the scope sentence. */
export const SETTINGS_WORKSPACE_SCOPE_PATHS: ReadonlySet<string> = new Set([
  "/settings/providers",
  "/settings/threads",
  "/settings/projects",
  "/settings/source-control",
  "/settings/worktrees",
  "/settings/maintenance",
  "/settings/archived",
]);

/** The search to redirect to when a page that hides the workspace still carries one. */
export function searchWithoutHiddenWorkspace(
  pathname: string,
  search: SettingsScopeSearch,
): SettingsScopeSearch | null {
  if (SETTINGS_WORKSPACE_SCOPE_PATHS.has(pathname)) return null;
  if (search.project === undefined && search.checkout === undefined) return null;
  return { machine: search.machine, project: undefined, checkout: undefined };
}

export const retainSettingsScope: SearchMiddleware<SettingsScopeSearch> = ({ search, next }) => {
  const result = next(search);
  if (TARGET_INPUT_KEYS.some((key) => Object.hasOwn(result, key))) return result;
  const previousScope = Object.fromEntries(
    SCOPE_KEYS.filter((key) => search[key] !== undefined).map((key) => [key, search[key]]),
  );
  return { ...previousScope, ...result };
};
