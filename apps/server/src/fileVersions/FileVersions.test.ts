import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { symlinksSupported } from "@codenine/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { TestClock } from "effect/testing";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as FileVersionStorage from "./FileVersionStorage.ts";
import * as FileVersions from "./FileVersions.ts";

const GIT_CHECKOUT_MARK = "git-checkout";
const DEFAULT_LIMITS = {
  maxFileBytes: 1024,
  maxWorkspaceBytes: 64 * 1024,
  maxVersionsPerFile: 30,
  maxTrackedFiles: 100,
  userSaveCoalesceMs: 60_000,
};

const layerWith = (limits: Partial<typeof DEFAULT_LIMITS> = {}) =>
  FileVersions.layer.pipe(
    Layer.provide(
      Layer.succeed(FileVersionStorage.FileVersionLimits, { ...DEFAULT_LIMITS, ...limits }),
    ),
    Layer.provide(
      Layer.mock(CheckpointStore.CheckpointStore)({
        isGitRepository: (cwd) => Effect.succeed(cwd.includes(GIT_CHECKOUT_MARK)),
      }),
    ),
    Layer.provideMerge(
      WorkspaceFileSystem.layer.pipe(
        Layer.provide(
          Layer.mock(KnownWorkspaces.KnownWorkspaces)({ assertContains: () => Effect.void }),
        ),
        Layer.provide(
          Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
        ),
      ),
    ),
    Layer.provideMerge(WorkspacePaths.layer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(
      ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "codenine-file-versions-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const EXTERNAL = { kind: "external" } as const;
const turn = (turnCount: number) => ({ kind: "agent", threadId: "thread", turnCount }) as const;

const makeWorkspace = Effect.fn("FileVersionsTest.makeWorkspace")(function* (
  prefix = "codenine-versions-workspace-",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const versions = yield* FileVersions.FileVersions;
  const config = yield* ServerConfig.ServerConfig;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix });
  const storeDirectory = path.join(config.stateDir, FileVersionStorage.FILE_VERSIONS_DIRECTORY);
  return {
    cwd,
    versions,
    write: (name: string, contents: string | Uint8Array) =>
      typeof contents === "string"
        ? fileSystem.writeFileString(path.join(cwd, name), contents)
        : fileSystem.writeFile(path.join(cwd, name), contents),
    readBytes: (name: string) =>
      fileSystem.readFile(path.join(cwd, name)).pipe(Effect.map((bytes) => Buffer.from(bytes))),
    remove: (name: string) => fileSystem.remove(path.join(cwd, name)),
    list: (relativePath: string) =>
      versions.list({ cwd, relativePath }).pipe(Effect.map((result) => result.versions)),
    /** Every stored contents file, across workspaces. */
    storedContents: fileSystem.readDirectory(storeDirectory, { recursive: true }).pipe(
      Effect.map((entries) => entries.filter((entry) => /[0-9a-f]{64}$/.test(entry))),
      Effect.orElseSucceed((): Array<string> => []),
    ),
  };
});

describe("FileVersions", () => {
  it.effect(
    "records, lists and restores versions of text and binary files, and undoes a restore",
    () =>
      Effect.gen(function* () {
        const { cwd, versions, write, readBytes, list, storedContents } = yield* makeWorkspace();
        const original = Uint8Array.from([0, 1, 2, 255, 0, 7]);
        const edited = Uint8Array.from([0, 1, 2, 255, 0, 7, 9, 9]);
        yield* write("sheet.xlsx", original);
        yield* write("copy.xlsx", original);
        yield* versions.syncWorkspace({ cwd, origin: EXTERNAL });
        // Equal contents are stored once.
        expect(yield* storedContents).toHaveLength(1);

        yield* write("sheet.xlsx", edited);
        yield* versions.syncWorkspace({ cwd, origin: turn(1) });
        // A sync that finds nothing new records nothing.
        yield* versions.syncWorkspace({ cwd, origin: turn(2) });
        const afterTurn = yield* list("sheet.xlsx");
        expect(
          afterTurn.map(({ origin, state, byteLength, threadId, turnCount }) => ({
            origin,
            state,
            byteLength,
            threadId,
            turnCount,
          })),
        ).toEqual([
          { origin: "agent", state: "stored", byteLength: 8, threadId: "thread", turnCount: 1 },
          {
            origin: "external",
            state: "stored",
            byteLength: 6,
            threadId: undefined,
            turnCount: undefined,
          },
        ]);

        const file = { cwd, relativePath: "sheet.xlsx" };
        const [agentVersion, firstVersion] = afterTurn;
        // Binary contents are not sent as a preview, and still restore byte for byte.
        expect(yield* versions.read({ ...file, versionId: firstVersion!.id })).toEqual({
          contents: null,
          byteLength: 6,
        });
        const restored = yield* versions.restore({
          ...file,
          versionId: firstVersion!.id,
          expectedVersion: agentVersion!.version,
        });
        expect(restored.version).toBe(firstVersion!.version);
        expect(yield* readBytes("sheet.xlsx")).toEqual(Buffer.from(original));
        expect((yield* list("sheet.xlsx")).map((version) => version.origin)).toEqual([
          "restore",
          "agent",
          "external",
        ]);

        // The contents the restore replaced are still a version, so it can be undone.
        yield* versions.restore({ ...file, versionId: agentVersion!.id });
        expect(yield* readBytes("sheet.xlsx")).toEqual(Buffer.from(edited));

        // A restore over a file that changed since the caller read it is refused, and the
        // contents found on disk are kept as a version first.
        yield* write("sheet.xlsx", "typed elsewhere");
        const refused = yield* versions
          .restore({ ...file, versionId: firstVersion!.id, expectedVersion: agentVersion!.version })
          .pipe(Effect.flip);
        expect(refused._tag).toBe("WorkspaceFileConflictError");
        expect((yield* list("sheet.xlsx"))[0]).toMatchObject({
          origin: "external",
          byteLength: 15,
        });
      }).pipe(Effect.provide(layerWith())),
  );

  it.effect("an editor save keeps what it replaced, and saves close together are one version", () =>
    Effect.gen(function* () {
      const { cwd, versions, write, list } = yield* makeWorkspace();
      const file = { cwd, relativePath: "notes.md" };
      yield* write("notes.md", "written outside\n");

      yield* versions.writeFile({ ...file, contents: "first save\n" }, "user");
      yield* versions.writeFile({ ...file, contents: "second save, longer\n" }, "user");
      const saved = yield* list("notes.md");
      expect(saved.map((version) => version.origin)).toEqual(["user", "external"]);
      expect(yield* versions.read({ ...file, versionId: saved[0]!.id })).toMatchObject({
        contents: "second save, longer\n",
      });
      expect(yield* versions.read({ ...file, versionId: saved[1]!.id })).toMatchObject({
        contents: "written outside\n",
      });

      yield* TestClock.adjust("2 minutes");
      yield* versions.writeFile({ ...file, contents: "a later save\n" }, "user");
      // Saving the same contents again is not a new version.
      yield* versions.writeFile({ ...file, contents: "a later save\n" }, "user");
      expect((yield* list("notes.md")).map((version) => version.origin)).toEqual([
        "user",
        "user",
        "external",
      ]);
    }).pipe(Effect.provide(layerWith())),
  );

  it.effect("keeps the newest versions of a file up to the per-file limit", () =>
    Effect.gen(function* () {
      const { cwd, versions, write, list } = yield* makeWorkspace();
      for (let count = 1; count <= 5; count++) {
        yield* write("notes.md", "x".repeat(count));
        yield* versions.syncWorkspace({ cwd, origin: turn(count) });
      }
      expect((yield* list("notes.md")).map((version) => version.byteLength)).toEqual([5, 4, 3]);
    }).pipe(Effect.provide(layerWith({ maxVersionsPerFile: 3 }))),
  );

  it.effect(
    "prunes the oldest versions to stay under the workspace limit, never a file's latest",
    () =>
      Effect.gen(function* () {
        const { cwd, versions, write, list, storedContents } = yield* makeWorkspace();
        yield* write("a.txt", "a".repeat(30));
        yield* write("b.txt", "b".repeat(30));
        yield* versions.syncWorkspace({ cwd, origin: EXTERNAL });
        yield* write("a.txt", "A".repeat(31));
        yield* versions.syncWorkspace({ cwd, origin: turn(1) });
        // 91 of 100 bytes are in use. The next version needs room, and only a.txt has an older one.
        yield* write("b.txt", "B".repeat(32));
        yield* versions.syncWorkspace({ cwd, origin: turn(2) });

        expect((yield* list("a.txt")).map((version) => version.byteLength)).toEqual([31]);
        expect((yield* list("b.txt")).map((version) => version.byteLength)).toEqual([32, 30]);
        expect(yield* storedContents).toHaveLength(3);

        // Nothing older is left to prune, so the change is listed without its contents.
        yield* write("a.txt", "Z".repeat(40));
        yield* versions.syncWorkspace({ cwd, origin: turn(3) });
        expect(
          (yield* list("a.txt")).map(({ state, byteLength }) => ({ state, byteLength })),
        ).toEqual([
          { state: "skipped", byteLength: 40 },
          { state: "stored", byteLength: 31 },
        ]);
      }).pipe(Effect.provide(layerWith({ maxWorkspaceBytes: 100 }))),
  );

  it.effect(
    "lists a file over the size limit without keeping it, and the save still succeeds",
    () =>
      Effect.gen(function* () {
        const { cwd, versions, write, readBytes, list, storedContents } = yield* makeWorkspace();
        yield* write("big.bin", "x".repeat(40));
        yield* versions.syncWorkspace({ cwd, origin: EXTERNAL });
        const file = { cwd, relativePath: "big.bin" };
        const saved = yield* versions.writeFile({ ...file, contents: "y".repeat(50) }, "user");

        expect(saved.relativePath).toBe("big.bin");
        expect((yield* readBytes("big.bin")).toString()).toBe("y".repeat(50));
        const listed = yield* list("big.bin");
        expect(listed.map(({ state, byteLength }) => ({ state, byteLength }))).toEqual([
          { state: "skipped", byteLength: 50 },
          { state: "skipped", byteLength: 40 },
        ]);
        expect(yield* storedContents).toEqual([]);
        const unavailable = yield* versions
          .restore({ ...file, versionId: listed[1]!.id })
          .pipe(Effect.flip);
        expect(unavailable).toMatchObject({ reason: "not-stored" });
      }).pipe(Effect.provide(layerWith({ maxFileBytes: 32 }))),
  );

  it.effect("refuses paths outside the workspace and never follows a link out of it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { cwd, versions, write, list, storedContents } = yield* makeWorkspace();
      const outside = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codenine-outside-" });
      yield* fileSystem.writeFileString(path.join(outside, "secret.txt"), "outside the workspace");
      yield* write("inside.txt", "inside");
      if (symlinksSupported) {
        yield* fileSystem.symlink(path.join(outside, "secret.txt"), path.join(cwd, "link.txt"));
        yield* fileSystem.symlink(outside, path.join(cwd, "linked-folder"));
      }
      yield* versions.syncWorkspace({ cwd, origin: EXTERNAL });

      expect(yield* storedContents).toHaveLength(1);
      expect(yield* list("link.txt")).toEqual([]);
      for (const relativePath of ["../secret.txt", path.join(outside, "secret.txt")]) {
        const target = { cwd, relativePath };
        expect((yield* versions.list(target).pipe(Effect.flip))._tag).toBe(
          "WorkspacePathOutsideRootError",
        );
        expect((yield* versions.read({ ...target, versionId: "1" }).pipe(Effect.flip))._tag).toBe(
          "WorkspacePathOutsideRootError",
        );
        expect(
          (yield* versions.restore({ ...target, versionId: "1" }).pipe(Effect.flip))._tag,
        ).toBe("WorkspacePathOutsideRootError");
      }
      if (symlinksSupported) {
        // A version of one file cannot be restored over another through a link that leaves.
        const inside = (yield* list("inside.txt"))[0]!;
        const escaped = yield* versions
          .restore({ cwd, relativePath: "linked-folder/secret.txt", versionId: inside.id })
          .pipe(Effect.flip);
        expect(escaped).toMatchObject({ reason: "not-found" });
        expect(yield* fileSystem.readFileString(path.join(outside, "secret.txt"))).toBe(
          "outside the workspace",
        );
      }
    }).pipe(Effect.provide(layerWith())),
  );

  it.effect("holds what each file was before a turn changed, created or deleted it", () =>
    Effect.gen(function* () {
      const { cwd, versions, write, remove, list } = yield* makeWorkspace();
      yield* write("changed.md", "before\n");
      yield* write("deleted.md", "to be deleted\n");
      yield* write("untouched.md", "same\n");
      yield* versions.syncWorkspace({ cwd, origin: EXTERNAL });
      yield* write("changed.md", "after the turn\n");
      yield* write("created.md", "new\n");
      yield* remove("deleted.md");
      yield* versions.syncWorkspace({ cwd, origin: turn(1) });

      const changes = yield* versions.turnChanges({ cwd, threadId: "thread", turnCount: 1 });
      expect([...changes].sort()).toEqual(["changed.md", "created.md", "deleted.md"]);
      const baseline = (relativePath: string) =>
        versions
          .turnBaseline({ cwd, threadId: "thread", turnCount: 1, relativePath })
          .pipe(
            Effect.map((result) =>
              result === null ? null : result.bytes && Buffer.from(result.bytes).toString(),
            ),
          );
      expect(yield* baseline("changed.md")).toBe("before\n");
      expect(yield* baseline("created.md")).toBeNull();
      expect(yield* baseline("deleted.md")).toBe("to be deleted\n");
      expect(
        yield* versions.turnBaseline({
          cwd,
          threadId: "thread",
          turnCount: 1,
          relativePath: "untouched.md",
        }),
      ).toBeNull();
      expect((yield* list("deleted.md"))[0]).toMatchObject({ state: "deleted", origin: "agent" });
    }).pipe(Effect.provide(layerWith())),
  );

  it.effect("does not call a file the turn's when no walk had seen the whole folder", () =>
    Effect.gen(function* () {
      const { cwd, versions, write, remove, list } = yield* makeWorkspace();
      yield* write("a.md", "a");
      yield* write("b.md", "bb");
      yield* write("c.md", "ccc");
      yield* versions.syncWorkspace({ cwd, origin: EXTERNAL });
      // c.md was past the file limit before the turn and comes into view when the turn deletes
      // a.md. Listing it as created by the turn would let a review's Discard delete it.
      yield* remove("a.md");
      yield* versions.syncWorkspace({ cwd, origin: turn(1) });
      expect((yield* list("c.md")).map((version) => version.origin)).toEqual(["external"]);
      expect(yield* versions.turnChanges({ cwd, threadId: "thread", turnCount: 1 })).toEqual([
        "a.md",
      ]);
    }).pipe(Effect.provide(layerWith({ maxTrackedFiles: 2 }))),
  );

  it.effect("records nothing in a Git checkout", () =>
    Effect.gen(function* () {
      const { cwd, versions, write, readBytes, list } = yield* makeWorkspace(
        `codenine-${GIT_CHECKOUT_MARK}-`,
      );
      yield* write("notes.md", "committed\n");
      yield* versions.syncWorkspace({ cwd, origin: EXTERNAL });
      yield* versions.writeFile({ cwd, relativePath: "notes.md", contents: "edited\n" }, "user");

      expect((yield* readBytes("notes.md")).toString()).toBe("edited\n");
      expect(yield* versions.list({ cwd, relativePath: "notes.md" })).toEqual({
        tracked: false,
        versions: [],
      });
      expect(yield* list("notes.md")).toEqual([]);
    }).pipe(Effect.provide(layerWith())),
  );
});
