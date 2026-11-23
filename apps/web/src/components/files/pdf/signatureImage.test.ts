import { PDF_SIGNATURE_IMAGE_MAX_BYTES } from "@codenine/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  base64ByteLength,
  needsCaptionImage,
  signatureImageOfDataUrl,
  signatureUploadProblem,
  strokeBounds,
} from "./signatureImage";

describe("signatureImage", () => {
  it.each([
    [{ type: "image/png", size: 2048 }, null],
    [{ type: "image/jpeg", size: PDF_SIGNATURE_IMAGE_MAX_BYTES }, null],
    [{ type: "image/jpeg", size: PDF_SIGNATURE_IMAGE_MAX_BYTES + 1 }, "too large"],
    [{ type: "image/svg+xml", size: 100 }, "PNG or JPEG"],
    [{ type: "image/gif", size: 100 }, "PNG or JPEG"],
    [{ type: "", size: 100 }, "PNG or JPEG"],
    [{ type: "image/png", size: 0 }, "empty"],
  ])("limits an uploaded signature %j", (file, problem) => {
    const found = signatureUploadProblem(file);
    if (problem === null) expect(found).toBeNull();
    else expect(found).toContain(problem);
  });

  it("takes only PNG and JPEG data within the size limit as a signature", () => {
    const size = { width: 300, height: 100 };
    expect(signatureImageOfDataUrl("data:image/png;base64,AAAA", size)).toEqual({
      mediaType: "image/png",
      dataBase64: "AAAA",
      ...size,
    });
    expect(signatureImageOfDataUrl("data:image/svg+xml;base64,AAAA", size)).toBeNull();
    expect(
      signatureImageOfDataUrl("data:image/png;base64,AAAA", { width: 0, height: 0 }),
    ).toBeNull();
    expect(signatureImageOfDataUrl("https://example.com/sign.png", size)).toBeNull();
    expect(
      signatureImageOfDataUrl("data:image/png;base64,AAAA", { width: 4000, height: 4000 }),
    ).toBeNull();
    const oversized = "A".repeat(Math.ceil(((PDF_SIGNATURE_IMAGE_MAX_BYTES + 3) * 4) / 3));
    expect(signatureImageOfDataUrl(`data:image/png;base64,${oversized}`, size)).toBeNull();
    expect(base64ByteLength("AAAA")).toBe(3);
    expect(base64ByteLength("AAA=")).toBe(2);
    expect(base64ByteLength("AA==")).toBe(1);
  });

  it("sends a picture of the name only for text the PDF font may not print", () => {
    expect(needsCaptionImage("Zoë O'Neill-Müller")).toBe(false);
    expect(needsCaptionImage("23/11/2026")).toBe(false);
    expect(needsCaptionImage("山田 太郎")).toBe(true);
    expect(needsCaptionImage("2026年11月23日")).toBe(true);
    expect(needsCaptionImage("Łukasz")).toBe(true);
  });

  it("crops a drawn signature to its strokes", () => {
    const canvas = { width: 400, height: 150 };
    expect(strokeBounds([], canvas, 8)).toBeNull();
    expect(
      strokeBounds(
        [
          {
            points: [
              { x: 100, y: 60 },
              { x: 180, y: 90 },
            ],
          },
          { points: [{ x: 396, y: 4 }] },
        ],
        canvas,
        8,
      ),
    ).toEqual({ x: 92, y: 0, width: 308, height: 98 });
  });
});
