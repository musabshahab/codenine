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
  linkCodenineSkills,
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
    "links each skill into an account, never over its own, and removes only broken links of ours",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codenine-skills-" });
        const baseDir = path.join(root, "codenine");
        const skills = path.join(baseDir, "skills");
        const accountHome = path.join(root, "account");
        const accountSkills = path.join(accountHome, "skills");
        const writeSkill = (folder: string) =>
          fileSystem
            .makeDirectory(folder, { recursive: true })
            .pipe(
              Effect.andThen(fileSystem.writeFileString(path.join(folder, "SKILL.md"), "---\n")),
            );
        yield* writeSkill(path.join(skills, "review"));
        yield* writeSkill(path.join(skills, "deploy"));
        yield* writeSkill(path.join(skills, ".hidden"));
        yield* fileSystem.makeDirectory(path.join(skills, "draft"));
        yield* fileSystem.writeFileString(path.join(skills, "README.md"), "guide\n");
        yield* writeSkill(path.join(accountSkills, "deploy"));
        yield* fileSystem.symlink(
          path.join(skills, "renamed"),
          path.join(accountSkills, "renamed"),
        );
        yield* fileSystem.symlink(path.join(root, "gone"), path.join(accountSkills, "elsewhere"));

        const link = () => linkCodenineSkills({ baseDir, accountHome });
        yield* link();
        yield* link();

        expect(yield* fileSystem.readLink(path.join(accountSkills, "review"))).toBe(
          path.join(skills, "review"),
        );
        expect((yield* fileSystem.lstat(path.join(accountSkills, "deploy"))).type).toBe(
          "Directory",
        );
        expect(yield* fileSystem.readLink(path.join(accountSkills, "elsewhere"))).toBe(
          path.join(root, "gone"),
        );
        expect([...(yield* fileSystem.readDirectory(accountSkills))].sort()).toEqual([
          "deploy",
          "elsewhere",
          "review",
        ]);

        yield* fileSystem.remove(path.join(skills, "review"), { recursive: true });
        yield* link();
        expect([...(yield* fileSystem.readDirectory(accountSkills))].sort()).toEqual([
          "deploy",
          "elsewhere",
        ]);
      }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "leaves an account folder that does not exist yet for the agent to create",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codenine-skills-" });
        const baseDir = path.join(root, "codenine");
        yield* fileSystem.makeDirectory(path.join(baseDir, "skills", "review"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          path.join(baseDir, "skills", "review", "SKILL.md"),
          "---\n",
        );
        const missing = path.join(root, "accounts", "claude", "work");
        const signedIn = path.join(root, "accounts", "claude", "personal");
        yield* fileSystem.makeDirectory(signedIn, { recursive: true });

        yield* linkCodenineSkills({ baseDir, accountHome: missing });
        yield* linkCodenineSkills({ baseDir, accountHome: signedIn });

        expect(yield* fileSystem.exists(missing)).toBe(false);
        expect(yield* fileSystem.readLink(path.join(signedIn, "skills", "review"))).toBe(
          path.join(baseDir, "skills", "review"),
        );
      }),
  );
});
