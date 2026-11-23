import type { DeckOperation, DeckOperationError, DeckShape, DeckSlide } from "@codenine/contracts";
import JSZip from "jszip";

import {
  type XmlElement,
  childElements,
  escapeAttribute,
  escapeXml,
  localNameOf,
  parseAttributes,
  rootElement,
  unescapeXml,
} from "../spreadsheet/xml.ts";

const MAIN_NAMESPACE = "http://schemas.openxmlformats.org/presentationml/2006/main";
const DRAWING_NAMESPACE = "http://schemas.openxmlformats.org/drawingml/2006/main";
const RELATIONSHIPS_NAMESPACE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_RELATIONSHIPS_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const CONTENT_TYPE_PREFIX = "application/vnd.openxmlformats-officedocument.";
const SLIDE_CONTENT_TYPE = `${CONTENT_TYPE_PREFIX}presentationml.slide+xml`;
const NOTES_CONTENT_TYPE = `${CONTENT_TYPE_PREFIX}presentationml.notesSlide+xml`;
const NOTES_MASTER_CONTENT_TYPE = `${CONTENT_TYPE_PREFIX}presentationml.notesMaster+xml`;
const THEME_CONTENT_TYPE = `${CONTENT_TYPE_PREFIX}theme+xml`;
const CONTENT_TYPES_PATH = "[Content_Types].xml";
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NAMESPACES = `xmlns:a="${DRAWING_NAMESPACE}" xmlns:r="${RELATIONSHIPS_NAMESPACE}" xmlns:p="${MAIN_NAMESPACE}"`;
const EMPTY_GROUP =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>';
const COLOUR_MAP_OVERRIDE = "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>";
// Placeholders a new slide does not take from its layout: the date, footer and slide number.
const LAYOUT_ONLY_PLACEHOLDERS = new Set(["dt", "ftr", "sldNum"]);
// The lowest id a slide may have in the deck's slide list.
const FIRST_SLIDE_ID = 256;

export interface DeckLimits {
  /** The most the deck's XML parts may unpack to. Pictures and media are never unpacked. */
  readonly maxUnpackedBytes: number;
}

/** Thrown by the deck code; the service turns it into the matching typed error. */
// @effect-diagnostics-next-line extendsNativeError:off - thrown by pure code and mapped to a typed error at the service.
export class DeckProblem extends Error {
  readonly reason: DeckOperationError["reason"];
  operationIndex: number | undefined = undefined;
  constructor(reason: DeckOperationError["reason"]) {
    super(reason);
    this.reason = reason;
  }
}

const problem = (reason: DeckOperationError["reason"]) => new DeckProblem(reason);

interface Relationship {
  readonly id: string;
  readonly type: string;
  /** The target's path in the package. Empty for a target outside it. */
  readonly path: string;
}

const directoryOf = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);
const relationshipsPathOf = (path: string) =>
  `${directoryOf(path)}_rels/${path.slice(path.lastIndexOf("/") + 1)}.rels`;

function resolveTarget(sourcePath: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const segments = directoryOf(sourcePath).split("/").filter(Boolean);
  for (const segment of target.split("/")) {
    if (segment === "..") segments.pop();
    else if (segment !== "." && segment !== "") segments.push(segment);
  }
  return segments.join("/");
}

function relativeTarget(sourcePath: string, targetPath: string): string {
  const from = directoryOf(sourcePath).split("/").filter(Boolean);
  const to = targetPath.split("/");
  let shared = 0;
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared++;
  return [...from.slice(shared).map(() => ".."), ...to.slice(shared)].join("/");
}

function readRelationships(xml: string | null, sourcePath: string): Array<Relationship> {
  if (xml === null) return [];
  const relationships: Array<Relationship> = [];
  for (const element of childElements(rootElement(xml)?.inner ?? "")) {
    const attributes = parseAttributes(element.attributes);
    relationships.push({
      id: attributes.get("Id") ?? "",
      type: attributes.get("Type") ?? "",
      path:
        attributes.get("TargetMode") === "External"
          ? ""
          : resolveTarget(sourcePath, attributes.get("Target") ?? ""),
    });
  }
  return relationships;
}

const innerEnd = (element: XmlElement) => element.innerStart + (element.inner?.length ?? 0);

/** The elements directly inside `parent`, placed in the text `parent` was found in. */
const childrenOf = (xml: string, parent: XmlElement) =>
  parent.inner === null ? [] : [...childElements(xml, parent.innerStart, innerEnd(parent))];

const childOf = (xml: string, parent: XmlElement, localName: string) =>
  childrenOf(xml, parent).find((child) => localNameOf(child.name) === localName) ?? null;

const prefixOf = (name: string) => (name.includes(":") ? name.slice(0, name.indexOf(":") + 1) : "");

const replaceRange = (xml: string, start: number, end: number, text: string) =>
  xml.slice(0, start) + text + xml.slice(end);

/** The root element as an open and close pair, so children can be added to an empty one. */
function withOpenRoot(xml: string): string {
  const root = rootElement(xml);
  if (root === null || root.inner !== null) return xml;
  const open = xml.slice(root.start, root.end).replace(/\s*\/>$/, ">");
  return replaceRange(xml, root.start, root.end, `${open}</${root.name}>`);
}

function appendToRoot(xml: string, child: string): string {
  const opened = withOpenRoot(xml);
  const root = rootElement(opened);
  if (root === null) throw problem("not-a-deck");
  return replaceRange(opened, innerEnd(root), innerEnd(root), child);
}

function removeFromRoot(xml: string, matches: (attributes: Map<string, string>) => boolean) {
  const root = rootElement(xml);
  if (root === null) return xml;
  let output = xml;
  for (const element of childrenOf(xml, root).toReversed()) {
    if (matches(parseAttributes(element.attributes))) {
      output = replaceRange(output, element.start, element.end, "");
    }
  }
  return output;
}

/** Every element of that local name whose attribute holds the value, wherever it sits. */
const elementsWith = (localName: string, attribute: string, value: string) =>
  new RegExp(
    `<((?:[\\w.-]+:)?${localName})\\s(?:[^>]*\\s)?${attribute}="${value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*?(?:/>|>\\s*</\\1>)`,
    "g",
  );

/** Text shapes of a shape tree in drawing order, groups included. */
function* textShapes(xml: string, tree: XmlElement): Generator<XmlElement> {
  for (const child of childrenOf(xml, tree)) {
    const name = localNameOf(child.name);
    if (name === "sp") yield child;
    else if (name === "grpSp") yield* textShapes(xml, child);
  }
}

interface ShapeParts {
  readonly element: XmlElement;
  readonly id: string;
  readonly name: string;
  /** The placeholder element's attributes as written. Null for a free shape. */
  readonly placeholder: { readonly kind: string; readonly attributes: string } | null;
  readonly textBody: XmlElement | null;
}

function shapeParts(xml: string, element: XmlElement): ShapeParts {
  let id = "";
  let name = "";
  let placeholder: ShapeParts["placeholder"] = null;
  let textBody: XmlElement | null = null;
  for (const child of childrenOf(xml, element)) {
    const childName = localNameOf(child.name);
    if (childName === "txBody") textBody = child;
    if (childName !== "nvSpPr") continue;
    for (const part of childrenOf(xml, child)) {
      const partName = localNameOf(part.name);
      if (partName === "cNvPr") {
        const attributes = parseAttributes(part.attributes);
        id = attributes.get("id") ?? "";
        name = attributes.get("name") ?? "";
      }
      const holder = partName === "nvPr" ? childOf(xml, part, "ph") : null;
      if (holder !== null) {
        placeholder = {
          // A placeholder without a type holds content, as a body does.
          kind: parseAttributes(holder.attributes).get("type") ?? "body",
          attributes: holder.attributes.trim(),
        };
      }
    }
  }
  return { element, id, name, placeholder, textBody };
}

function paragraphText(xml: string, paragraph: XmlElement): string {
  let text = "";
  for (const child of childrenOf(xml, paragraph)) {
    const name = localNameOf(child.name);
    if (name === "br") text += "\n";
    if (name !== "r" && name !== "fld") continue;
    const run = childOf(xml, child, "t");
    if (run?.inner != null) text += unescapeXml(run.inner);
  }
  return text;
}

const bodyText = (xml: string, body: XmlElement) =>
  childrenOf(xml, body)
    .filter((child) => localNameOf(child.name) === "p")
    .map((paragraph) => paragraphText(xml, paragraph))
    .join("\n");

function paragraphsXml(prefix: string, text: string, paragraphStyle = "", runStyle = "") {
  return text
    .split(/\r?\n/)
    .map((line) =>
      line === ""
        ? `<${prefix}p>${paragraphStyle}</${prefix}p>`
        : `<${prefix}p>${paragraphStyle}<${prefix}r>${runStyle}<${prefix}t>${escapeXml(line)}</${prefix}t></${prefix}r></${prefix}p>`,
    )
    .join("");
}

/** Replaces a text body's paragraphs, keeping the first paragraph's and first run's formatting. */
function setBodyText(xml: string, body: XmlElement, text: string): string {
  const children = childrenOf(xml, body);
  const paragraphs = children.filter((child) => localNameOf(child.name) === "p");
  const raw = (element: XmlElement | null | undefined) =>
    element == null ? "" : xml.slice(element.start, element.end);
  const first = paragraphs[0];
  const paragraphStyle = first === undefined ? "" : raw(childOf(xml, first, "pPr"));
  const firstRun = paragraphs
    .flatMap((paragraph) => childrenOf(xml, paragraph))
    .find((child) => localNameOf(child.name) === "r");
  const runStyle = firstRun === undefined ? "" : raw(childOf(xml, firstRun, "rPr"));
  const kept = children
    .filter((child) => localNameOf(child.name) !== "p")
    .map(raw)
    .join("");
  const prefix = prefixOf(children[0]?.name ?? "a:x") || "a:";
  const inner = kept + paragraphsXml(prefix, text, paragraphStyle, runStyle);
  if (body.inner === null) {
    return replaceRange(xml, body.start, body.end, `<${body.name}>${inner}</${body.name}>`);
  }
  return replaceRange(xml, body.innerStart, innerEnd(body), inner);
}

const shapeTreeOf = (xml: string): XmlElement | null => {
  const root = rootElement(xml);
  const common = root === null ? null : childOf(xml, root, "cSld");
  return common === null ? null : childOf(xml, common, "spTree");
};

const matchesShape = (shape: ShapeParts, wanted: string) => {
  if (shape.id === wanted) return true;
  const kind = shape.placeholder?.kind.toLowerCase();
  if (kind === undefined) return false;
  const key = wanted.toLowerCase();
  if (kind === key) return true;
  if (key === "title") return kind === "ctrtitle";
  if (key === "subtitle") return kind === "subtitle";
  return key === "body" && kind === "obj";
};

const notesSlideXml = (text: string) =>
  `${XML_DECLARATION}<p:notes ${NAMESPACES}><p:cSld><p:spTree>${EMPTY_GROUP}` +
  '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>' +
  `${notesBodyShape(text)}</p:spTree></p:cSld>${COLOUR_MAP_OVERRIDE}</p:notes>`;

const notesBodyShape = (text: string) =>
  '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/>' +
  `<p:txBody><a:bodyPr/><a:lstStyle/>${paragraphsXml("a:", text)}</p:txBody></p:sp>`;

const NOTES_MASTER_XML =
  `${XML_DECLARATION}<p:notesMaster ${NAMESPACES}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${EMPTY_GROUP}` +
  '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="1143000"/><a:ext cx="5486400" cy="3086100"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln></p:spPr></p:sp>' +
  '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="4400550"/><a:ext cx="5486400" cy="3600450"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-GB"/><a:t>Notes</a:t></a:r></a:p></p:txBody></p:sp>' +
  '</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:notesStyle><a:lvl1pPr marL="0" algn="l" rtl="0"><a:defRPr sz="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:notesStyle></p:notesMaster>';

const relationshipsXml = (relationships: ReadonlyArray<readonly [type: string, target: string]>) =>
  `${XML_DECLARATION}<Relationships xmlns="${PACKAGE_RELATIONSHIPS_NAMESPACE}">${relationships
    .map(
      ([type, target], index) =>
        `<Relationship Id="rId${index + 1}" Type="${RELATIONSHIPS_NAMESPACE}/${type}" Target="${escapeAttribute(target)}"/>`,
    )
    .join("")}</Relationships>`;

interface SlideEntry {
  /** The slide's entry in the deck's slide list, as written. */
  readonly listed: string;
  readonly relationshipId: string;
  readonly path: string;
}

/**
 * A .pptx deck held as its package: slides are read and changed part by part, and every part an
 * operation does not name is written back as it was.
 */
export class PptxDeck {
  private readonly zip: JSZip;
  private readonly limits: DeckLimits;
  private readonly parts = new Map<string, string>();
  private readonly changed = new Set<string>();
  private readonly removed = new Set<string>();
  private unpackedBytes = 0;
  private presentationPath = "";
  private slides: Array<SlideEntry> = [];

  private constructor(zip: JSZip, limits: DeckLimits) {
    this.zip = zip;
    this.limits = limits;
  }

  static async open(bytes: Uint8Array, limits: DeckLimits): Promise<PptxDeck> {
    const zip = await JSZip.loadAsync(bytes).catch(() => {
      throw problem("not-a-deck");
    });
    const deck = new PptxDeck(zip, limits);
    const presentationPath = readRelationships(await deck.read("_rels/.rels"), "").find(
      (relationship) => relationship.type.endsWith("/officeDocument"),
    )?.path;
    if (presentationPath === undefined) throw problem("not-a-deck");
    deck.presentationPath = presentationPath;
    await deck.readSlideList();
    return deck;
  }

  private async read(path: string): Promise<string | null> {
    if (this.removed.has(path)) return null;
    const held = this.parts.get(path);
    if (held !== undefined) return held;
    const file = this.zip.file(path);
    if (file === null) return null;
    const budget = this.limits.maxUnpackedBytes - this.unpackedBytes;
    const chunks: Array<Uint8Array> = [];
    let size = 0;
    await new Promise<void>((resolve, reject) => {
      const stream = file.nodeStream();
      stream
        .on("data", (chunk: Uint8Array) => {
          size += chunk.length;
          // Stops inflating at the limit, whatever size the archive claims for the part.
          if (size > budget) {
            stream.pause();
            reject(problem("too-large"));
          } else chunks.push(chunk);
        })
        .on("error", () => reject(problem("not-a-deck")))
        .on("end", () => resolve());
    });
    this.unpackedBytes += size;
    const text = new TextDecoder("utf-8").decode(Buffer.concat(chunks));
    this.parts.set(path, text);
    return text;
  }

  private async require(path: string): Promise<string> {
    const text = await this.read(path);
    if (text === null) throw problem("not-a-deck");
    return text;
  }

  private write(path: string, text: string) {
    this.parts.set(path, text);
    this.changed.add(path);
    this.removed.delete(path);
  }

  private remove(path: string) {
    this.parts.delete(path);
    this.changed.delete(path);
    this.removed.add(path);
  }

  private exists(path: string) {
    return !this.removed.has(path) && (this.parts.has(path) || this.zip.file(path) !== null);
  }

  private paths(): ReadonlyArray<string> {
    const paths = new Set(Object.keys(this.zip.files));
    for (const path of this.parts.keys()) paths.add(path);
    for (const path of this.removed) paths.delete(path);
    return [...paths];
  }

  private async relationships(path: string) {
    return readRelationships(await this.read(relationshipsPathOf(path)), path);
  }

  /** The presentation part, its root, and the prefix the root's elements are written with. */
  private async presentation() {
    const xml = await this.require(this.presentationPath);
    const root = rootElement(xml);
    if (root === null || localNameOf(root.name) !== "presentation" || root.inner === null) {
      throw problem("not-a-deck");
    }
    const relationshipPrefix =
      [...parseAttributes(root.attributes)].find(
        ([, value]) => value === RELATIONSHIPS_NAMESPACE,
      )?.[0] ?? "xmlns:r";
    return {
      xml,
      root,
      prefix: prefixOf(root.name),
      relationshipAttribute: `${relationshipPrefix.replace(/^xmlns:?/, "") || "r"}:id`,
    };
  }

  private async readSlideList() {
    const { xml, root, relationshipAttribute } = await this.presentation();
    const byId = new Map(
      (await this.relationships(this.presentationPath)).map((relationship) => [
        relationship.id,
        relationship.path,
      ]),
    );
    const list = childOf(xml, root, "sldIdLst");
    this.slides = (list === null ? [] : childrenOf(xml, list)).flatMap((element) => {
      const relationshipId = parseAttributes(element.attributes).get(relationshipAttribute) ?? "";
      const path = byId.get(relationshipId);
      return path === undefined || path === ""
        ? []
        : [{ listed: xml.slice(element.start, element.end), relationshipId, path }];
    });
  }

  private async writeSlideList() {
    const { xml, root, prefix } = await this.presentation();
    const list = childOf(xml, root, "sldIdLst");
    const listed = `<${prefix}sldIdLst>${this.slides.map((slide) => slide.listed).join("")}</${prefix}sldIdLst>`;
    if (list !== null) {
      this.write(this.presentationPath, replaceRange(xml, list.start, list.end, listed));
      return;
    }
    // The slide list comes after the master lists and before the slide size.
    const size = childOf(xml, root, "sldSz");
    if (size === null) throw problem("not-a-deck");
    this.write(this.presentationPath, replaceRange(xml, size.start, size.start, listed));
  }

  private slideAt(number: number): SlideEntry {
    const slide = this.slides[number - 1];
    if (slide === undefined) throw problem("unknown-slide");
    return slide;
  }

  private async layoutPaths(): Promise<ReadonlyArray<string>> {
    const paths: Array<string> = [];
    for (const relationship of await this.relationships(this.presentationPath)) {
      if (!relationship.type.endsWith("/slideMaster")) continue;
      for (const layout of await this.relationships(relationship.path)) {
        if (layout.type.endsWith("/slideLayout") && !paths.includes(layout.path)) {
          paths.push(layout.path);
        }
      }
    }
    return paths;
  }

  private async layoutName(path: string): Promise<string> {
    const xml = await this.read(path);
    const root = xml === null ? null : rootElement(xml);
    const common = xml === null || root === null ? null : childOf(xml, root, "cSld");
    const name = common === null ? undefined : parseAttributes(common.attributes).get("name");
    return name ?? path.slice(path.lastIndexOf("/") + 1).replace(/\.xml$/, "");
  }

  private async notesPath(slidePath: string): Promise<string | null> {
    return (
      (await this.relationships(slidePath)).find((relationship) =>
        relationship.type.endsWith("/notesSlide"),
      )?.path ?? null
    );
  }

  private async readNotes(slidePath: string): Promise<string> {
    const path = await this.notesPath(slidePath);
    const xml = path === null ? null : await this.read(path);
    const tree = xml === null ? null : shapeTreeOf(xml);
    if (xml === null || tree === null) return "";
    for (const element of textShapes(xml, tree)) {
      const shape = shapeParts(xml, element);
      if (shape.placeholder?.kind === "body" && shape.textBody !== null) {
        return bodyText(xml, shape.textBody);
      }
    }
    return "";
  }

  /** Every slide's text, in the order they are shown. */
  async contents(): Promise<{
    readonly slides: ReadonlyArray<DeckSlide>;
    readonly layouts: ReadonlyArray<string>;
  }> {
    const slides: Array<DeckSlide> = [];
    for (const [index, slide] of this.slides.entries()) {
      const xml = await this.require(slide.path);
      const tree = shapeTreeOf(xml);
      const shapes: Array<DeckShape> = [];
      for (const element of tree === null ? [] : textShapes(xml, tree)) {
        const shape = shapeParts(xml, element);
        if (shape.textBody === null || shape.id === "") continue;
        shapes.push({
          id: shape.id,
          name: shape.name,
          ...(shape.placeholder === null ? {} : { placeholder: shape.placeholder.kind }),
          text: bodyText(xml, shape.textBody),
        });
      }
      const layoutPath = (await this.relationships(slide.path)).find((relationship) =>
        relationship.type.endsWith("/slideLayout"),
      )?.path;
      slides.push({
        slide: index + 1,
        layout: layoutPath === undefined ? "" : await this.layoutName(layoutPath),
        shapes,
        notes: await this.readNotes(slide.path),
      });
    }
    const layouts: Array<string> = [];
    for (const path of await this.layoutPaths()) layouts.push(await this.layoutName(path));
    return { slides, layouts };
  }

  /** A failed operation may leave the deck half changed, so the caller must drop it. */
  async apply(operations: ReadonlyArray<DeckOperation>): Promise<void> {
    for (const [index, operation] of operations.entries()) {
      try {
        await this.applyOne(operation);
      } catch (cause) {
        if (cause instanceof DeckProblem) cause.operationIndex ??= index;
        throw cause;
      }
    }
  }

  private async applyOne(operation: DeckOperation): Promise<void> {
    switch (operation.type) {
      case "setText":
        return this.setText(this.slideAt(operation.slide).path, operation.shape, operation.text);
      case "setNotes":
        return this.setNotes(this.slideAt(operation.slide).path, operation.notes);
      case "moveSlide": {
        const slide = this.slideAt(operation.slide);
        if (operation.to > this.slides.length) throw problem("unknown-slide");
        this.slides.splice(operation.slide - 1, 1);
        this.slides.splice(operation.to - 1, 0, slide);
        return this.writeSlideList();
      }
      case "deleteSlide":
        return this.deleteSlide(operation.slide);
      case "addSlide":
        return this.addSlide(operation);
    }
  }

  private async setText(slidePath: string, wanted: string, text: string) {
    const xml = await this.require(slidePath);
    const tree = shapeTreeOf(xml);
    for (const element of tree === null ? [] : textShapes(xml, tree)) {
      const shape = shapeParts(xml, element);
      if (shape.textBody === null || !matchesShape(shape, wanted)) continue;
      this.write(slidePath, setBodyText(xml, shape.textBody, text));
      return;
    }
    throw problem("unknown-shape");
  }

  private nextPartPath(directory: string, stem: string): string {
    const pattern = new RegExp(`^${directory}${stem}(\\d+)\\.xml$`);
    const taken = this.paths().flatMap((path) => {
      const match = pattern.exec(path);
      return match === null ? [] : [Number(match[1])];
    });
    return `${directory}${stem}${Math.max(0, ...taken) + 1}.xml`;
  }

  private async addRelationship(sourcePath: string, type: string, targetPath: string) {
    const path = relationshipsPathOf(sourcePath);
    const xml = (await this.read(path)) ?? relationshipsXml([]);
    const taken = readRelationships(xml, sourcePath).flatMap((relationship) => {
      const match = /^rId(\d+)$/.exec(relationship.id);
      return match === null ? [] : [Number(match[1])];
    });
    const id = `rId${Math.max(0, ...taken) + 1}`;
    this.write(
      path,
      appendToRoot(
        xml,
        `<Relationship Id="${id}" Type="${RELATIONSHIPS_NAMESPACE}/${type}" Target="${escapeAttribute(relativeTarget(sourcePath, targetPath))}"/>`,
      ),
    );
    return id;
  }

  private async addContentType(path: string, contentType: string) {
    this.write(
      CONTENT_TYPES_PATH,
      appendToRoot(
        await this.require(CONTENT_TYPES_PATH),
        `<Override PartName="/${escapeAttribute(path)}" ContentType="${contentType}"/>`,
      ),
    );
  }

  private async removePart(path: string) {
    this.remove(path);
    if (this.exists(relationshipsPathOf(path))) this.remove(relationshipsPathOf(path));
    this.write(
      CONTENT_TYPES_PATH,
      removeFromRoot(
        await this.require(CONTENT_TYPES_PATH),
        (attributes) => attributes.get("PartName") === `/${path}`,
      ),
    );
  }

  private async addSlide(operation: Extract<DeckOperation, { type: "addSlide" }>) {
    const at = operation.at ?? this.slides.length + 1;
    if (at > this.slides.length + 1) throw problem("unknown-slide");
    let layoutPath: string | undefined;
    for (const path of await this.layoutPaths()) {
      if ((await this.layoutName(path)).toLowerCase() === operation.layout.toLowerCase()) {
        layoutPath = path;
        break;
      }
    }
    if (layoutPath === undefined) throw problem("unknown-layout");
    const layoutXml = await this.require(layoutPath);
    const layoutTree = shapeTreeOf(layoutXml);
    let shapes = "";
    let shapeId = 2;
    for (const element of layoutTree === null ? [] : textShapes(layoutXml, layoutTree)) {
      const shape = shapeParts(layoutXml, element);
      if (shape.placeholder === null || LAYOUT_ONLY_PLACEHOLDERS.has(shape.placeholder.kind)) {
        continue;
      }
      shapes +=
        `<p:sp><p:nvSpPr><p:cNvPr id="${shapeId++}" name="${escapeAttribute(shape.name)}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>` +
        `<p:nvPr><p:ph ${shape.placeholder.attributes}/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>`;
    }
    const slidePath = this.nextPartPath(`${directoryOf(this.presentationPath)}slides/`, "slide");
    this.write(
      slidePath,
      `${XML_DECLARATION}<p:sld ${NAMESPACES}><p:cSld><p:spTree>${EMPTY_GROUP}${shapes}</p:spTree></p:cSld>${COLOUR_MAP_OVERRIDE}</p:sld>`,
    );
    this.write(
      relationshipsPathOf(slidePath),
      relationshipsXml([["slideLayout", relativeTarget(slidePath, layoutPath)]]),
    );
    await this.addContentType(slidePath, SLIDE_CONTENT_TYPE);
    const relationshipId = await this.addRelationship(this.presentationPath, "slide", slidePath);
    const { prefix, relationshipAttribute } = await this.presentation();
    const ids = this.slides.map((slide) => Number(/\sid="(\d+)"/.exec(slide.listed)?.[1] ?? 0));
    const id = Math.max(FIRST_SLIDE_ID - 1, ...ids) + 1;
    this.slides.splice(at - 1, 0, {
      listed: `<${prefix}sldId id="${id}" ${relationshipAttribute}="${relationshipId}"/>`,
      relationshipId,
      path: slidePath,
    });
    await this.writeSlideList();
    for (const { shape, text } of operation.text ?? []) await this.setText(slidePath, shape, text);
    if (operation.notes !== undefined) await this.setNotes(slidePath, operation.notes);
  }

  private async deleteSlide(number: number) {
    const slide = this.slideAt(number);
    if (this.slides.length === 1) throw problem("last-slide");
    const notes = await this.notesPath(slide.path);
    this.slides.splice(number - 1, 1);
    await this.writeSlideList();
    // Custom shows name the slide by relationship and sections by slide id. One left behind
    // points at nothing, and PowerPoint then asks to repair the file.
    const { xml, relationshipAttribute } = await this.presentation();
    const slideId = /\sid="(\d+)"/.exec(slide.listed)?.[1];
    const unlisted = xml.replace(
      elementsWith("sld", relationshipAttribute, slide.relationshipId),
      "",
    );
    this.write(
      this.presentationPath,
      slideId === undefined ? unlisted : unlisted.replace(elementsWith("sldId", "id", slideId), ""),
    );
    const relationshipsPath = relationshipsPathOf(this.presentationPath);
    this.write(
      relationshipsPath,
      removeFromRoot(
        await this.require(relationshipsPath),
        (attributes) => attributes.get("Id") === slide.relationshipId,
      ),
    );
    // A slide another part still links to stays in the package, so that link keeps its target.
    if (await this.isLinked(slide.path, notes)) return;
    await this.removePart(slide.path);
    if (notes !== null) await this.removePart(notes);
  }

  private async isLinked(slidePath: string, ownNotes: string | null): Promise<boolean> {
    for (const path of this.paths()) {
      if (!path.endsWith(".rels")) continue;
      if (path === relationshipsPathOf(slidePath)) continue;
      if (ownNotes !== null && path === relationshipsPathOf(ownNotes)) continue;
      const source = path.replace(/_rels\/([^/]+)\.rels$/, "$1");
      const relationships = readRelationships(await this.read(path), source);
      if (relationships.some((relationship) => relationship.path === slidePath)) return true;
    }
    return false;
  }

  private async notesMasterPath(): Promise<string> {
    const existing = (await this.relationships(this.presentationPath)).find((relationship) =>
      relationship.type.endsWith("/notesMaster"),
    );
    if (existing !== undefined) return existing.path;
    const base = directoryOf(this.presentationPath);
    const sourceTheme = this.paths().find((path) => /\/theme\/theme\d+\.xml$/.test(path));
    if (sourceTheme === undefined) throw problem("not-a-deck");
    const themePath = this.nextPartPath(`${base}theme/`, "theme");
    this.write(themePath, await this.require(sourceTheme));
    await this.addContentType(themePath, THEME_CONTENT_TYPE);
    const masterPath = this.nextPartPath(`${base}notesMasters/`, "notesMaster");
    this.write(masterPath, NOTES_MASTER_XML);
    this.write(
      relationshipsPathOf(masterPath),
      relationshipsXml([["theme", relativeTarget(masterPath, themePath)]]),
    );
    await this.addContentType(masterPath, NOTES_MASTER_CONTENT_TYPE);
    const relationshipId = await this.addRelationship(
      this.presentationPath,
      "notesMaster",
      masterPath,
    );
    const { xml, root, prefix, relationshipAttribute } = await this.presentation();
    const masters = childOf(xml, root, "sldMasterIdLst");
    if (masters === null) throw problem("not-a-deck");
    // The notes master list comes straight after the slide master list.
    this.write(
      this.presentationPath,
      replaceRange(
        xml,
        masters.end,
        masters.end,
        `<${prefix}notesMasterIdLst><${prefix}notesMasterId ${relationshipAttribute}="${relationshipId}"/></${prefix}notesMasterIdLst>`,
      ),
    );
    return masterPath;
  }

  private async setNotes(slidePath: string, text: string) {
    const existing = await this.notesPath(slidePath);
    if (existing !== null) {
      const xml = await this.require(existing);
      const tree = shapeTreeOf(xml);
      if (tree === null) throw problem("not-a-deck");
      for (const element of textShapes(xml, tree)) {
        const shape = shapeParts(xml, element);
        if (shape.placeholder?.kind !== "body") continue;
        this.write(
          existing,
          shape.textBody === null
            ? replaceRange(xml, element.start, element.end, notesBodyShape(text))
            : setBodyText(xml, shape.textBody, text),
        );
        return;
      }
      this.write(existing, replaceRange(xml, innerEnd(tree), innerEnd(tree), notesBodyShape(text)));
      return;
    }
    const masterPath = await this.notesMasterPath();
    const notesPath = this.nextPartPath(
      `${directoryOf(this.presentationPath)}notesSlides/`,
      "notesSlide",
    );
    this.write(notesPath, notesSlideXml(text));
    this.write(
      relationshipsPathOf(notesPath),
      relationshipsXml([
        ["notesMaster", relativeTarget(notesPath, masterPath)],
        ["slide", relativeTarget(notesPath, slidePath)],
      ]),
    );
    await this.addContentType(notesPath, NOTES_CONTENT_TYPE);
    await this.addRelationship(slidePath, "notesSlide", notesPath);
  }

  async save(): Promise<Uint8Array> {
    for (const path of this.removed) this.zip.remove(path);
    for (const path of this.changed) this.zip.file(path, this.parts.get(path) ?? "");
    this.removed.clear();
    this.changed.clear();
    return this.zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  }
}
