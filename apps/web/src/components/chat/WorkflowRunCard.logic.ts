/** About what four lines of the card hold; a longer result offers the whole of it. */
const EXCERPT_MAX_LINES = 4;
const EXCERPT_MAX_CHARS = 300;

const DROPPED_LINE = [
  /^\s*(```|~~~)/, // code fence
  /^\s{0,3}([-*_])(\s*\1){2,}\s*$/, // thematic break
  /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/, // table separator
];

function plainLine(line: string): string {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s*(>\s?)+/, "")
    .replace(/^\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, "")
    .replace(/^\s*\|(.*?)\|?\s*$/, (_match, cells: string) => cells.replace(/\s*\|\s*/g, " · "))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "$1")
    .replace(/(?<![\w*])\*(?=\S)(.+?)(?<=\S)\*(?![\w*])/g, "$1")
    .replace(/(?<![\w_])_(?=\S)(.+?)(?<=\S)_(?![\w_])/g, "$1")
    .trim();
}

/**
 * The start of a Markdown result as plain text for the collapsed card, and whether there is more
 * of it to show.
 */
export function workflowResultExcerpt(markdown: string): {
  readonly text: string;
  readonly more: boolean;
} {
  const lines = markdown
    .split(/\r?\n/)
    .filter((line) => !DROPPED_LINE.some((pattern) => pattern.test(line)))
    .map(plainLine)
    .filter((line) => line.length > 0);
  const text = lines.slice(0, EXCERPT_MAX_LINES).join("\n");
  if (text.length > EXCERPT_MAX_CHARS) {
    return { text: `${text.slice(0, EXCERPT_MAX_CHARS - 1).trimEnd()}…`, more: true };
  }
  return { text, more: lines.length > EXCERPT_MAX_LINES };
}
