import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { CheckpointRef, ThreadId } from "@codenine/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as CheckpointDiffQuery from "./CheckpointDiffQuery.ts";
import * as CheckpointStore from "./CheckpointStore.ts";
import * as FileBaselines from "./FileBaselines.ts";

const TURN_START = CheckpointRef.make("refs/codenine/checkpoints/file-baselines/ordinal/0");
const turn = { threadId: ThreadId.make("thread"), turnCount: 1 };

const layerPlatform = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
const layerVcsProcess = VcsProcess.layer.pipe(Layer.provide(layerPlatform));
const layerCheckpointStore = CheckpointStore.layer.pipe(
  Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(layerVcsProcess))),
);
const layerWorkspaceFileSystem = WorkspaceFileSystem.layer.pipe(
  Layer.provide(Layer.mock(KnownWorkspaces.KnownWorkspaces)({ assertContains: () => Effect.void })),
  Layer.provide(Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void })),
);
const layerTest = FileBaselines.layer.pipe(
  Layer.provide(
    Layer.mock(CheckpointDiffQuery.CheckpointDiffQuery)({
      getTurnStartRef: () => Effect.succeed(TURN_START),
    }),
  ),
  Layer.provideMerge(layerWorkspaceFileSystem),
  Layer.provideMerge(layerCheckpointStore),
  Layer.provideMerge(layerVcsProcess),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "codenine-file-baselines-test-" }),
  ),
  Layer.provideMerge(layerPlatform),
);

const BEFORE_TURN = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n";
const AFTER_TURN = "one\nTWO\nthree\nfour\nfive\nsix\nseven\nEIGHT\nnine\n";

/** A committed repository whose turn-start checkpoint holds `notes.md` as it was before the turn. */
const makeTurnWorkspace = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codenine-file-baselines-" });
  const git = (...args: ReadonlyArray<string>) =>
    vcsProcess.run({ operation: "FileBaselines.test.git", command: "git", cwd, args });
  yield* git("init");
  yield* git("config", "user.email", "test@test.com");
  yield* git("config", "user.name", "Test");
  yield* fileSystem.writeFileString(path.join(cwd, "notes.md"), "committed\n");
  yield* git("add", ".");
  yield* git("commit", "-m", "initial commit");
  yield* fileSystem.writeFileString(path.join(cwd, "notes.md"), BEFORE_TURN);
  yield* checkpointStore.captureCheckpoint({ cwd, checkpointRef: TURN_START });
  yield* fileSystem.writeFileString(path.join(cwd, "notes.md"), AFTER_TURN);
  yield* fileSystem.writeFileString(path.join(cwd, "created.md"), "new\n");
  return {
    cwd,
    readDisk: (name: string) => fileSystem.readFileString(path.join(cwd, name)),
    writeDisk: (name: string, contents: string) =>
      fileSystem.writeFileString(path.join(cwd, name), contents),
    exists: (name: string) => fileSystem.exists(path.join(cwd, name)),
  };
});

it.layer(layerTest)("FileBaselines", (it) => {
  describe("read", () => {
    it.effect("reads a file at the last commit and at the start of a turn", () =>
      Effect.gen(function* () {
        const baselines = yield* FileBaselines.FileBaselines;
        const fileSystem = yield* FileSystem.FileSystem;
        const { cwd } = yield* makeTurnWorkspace;
        const notes = { cwd, relativePath: "notes.md" };

        const head = yield* baselines.read({ ...notes, source: { kind: "head" } });
        expect(head).toMatchObject({ available: true, contents: "committed\n" });
        expect(
          yield* baselines.read({
            ...notes,
            source: { kind: "head" },
            knownRevision: head.revision,
          }),
        ).toEqual({ available: true, contents: null, revision: head.revision, unchanged: true });
        expect(
          yield* baselines.read({ ...notes, source: { kind: "turn", ...turn } }),
        ).toMatchObject({ available: true, contents: BEFORE_TURN });
        expect(
          yield* baselines.read({ cwd, relativePath: "created.md", source: { kind: "head" } }),
        ).toEqual({ available: true, contents: null, revision: head.revision });

        const plainFolder = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "codenine-file-baselines-plain-",
        });
        expect(
          yield* baselines.read({
            cwd: plainFolder,
            relativePath: "notes.md",
            source: { kind: "head" },
          }),
        ).toEqual({ available: false, contents: null });
      }),
    );
  });

  describe("revertTurnChange", () => {
    it.effect("restores one change, then the whole file, and refuses a stale version", () =>
      Effect.gen(function* () {
        const baselines = yield* FileBaselines.FileBaselines;
        const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const { cwd, readDisk, writeDisk } = yield* makeTurnWorkspace;
        const notes = { cwd, relativePath: "notes.md", ...turn };
        const seen = (yield* files.readFile(notes)).version!;

        // The turn's second change: "eight" became "EIGHT" and "nine" was added.
        const reverted = yield* baselines.revertTurnChange({
          ...notes,
          expectedVersion: seen,
          change: { baseStart: 7, baseCount: 1, currentStart: 7, currentCount: 2 },
        });
        expect(yield* readDisk("notes.md")).toBe(
          "one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\n",
        );
        expect(reverted).toEqual({
          relativePath: "notes.md",
          deleted: false,
          version: (yield* files.readFile(notes)).version,
        });

        const stale = yield* baselines
          .revertTurnChange({ ...notes, expectedVersion: seen })
          .pipe(Effect.flip);
        expect(stale).toMatchObject({
          _tag: "WorkspaceFileConflictError",
          currentVersion: reverted.version,
        });

        yield* writeDisk("notes.md", "edited after the turn\n");
        expect(
          yield* baselines
            .revertTurnChange({ ...notes, expectedVersion: reverted.version! })
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "WorkspaceFileConflictError" });
        expect(yield* readDisk("notes.md")).toBe("edited after the turn\n");

        yield* baselines.revertTurnChange({
          ...notes,
          expectedVersion: (yield* files.readFile(notes)).version!,
        });
        expect(yield* readDisk("notes.md")).toBe(BEFORE_TURN);
      }),
    );

    it.effect("deletes a file the turn created", () =>
      Effect.gen(function* () {
        const baselines = yield* FileBaselines.FileBaselines;
        const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const { cwd, exists } = yield* makeTurnWorkspace;
        const created = { cwd, relativePath: "created.md", ...turn };

        expect(
          yield* baselines.revertTurnChange({
            ...created,
            expectedVersion: (yield* files.readFile(created)).version!,
          }),
        ).toEqual({ relativePath: "created.md", deleted: true });
        expect(yield* exists("created.md")).toBe(false);
      }),
    );
  });
});
