import { assert, it } from "@effect/vitest";

import {
  encodeTarHeader,
  TAR_END_BLOCKS,
  type TarEntry,
  type TarEvent,
  TarParser,
  tarPadding,
} from "./tar.ts";

const encoder = new TextEncoder();

const archive = (
  entries: ReadonlyArray<{ readonly entry: TarEntry; readonly data?: Uint8Array }>,
) => {
  const parts: Array<Uint8Array> = [];
  for (const { entry, data } of entries) {
    parts.push(encodeTarHeader(entry));
    if (data !== undefined) parts.push(data, tarPadding(data.length));
  }
  parts.push(TAR_END_BLOCKS);
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
};

const readAll = (bytes: Uint8Array, pushSize: number) => {
  const parser = new TarParser();
  const events: Array<TarEvent> = [];
  for (let offset = 0; offset < bytes.length; offset += pushSize) {
    events.push(...parser.push(bytes.subarray(offset, offset + pushSize)));
  }
  parser.finish();
  const entries: Array<{ entry: TarEntry; data: string }> = [];
  for (const event of events) {
    if (event._tag === "entry") entries.push({ entry: event.entry, data: "" });
    if (event._tag === "data") {
      const current = entries.at(-1)!;
      current.data += Buffer.from(event.bytes).toString("latin1");
    }
  }
  return entries;
};

const file = (path: string, contents: Uint8Array): { entry: TarEntry; data: Uint8Array } => ({
  entry: { path, type: "file", size: contents.length, mode: 0o640, mtimeMs: 1_700_000_000_000 },
  data: contents,
});

it("reads back what it wrote, however the stream is split", () => {
  const longPath = `workspaces/${"deep/".repeat(30)}file.ts`;
  const entries: ReadonlyArray<{ readonly entry: TarEntry; readonly data?: Uint8Array }> = [
    file("manifest.json", encoder.encode("{}")),
    {
      entry: { path: "workspaces/app", type: "directory", size: 0, mode: 0o755, mtimeMs: 0 },
    },
    file("workspaces/app/empty.txt", new Uint8Array(0)),
    file("workspaces/app/block.bin", new Uint8Array(512).fill(7)),
    file("workspaces/app/odd.bin", new Uint8Array(513).fill(9)),
    file(longPath, encoder.encode("long")),
    file("workspaces/app/Résumé ✓.md", encoder.encode("unicode")),
    {
      entry: {
        path: "accounts/codex/work/sessions",
        type: "symlink",
        size: 0,
        mode: 0o777,
        mtimeMs: 0,
        linkTarget: `../${"shared/".repeat(20)}sessions`,
      },
    },
  ];
  const bytes = archive(entries);
  for (const pushSize of [1, 7, 512, 4096, bytes.length]) {
    const read = readAll(bytes, pushSize);
    assert.deepEqual(
      read.map(({ entry }) => [entry.path, entry.type, entry.size, entry.linkTarget]),
      entries.map(({ entry }) => [entry.path, entry.type, entry.size, entry.linkTarget]),
    );
    assert.equal(read[3]!.data, "\u0007".repeat(512));
    assert.equal(read[4]!.data.length, 513);
    assert.equal(read[5]!.data, "long");
    assert.equal(read[0]!.entry.mode, 0o640);
    assert.equal(read[0]!.entry.mtimeMs, 1_700_000_000_000);
  }
});

it("rejects a truncated archive and a damaged header", () => {
  const bytes = archive([file("a.txt", encoder.encode("hello"))]);
  const truncated = new TarParser();
  truncated.push(bytes.subarray(0, 600));
  assert.throws(() => truncated.finish(), /damaged \(truncated\)/);

  const damaged = bytes.slice();
  damaged[10] = (damaged[10] ?? 0) ^ 0xff;
  assert.throws(() => new TarParser().push(damaged), /damaged \(checksum\)/);
});
