import type { ReplyFileFormat } from "@codenine/contracts";

export const REPLY_FILE_FORMATS: ReadonlyArray<{
  readonly format: ReplyFileFormat;
  readonly label: string;
  readonly extension: string;
}> = [
  { format: "markdown", label: "Markdown", extension: ".md" },
  { format: "pdf", label: "PDF", extension: ".pdf" },
  { format: "xlsx", label: "Spreadsheet", extension: ".xlsx" },
];

const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/** Whether the reply holds a Markdown table, which is what a spreadsheet is made from. */
export function replyHasTable(markdown: string): boolean {
  const lines = markdown.split(/\r?\n/);
  let fence: string | null = null;
  for (const [index, line] of lines.entries()) {
    const marker = /^\s*(```|~~~)/.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence === null && line.includes("|") && TABLE_DIVIDER.test(lines[index + 1] ?? "")) {
      return true;
    }
  }
  return false;
}

/** A file name from the reply's first heading or first words, without an extension. */
export function defaultReplyFileName(markdown: string): string {
  const lines = markdown.split(/\r?\n/).map((line) => line.trim());
  const heading = lines.find((line) => /^#{1,6}\s+\S/.test(line));
  const first = heading ?? lines.find((line) => /[\p{L}\p{N}]/u.test(line)) ?? "";
  const words = first
    .replace(/[`*_~#>[\]()|]/g, " ")
    .replace(/[\\/:"?<>\u0000-\u001f]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .join(" ")
    .replace(/[.\s]+$/, "")
    .slice(0, 60)
    .trim();
  return words === "" ? "Reply" : words;
}

export type ReplyFilePath =
  | { readonly ok: true; readonly relativePath: string }
  | { readonly ok: false; readonly problem: string };

/**
 * The workspace-relative path a reply is saved to: the folder and name the user typed, with the
 * format's extension. A path that would leave the workspace is refused.
 */
export function replyFilePath(
  folder: string,
  name: string,
  format: ReplyFileFormat,
): ReplyFilePath {
  const extension = REPLY_FILE_FORMATS.find((entry) => entry.format === format)!.extension;
  const segments = `${folder}/${name}`
    .replaceAll("\\", "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "" && segment !== ".");
  const typedName = name.replaceAll("\\", "/").split("/").at(-1)?.trim() ?? "";
  if (typedName === "" || segments.length === 0) {
    return { ok: false, problem: "Give the file a name." };
  }
  if (segments.includes("..") || /^[A-Za-z]:$/.test(segments[0]!)) {
    return { ok: false, problem: "The file must be inside the workspace." };
  }
  if (segments.some((segment) => /[:"?<>|*\u0000-\u001f]/.test(segment))) {
    return { ok: false, problem: 'A name cannot contain any of : " ? < > | *' };
  }
  const last = segments.at(-1)!;
  // Another format's extension is replaced, so "plan.md" saved as a PDF is "plan.pdf".
  const stem = last.replace(/\.(md|markdown|pdf|xlsx)$/i, "");
  if (stem === "") return { ok: false, problem: "Give the file a name." };
  const relativePath = [...segments.slice(0, -1), `${stem}${extension}`].join("/");
  if (relativePath.length > 512) return { ok: false, problem: "That path is too long." };
  return { ok: true, relativePath };
}
