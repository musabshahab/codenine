import type { SearchMiddleware } from "@tanstack/react-router";

import { validateSettingsScopeSearch, type SettingsScopeSearch } from "./settingsScope";
import { movedSettingsPath, SETTINGS_WORKSPACE_SCOPE_PATHS } from "./settingsSearch";

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

/** Where the settings route sends an old link, then a page that hides the workspace it carries. */
export function settingsRedirect(location: {
  readonly pathname: string;
  readonly hash: string;
  readonly search: SettingsScopeSearch;
}) {
  const moved = movedSettingsPath(location.pathname, location.hash);
  if (moved) return { to: moved, search: true } as const;
  const { pathname, search } = location;
  if (SETTINGS_WORKSPACE_SCOPE_PATHS.has(pathname)) return null;
  if (search.project === undefined && search.checkout === undefined) return null;
  return {
    to: pathname,
    search: { machine: search.machine, project: undefined, checkout: undefined },
  };
}

export const retainSettingsScope: SearchMiddleware<SettingsScopeSearch> = ({ search, next }) => {
  const result = next(search);
  if (TARGET_INPUT_KEYS.some((key) => Object.hasOwn(result, key))) return result;
  const previousScope = Object.fromEntries(
    SCOPE_KEYS.filter((key) => search[key] !== undefined).map((key) => [key, search[key]]),
  );
  return { ...previousScope, ...result };
};
