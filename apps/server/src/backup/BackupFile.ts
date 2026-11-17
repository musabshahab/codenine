// @effect-diagnostics nodeBuiltinImport:off - effect/crypto has neither scrypt nor a streaming AEAD,
// and backups stream gigabytes through Node streams with backpressure.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeZlib from "node:zlib";

import { BackupError, type BackupFileInfo, BackupKind } from "@codenine/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// The file layout and why each part is there: docs/internals/backup.md.

export const BACKUP_FILE_EXTENSION = ".c9backup";
const BACKUP_FORMAT_VERSION = 1;

const MAGIC = Buffer.from("C9BACKUP", "ascii");
const PREAMBLE_BYTES = MAGIC.length + 4;
const MAX_HEADER_BYTES = 64 * 1024;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const DEFAULT_CHUNK_BYTES = 1024 * 1024;
const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
// Source code and the database's JSON compress well even at a fast level.
const GZIP_LEVEL = 3;

export interface ScryptParams {
  readonly n: number;
  readonly r: number;
  readonly p: number;
}

/** OWASP's scrypt floor: 128 MiB and about half a second on a laptop. */
export const DEFAULT_SCRYPT: ScryptParams = { n: 2 ** 17, r: 8, p: 1 };

// A file states its own cost; refuse costs that would exhaust memory or that are trivially weak.
const scryptMemoryBytes = ({ n, r, p }: ScryptParams) => 128 * n * r * p;
const isAcceptedScrypt = (params: ScryptParams) =>
  Number.isInteger(Math.log2(params.n)) &&
  params.n >= 2 ** 10 &&
  params.r >= 1 &&
  params.r <= 32 &&
  params.p >= 1 &&
  params.p <= 16 &&
  scryptMemoryBytes(params) <= 1024 ** 3;

const BackupFileHeader = Schema.Struct({
  format: Schema.Literal(BACKUP_FORMAT_VERSION),
  createdAt: Schema.String,
  kind: BackupKind,
  computerName: Schema.String,
  /** A hash of the environment id, so pruning can tell this computer's backups apart. */
  computerId: Schema.String,
  codenineVersion: Schema.String,
  schemaVersion: Schema.Int,
  compression: Schema.Literal("gzip"),
  kdf: Schema.Struct({
    name: Schema.Literal("scrypt"),
    n: Schema.Int,
    r: Schema.Int,
    p: Schema.Int,
    salt: Schema.String,
  }),
  cipher: Schema.Struct({
    name: Schema.Literal("aes-256-gcm"),
    chunkBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_CHUNK_BYTES })),
  }),
  /** Tells a wrong password apart from a damaged file before any chunk is read. */
  keyCheck: Schema.String,
});
export type BackupFileHeader = typeof BackupFileHeader.Type;

const decodeHeader = Schema.decodeUnknownOption(Schema.fromJsonString(BackupFileHeader));
// What every format version keeps, so a list can show a backup this version cannot open.
const decodeSummary = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      format: Schema.Number,
      createdAt: Schema.String,
      kind: BackupKind,
      computerName: Schema.String,
      computerId: Schema.optionalKey(Schema.String),
      codenineVersion: Schema.String,
    }),
  ),
);

export type BackupFileIdentity = Pick<
  BackupFileHeader,
  "createdAt" | "kind" | "computerName" | "computerId" | "codenineVersion" | "schemaVersion"
>;

export interface OpenedBackupFile {
  readonly path: string;
  readonly header: BackupFileHeader;
  readonly headerBytes: Buffer;
  readonly payloadOffset: number;
  readonly sizeBytes: number;
}

const unreadable = (detail: string) => new BackupError({ reason: "unreadable", detail });
const isBackupError = Schema.is(BackupError);
const NOT_A_BACKUP = "This file is not a Codenine backup.";
const DAMAGED = "This backup is damaged or incomplete.";
const newerFormat = () =>
  new BackupError({
    reason: "newer-version",
    detail:
      "This backup was made by a newer version of Codenine. Update Codenine, then restore it.",
  });

const errnoCode = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : undefined;

const readHeaderBytes = async (filePath: string) => {
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(filePath, "r");
  } catch (cause) {
    throw errnoCode(cause) === "ENOENT"
      ? unreadable("The backup file no longer exists.")
      : unreadable("The backup file cannot be read.");
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw unreadable(NOT_A_BACKUP);
    const preamble = Buffer.alloc(PREAMBLE_BYTES);
    const { bytesRead } = await handle.read(preamble, 0, PREAMBLE_BYTES, 0);
    if (bytesRead < PREAMBLE_BYTES || !preamble.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw unreadable(NOT_A_BACKUP);
    }
    const headerLength = preamble.readUInt32BE(MAGIC.length);
    if (headerLength === 0 || headerLength > MAX_HEADER_BYTES) throw unreadable(NOT_A_BACKUP);
    const headerBytes = Buffer.alloc(headerLength);
    const read = await handle.read(headerBytes, 0, headerLength, PREAMBLE_BYTES);
    if (read.bytesRead < headerLength) throw unreadable(DAMAGED);
    return { headerBytes, payloadOffset: PREAMBLE_BYTES + headerLength, sizeBytes: info.size };
  } finally {
    await handle.close();
  }
};

/** Reads the plain header; needs no password. */
export async function readBackupHeader(filePath: string): Promise<OpenedBackupFile> {
  const { headerBytes, payloadOffset, sizeBytes } = await readHeaderBytes(filePath);
  const text = headerBytes.toString("utf8");
  const summary = decodeSummary(text);
  if (Option.isSome(summary) && summary.value.format > BACKUP_FORMAT_VERSION) throw newerFormat();
  const header = decodeHeader(text);
  if (Option.isNone(header)) throw unreadable(NOT_A_BACKUP);
  return { path: filePath, header: header.value, headerBytes, payloadOffset, sizeBytes };
}

/** What a list shows about a backup, from any format version, and who made it. */
export async function readBackupSummary(filePath: string): Promise<{
  readonly file: BackupFileInfo;
  readonly computerId: string | null;
}> {
  const { headerBytes, sizeBytes } = await readHeaderBytes(filePath);
  const summary = decodeSummary(headerBytes.toString("utf8"));
  if (Option.isNone(summary)) throw unreadable(NOT_A_BACKUP);
  return {
    file: {
      path: filePath,
      fileName: NodePath.basename(filePath),
      createdAt: summary.value.createdAt,
      computerName: summary.value.computerName,
      codenineVersion: summary.value.codenineVersion,
      kind: summary.value.kind,
      sizeBytes,
    },
    computerId: summary.value.computerId ?? null,
  };
}

const deriveKeys = (password: string, salt: Buffer, params: ScryptParams) =>
  new Promise<{ readonly payloadKey: Buffer; readonly keyCheck: Buffer }>((resolve, reject) => {
    // Normalize so a password typed on another platform derives the same key.
    NodeCrypto.scrypt(
      password.normalize("NFC"),
      salt,
      KEY_BYTES * 2,
      { N: params.n, r: params.r, p: params.p, maxmem: scryptMemoryBytes(params) * 2 },
      (error, derived) => {
        if (error) return reject(error);
        resolve({
          payloadKey: derived.subarray(0, KEY_BYTES),
          keyCheck: NodeCrypto.createHash("sha256")
            .update(derived.subarray(KEY_BYTES))
            .digest()
            .subarray(0, 16),
        });
      },
    );
  });

/** Derives the payload key; fails with "wrong-password" before any payload is read. */
export async function unlockBackup(file: OpenedBackupFile, password: string): Promise<Buffer> {
  const { kdf } = file.header;
  if (!isAcceptedScrypt(kdf)) throw unreadable(NOT_A_BACKUP);
  const keys = await deriveKeys(password, Buffer.from(kdf.salt, "base64"), kdf);
  const expected = Buffer.from(file.header.keyCheck, "base64");
  if (
    expected.length !== keys.keyCheck.length ||
    !NodeCrypto.timingSafeEqual(expected, keys.keyCheck)
  ) {
    throw new BackupError({
      reason: "wrong-password",
      detail: "That password does not open this backup.",
    });
  }
  return keys.payloadKey;
}

const chunkNonce = (index: number, final: boolean) => {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(BigInt(index), 3);
  nonce[11] = final ? 1 : 0;
  return nonce;
};

const headerDigest = (headerBytes: Buffer) =>
  NodeCrypto.createHash("sha256").update(headerBytes).digest();

class ChunkEncryptor extends NodeStream.Transform {
  readonly #key: Buffer;
  readonly #aad: Buffer;
  readonly #chunkBytes: number;
  #prefix: Buffer | null;
  #pending: Array<Buffer> = [];
  #pendingBytes = 0;
  #index = 0;

  constructor(key: Buffer, aad: Buffer, chunkBytes: number, prefix: Buffer) {
    super();
    this.#key = key;
    this.#aad = aad;
    this.#chunkBytes = chunkBytes;
    this.#prefix = prefix;
  }

  #seal(plaintext: Buffer, final: boolean) {
    if (this.#prefix !== null) {
      this.push(this.#prefix);
      this.#prefix = null;
    }
    const cipher = NodeCrypto.createCipheriv(
      "aes-256-gcm",
      this.#key,
      chunkNonce(this.#index, final),
      {
        authTagLength: TAG_BYTES,
      },
    );
    cipher.setAAD(this.#aad);
    this.push(Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]));
    this.#index += 1;
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: NodeStream.TransformCallback,
  ) {
    this.#pending.push(chunk);
    this.#pendingBytes += chunk.length;
    if (this.#pendingBytes >= this.#chunkBytes) {
      let buffered = Buffer.concat(this.#pending);
      while (buffered.length >= this.#chunkBytes) {
        this.#seal(buffered.subarray(0, this.#chunkBytes), false);
        buffered = buffered.subarray(this.#chunkBytes);
      }
      this.#pending = buffered.length > 0 ? [buffered] : [];
      this.#pendingBytes = buffered.length;
    }
    callback();
  }

  override _flush(callback: NodeStream.TransformCallback) {
    this.#seal(Buffer.concat(this.#pending), true);
    callback();
  }
}

class ChunkDecryptor extends NodeStream.Transform {
  readonly #key: Buffer;
  readonly #aad: Buffer;
  readonly #unitBytes: number;
  readonly #onBytesRead: ((bytes: number) => void) | undefined;
  #pending: Array<Buffer> = [];
  #pendingBytes = 0;
  #index = 0;

  constructor(
    key: Buffer,
    aad: Buffer,
    chunkBytes: number,
    onBytesRead: ((bytes: number) => void) | undefined,
  ) {
    super();
    this.#key = key;
    this.#aad = aad;
    this.#unitBytes = chunkBytes + TAG_BYTES;
    this.#onBytesRead = onBytesRead;
  }

  #open(sealed: Buffer, final: boolean): Buffer {
    const decipher = NodeCrypto.createDecipheriv(
      "aes-256-gcm",
      this.#key,
      chunkNonce(this.#index, final),
      { authTagLength: TAG_BYTES },
    );
    decipher.setAAD(this.#aad);
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    try {
      const plaintext = Buffer.concat([
        decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)),
        decipher.final(),
      ]);
      this.#index += 1;
      return plaintext;
    } catch {
      throw unreadable(DAMAGED);
    }
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: NodeStream.TransformCallback,
  ) {
    this.#onBytesRead?.(chunk.length);
    this.#pending.push(chunk);
    this.#pendingBytes += chunk.length;
    // Only a unit with more bytes after it is known not to be the last.
    if (this.#pendingBytes > this.#unitBytes) {
      let buffered = Buffer.concat(this.#pending);
      try {
        while (buffered.length > this.#unitBytes) {
          this.push(this.#open(buffered.subarray(0, this.#unitBytes), false));
          buffered = buffered.subarray(this.#unitBytes);
        }
      } catch (error) {
        return callback(error as Error);
      }
      this.#pending = [buffered];
      this.#pendingBytes = buffered.length;
    }
    callback();
  }

  override _flush(callback: NodeStream.TransformCallback) {
    const rest = Buffer.concat(this.#pending);
    // A full unit at the end means the shorter final chunk is missing.
    if (rest.length < TAG_BYTES || rest.length >= this.#unitBytes)
      return callback(unreadable(DAMAGED));
    try {
      this.push(this.#open(rest, true));
    } catch (error) {
      return callback(error as Error);
    }
    callback();
  }
}

/**
 * The decrypted, decompressed archive. Errors arrive through iteration; destroying the stream
 * stops reading the file.
 */
export function readBackupPayload(
  file: OpenedBackupFile,
  key: Buffer,
  options: { readonly onBytesRead?: (bytes: number) => void } = {},
): NodeStream.Readable {
  const source = NodeFS.createReadStream(file.path, {
    start: file.payloadOffset,
    highWaterMark: DEFAULT_CHUNK_BYTES,
  });
  const decryptor = new ChunkDecryptor(
    key,
    headerDigest(file.headerBytes),
    file.header.cipher.chunkBytes,
    options.onBytesRead,
  );
  return NodeStream.pipeline(source, decryptor, NodeZlib.createGunzip(), () => undefined);
}

/** Maps a write failure in the destination folder to the reason the user can act on. */
export const backupWriteError = (cause: unknown): BackupError => {
  if (isBackupError(cause)) return cause;
  const code = errnoCode(cause);
  if (code === "ENOSPC" || code === "EDQUOT") {
    return new BackupError({
      reason: "not-enough-space",
      detail: "The backup folder ran out of space.",
    });
  }
  if (
    code === "EACCES" ||
    code === "EPERM" ||
    code === "EROFS" ||
    code === "ENOENT" ||
    code === "ENOTDIR"
  ) {
    return new BackupError({
      reason: "folder-unavailable",
      detail: "Codenine cannot write to the backup folder.",
    });
  }
  return new BackupError({ reason: "failed", detail: "The backup could not be written." });
};

/**
 * Writes `<filePath>` from the plain archive `source`, under a hidden partial name until it is
 * complete and flushed, so a folder never shows half a backup.
 */
export async function writeBackupFile(input: {
  readonly filePath: string;
  readonly identity: BackupFileIdentity;
  readonly password: string;
  readonly source: AsyncIterable<Uint8Array>;
  readonly scrypt?: ScryptParams | undefined;
  readonly chunkBytes?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}): Promise<OpenedBackupFile> {
  const scrypt = input.scrypt ?? DEFAULT_SCRYPT;
  const chunkBytes = input.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  const salt = NodeCrypto.randomBytes(SALT_BYTES);
  const keys = await deriveKeys(input.password, salt, scrypt);
  const header: BackupFileHeader = {
    format: BACKUP_FORMAT_VERSION,
    ...input.identity,
    compression: "gzip",
    kdf: { name: "scrypt", ...scrypt, salt: salt.toString("base64") },
    cipher: { name: "aes-256-gcm", chunkBytes },
    keyCheck: keys.keyCheck.toString("base64"),
  };
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const preamble = Buffer.alloc(PREAMBLE_BYTES);
  MAGIC.copy(preamble);
  preamble.writeUInt32BE(headerBytes.length, MAGIC.length);

  const directory = NodePath.dirname(input.filePath);
  const partialPath = NodePath.join(
    directory,
    `.${NodePath.basename(input.filePath)}.${process.pid}.partial`,
  );
  try {
    await NodeStreamPromises.pipeline(
      input.source,
      NodeZlib.createGzip({ level: GZIP_LEVEL }),
      new ChunkEncryptor(
        keys.payloadKey,
        headerDigest(headerBytes),
        chunkBytes,
        Buffer.concat([preamble, headerBytes]),
      ),
      NodeFS.createWriteStream(partialPath, { flags: "wx", mode: 0o600, flush: true }),
      input.signal === undefined ? {} : { signal: input.signal },
    );
    await NodeFSP.rename(partialPath, input.filePath);
  } catch (cause) {
    await NodeFSP.rm(partialPath, { force: true }).catch(() => undefined);
    throw cause;
  }
  await syncDirectory(directory);
  return {
    path: input.filePath,
    header,
    headerBytes,
    payloadOffset: PREAMBLE_BYTES + headerBytes.length,
    sizeBytes: (await NodeFSP.stat(input.filePath)).size,
  };
}

/** Makes a rename durable; Windows refuses directory handles and journals renames itself. */
async function syncDirectory(directory: string): Promise<void> {
  let handle: NodeFSP.FileHandle | undefined;
  try {
    handle = await NodeFSP.open(directory, "r");
    await handle.sync();
  } catch {
    // Best effort: a crash before the next flush can only lose the newest rename.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Partial files a crashed or killed writer left behind in a backup folder. */
export const isAbandonedPartial = (fileName: string, isProcessAlive: (pid: number) => boolean) => {
  const match = /^\..+\.c9backup\.(\d+)\.partial$/.exec(fileName);
  return match !== null && !isProcessAlive(Number(match[1]));
};
