import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type SkillError,
} from "@codenine/contracts";
import { symlinksSupported } from "@codenine/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Skills from "./Skills.ts";

const projectId = ProjectId.make("project-acme");

const makeFixture = Effect.fn("SkillsTest.makeFixture")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "codenine-skills-service-" }),
  );
  const baseDir = path.join(root, "codenine");
  const workspaceRoot = path.join(root, "acme-app");
  const writeFile = (file: string, contents: string) =>
    fileSystem
      .makeDirectory(path.dirname(file), { recursive: true })
      .pipe(Effect.andThen(fileSystem.writeFileString(file, contents)));
  const writeSkill = (folder: string, frontmatter: string, body = "Steps.") =>
    writeFile(path.join(folder, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`);
  return {
    fileSystem,
    path,
    root,
    baseDir,
    workspaceRoot,
    codenineSkills: path.join(baseDir, "skills"),
    workspaceSkills: path.join(workspaceRoot, ".agents", "skills"),
    writeFile,
    writeSkill,
  };
});

const provider = (
  driver: string,
  skills: ReadonlyArray<{ readonly name: string; readonly path: string }>,
) =>
  ({
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    skills: skills.map((skill) => ({ ...skill, enabled: true, description: `${skill.name} help` })),
  }) as unknown as ServerProvider;

const skillsLayer = (
  fixture: Effect.Success<ReturnType<typeof makeFixture>>,
  providers: ReadonlyArray<ServerProvider> = [],
) =>
  Skills.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ServerConfig.layerTest(fixture.root, fixture.baseDir),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          getShell: (id) =>
            Effect.succeed(
              id === projectId
                ? Option.some({ id, workspaceRoot: fixture.workspaceRoot } as never)
                : Option.none(),
            ),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed(providers) }),
      ),
    ),
  );

const reasonOf = <A>(effect: Effect.Effect<A, SkillError, Skills.Skills>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );

it.layer(NodeServices.layer)("Skills", (it) => {
  it.effect("saves a skill in either scope, edits it in place, and renames it", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const { fileSystem, path } = fixture;
      yield* Effect.gen(function* () {
        const skills = yield* Skills.Skills;
        const created = yield* skills.save({
          name: "deploy",
          description: "Ships the app.",
          instructions: "# Deploy",
          scope: "codenine",
        });
        expect(created).toMatchObject({
          name: "deploy",
          scope: "codenine",
          projectId: null,
          path: path.join(fixture.codenineSkills, "deploy"),
          fromLibrary: null,
        });

        const skillFile = path.join(fixture.codenineSkills, "deploy", "SKILL.md");
        yield* fileSystem.writeFileString(
          skillFile,
          "---\nname: deploy\ndescription: Ships the app.\nlicense: MIT\n---\n# Deploy\n",
        );
        yield* fixture.writeFile(
          path.join(fixture.codenineSkills, "deploy", "scripts", "run.sh"),
          "",
        );
        yield* skills.save({
          name: "deploy",
          description: "Ships the app to production.",
          instructions: "# Deploy\n\nRun scripts/run.sh.",
          scope: "codenine",
          previousName: "deploy",
        });
        expect(yield* fileSystem.readFileString(skillFile)).toBe(
          "---\nname: deploy\ndescription: Ships the app to production.\nlicense: MIT\n---\n\n# Deploy\n\nRun scripts/run.sh.\n",
        );

        const renamed = yield* skills.save({
          name: "ship-it",
          description: "Ships the app to production.",
          instructions: "# Ship it",
          scope: "codenine",
          previousName: "deploy",
        });
        expect(renamed.files).toEqual(["scripts/run.sh"]);
        expect(yield* fileSystem.exists(path.join(fixture.codenineSkills, "deploy"))).toBe(false);
        expect(yield* fileSystem.readFileString(path.join(renamed.path, "SKILL.md"))).toContain(
          "name: ship-it\n",
        );

        yield* skills.save({
          name: "notes",
          description: "Takes notes.",
          instructions: "",
          scope: "codenine",
        });
        // Creating never replaces a skill that already has the name.
        expect(
          yield* reasonOf(
            skills.save({
              name: "notes",
              description: "Other notes.",
              instructions: "",
              scope: "codenine",
            }),
          ),
        ).toBe("exists");
        expect(
          yield* reasonOf(
            skills.save({
              name: "notes",
              description: "Takes notes.",
              instructions: "",
              scope: "codenine",
              previousName: "ship-it",
            }),
          ),
        ).toBe("exists");
        expect(
          yield* reasonOf(
            skills.save({
              name: "gone",
              description: "Gone.",
              instructions: "",
              scope: "codenine",
              previousName: "missing",
            }),
          ),
        ).toBe("not-found");

        const shared = yield* skills.save({
          name: "deploy",
          description: "Ships this app.",
          instructions: "",
          scope: "workspace",
          projectId,
        });
        expect(shared).toMatchObject({
          scope: "workspace",
          projectId,
          path: path.join(fixture.workspaceSkills, "deploy"),
        });
        expect(
          yield* reasonOf(
            skills.save({
              name: "deploy",
              description: "Ships this app.",
              instructions: "",
              scope: "workspace",
            }),
          ),
        ).toBe("invalid");

        // Moving a skill to the other place takes its files and other frontmatter along.
        const moved = yield* skills.save({
          name: "ship-it",
          description: "Ships this app.",
          instructions: "# Ship it",
          scope: "workspace",
          projectId,
          previousName: "ship-it",
          previousScope: "codenine",
        });
        expect(moved).toMatchObject({
          scope: "workspace",
          path: path.join(fixture.workspaceSkills, "ship-it"),
          files: ["scripts/run.sh"],
        });
        expect(yield* fileSystem.readFileString(path.join(moved.path, "SKILL.md"))).toContain(
          "license: MIT\n",
        );
        expect(yield* fileSystem.exists(path.join(fixture.codenineSkills, "ship-it"))).toBe(false);
        // A move never replaces a skill already in the other place.
        expect(
          yield* reasonOf(
            skills.save({
              name: "deploy",
              description: "Ships this app.",
              instructions: "",
              scope: "workspace",
              projectId,
              previousName: "notes",
              previousScope: "codenine",
            }),
          ),
        ).toBe("exists");
        expect(yield* fileSystem.exists(path.join(fixture.codenineSkills, "notes"))).toBe(true);
      }).pipe(Effect.provide(skillsLayer(fixture)));
    }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "lists both scopes, the skills providers found outside Codenine, and the library",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const { fileSystem, path } = fixture;
        const claudeSkills = path.join(fixture.root, "claude", "skills");
        yield* fixture.writeSkill(
          path.join(fixture.codenineSkills, "notes"),
          "name: notes\ndescription: Codenine notes.",
        );
        yield* fixture.writeFile(
          path.join(fixture.codenineSkills, "broken", "SKILL.md"),
          "---\n[\n---\n",
        );
        yield* fixture.writeFile(path.join(fixture.codenineSkills, "Not A Skill", "SKILL.md"), "");
        yield* fixture.writeSkill(
          path.join(fixture.workspaceSkills, "notes"),
          "name: notes\ndescription: Workspace notes.",
        );
        yield* fixture.writeSkill(path.join(claudeSkills, "lint"), "name: lint");
        yield* fixture.writeSkill(path.join(fixture.root, "plugin", "review"), "name: review");
        yield* fileSystem.makeDirectory(claudeSkills, { recursive: true });
        // A link an older Codenine made: one of Codenine's own skills, not a found one.
        yield* fileSystem.symlink(
          path.join(fixture.codenineSkills, "notes"),
          path.join(claudeSkills, "notes"),
        );
        const providers = [
          provider("claudeAgent", [
            { name: "lint", path: path.join(claudeSkills, "lint", "SKILL.md") },
            { name: "notes", path: path.join(claudeSkills, "notes", "SKILL.md") },
            {
              name: "plugin:Review",
              path: path.join(fixture.root, "plugin", "review", "SKILL.md"),
            },
          ]),
          provider("codex", [{ name: "lint", path: path.join(claudeSkills, "lint", "SKILL.md") }]),
        ];
        yield* Effect.gen(function* () {
          const skills = yield* Skills.Skills;
          yield* skills.addFromLibrary({ name: "review-code" });
          yield* skills.save({
            name: "plugin-review",
            description: "Reviews.",
            instructions: "",
            scope: "codenine",
          });

          const listed = yield* skills.list({ projectId });
          expect(
            listed.skills.map(({ name, scope, description }) => [name, scope, description]),
          ).toEqual([
            ["broken", "codenine", ""],
            ["notes", "workspace", "Workspace notes."],
            ["notes", "codenine", "Codenine notes."],
            ["plugin-review", "codenine", "Reviews."],
            ["review-code", "codenine", expect.stringContaining("Reviews a code change")],
          ]);
          expect(listed.found).toEqual([
            {
              name: "lint",
              description: "lint help",
              providerInstanceId: ProviderInstanceId.make("claudeAgent"),
              providerName: "Claude Code",
              path: path.join(claudeSkills, "lint", "SKILL.md"),
              inCodenine: false,
            },
            expect.objectContaining({ name: "plugin:Review", inCodenine: true }),
          ]);
          expect(listed.library.filter((skill) => skill.added).map((skill) => skill.name)).toEqual([
            "review-code",
          ]);
          expect((yield* skills.list({})).skills.map((skill) => skill.scope)).not.toContain(
            "workspace",
          );
          expect(yield* reasonOf(skills.list({ projectId: ProjectId.make("gone") }))).toBe(
            "not-found",
          );
        }).pipe(Effect.provide(skillsLayer(fixture, providers)));
      }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "deletes a skill's folder, and only the link of a linked skill",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const { fileSystem, path } = fixture;
        const elsewhere = path.join(fixture.root, "team", "release");
        yield* fixture.writeSkill(path.join(fixture.codenineSkills, "notes"), "name: notes");
        yield* fixture.writeSkill(elsewhere, "name: release");
        yield* fileSystem.symlink(elsewhere, path.join(fixture.codenineSkills, "release"));
        yield* Effect.gen(function* () {
          const skills = yield* Skills.Skills;
          yield* skills.remove({ name: "notes", scope: "codenine" });
          yield* skills.remove({ name: "release", scope: "codenine" });
          expect(yield* fileSystem.readDirectory(fixture.codenineSkills)).toEqual([]);
          expect(yield* fileSystem.exists(path.join(elsewhere, "SKILL.md"))).toBe(true);
          expect(yield* reasonOf(skills.remove({ name: "notes", scope: "codenine" }))).toBe(
            "not-found",
          );
        }).pipe(Effect.provide(skillsLayer(fixture)));
      }),
  );

  it.effect("adds a library skill once, marked as added from the library", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* Effect.gen(function* () {
        const skills = yield* Skills.Skills;
        const added = yield* skills.addFromLibrary({ name: "write-a-skill" });
        expect(added).toMatchObject({ name: "write-a-skill", fromLibrary: "write-a-skill" });
        expect(
          (yield* skills.read({ name: "write-a-skill", scope: "codenine" })).instructions,
        ).toMatch(/^# Write a skill/);
        expect(yield* reasonOf(skills.addFromLibrary({ name: "write-a-skill" }))).toBe("exists");
        expect(yield* reasonOf(skills.addFromLibrary({ name: "no-such-skill" }))).toBe("not-found");
      }).pipe(Effect.provide(skillsLayer(fixture)));
    }),
  );

  it.effect("copies a found skill into Codenine under a valid name and leaves the original", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const { fileSystem, path } = fixture;
      const source = path.join(fixture.root, "plugin", "review");
      const original = "---\nname: review\ndescription: Reviews.\nlicense: MIT\n---\n\nSteps.\n";
      yield* fixture.writeFile(path.join(source, "SKILL.md"), original);
      yield* fixture.writeFile(path.join(source, "scripts", "check.sh"), "echo ok\n");
      const providers = [
        provider("claudeAgent", [{ name: "plugin:Review", path: path.join(source, "SKILL.md") }]),
      ];
      yield* Effect.gen(function* () {
        const skills = yield* Skills.Skills;
        const imported = yield* skills.importFound({ path: source });
        expect(imported).toMatchObject({
          name: "plugin-review",
          description: "Reviews.",
          files: ["scripts/check.sh"],
        });
        expect(yield* fileSystem.readFileString(path.join(imported.path, "SKILL.md"))).toBe(
          "---\nname: plugin-review\ndescription: Reviews.\nlicense: MIT\n---\n\nSteps.\n",
        );
        expect(yield* fileSystem.readFileString(path.join(source, "SKILL.md"))).toBe(original);
        expect(yield* reasonOf(skills.importFound({ path: path.join(source, "SKILL.md") }))).toBe(
          "exists",
        );
        expect(yield* reasonOf(skills.importFound({ path: fixture.root }))).toBe("not-found");

        // Any folder that holds a SKILL.md imports, named by the file or else the folder.
        const downloaded = path.join(fixture.root, "Downloads", "PDF Tools");
        yield* fixture.writeFile(path.join(downloaded, "SKILL.md"), "Fill in forms.\n");
        expect(yield* skills.importFound({ path: downloaded })).toMatchObject({
          name: "pdf-tools",
          scope: "codenine",
        });
        expect(yield* reasonOf(skills.importFound({ path: imported.path }))).toBe("exists");
      }).pipe(Effect.provide(skillsLayer(fixture, providers)));
    }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "gives agents a workspace skill before a Codenine one, and only files inside the skill",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const { fileSystem, path } = fixture;
        const workspaceNotes = path.join(fixture.workspaceSkills, "notes");
        yield* fixture.writeSkill(
          path.join(fixture.codenineSkills, "notes"),
          "name: notes",
          "Codenine.",
        );
        yield* fixture.writeSkill(path.join(fixture.codenineSkills, "plan"), "name: plan");
        yield* fixture.writeSkill(workspaceNotes, "name: notes", "Workspace.");
        yield* fixture.writeFile(path.join(workspaceNotes, "references", "guide.md"), "Guide.");
        yield* fixture.writeFile(path.join(workspaceNotes, "assets", "logo.png"), "\u0000PNG");
        yield* fixture.writeFile(path.join(fixture.root, "secret.txt"), "secret");
        yield* fileSystem.symlink(
          path.join(fixture.root, "secret.txt"),
          path.join(workspaceNotes, "references", "linked.md"),
        );
        yield* Effect.gen(function* () {
          const skills = yield* Skills.Skills;
          expect(yield* skills.readForAgent({ name: "notes", projectId })).toEqual({
            name: "notes",
            folder: workspaceNotes,
            files: ["assets/logo.png", "references/guide.md", "references/linked.md"],
            text: "Workspace.",
          });
          expect((yield* skills.readForAgent({ name: "notes", projectId: undefined })).text).toBe(
            "Codenine.",
          );
          expect((yield* skills.readForAgent({ name: "$notes", projectId })).folder).toBe(
            workspaceNotes,
          );
          expect(
            (yield* skills.readForAgent({ name: "notes", projectId, file: "references/guide.md" }))
              .text,
          ).toBe("Guide.");
          for (const [file, reason] of [
            ["../../../secret.txt", "invalid"],
            [path.join(fixture.root, "secret.txt"), "invalid"],
            ["references/linked.md", "invalid"],
            ["assets/logo.png", "invalid"],
            ["references/missing.md", "not-found"],
          ] as const) {
            expect(yield* reasonOf(skills.readForAgent({ name: "notes", projectId, file }))).toBe(
              reason,
            );
          }
          expect(yield* reasonOf(skills.readForAgent({ name: "nope", projectId }))).toBe(
            "not-found",
          );
          expect(
            (yield* skills.available(projectId)).map(({ name, scope }) => [name, scope]),
          ).toEqual([
            ["notes", "workspace"],
            ["plan", "codenine"],
          ]);
        }).pipe(Effect.provide(skillsLayer(fixture)));
      }),
  );
});
