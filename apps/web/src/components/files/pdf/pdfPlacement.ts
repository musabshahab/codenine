import { pdfSignatureLayout } from "@codenine/shared/pdfGeometry";

/** A box on a shown page, in CSS pixels from the page's upper left corner. */
export interface ViewBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface ViewSize {
  readonly width: number;
  readonly height: number;
}

/**
 * The boxes a text selection covers, one per line. A browser reports a box for every run of
 * text, and often the same one twice, so boxes that share a line are joined.
 */
export function mergeLineBoxes(boxes: ReadonlyArray<ViewBox>): ReadonlyArray<ViewBox> {
  const lines: Array<{ x: number; y: number; right: number; bottom: number }> = [];
  const sorted = boxes
    .filter((box) => box.width > 0.5 && box.height > 0.5)
    .toSorted((a, b) => a.y - b.y || a.x - b.x);
  for (const box of sorted) {
    const middle = box.y + box.height / 2;
    const line = lines.find(
      (candidate) =>
        middle > candidate.y &&
        middle < candidate.bottom &&
        // Text in another column on the same line stays a highlight of its own.
        box.x <= candidate.right + box.height &&
        box.x + box.width >= candidate.x - box.height,
    );
    if (line === undefined) {
      lines.push({ x: box.x, y: box.y, right: box.x + box.width, bottom: box.y + box.height });
      continue;
    }
    line.x = Math.min(line.x, box.x);
    line.y = Math.min(line.y, box.y);
    line.right = Math.max(line.right, box.x + box.width);
    line.bottom = Math.max(line.bottom, box.y + box.height);
  }
  return lines.map((line) => ({
    x: line.x,
    y: line.y,
    width: line.right - line.x,
    height: line.bottom - line.y,
  }));
}

/**
 * The boxes of the text a range covers inside `layer`. A range's own boxes also include every
 * element it wholly contains, such as the canvas of the next page, so only text is measured.
 */
export function textBoxesInRange(range: Range, layer: Element): ReadonlyArray<DOMRect> {
  const boxes: DOMRect[] = [];
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (!range.intersectsNode(node)) continue;
    const part = document.createRange();
    part.selectNodeContents(node);
    if (node === range.startContainer) part.setStart(node, range.startOffset);
    if (node === range.endContainer) part.setEnd(node, range.endOffset);
    boxes.push(...part.getClientRects());
  }
  return boxes;
}

/** The part of a box that lies on the page, or null when none of it does. */
export function clipViewBox(box: ViewBox, page: ViewSize): ViewBox | null {
  const x = Math.max(0, box.x);
  const y = Math.max(0, box.y);
  const width = Math.min(page.width, box.x + box.width) - x;
  const height = Math.min(page.height, box.y + box.height) - y;
  return width > 0.5 && height > 0.5 ? { x, y, width, height } : null;
}

/** The box moved by a drag, kept whole on the page. */
export function moveViewBox(box: ViewBox, dx: number, dy: number, page: ViewSize): ViewBox {
  return {
    ...box,
    x: Math.min(Math.max(0, box.x + dx), Math.max(0, page.width - box.width)),
    y: Math.min(Math.max(0, box.y + dy), Math.max(0, page.height - box.height)),
  };
}

/**
 * The box resized by dragging its lower right corner sideways. Its proportions are kept, and it
 * stays on the page and no narrower than `minWidth`.
 */
export function resizeViewBox(box: ViewBox, dx: number, page: ViewSize, minWidth: number): ViewBox {
  const proportion = box.height / box.width;
  const widest = Math.min(page.width - box.x, (page.height - box.y) / proportion);
  const width = Math.max(Math.min(minWidth, widest), Math.min(widest, box.width + dx));
  return { ...box, width, height: width * proportion };
}

const SIGNATURE_WIDTH_POINTS = 170;

/**
 * Where a new signature goes: centred on the click, sized for its image with room under it for
 * the name and date, and kept on the page.
 */
export function signatureBoxAt(
  point: { readonly x: number; readonly y: number },
  image: ViewSize,
  scale: number,
  page: ViewSize,
): ViewBox {
  const width = Math.min(SIGNATURE_WIDTH_POINTS * scale, page.width);
  const proportion = Math.min(0.6, Math.max(0.2, image.height / Math.max(1, image.width)));
  const imageHeight = width * proportion;
  // The caption's height depends on the block's, so it is settled from a first estimate.
  const caption = pdfSignatureLayout(width / scale, (imageHeight / scale) * 1.5).captionHeight;
  const height = Math.min(imageHeight + caption * scale, page.height);
  return moveViewBox(
    { x: point.x - width / 2, y: point.y - height / 2, width, height },
    0,
    0,
    page,
  );
}
