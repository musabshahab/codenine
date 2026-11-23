/** How many numbered names a copy tries before giving up. */
const MAX_NUMBERED_NAMES = 99;

// Characters no common filesystem takes in a name, and control characters.
const UNSAFE_NAME_CHARACTERS = /[<>:"|?*\u0000-\u001f]/g;

/**
 * The names a copy is tried under, in order: the name itself, then `name (2).ext` and so on.
 * Only the last path segment is kept, so a copy always lands at the top of the workspace.
 * Null when nothing usable is left of the name.
 */
export function copyNameCandidates(name: string): ReadonlyArray<string> | null {
  const base = (name.split(/[\\/]/).at(-1) ?? "")
    .replace(UNSAFE_NAME_CHARACTERS, "")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "");
  if (base === "") return null;
  const dot = base.lastIndexOf(".");
  const stem = dot <= 0 ? base : base.slice(0, dot);
  const extension = dot <= 0 ? "" : base.slice(dot);
  const names = [base];
  for (let number = 2; number <= MAX_NUMBERED_NAMES + 1; number++) {
    names.push(`${stem} (${number})${extension}`);
  }
  return names;
}
