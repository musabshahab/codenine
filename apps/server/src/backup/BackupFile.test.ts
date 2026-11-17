// @effect-diagnostics-next-line nodeBuiltinImport:off - the format module is Promise-based; tests damage its files in place.
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  readBackupHeader,
  readBackupPayload,
  type ScryptParams,
  unlockBackup,
  writeBackupFile,
} from "./BackupFile.ts";

// Cheap enough for tests; the header carries the cost, so readers follow it.
const SCRYPT: ScryptParams = { n: 2 ** 10, r: 8, p: 1 };
const CHUNK_BYTES = 1024;

const identity = {
  createdAt: "2026-11-17T06:00:00.000Z",
  kind: "manual",
  computerName: "Alpha",
  computerId: "0123456789abcdef",
  codenineVersion: "0.1.7",
  schemaVersion: 83,
} as const;

// Pseudo-random bytes do not compress, so the payload spans many chunks.
const payload = (() => {
  const bytes = Buffer.alloc(20_000);
  let state = 0x2545f491;
  for (let index = 0; index < bytes.length; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 0xff;
  }
  return bytes;
})();

async function* source() {
  for (let offset = 0; offset < payload.length; offset += 3000) {
    yield payload.subarray(offset, offset + 3000);
  }
}

const readPayload = async (filePath: string, password: string) => {
  const opened = await readBackupHeader(filePath);
  const key = await unlockBackup(opened, password);
  const chunks: Array<Buffer> = [];
  for await (const chunk of readBackupPayload(opened, key)) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

const writeFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "codenine-backup-file-" });
  const filePath = path.join(directory, "fixture.c9backup");
  const written = yield* Effect.promise(() =>
    writeBackupFile({
      filePath,
      identity,
      password: "correct horse",
      source: source(),
      scrypt: SCRYPT,
      chunkBytes: CHUNK_BYTES,
    }),
  );
  return { directory, filePath, written };
});

const failure = (promise: Promise<unknown>) =>
  Effect.promise(() =>
    promise.then(
      () => assert.fail("expected the backup to be refused"),
      (error: unknown) => error as { readonly _tag: string; readonly reason: string },
    ),
  );

it.effect("round-trips the payload and keeps the header readable without the password", () =>
  Effect.gen(function* () {
    const { filePath, written } = yield* writeFixture;
    const fs = yield* FileSystem.FileSystem;
    const header = yield* Effect.promise(() => readBackupHeader(filePath));
    assert.deepEqual(
      {
        kind: header.header.kind,
        computerName: header.header.computerName,
        schemaVersion: header.header.schemaVersion,
        kdf: header.header.kdf.name,
        cipher: header.header.cipher.name,
      },
      {
        kind: "manual",
        computerName: "Alpha",
        schemaVersion: 83,
        kdf: "scrypt",
        cipher: "aes-256-gcm",
      },
    );
    assert.equal(header.sizeBytes, written.sizeBytes);
    assert.isTrue(written.sizeBytes > payload.length);
    assert.isTrue(
      (yield* Effect.promise(() => readPayload(filePath, "correct horse"))).equals(payload),
    );
    // No partial file is left beside the finished backup.
    assert.deepEqual(yield* fs.readDirectory(header.path.slice(0, -"/fixture.c9backup".length)), [
      "fixture.c9backup",
    ]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a wrong password fails before any chunk is read", () =>
  Effect.gen(function* () {
    const { filePath } = yield* writeFixture;
    const opened = yield* Effect.promise(() => readBackupHeader(filePath));
    const error = yield* failure(unlockBackup(opened, "wrong horse"));
    assert.deepEqual([error._tag, error.reason], ["BackupError", "wrong-password"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("detects truncation, reordered chunks and an edited header", () =>
  Effect.gen(function* () {
    const { filePath, written } = yield* writeFixture;
    const original = yield* Effect.promise(() => NodeFSP.readFile(filePath));
    const unit = CHUNK_BYTES + 16;
    const start = written.payloadOffset;
    const damaged = [
      // Cut at a chunk boundary: the shorter final chunk is missing.
      original.subarray(0, start + unit * 3),
      // Cut inside a chunk.
      original.subarray(0, original.length - 5),
      // Two chunks swapped.
      Buffer.concat([
        original.subarray(0, start),
        original.subarray(start + unit, start + unit * 2),
        original.subarray(start, start + unit),
        original.subarray(start + unit * 2),
      ]),
      // The plain header edited in place: "Alpha" becomes "Alphb".
      (() => {
        const copy = Buffer.from(original);
        const at = copy.indexOf("Alpha", 0, "utf8");
        copy[at + 4] = "b".charCodeAt(0);
        return copy;
      })(),
    ];
    for (const bytes of damaged) {
      yield* Effect.promise(() => NodeFSP.writeFile(filePath, bytes));
      const error = yield* failure(readPayload(filePath, "correct horse"));
      assert.deepEqual([error._tag, error.reason], ["BackupError", "unreadable"]);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
