import { expect, it } from "vite-plus/test";

import { signatureDataUrl, uploadedSignatureImage } from "./signatureImage";

/** A 40 by 20 JPEG that says, as a phone's portrait photo does, that it is shown turned a quarter. */
async function turnedJpeg(): Promise<File> {
  const canvas = document.createElement("canvas");
  canvas.width = 40;
  canvas.height = 20;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#fff";
  context.fillRect(0, 0, 40, 20);
  context.fillStyle = "#000";
  context.fillRect(0, 0, 20, 20);
  const blob = await new Promise<Blob>((resolve) =>
    canvas.toBlob((made) => resolve(made!), "image/jpeg", 0.9),
  );
  const jpeg = new Uint8Array(await blob.arrayBuffer());
  // An EXIF segment holding one tag: Orientation (0x0112) = 6.
  const exif = Uint8Array.of(
    0xff,
    0xe1,
    0x00,
    0x22,
    0x45,
    0x78,
    0x69,
    0x66,
    0x00,
    0x00,
    0x49,
    0x49,
    0x2a,
    0x00,
    0x08,
    0x00,
    0x00,
    0x00,
    0x01,
    0x00,
    0x12,
    0x01,
    0x03,
    0x00,
    0x01,
    0x00,
    0x00,
    0x00,
    0x06,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
  );
  return new File([jpeg.slice(0, 2), exif, jpeg.slice(2)], "signature.jpg", {
    type: "image/jpeg",
  });
}

const sizeOf = (src: string) =>
  new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () =>
      resolve({ width: image.naturalWidth, height: image.naturalHeight }),
    );
    image.addEventListener("error", () => reject(new Error("The image did not load.")));
    image.src = src;
  });

it("sends an uploaded photo the way up it is shown, not as its EXIF data turns it", async () => {
  const file = await turnedJpeg();
  // The browser shows the photo turned, which is what the user places on the page.
  const shown = URL.createObjectURL(file);
  expect(await sizeOf(shown)).toEqual({ width: 20, height: 40 });
  URL.revokeObjectURL(shown);

  const image = await uploadedSignatureImage(file);
  if (typeof image === "string") throw new Error(image);
  expect(image).toMatchObject({ mediaType: "image/jpeg", width: 20, height: 40 });
  // A PDF draws the stored pixels and ignores EXIF, so the sent file holds none and is upright.
  expect(atob(image.dataBase64)).not.toContain("Exif");
  expect(await sizeOf(signatureDataUrl(image))).toEqual({ width: 20, height: 40 });
});
