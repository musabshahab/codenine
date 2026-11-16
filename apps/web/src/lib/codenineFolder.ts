/**
 * Codenine's own folder on a machine, written with `~` when it sits in the user's home, so a
 * path saved under it reads the same on every computer.
 */
export function codenineFolderPath(
  config: { readonly codenineHome?: string; readonly homeDirectory?: string } | null | undefined,
): string {
  const folder = config?.codenineHome;
  if (!folder) return "~/.codenine";
  const home = config?.homeDirectory;
  const insideHome =
    home !== undefined &&
    (folder === home || folder.startsWith(`${home}/`) || folder.startsWith(`${home}\\`));
  return insideHome ? `~${folder.slice(home.length)}` : folder;
}
