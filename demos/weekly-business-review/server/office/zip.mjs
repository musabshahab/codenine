import * as NodeZlib from "node:zlib";

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_END_LOCATOR = 0x07064b50;
const UTF8_FLAG = 0x0800;
// 2026-11-23 00:00:00 in MS-DOS date/time format, so archives are reproducible.
const DOS_DATE = ((2026 - 1980) << 9) | (11 << 5) | 23;
const DOS_TIME = 0;

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

function invalid() {
  return new Error("Not a valid zip file");
}

function findEndOfCentralDirectory(view) {
  // The record is 22 bytes plus a comment of up to 65535 bytes, so it sits near the end.
  const stop = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let offset = view.byteLength - 22; offset >= stop; offset--) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw invalid();
}

export function readZip(input) {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  if (!(bytes instanceof Uint8Array) || bytes.length < 22) throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findEndOfCentralDirectory(view);
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  const isZip64 =
    count === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff ||
    (end >= 20 && view.getUint32(end - 20, true) === ZIP64_END_LOCATOR);
  if (isZip64) throw new Error("ZIP64 archives are not supported");
  if (directoryOffset + directorySize > end) throw invalid();

  const entries = new Map();
  let offset = directoryOffset;
  try {
    for (let i = 0; i < count; i++) {
      if (view.getUint32(offset, true) !== CENTRAL_HEADER) throw invalid();
      const flags = view.getUint16(offset + 8, true);
      const method = view.getUint16(offset + 10, true);
      const crc = view.getUint32(offset + 16, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const size = view.getUint32(offset + 24, true);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const localOffset = view.getUint32(offset + 42, true);
      const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
      offset += 46 + nameLength + extraLength + commentLength;

      if (name.endsWith("/")) continue;
      if (flags & 1) throw new Error(`Encrypted zip entry is not supported: ${name}`);
      // Sizes come from the central directory, so entries with data descriptors need no special case.
      if (view.getUint32(localOffset, true) !== LOCAL_HEADER) throw invalid();
      const start =
        localOffset +
        30 +
        view.getUint16(localOffset + 26, true) +
        view.getUint16(localOffset + 28, true);
      if (start + compressedSize > bytes.length) throw invalid();
      const raw = bytes.subarray(start, start + compressedSize);

      let data;
      if (method === 0) data = raw.slice();
      else if (method === 8) data = new Uint8Array(NodeZlib.inflateRawSync(raw));
      else throw new Error(`Unsupported zip compression method ${method}: ${name}`);
      if (data.length !== size || crc32(data) !== crc) {
        throw new Error(`Corrupt zip entry: ${name}`);
      }
      entries.set(name, data);
    }
  } catch (error) {
    if (error instanceof RangeError) throw invalid();
    throw error;
  }
  return entries;
}

export function writeZip(entries) {
  const locals = [];
  const centrals = [];
  const names = new Set();
  let offset = 0;

  for (const entry of entries) {
    if (names.has(entry.name)) throw new Error(`Duplicate zip entry: ${entry.name}`);
    names.add(entry.name);
    const name = encoder.encode(entry.name);
    const data = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
    const deflated = NodeZlib.deflateRawSync(data);
    // Incompressible data (already compressed images, random bytes) is stored as is.
    const method = deflated.length < data.length ? 8 : 0;
    const body = method === 8 ? deflated : data;
    const crc = crc32(data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, LOCAL_HEADER, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, UTF8_FLAG, true);
    local.setUint16(8, method, true);
    local.setUint16(10, DOS_TIME, true);
    local.setUint16(12, DOS_DATE, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    locals.push(new Uint8Array(local.buffer), name, body);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, CENTRAL_HEADER, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, UTF8_FLAG, true);
    central.setUint16(10, method, true);
    central.setUint16(12, DOS_TIME, true);
    central.setUint16(14, DOS_DATE, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, body.length, true);
    central.setUint32(24, data.length, true);
    central.setUint16(28, name.length, true);
    central.setUint32(42, offset, true);
    centrals.push(new Uint8Array(central.buffer), name);

    offset += 30 + name.length + body.length;
  }

  const directorySize = centrals.reduce((sum, part) => sum + part.length, 0);
  if (names.size > 0xfffe || offset + directorySize > 0xfffffffe) {
    throw new Error("Archive too large: ZIP64 is not supported");
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, END_OF_CENTRAL_DIRECTORY, true);
  end.setUint16(8, names.size, true);
  end.setUint16(10, names.size, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, offset, true);

  const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let position = 0;
  for (const part of parts) {
    output.set(part, position);
    position += part.length;
  }
  return output;
}
