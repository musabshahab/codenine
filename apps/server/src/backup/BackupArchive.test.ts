import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import { archiveRoots, collectArchiveEntries, remoteUrlFromGitConfig } from "./BackupArchive.ts";

const layer = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const runner = yield* ProcessRunner.ProcessRunner;
    const result = yield* runner.run({
      command: "git",
      args: ["-c", "init.defaultBranch=main", ...args],
      cwd,
    });
    assert.equal(result.code, 0, result.stderr);
  });

// Subprocess fixture: git runs for real.
it.live(
  "backs up what Git tracks or would track, the .git folder, and every file of other folders",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "codenine-backup-select-" }),
      );
      const write = (relative: string, contents = relative) =>
        Effect.gen(function* () {
          const file = path.join(baseDir, relative);
          yield* fs.makeDirectory(path.dirname(file), { recursive: true });
          yield* fs.writeFileString(file, contents);
        });

      const repository = path.join(baseDir, "workspaces", "app");
      yield* write("workspaces/app/.gitignore", "node_modules/\n*.log\n");
      yield* write("workspaces/app/src/index.ts");
      yield* git(repository, "init", "--quiet");
      yield* git(repository, "add", ".gitignore", "src/index.ts");
      yield* write("workspaces/app/notes.md");
      yield* write("workspaces/app/debug.log");
      yield* write("workspaces/app/node_modules/pkg/index.js");
      yield* write("workspaces/plain/node_modules/kept.js");
      yield* write("skills/review/SKILL.md");
      yield* fs.symlink(
        path.join(baseDir, "skills", "review"),
        path.join(baseDir, "workspaces", "plain", "review"),
      );
      yield* fs.symlink("/etc/hosts", path.join(baseDir, "workspaces", "plain", "hosts"));
      yield* write("userdata/settings.json");
      yield* write("userdata/statev2.sqlite");
      yield* write("userdata/statev2.sqlite-wal");
      yield* write("userdata/server-owner.sqlite");
      yield* write("userdata/logs/server.log");
      yield* write("userdata/usage-scan-cache-v11.json");
      yield* write("userdata/secrets/provider-env-a.bin");
      yield* write("userdata/secrets/provider-env-a.bin.123.tmp");
      yield* write("worktrees/app/feature/file.ts");

      const entries = yield* collectArchiveEntries(
        archiveRoots(
          {
            baseDir,
            stateDir: path.join(baseDir, "userdata"),
            dbPath: path.join(baseDir, "userdata", "statev2.sqlite"),
            worktreesDir: path.join(baseDir, "worktrees"),
          },
          false,
        ),
      );
      const files = new Set(
        entries.filter((entry) => entry.type !== "directory").map((entry) => entry.path),
      );
      for (const included of [
        "workspaces/app/.gitignore",
        "workspaces/app/src/index.ts",
        "workspaces/app/notes.md",
        "workspaces/app/.git/HEAD",
        "workspaces/plain/node_modules/kept.js",
        "skills/review/SKILL.md",
        "userdata/settings.json",
        "userdata/secrets/provider-env-a.bin",
      ]) {
        assert.isTrue(files.has(included), `${included} should be backed up`);
      }
      for (const excluded of [
        "workspaces/app/debug.log",
        "workspaces/app/node_modules/pkg/index.js",
        "workspaces/plain/hosts",
        "userdata/statev2.sqlite",
        "userdata/statev2.sqlite-wal",
        "userdata/server-owner.sqlite",
        "userdata/logs/server.log",
        "userdata/usage-scan-cache-v11.json",
        "userdata/secrets/provider-env-a.bin.123.tmp",
        "worktrees/app/feature/file.ts",
      ]) {
        assert.isFalse(files.has(excluded), `${excluded} should be left out`);
      }
      // A link into the archive becomes relative, so it works wherever the archive lands.
      assert.equal(
        entries.find((entry) => entry.path === "workspaces/plain/review")?.linkTarget,
        "../../skills/review",
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it("reads a repository's origin without credentials", () => {
  assert.equal(
    remoteUrlFromGitConfig(
      '[core]\n\tbare = false\n[remote "upstream"]\n\turl = git@example.com:up/app.git\n[remote "origin"]\n\turl = https://user:token@example.com/me/app.git\n',
    ),
    "https://example.com/me/app.git",
  );
  assert.equal(
    remoteUrlFromGitConfig('[remote "fork"]\n\turl = git@example.com:me/app.git\n'),
    "git@example.com:me/app.git",
  );
  assert.equal(remoteUrlFromGitConfig("[core]\n\tbare = false\n"), null);
});
