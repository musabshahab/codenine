import * as Schema from "effect/Schema";

// A small ustar writer and streaming reader. Paths that do not fit ustar's ASCII name field, and
// sizes past its 8 GiB limit, go in a pax extended header, which every current tar reads.

const BLOCK_BYTES = 512;
const MAX_USTAR_SIZE = 8 ** 11 - 1;
// Bounds the memory a crafted pax or GNU long-name header can claim.
const MAX_META_BYTES = 1024 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type TarEntryType = "file" | "directory" | "symlink";

export interface TarEntry {
  /** POSIX path relative to the archive root, without a trailing slash. */
  readonly path: string;
  readonly type: TarEntryType;
  readonly size: number;
  readonly mode: number;
  readonly mtimeMs: number;
  readonly linkTarget?: string | undefined;
}

export class TarFormatError extends Schema.TaggedError<TarFormatError>()("TarFormatError", {
  problem: Schema.Literals(["checksum", "number", "header", "truncated"]),
}) {
  override get message(): string {
    return `The archive is damaged (${this.problem}).`;
  }
}

export const TAR_END_BLOCKS = new Uint8Array(BLOCK_BYTES * 2);

export const tarPadding = (size: number): Uint8Array =>
  new Uint8Array((BLOCK_BYTES - (size % BLOCK_BYTES)) % BLOCK_BYTES);

const isPlainAscii = (value: string) => /^[\x20-\x7e]*$/.test(value);

const writeText = (block: Uint8Array, offset: number, length: number, value: string) => {
  block.set(encoder.encode(value).subarray(0, length), offset);
};

const writeOctal = (block: Uint8Array, offset: number, length: number, value: number) => {
  const digits = Math.max(0, Math.floor(value))
    .toString(8)
    .padStart(length - 1, "0");
  writeText(block, offset, length - 1, digits);
  block[offset + length - 1] = 0;
};

const paxRecord = (key: string, value: string): Uint8Array => {
  const body = ` ${key}=${value}\n`;
  const bodyLength = encoder.encode(body).length;
  // The record length counts its own digits.
  let length = bodyLength + 1;
  while (String(length).length + bodyLength !== length) length = String(length).length + bodyLength;
  return encoder.encode(`${length}${body}`);
};

const concat = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const ustarBlock = (input: {
  readonly name: string;
  readonly mode: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly typeflag: string;
  readonly linkName: string;
}): Uint8Array => {
  const block = new Uint8Array(BLOCK_BYTES);
  writeText(block, 0, 100, input.name);
  writeOctal(block, 100, 8, input.mode & 0o7777);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, input.size);
  writeOctal(block, 136, 12, input.mtimeMs / 1000);
  block.fill(0x20, 148, 156);
  writeText(block, 156, 1, input.typeflag);
  writeText(block, 157, 100, input.linkName);
  writeText(block, 257, 6, "ustar");
  writeText(block, 263, 2, "00");
  let sum = 0;
  for (const byte of block) sum += byte;
  writeOctal(block, 148, 7, sum);
  return block;
};

// ustar fields hold ASCII only; a pax reader takes the real value from the extended header.
const asciiFallback = (value: string) => value.replace(/[^\x20-\x7e]/g, "_").slice(0, 100);

/** The header blocks for one entry; file content and its padding follow. */
export const encodeTarHeader = (entry: TarEntry): Uint8Array => {
  const name = entry.type === "directory" ? `${entry.path}/` : entry.path;
  const linkName = entry.linkTarget ?? "";
  const size = entry.type === "file" ? entry.size : 0;
  const records: Array<Uint8Array> = [];
  if (!isPlainAscii(name) || name.length > 100) records.push(paxRecord("path", name));
  if (!isPlainAscii(linkName) || linkName.length > 100) {
    records.push(paxRecord("linkpath", linkName));
  }
  if (size > MAX_USTAR_SIZE) records.push(paxRecord("size", String(size)));
  const header = ustarBlock({
    name: asciiFallback(name),
    mode: entry.mode,
    size: size > MAX_USTAR_SIZE ? 0 : size,
    mtimeMs: entry.mtimeMs,
    typeflag: entry.type === "directory" ? "5" : entry.type === "symlink" ? "2" : "0",
    linkName: asciiFallback(linkName),
  });
  if (records.length === 0) return header;
  const pax = concat(records);
  return concat([
    ustarBlock({
      name: "PaxHeader",
      mode: 0o644,
      size: pax.length,
      mtimeMs: entry.mtimeMs,
      typeflag: "x",
      linkName: "",
    }),
    pax,
    tarPadding(pax.length),
    header,
  ]);
};

export type TarEvent =
  | { readonly _tag: "entry"; readonly entry: TarEntry }
  | { readonly _tag: "data"; readonly bytes: Uint8Array }
  | { readonly _tag: "entryEnd" }
  | { readonly _tag: "end" };

const readText = (block: Uint8Array, offset: number, length: number) => {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return decoder.decode(end === -1 ? field : field.subarray(0, end));
};

const readNumber = (block: Uint8Array, offset: number, length: number): number => {
  const field = block.subarray(offset, offset + length);
  // GNU base-256: the high bit of the first byte marks a big-endian binary number.
  if ((field[0] ?? 0) & 0x80) {
    let value = (field[0] ?? 0) & 0x7f;
    for (const byte of field.subarray(1)) value = value * 256 + byte;
    return value;
  }
  const text = readText(block, offset, length).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new TarFormatError({ problem: "number" });
  return Number.parseInt(text, 8);
};

const parsePaxRecords = (bytes: Uint8Array): Map<string, string> => {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < bytes.length && bytes[offset] !== 0) {
    const space = bytes.indexOf(0x20, offset);
    const length = space === -1 ? NaN : Number(decoder.decode(bytes.subarray(offset, space)));
    if (!Number.isInteger(length) || length <= 0 || offset + length > bytes.length) {
      throw new TarFormatError({ problem: "header" });
    }
    const record = decoder.decode(bytes.subarray(space + 1, offset + length - 1));
    const equals = record.indexOf("=");
    if (equals > 0) records.set(record.slice(0, equals), record.slice(equals + 1));
    offset += length;
  }
  return records;
};

type MetaKind = "pax" | "longName" | "longLink" | "ignore";

const META_KINDS: Readonly<Record<string, MetaKind>> = {
  x: "pax",
  g: "ignore",
  L: "longName",
  K: "longLink",
};

/** Reads a tar stream pushed in arbitrary chunks; data events borrow from the pushed chunks. */
export class TarParser {
  #state: "header" | "meta" | "data" | "skip" | "end" = "header";
  readonly #header = new Uint8Array(BLOCK_BYTES);
  #headerFill = 0;
  #zeroBlocks = 0;
  #remaining = 0;
  #padding = 0;
  #meta: { readonly kind: MetaKind; readonly bytes: Uint8Array } | null = null;
  #metaFill = 0;
  #pax = new Map<string, string>();
  #longName: string | undefined;
  #longLink: string | undefined;

  push(chunk: Uint8Array): ReadonlyArray<TarEvent> {
    const events: Array<TarEvent> = [];
    let offset = 0;
    while (offset < chunk.length && this.#state !== "end") {
      const available = chunk.length - offset;
      if (this.#state === "header") {
        const take = Math.min(BLOCK_BYTES - this.#headerFill, available);
        this.#header.set(chunk.subarray(offset, offset + take), this.#headerFill);
        this.#headerFill += take;
        offset += take;
        if (this.#headerFill === BLOCK_BYTES) {
          this.#headerFill = 0;
          this.#readHeader(events);
        }
      } else if (this.#state === "meta") {
        const meta = this.#meta!;
        const take = Math.min(meta.bytes.length - this.#metaFill, available);
        meta.bytes.set(chunk.subarray(offset, offset + take), this.#metaFill);
        this.#metaFill += take;
        offset += take;
        if (this.#metaFill === meta.bytes.length) this.#finishMeta();
      } else if (this.#state === "data") {
        const take = Math.min(this.#remaining, available);
        events.push({ _tag: "data", bytes: chunk.subarray(offset, offset + take) });
        this.#remaining -= take;
        offset += take;
        if (this.#remaining === 0) {
          events.push({ _tag: "entryEnd" });
          this.#skip(this.#padding);
        }
      } else {
        const take = Math.min(this.#remaining, available);
        this.#remaining -= take;
        offset += take;
        if (this.#remaining === 0) this.#state = "header";
      }
    }
    return events;
  }

  /** Throws unless the end-of-archive marker was read. */
  finish(): void {
    if (this.#state !== "end") throw new TarFormatError({ problem: "truncated" });
  }

  #skip(bytes: number) {
    this.#remaining = bytes;
    this.#state = bytes > 0 ? "skip" : "header";
  }

  #readHeader(events: Array<TarEvent>) {
    const block = this.#header;
    if (block.every((byte) => byte === 0)) {
      this.#zeroBlocks += 1;
      if (this.#zeroBlocks === 2) {
        this.#state = "end";
        events.push({ _tag: "end" });
      }
      return;
    }
    this.#zeroBlocks = 0;
    let sum = 0;
    for (let index = 0; index < BLOCK_BYTES; index++) {
      sum += index >= 148 && index < 156 ? 0x20 : (block[index] ?? 0);
    }
    if (sum !== readNumber(block, 148, 8)) throw new TarFormatError({ problem: "checksum" });

    const typeflag = String.fromCharCode(block[156] ?? 0);
    let size = readNumber(block, 124, 12);
    const metaKind = META_KINDS[typeflag];
    if (metaKind !== undefined) {
      if (size > MAX_META_BYTES) throw new TarFormatError({ problem: "header" });
      this.#meta = { kind: metaKind, bytes: new Uint8Array(size) };
      this.#metaFill = 0;
      this.#padding = (BLOCK_BYTES - (size % BLOCK_BYTES)) % BLOCK_BYTES;
      if (size === 0) this.#finishMeta();
      else this.#state = "meta";
      return;
    }

    const pax = this.#pax;
    const longName = this.#longName;
    const longLink = this.#longLink;
    this.#pax = new Map();
    this.#longName = undefined;
    this.#longLink = undefined;
    const prefix = block[257] === 0x75 ? readText(block, 345, 155) : "";
    const ustarName = readText(block, 0, 100);
    const path = pax.get("path") ?? longName ?? (prefix ? `${prefix}/${ustarName}` : ustarName);
    const paxSize = pax.get("size");
    if (paxSize !== undefined) {
      size = Number(paxSize);
      if (!Number.isSafeInteger(size) || size < 0) throw new TarFormatError({ problem: "number" });
    }
    const padding = (BLOCK_BYTES - (size % BLOCK_BYTES)) % BLOCK_BYTES;
    const type: TarEntryType | null =
      typeflag === "0" || typeflag === "\0" || typeflag === "7"
        ? "file"
        : typeflag === "5"
          ? "directory"
          : typeflag === "2"
            ? "symlink"
            : null;
    if (type === null) {
      // Hard links, devices and FIFOs are never written; skip whatever content they carry.
      this.#skip(size + padding);
      return;
    }
    events.push({
      _tag: "entry",
      entry: {
        path: path.replace(/\/+$/, ""),
        type,
        size: type === "file" ? size : 0,
        mode: readNumber(block, 100, 8),
        mtimeMs: readNumber(block, 136, 12) * 1000,
        ...(type === "symlink"
          ? { linkTarget: pax.get("linkpath") ?? longLink ?? readText(block, 157, 100) }
          : {}),
      },
    });
    if (type === "file" && size > 0) {
      this.#remaining = size;
      this.#padding = padding;
      this.#state = "data";
      return;
    }
    events.push({ _tag: "entryEnd" });
    this.#skip(type === "file" ? 0 : size + padding);
  }

  #finishMeta() {
    const meta = this.#meta!;
    this.#meta = null;
    const end = meta.bytes.indexOf(0);
    const text = decoder.decode(end === -1 ? meta.bytes : meta.bytes.subarray(0, end));
    if (meta.kind === "pax") {
      for (const [key, value] of parsePaxRecords(meta.bytes)) this.#pax.set(key, value);
    } else if (meta.kind === "longName") {
      this.#longName = text;
    } else if (meta.kind === "longLink") {
      this.#longLink = text;
    }
    this.#skip(this.#padding);
  }
}
