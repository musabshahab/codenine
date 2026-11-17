import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { symlinksSupported } from "@codenine/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  CODENINE_HOME_README,
  CODENINE_SKILLS_README,
  unlinkCodenineSkills,
  writeCodenineHomeGuide,
} from "./codenineHome.ts";

it.layer(NodeServices.layer)("codenineHome", (it) => {
  it.effect("writes the folder's guide once and rewrites it when it goes stale", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codenine-home-" });
      const readme = path.join(baseDir, "README.md");
      const skillsReadme = path.join(baseDir, "skills", "README.md");

      yield* writeCodenineHomeGuide(baseDir);
      expect(yield* fileSystem.readFileString(readme)).toBe(CODENINE_HOME_README);
      expect(CODENINE_HOME_README.split("\n")[0]).toContain("Codenine maintains this file");
      expect(yield* fileSystem.readFileString(skillsReadme)).toBe(CODENINE_SKILLS_README);
      expect((yield* fileSystem.stat(path.join(baseDir, "agents"))).type).toBe("Directory");

      yield* fileSystem.utimes(readme, 0, 0);
      yield* writeCodenineHomeGuide(baseDir);
      expect(Option.getOrThrow((yield* fileSystem.stat(readme)).mtime).getTime()).toBe(0);

      yield* fileSystem.writeFileString(readme, "# My notes\n");
      yield* fileSystem.writeFileString(skillsReadme, "# Old skills guide\n");
      yield* writeCodenineHomeGuide(baseDir);
      expect(yield* fileSystem.readFileString(readme)).toBe(CODENINE_HOME_README);
      expect(yield* fileSystem.readFileString(skillsReadme)).toBe(CODENINE_SKILLS_README);
    }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "removes only an account's links into the Codenine skills, never its own skills or other links",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codenine-skills-" });
        const baseDir = path.join(root, "codenine");
        const skills = path.join(baseDir, "skills");
        const accountSkills = path.join(root, "account", "skills");
        const writeSkill = (folder: string) =>
          fileSystem
            .makeDirectory(folder, { recursive: true })
            .pipe(
              Effect.andThen(fileSystem.writeFileString(path.join(folder, "SKILL.md"), "---\n")),
            );
        yield* writeSkill(path.join(skills, "review"));
        yield* writeSkill(path.join(accountSkills, "deploy"));
        yield* writeSkill(path.join(root, "shared", "lint"));
        yield* fileSystem.symlink(path.join(skills, "review"), path.join(accountSkills, "review"));
        yield* fileSystem.symlink(path.join(skills, "gone"), path.join(accountSkills, "gone"));
        yield* fileSystem.symlink(
          path.join(root, "shared", "lint"),
          path.join(accountSkills, "lint"),
        );
        yield* fileSystem.symlink(
          path.join(root, "missing"),
          path.join(accountSkills, "elsewhere"),
        );
        yield* fileSystem.symlink(skills, path.join(accountSkills, "all"));

        yield* unlinkCodenineSkills({ baseDir, accountHome: path.join(root, "account") });

        expect([...(yield* fileSystem.readDirectory(accountSkills))].sort()).toEqual([
          "all",
          "deploy",
          "elsewhere",
          "lint",
        ]);
        expect((yield* fileSystem.lstat(path.join(accountSkills, "deploy"))).type).toBe(
          "Directory",
        );
        expect(yield* fileSystem.exists(path.join(skills, "review", "SKILL.md"))).toBe(true);
      }),
  );

  it.effect("leaves an account that has no skills folder alone", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codenine-skills-" });
      const accountHome = path.join(root, "accounts", "claude", "work");

      yield* unlinkCodenineSkills({ baseDir: path.join(root, "codenine"), accountHome });

      expect(yield* fileSystem.exists(accountHome)).toBe(false);
    }),
  );
});
