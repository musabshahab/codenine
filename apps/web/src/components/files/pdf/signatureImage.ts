import { PDF_SIGNATURE_IMAGE_MAX_BYTES, PDF_SIGNATURE_IMAGE_MAX_PIXELS } from "@codenine/contracts";
import * as Schema from "effect/Schema";

export const SignatureImage = Schema.Struct({
  mediaType: Schema.Literals(["image/png", "image/jpeg"]),
  dataBase64: Schema.String,
  // The image's own size in pixels, which sets the proportions it is placed with.
  width: Schema.Number,
  height: Schema.Number,
});
export type SignatureImage = typeof SignatureImage.Type;

/** A signature kept in this browser's storage for the next document. It is never sent on its own. */
export const SavedSignature = Schema.NullOr(
  Schema.Struct({ name: Schema.String, image: SignatureImage }),
);
export type SavedSignature = typeof SavedSignature.Type;

export const SAVED_SIGNATURE_STORAGE_KEY = "codenine.pdfSignature";

/** Why an uploaded file cannot be a signature, or null when it can. */
export function signatureUploadProblem(file: {
  readonly type: string;
  readonly size: number;
}): string | null {
  if (file.type !== "image/png" && file.type !== "image/jpeg") {
    return "Use a PNG or JPEG image.";
  }
  if (file.size > PDF_SIGNATURE_IMAGE_MAX_BYTES) {
    return `That image is too large. Use one under ${Math.round(PDF_SIGNATURE_IMAGE_MAX_BYTES / 1024)} KB.`;
  }
  if (file.size === 0) return "That image is empty.";
  return null;
}

/** The bytes a base64 string decodes to. */
export const base64ByteLength = (dataBase64: string): number =>
  Math.floor((dataBase64.length * 3) / 4) - (dataBase64.match(/=+$/)?.[0].length ?? 0);

/** A `data:` URL as the image a signature is sent with, or null for any other kind of URL. */
export function signatureImageOfDataUrl(
  dataUrl: string,
  size: { readonly width: number; readonly height: number },
): SignatureImage | null {
  const match = /^data:(image\/png|image\/jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (match === null || size.width < 1 || size.height < 1) return null;
  if (size.width * size.height > PDF_SIGNATURE_IMAGE_MAX_PIXELS) return null;
  if (base64ByteLength(match[2]!) > PDF_SIGNATURE_IMAGE_MAX_BYTES) return null;
  return {
    mediaType: match[1] as SignatureImage["mediaType"],
    dataBase64: match[2]!,
    width: size.width,
    height: size.height,
  };
}

export const signatureDataUrl = (image: Pick<SignatureImage, "mediaType" | "dataBase64">) =>
  `data:${image.mediaType};base64,${image.dataBase64}`;

/**
 * True for a name or date the PDF's built-in font may not print, which is then sent as a
 * picture as well. Basic Latin and Western European letters are printed as text.
 */
export const needsCaptionImage = (text: string): boolean => /[^\x20-\x7E\xA1-\xFF]/.test(text);

export interface SignatureStroke {
  readonly points: ReadonlyArray<{ readonly x: number; readonly y: number }>;
}

/** The box the strokes cover with a margin, so a small signature is not sent as a wide blank. */
export function strokeBounds(
  strokes: ReadonlyArray<SignatureStroke>,
  canvas: { readonly width: number; readonly height: number },
  margin: number,
): {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
} | null {
  const points = strokes.flatMap((stroke) => stroke.points);
  if (points.length === 0) return null;
  const left = Math.max(0, Math.min(...points.map((point) => point.x)) - margin);
  const top = Math.max(0, Math.min(...points.map((point) => point.y)) - margin);
  const right = Math.min(canvas.width, Math.max(...points.map((point) => point.x)) + margin);
  const bottom = Math.min(canvas.height, Math.max(...points.map((point) => point.y)) + margin);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

const INK = "#14213d";

const pngOf = (canvas: HTMLCanvasElement): SignatureImage | null =>
  signatureImageOfDataUrl(canvas.toDataURL("image/png"), canvas);

/** The strokes drawn in ink on a clear background, cropped to what was drawn. */
export function drawnSignatureImage(
  strokes: ReadonlyArray<SignatureStroke>,
  size: { readonly width: number; readonly height: number },
): SignatureImage | null {
  const bounds = strokeBounds(strokes, size, 8);
  if (bounds === null) return null;
  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(bounds.width * scale));
  canvas.height = Math.max(1, Math.ceil(bounds.height * scale));
  const context = canvas.getContext("2d");
  if (context === null) return null;
  context.scale(scale, scale);
  context.translate(-bounds.x, -bounds.y);
  paintStrokes(context, strokes);
  return pngOf(canvas);
}

export function paintStrokes(
  context: CanvasRenderingContext2D,
  strokes: ReadonlyArray<SignatureStroke>,
): void {
  context.strokeStyle = INK;
  context.fillStyle = INK;
  context.lineWidth = 2.2;
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const { points } of strokes) {
    const first = points[0];
    if (first === undefined) continue;
    if (points.length === 1) {
      context.beginPath();
      context.arc(first.x, first.y, 1.2, 0, Math.PI * 2);
      context.fill();
      continue;
    }
    context.beginPath();
    context.moveTo(first.x, first.y);
    for (const point of points.slice(1)) context.lineTo(point.x, point.y);
    context.stroke();
  }
}

function textImage(
  lines: ReadonlyArray<string>,
  font: string,
  size: number,
): SignatureImage | null {
  const canvas = document.createElement("canvas");
  const measure = canvas.getContext("2d");
  if (measure === null) return null;
  measure.font = `${size}px ${font}`;
  const lineHeight = size * 1.25;
  const pad = Math.ceil(size * 0.3);
  const width = Math.max(...lines.map((line) => measure.measureText(line).width));
  canvas.width = Math.max(1, Math.ceil(width) + pad * 2);
  canvas.height = Math.ceil(lineHeight * lines.length) + (lines.length === 1 ? pad * 2 : 0);
  const context = canvas.getContext("2d");
  if (context === null) return null;
  context.font = `${size}px ${font}`;
  context.fillStyle = INK;
  context.textBaseline = "alphabetic";
  lines.forEach((line, index) => {
    const top = lines.length === 1 ? pad : 0;
    context.fillText(
      line,
      lines.length === 1 ? pad : 0,
      top + lineHeight * (index + 1) - size * 0.3,
    );
  });
  return pngOf(canvas);
}

export const SIGNATURE_FONT_FAMILY = '"Satisfy", cursive';

/** The name written in the bundled handwriting font. The font is loaded before it is drawn. */
export async function typedSignatureImage(name: string): Promise<SignatureImage | null> {
  if (name.trim() === "") return null;
  await document.fonts.load(`64px ${SIGNATURE_FONT_FAMILY}`, name);
  return textImage([name.trim()], SIGNATURE_FONT_FAMILY, 64);
}

/** The name and date as the picture sent for text the PDF's built-in font cannot print. */
export function captionImageBase64(name: string, date: string): string | undefined {
  return textImage([name, date], "system-ui, sans-serif", 40)?.dataBase64;
}

/**
 * A photo as a JPEG whose pixels are the way up it is shown. A camera stores the turn in the
 * file's EXIF data, which a browser applies and a PDF does not, so the turn is drawn in.
 */
function uprightJpeg(image: HTMLImageElement): SignatureImage | null {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (context === null) return null;
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0);
  for (const quality of [0.92, 0.8, 0.6]) {
    const encoded = signatureImageOfDataUrl(canvas.toDataURL("image/jpeg", quality), canvas);
    if (encoded !== null) return encoded;
  }
  return null;
}

/** Reads an uploaded image, with its size, as a signature. */
export async function uploadedSignatureImage(file: File): Promise<SignatureImage | string> {
  const problem = signatureUploadProblem(file);
  if (problem !== null) return problem;
  const dataUrl = await new Promise<string | null>((resolve) => {
    const reader = new FileReader();
    reader.addEventListener("load", () =>
      resolve(typeof reader.result === "string" ? reader.result : null),
    );
    reader.addEventListener("error", () => resolve(null));
    reader.readAsDataURL(file);
  });
  const unreadable = "That image could not be read.";
  if (dataUrl === null) return unreadable;
  const loaded = await new Promise<HTMLImageElement | null>((resolve) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image));
    image.addEventListener("error", () => resolve(null));
    image.src = dataUrl;
  });
  if (loaded === null) return unreadable;
  const size = { width: loaded.naturalWidth, height: loaded.naturalHeight };
  if (size.width * size.height > PDF_SIGNATURE_IMAGE_MAX_PIXELS) {
    return "That image has too many pixels. Use a smaller one.";
  }
  if (file.type === "image/jpeg") {
    return uprightJpeg(loaded) ?? "That image is too large. Use a smaller one.";
  }
  return signatureImageOfDataUrl(dataUrl, size) ?? unreadable;
}
