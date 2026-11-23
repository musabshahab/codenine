import { describe, expect, it } from "vite-plus/test";

import {
  clipViewBox,
  mergeLineBoxes,
  moveViewBox,
  resizeViewBox,
  signatureBoxAt,
} from "./pdfPlacement";

const page = { width: 600, height: 800 };

describe("pdfPlacement", () => {
  it("joins the boxes of a text selection into one per line", () => {
    expect(
      mergeLineBoxes([
        { x: 100, y: 50, width: 40, height: 12 },
        { x: 140, y: 51, width: 60, height: 11 },
        { x: 100, y: 50, width: 40, height: 12 },
        { x: 40, y: 66, width: 90, height: 12 },
        // The same line of a second column, far to the right.
        { x: 400, y: 50, width: 80, height: 12 },
        { x: 10, y: 10, width: 0, height: 12 },
      ]),
    ).toEqual([
      { x: 100, y: 50, width: 100, height: 12 },
      { x: 400, y: 50, width: 80, height: 12 },
      { x: 40, y: 66, width: 90, height: 12 },
    ]);
  });

  it("keeps boxes on the page when clipped, moved and resized", () => {
    expect(clipViewBox({ x: -20, y: 790, width: 60, height: 30 }, page)).toEqual({
      x: 0,
      y: 790,
      width: 40,
      height: 10,
    });
    expect(clipViewBox({ x: 700, y: 10, width: 60, height: 30 }, page)).toBeNull();

    const box = { x: 100, y: 100, width: 200, height: 80 };
    expect(moveViewBox(box, 30, -20, page)).toEqual({ ...box, x: 130, y: 80 });
    expect(moveViewBox(box, 900, 900, page)).toEqual({ ...box, x: 400, y: 720 });
    expect(moveViewBox(box, -900, -900, page)).toEqual({ ...box, x: 0, y: 0 });

    expect(resizeViewBox(box, 100, page, 60)).toEqual({ ...box, width: 300, height: 120 });
    // No wider than the page allows, and no narrower than the least.
    expect(resizeViewBox(box, 5000, page, 60)).toEqual({ ...box, width: 500, height: 200 });
    expect(resizeViewBox(box, -5000, page, 60)).toEqual({ ...box, width: 60, height: 24 });
    expect(resizeViewBox({ ...box, y: 760 }, 5000, page, 60).height).toBeCloseTo(40);
  });

  it("places a new signature on the click and inside the page", () => {
    const placed = signatureBoxAt({ x: 300, y: 400 }, { width: 400, height: 120 }, 1, page);
    expect(placed.width).toBe(170);
    expect(placed.x + placed.width / 2).toBeCloseTo(300);
    expect(placed.y + placed.height / 2).toBeCloseTo(400);
    expect(placed.height).toBeGreaterThan(170 * 0.3);

    const corner = signatureBoxAt({ x: 590, y: 795 }, { width: 400, height: 120 }, 2, page);
    expect(corner.width).toBe(340);
    expect(corner.x + corner.width).toBeCloseTo(600);
    expect(corner.y + corner.height).toBeCloseTo(800);
  });
});
