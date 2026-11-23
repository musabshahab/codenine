const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

export const unescapeXml = (text: string) =>
  text.includes("&")
    ? text.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (whole, name: string) => {
        if (name.startsWith("#x")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
        if (name.startsWith("#")) return String.fromCodePoint(Number(name.slice(1)));
        return ENTITIES[name] ?? whole;
      })
    : text;

// Control characters XML 1.0 cannot hold are dropped; a spreadsheet app would refuse the file.
const escapeText = (text: string) =>
  text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "");

export const escapeXml = (text: string) =>
  escapeText(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export const escapeAttribute = (text: string) =>
  escapeXml(text).replaceAll('"', "&quot;").replaceAll("\n", "&#10;").replaceAll("\r", "&#13;");

export interface XmlElement {
  /** The tag name as written, prefix included. */
  readonly name: string;
  /** The text between the name and the end of the opening tag. */
  readonly attributes: string;
  /** Null for a self-closing element. */
  readonly inner: string | null;
  /** Where `inner` starts in the scanned text. */
  readonly innerStart: number;
  readonly start: number;
  readonly end: number;
}

/**
 * The elements directly inside a stretch of XML, in order. Text, comments and processing
 * instructions between them are skipped.
 */
export function* childElements(xml: string, from = 0, to = xml.length): Generator<XmlElement> {
  let index = from;
  while (index < to) {
    const open = xml.indexOf("<", index);
    if (open === -1 || open >= to) return;
    if (xml.startsWith("<!--", open)) {
      const close = xml.indexOf("-->", open + 4);
      if (close === -1) return;
      index = close + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", open)) {
      const close = xml.indexOf("]]>", open + 9);
      if (close === -1) return;
      index = close + 3;
      continue;
    }
    if (xml[open + 1] === "?" || xml[open + 1] === "!") {
      const close = xml.indexOf(">", open);
      if (close === -1) return;
      index = close + 1;
      continue;
    }
    if (xml[open + 1] === "/") return;
    const tagEnd = endOfTag(xml, open);
    if (tagEnd === -1) return;
    let nameEnd = open + 1;
    while (nameEnd < tagEnd && !isNameEnd(xml.charCodeAt(nameEnd))) nameEnd += 1;
    const name = xml.slice(open + 1, nameEnd);
    if (xml[tagEnd - 1] === "/") {
      yield {
        name,
        attributes: xml.slice(nameEnd, tagEnd - 1),
        inner: null,
        innerStart: tagEnd + 1,
        start: open,
        end: tagEnd + 1,
      };
      index = tagEnd + 1;
      continue;
    }
    const close = closingTag(xml, name, tagEnd + 1);
    if (close === null) return;
    yield {
      name,
      attributes: xml.slice(nameEnd, tagEnd),
      inner: xml.slice(tagEnd + 1, close.start),
      innerStart: tagEnd + 1,
      start: open,
      end: close.end,
    };
    index = close.end;
  }
}

// Space, tab, line feed, carriage return, `/` and `>`.
const isNameEnd = (code: number) =>
  code === 32 || code === 9 || code === 10 || code === 13 || code === 47 || code === 62;

/** The index of the `>` that ends the tag opening at `open`, past any quoted `>`. */
function endOfTag(xml: string, open: number): number {
  let quote = "";
  for (let index = open + 1; index < xml.length; index++) {
    const character = xml[index]!;
    if (quote !== "") {
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") quote = character;
    else if (character === ">") return index;
  }
  return -1;
}

function closingTag(xml: string, name: string, from: number) {
  const closeText = `</${name}`;
  const openText = `<${name}`;
  let depth = 1;
  let index = from;
  while (true) {
    const close = xml.indexOf(closeText, index);
    if (close === -1) return null;
    // Count openings of the same element before this closing tag; elements rarely nest in themselves.
    for (let open = xml.indexOf(openText, index); open !== -1 && open < close;) {
      if (isNameEnd(xml.charCodeAt(open + openText.length))) {
        const tagEnd = endOfTag(xml, open);
        if (tagEnd === -1) return null;
        if (xml[tagEnd - 1] !== "/") depth += 1;
        open = xml.indexOf(openText, tagEnd);
      } else open = xml.indexOf(openText, open + openText.length);
    }
    const end = xml.indexOf(">", close);
    if (end === -1) return null;
    index = end + 1;
    if (!isNameEnd(xml.charCodeAt(close + closeText.length))) continue;
    depth -= 1;
    if (depth === 0) return { start: close, end: end + 1 };
  }
}

const ATTRIBUTE_PATTERN = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Attribute values as written, entities decoded. */
export function parseAttributes(attributes: string): Map<string, string> {
  const parsed = new Map<string, string>();
  for (const match of attributes.matchAll(ATTRIBUTE_PATTERN)) {
    parsed.set(match[1]!, unescapeXml(match[2] ?? match[3] ?? ""));
  }
  return parsed;
}

export const attributeText = (attributes: ReadonlyMap<string, string>) => {
  let text = "";
  for (const [name, value] of attributes) text += ` ${name}="${escapeAttribute(value)}"`;
  return text;
};

/** The first element with this local name directly inside `xml`, whatever its prefix. */
export function findChild(xml: string, localName: string): XmlElement | null {
  for (const element of childElements(xml)) {
    if (localNameOf(element.name) === localName) return element;
  }
  return null;
}

export const localNameOf = (name: string) => name.slice(name.indexOf(":") + 1);

/** The document's root element. */
export function rootElement(xml: string): XmlElement | null {
  for (const element of childElements(xml)) return element;
  return null;
}
