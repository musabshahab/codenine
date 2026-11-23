/**
 * Where a PDF page's own coordinates land on the page as it is shown. A PDF stores positions in
 * points from the lower left, before the page's rotation and without regard to its crop box; a
 * viewer shows the cropped, rotated page with the origin at its upper left and y running down.
 */
export interface PdfPageGeometry {
  /** The visible box as the file stores it: `[left, bottom, right, top]`. */
  readonly box: readonly [number, number, number, number];
  /** Clockwise quarter turns applied for display: 0, 90, 180 or 270. */
  readonly rotation: number;
  /** Shown units per PDF point. */
  readonly scale: number;
}

export interface PdfBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PdfXY {
  readonly x: number;
  readonly y: number;
}

/** Any rotation as one of 0, 90, 180 or 270. */
export function normalizePdfRotation(rotation: number): 0 | 90 | 180 | 270 {
  const turns = (((Math.round(rotation / 90) % 4) + 4) % 4) as 0 | 1 | 2 | 3;
  return (turns * 90) as 0 | 90 | 180 | 270;
}

export function pdfPageViewSize(geometry: PdfPageGeometry): {
  readonly width: number;
  readonly height: number;
} {
  const [left, bottom, right, top] = geometry.box;
  const width = (right - left) * geometry.scale;
  const height = (top - bottom) * geometry.scale;
  return normalizePdfRotation(geometry.rotation) % 180 === 0
    ? { width, height }
    : { width: height, height: width };
}

export function pdfToViewPoint(geometry: PdfPageGeometry, point: PdfXY): PdfXY {
  const [left, bottom, right, top] = geometry.box;
  const { scale } = geometry;
  switch (normalizePdfRotation(geometry.rotation)) {
    case 0:
      return { x: (point.x - left) * scale, y: (top - point.y) * scale };
    case 90:
      return { x: (point.y - bottom) * scale, y: (point.x - left) * scale };
    case 180:
      return { x: (right - point.x) * scale, y: (point.y - bottom) * scale };
    case 270:
      return { x: (top - point.y) * scale, y: (right - point.x) * scale };
  }
}

export function viewToPdfPoint(geometry: PdfPageGeometry, point: PdfXY): PdfXY {
  const [left, bottom, right, top] = geometry.box;
  const x = point.x / geometry.scale;
  const y = point.y / geometry.scale;
  switch (normalizePdfRotation(geometry.rotation)) {
    case 0:
      return { x: left + x, y: top - y };
    case 90:
      return { x: left + y, y: bottom + x };
    case 180:
      return { x: right - x, y: bottom + y };
    case 270:
      return { x: right - y, y: top - x };
  }
}

const boxOfCorners = (first: PdfXY, second: PdfXY): PdfBox => ({
  x: Math.min(first.x, second.x),
  y: Math.min(first.y, second.y),
  width: Math.abs(first.x - second.x),
  height: Math.abs(first.y - second.y),
});

/** A stored rectangle as the box it covers on the shown page, with `x` and `y` its upper left. */
export function pdfToViewRect(geometry: PdfPageGeometry, rect: PdfBox): PdfBox {
  return boxOfCorners(
    pdfToViewPoint(geometry, rect),
    pdfToViewPoint(geometry, { x: rect.x + rect.width, y: rect.y + rect.height }),
  );
}

/** A box on the shown page as the rectangle to store, with `x` and `y` its lower left. */
export function viewToPdfRect(geometry: PdfPageGeometry, rect: PdfBox): PdfBox {
  return boxOfCorners(
    viewToPdfPoint(geometry, rect),
    viewToPdfPoint(geometry, { x: rect.x + rect.width, y: rect.y + rect.height }),
  );
}

/**
 * How a signature block of the given shown size is divided: the image above, and the signer's
 * name and the date on two lines under it. The server prints it and the client previews it.
 */
export function pdfSignatureLayout(
  width: number,
  height: number,
): {
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly captionHeight: number;
  readonly imageHeight: number;
} {
  const fontSize = Math.max(3, Math.min(10, height * 0.14, width * 0.09));
  const lineHeight = fontSize * 1.25;
  const captionHeight = lineHeight * 2;
  return { fontSize, lineHeight, captionHeight, imageHeight: Math.max(0, height - captionHeight) };
}

/** The largest box of the given proportions inside a space, placed at its left and bottom. */
export function fitPdfImage(
  space: { readonly width: number; readonly height: number },
  image: { readonly width: number; readonly height: number },
): { readonly width: number; readonly height: number } {
  if (image.width <= 0 || image.height <= 0) return { width: 0, height: 0 };
  const scale = Math.min(space.width / image.width, space.height / image.height);
  return { width: image.width * scale, height: image.height * scale };
}
