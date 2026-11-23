import * as Schema from "effect/Schema";

/** The document is larger than the viewer reads into memory. */
export class DocumentTooLargeError extends Schema.TaggedError<DocumentTooLargeError>()(
  "DocumentTooLargeError",
  {},
) {
  override get message(): string {
    return "This file is too large to preview.";
  }
}

export async function readBoundedDocument(
  src: string,
  signal: AbortSignal,
  limit: number,
  cache: RequestCache = "default",
) {
  const response = await fetch(src, { signal, cache });
  if (!response.ok) throw new Error("This file is unavailable.");
  if (Number(response.headers.get("content-length")) > limit) throw new DocumentTooLargeError();
  const reader = response.body?.getReader();
  if (!reader) throw new Error("This file is unavailable.");
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new DocumentTooLargeError();
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return new Blob(chunks).arrayBuffer();
}
