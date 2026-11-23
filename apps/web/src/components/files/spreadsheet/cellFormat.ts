const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_MS = 86_400_000;
// Days from the spreadsheet epoch to 1 January 1970, and from the 1904 epoch to the 1900 one.
const UNIX_EPOCH_SERIAL = 25_569;
const DATE_1904_OFFSET = 1_462;

const pad = (value: number, length: number) => String(value).padStart(length, "0");

/** A number as a spreadsheet shows it without a format: up to eleven significant digits. */
const generalNumber = (value: number) => String(Number(value.toPrecision(11)));

/** The section of a format for this value's sign, without colours and conditions. */
function sectionFor(code: string, value: number): { section: string; signed: boolean } {
  const sections: Array<string> = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < code.length; index++) {
    const character = code[index]!;
    if (character === '"') quoted = !quoted;
    if (character === "\\" && !quoted) {
      current += character + (code[index + 1] ?? "");
      index += 1;
    } else if (character === ";" && !quoted) {
      sections.push(current);
      current = "";
    } else current += character;
  }
  sections.push(current);
  const index = value < 0 && sections.length > 1 ? 1 : value === 0 && sections.length > 2 ? 2 : 0;
  return { section: sections[index] ?? "", signed: index === 1 };
}

type Piece = { readonly literal: string } | { readonly token: string };

function pieces(section: string): Array<Piece> {
  const found: Array<Piece> = [];
  const pattern =
    /"([^"]*)"|\\(.)|_.|\*.|\[\$([^\]-]*)[^\]]*\]|\[(h+|m+|s+)\]|\[[^\]]*\]|(AM\/PM|A\/P)|(y+|m+|d+|h+|s+)|([#0?,.]+(?:E[+-]0+)?)|(.)/gi;
  for (const match of section.matchAll(pattern)) {
    if (match[1] !== undefined) found.push({ literal: match[1] });
    else if (match[2] !== undefined) found.push({ literal: match[2] });
    else if (match[3] !== undefined) found.push({ literal: match[3] });
    else if (match[4] !== undefined) found.push({ token: `[${match[4].toLowerCase()}]` });
    else if (match[5] !== undefined) found.push({ token: match[5].toUpperCase() });
    else if (match[6] !== undefined) found.push({ token: match[6].toLowerCase() });
    else if (match[7] !== undefined) found.push({ token: `#${match[7]}` });
    else if (match[8] !== undefined) found.push({ literal: match[8] });
  }
  return found;
}

function formatDate(parts: ReadonlyArray<Piece>, serial: number, date1904: boolean): string {
  const date = new Date(
    Math.round((serial + (date1904 ? DATE_1904_OFFSET : 0) - UNIX_EPOCH_SERIAL) * DAY_MS),
  );
  const twelveHour = parts.some((part) => "token" in part && /^(AM\/PM|A\/P)$/.test(part.token));
  const hours = date.getUTCHours();
  let output = "";
  parts.forEach((part, index) => {
    if ("literal" in part) {
      output += part.literal;
      return;
    }
    const { token } = part;
    const neighbour = (step: number) => {
      for (let at = index + step; at >= 0 && at < parts.length; at += step) {
        const other = parts[at]!;
        if ("token" in other) return other.token;
      }
      return "";
    };
    // `m` is minutes next to hours or seconds, and the month everywhere else.
    const minutes =
      token.startsWith("m") && (/^\[?h/.test(neighbour(-1)) || /^s/.test(neighbour(1)));
    if (token.startsWith("y")) {
      output += token.length <= 2 ? pad(date.getUTCFullYear() % 100, 2) : date.getUTCFullYear();
    } else if (minutes) output += pad(date.getUTCMinutes(), token.length);
    else if (token.startsWith("m")) {
      const month = date.getUTCMonth();
      output +=
        token.length >= 4
          ? MONTHS[month]
          : token.length === 3
            ? MONTHS[month]!.slice(0, 3)
            : pad(month + 1, token.length);
    } else if (token.startsWith("d")) {
      output +=
        token.length >= 4
          ? WEEKDAYS[date.getUTCDay()]
          : token.length === 3
            ? WEEKDAYS[date.getUTCDay()]!.slice(0, 3)
            : pad(date.getUTCDate(), token.length);
    } else if (token === "[h]") output += Math.floor(serial * 24);
    else if (token.startsWith("h")) {
      output += pad(twelveHour ? hours % 12 || 12 : hours, token.length);
    } else if (token.startsWith("s")) output += pad(date.getUTCSeconds(), token.length);
    else if (token === "AM/PM") output += hours < 12 ? "AM" : "PM";
    else if (token === "A/P") output += hours < 12 ? "A" : "P";
    else if (token.startsWith("#")) output += token.slice(1).replace(/[#0?]/g, "0");
  });
  return output;
}

function formatDigits(pattern: string, value: number): string {
  const exponent = /E[+-]0+$/i.exec(pattern);
  const [whole = "", fraction = ""] = (exponent ? pattern.slice(0, exponent.index) : pattern).split(
    ".",
  );
  const maxDecimals = fraction.replace(/[^#0?]/g, "").length;
  const minDecimals = fraction.replace(/[^0]/g, "").length;
  if (exponent) {
    const width = exponent[0].length - 2;
    return value
      .toExponential(maxDecimals)
      .replace(
        /e([+-])(\d+)/,
        (_, sign: string, power: string) => `E${sign}${power.padStart(width, "0")}`,
      );
  }
  let text = Math.abs(value).toFixed(maxDecimals);
  if (maxDecimals > minDecimals) {
    const keep = text.length - (maxDecimals - minDecimals);
    let end = text.length;
    while (end > keep && text[end - 1] === "0") end -= 1;
    text = text.slice(0, text[end - 1] === "." ? end - 1 : end);
  }
  let [digits = "", decimals] = text.split(".");
  digits = digits.padStart(whole.replace(/[^0]/g, "").length, "0");
  if (whole.includes(",")) digits = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return decimals === undefined ? digits : `${digits}.${decimals}`;
}

/**
 * A number as its Excel format code shows it. Covers digits, thousands, decimals, percent,
 * exponents, literal text and dates; anything else falls back to the plain number.
 */
export function formatNumber(value: number, code: string | undefined, date1904: boolean): string {
  if (code === undefined || code === "" || /^general$/i.test(code) || code === "@") {
    return generalNumber(value);
  }
  const { section, signed } = sectionFor(code, value);
  const parts = pieces(section);
  const tokens = parts.flatMap((part) => ("token" in part ? [part.token] : []));
  if (tokens.some((token) => /^(\[?[ymdhs]|AM\/PM|A\/P)/.test(token))) {
    return value < 0 ? generalNumber(value) : formatDate(parts, value, date1904);
  }
  const digits = tokens.filter((token) => token.startsWith("#"));
  // A fraction or several digit groups is a layout this does not reproduce.
  if (digits.length !== 1 || section.includes("/")) return generalNumber(value);
  const percent = parts.some((part) => "literal" in part && part.literal === "%");
  const scaled = percent ? value * 100 : value;
  let output = !signed && value < 0 ? "-" : "";
  for (const part of parts) {
    output += "literal" in part ? part.literal : formatDigits(part.token.slice(1), scaled);
  }
  return output;
}
