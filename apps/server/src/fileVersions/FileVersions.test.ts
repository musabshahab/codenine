// @effect-diagnostics nodeBuiltinImport:off - fails the walk's own file calls, which are Node's.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, vi } from "@effect/vitest";
import { symlinksSupported } from "@codenine/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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
    // The store the service is built on, which a project's deletion uses too.
    Layer.provideMerge(FileVersionStorage.layer),
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

/** Makes these workspace files fail to open, as one held open by another program does. */
const blockOpen = (...names: ReadonlyArray<string>) => {
  const open = NodeFS.promises.open;
  const spy = vi
    .spyOn(NodeFS.promises, "open")
    .mockImplementation(((...args: Parameters<typeof open>) =>
      names.some((name) => String(args[0]).endsWith(name))
        ? Promise.reject(Object.assign(new Error("EBUSY"), { code: "EBUSY" }))
        : open(...args)) as typeof open);
  NodeModule.syncBuiltinESMExports();
  return {
    [Symbol.dispose]: () => {
      spy.mockRestore();
      NodeModule.syncBuiltinESMExports();
    },
  };
};

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

      yield* versions.writeFile({ ...file, contents: "first save\n" });
      yield* versions.writeFile({ ...file, contents: "second save, longer\n" });
      const saved = yield* list("notes.md");
      expect(saved.map((version) => version.origin)).toEqual(["user", "external"]);
      expect(yield* versions.read({ ...file, versionId: saved[0]!.id })).toMatchObject({
        contents: "second save, longer\n",
      });
      expect(yield* versions.read({ ...file, versionId: saved[1]!.id })).toMatchObject({
        contents: "written outside\n",
      });

      yield* TestClock.adjust("2 minutes");
      yield* versions.writeFile({ ...file, contents: "a later save\n" });
      // Saving the same contents again is not a new version.
      yield* versions.writeFile({ ...file, contents: "a later save\n" });
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
        const saved = yield* versions.writeFile({ ...file, contents: "y".repeat(50) });

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

        // A restore, a discard and a delete promise an undo, so they leave a file alone when
        // the store cannot hold what they would replace.
        yield* write("grown.bin", "small");
        yield* versions.syncWorkspace({ cwd, origin: EXTERNAL });
        const small = (yield* list("grown.bin"))[0]!;
        yield* write("grown.bin", "z".repeat(40));
        const grown = { cwd, relativePath: "grown.bin" };
        for (const refused of [
          versions.restore({ ...grown, versionId: small.id }),
          versions.overwriteFile({ ...grown, contents: "small" }),
          versions.removeFile({ ...grown, expectedVersion: "unused" }),
        ]) {
          expect((yield* refused.pipe(Effect.flip))._tag).toBe("FileVersionNotKeptError");
        }
        expect((yield* readBytes("grown.bin")).toString()).toBe("z".repeat(40));
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
        // A file saved through a link inside the workspace has one history, under where it is,
        // so the next walk does not find the linked name gone and call it deleted by the turn.
        yield* fileSystem.symlink(path.join(cwd, "inside.txt"), path.join(cwd, "alias.txt"));
        yield* versions.writeFile({ cwd, relativePath: "alias.txt", contents: "saved by link" });
        yield* versions.syncWorkspace({ cwd, origin: turn(1) });
        expect(yield* versions.turnChanges({ cwd, threadId: "thread", turnCount: 1 })).toEqual([]);
        expect((yield* list("alias.txt")).map((version) => version.origin)).toEqual([
          "user",
          "external",
        ]);
        expect(yield* list("alias.txt")).toEqual(yield* list("inside.txt"));
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
      yield* versions.syncWorkspace({ cwd, origin: { kind: "turn-start", threadId: "thread" } });
      yield* write("changed.md", "after the turn\n");
      yield* write("created.md", "new\n");
      yield* remove("deleted.md");
      // Another thread's turn starting in the folder must not take the running turn's changes.
      yield* versions.syncWorkspace({ cwd, origin: { kind: "turn-start", threadId: "other" } });
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

  it.effect("does not call a file the turn's when the walk before could not read it", () =>
    Effect.gen(function* () {
      const { cwd, versions, write, list } = yield* makeWorkspace();
      yield* write("seen.md", "seen");
      yield* versions.syncWorkspace({ cwd, origin: EXTERNAL });
      yield* write("report.xlsx", "open in another program");
      {
        using _blocked = blockOpen("report.xlsx");
        yield* versions.syncWorkspace({ cwd, origin: EXTERNAL });
      }
      expect(yield* list("report.xlsx")).toEqual([]);
      yield* write("made.md", "made by the turn");
      yield* versions.syncWorkspace({ cwd, origin: turn(1) });
      expect((yield* list("report.xlsx")).map((version) => version.origin)).toEqual(["external"]);
      expect(yield* versions.turnChanges({ cwd, threadId: "thread", turnCount: 1 })).toEqual([
        "made.md",
      ]);
    }).pipe(Effect.provide(layerWith())),
  );

  it.effect("an editor save does not wait for a walk of the folder", () =>
    Effect.gen(function* () {
      const { cwd, versions, write, list } = yield* makeWorkspace();
      yield* write("notes.md", "before");
      yield* versions.syncWorkspace({ cwd, origin: EXTERNAL });
      const reached = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      const readdir = NodeFS.promises.readdir;
      using _spy = vi.spyOn(NodeFS.promises, "readdir").mockImplementation((async (
        ...args: Parameters<typeof readdir>
      ) => {
        reached.resolve();
        await released.promise;
        return readdir(...args);
      }) as typeof readdir);
      NodeModule.syncBuiltinESMExports();
      const walk = yield* versions.syncWorkspace({ cwd, origin: turn(1) }).pipe(Effect.forkChild);
      yield* Effect.promise(() => reached.promise);
      yield* versions.writeFile({ cwd, relativePath: "notes.md", contents: "saved mid-walk" });
      released.resolve();
      yield* Fiber.join(walk);
      // The walk finds the save already recorded, so the turn is not given the user's edit.
      expect((yield* list("notes.md")).map((version) => version.origin)).toEqual([
        "user",
        "external",
      ]);
    }).pipe(
      Effect.provide(layerWith()),
      Effect.ensuring(Effect.sync(NodeModule.syncBuiltinESMExports)),
    ),
  );

  it.effect("starts a workspace's limit afresh once its versions are deleted", () =>
    Effect.gen(function* () {
      const { cwd, versions, write, list } = yield* makeWorkspace();
      const storage = yield* FileVersionStorage.FileVersionStorage;
      const path = yield* Path.Path;
      yield* write("a.bin", "a".repeat(90));
      yield* versions.syncWorkspace({ cwd, origin: EXTERNAL });
      // What a project's deletion does; the folder is then added again as a new workspace.
      yield* storage.forgetWorkspace(path.resolve(cwd));
      yield* versions.writeFile({ cwd, relativePath: "notes.md", contents: "n".repeat(50) });
      expect((yield* list("notes.md")).map((version) => version.state)).toEqual(["stored"]);
    }).pipe(Effect.provide(layerWith({ maxWorkspaceBytes: 100 }))),
  );

  it.effect("records nothing in a Git checkout", () =>
    Effect.gen(function* () {
      const { cwd, versions, write, readBytes, list } = yield* makeWorkspace(
        `codenine-${GIT_CHECKOUT_MARK}-`,
      );
      yield* write("notes.md", "committed\n");
      yield* versions.syncWorkspace({ cwd, origin: EXTERNAL });
      yield* versions.writeFile({ cwd, relativePath: "notes.md", contents: "edited\n" });

      expect((yield* readBytes("notes.md")).toString()).toBe("edited\n");
      expect(yield* versions.list({ cwd, relativePath: "notes.md" })).toEqual({
        tracked: false,
        versions: [],
      });
      expect(yield* list("notes.md")).toEqual([]);
    }).pipe(Effect.provide(layerWith())),
  );
});
