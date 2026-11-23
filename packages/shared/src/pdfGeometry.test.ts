import { describe, expect, it } from "vite-plus/test";

import {
  fitPdfImage,
  type PdfPageGeometry,
  pdfPageViewSize,
  pdfSignatureLayout,
  pdfToViewPoint,
  pdfToViewRect,
  viewToPdfPoint,
  viewToPdfRect,
} from "./pdfGeometry.ts";

// A page cropped away from the origin: 300 by 400 points, shown at twice its size.
const page = (rotation: number): PdfPageGeometry => ({
  box: [50, 100, 350, 500],
  rotation,
  scale: 2,
});

describe("pdfGeometry", () => {
  it.each([
    // rotation, shown size, where the stored lower left corner and the point (80, 460) appear
    [0, { width: 600, height: 800 }, { x: 0, y: 800 }, { x: 60, y: 80 }],
    [90, { width: 800, height: 600 }, { x: 0, y: 0 }, { x: 720, y: 60 }],
    [180, { width: 600, height: 800 }, { x: 600, y: 0 }, { x: 540, y: 720 }],
    [270, { width: 800, height: 600 }, { x: 800, y: 600 }, { x: 80, y: 540 }],
    [-90, { width: 800, height: 600 }, { x: 800, y: 600 }, { x: 80, y: 540 }],
    [450, { width: 800, height: 600 }, { x: 0, y: 0 }, { x: 720, y: 60 }],
  ])("maps a cropped page turned %i degrees to the view and back", (rotation, size, corner, at) => {
    const geometry = page(rotation);
    expect(pdfPageViewSize(geometry)).toEqual(size);
    expect(pdfToViewPoint(geometry, { x: 50, y: 100 })).toEqual(corner);
    expect(pdfToViewPoint(geometry, { x: 80, y: 460 })).toEqual(at);
    expect(viewToPdfPoint(geometry, at)).toEqual({ x: 80, y: 460 });
  });

  it.each([
    [0, { x: 60, y: 40, width: 200, height: 40 }],
    [90, { x: 720, y: 60, width: 40, height: 200 }],
    [180, { x: 340, y: 720, width: 200, height: 40 }],
    [270, { x: 40, y: 340, width: 40, height: 200 }],
  ])("maps rectangles on a page turned %i degrees both ways", (rotation, shown) => {
    const geometry = page(rotation);
    const stored = { x: 80, y: 460, width: 100, height: 20 };
    expect(pdfToViewRect(geometry, stored)).toEqual(shown);
    expect(viewToPdfRect(geometry, shown)).toEqual(stored);
  });

  it("divides a signature block and fits its image", () => {
    const layout = pdfSignatureLayout(160, 70);
    expect(layout.captionHeight + layout.imageHeight).toBeCloseTo(70);
    expect(layout.captionHeight).toBeCloseTo(layout.lineHeight * 2);
    expect(layout.fontSize).toBeCloseTo(9.8);
    // A small block keeps its text inside it.
    expect(pdfSignatureLayout(40, 20).fontSize).toBe(3);
    expect(fitPdfImage({ width: 160, height: 45 }, { width: 400, height: 100 })).toEqual({
      width: 160,
      height: 40,
    });
    expect(fitPdfImage({ width: 160, height: 45 }, { width: 100, height: 100 })).toEqual({
      width: 45,
      height: 45,
    });
  });
});
