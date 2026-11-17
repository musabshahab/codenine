import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProjectId } from "@codenine/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { skillRoots } from "./SkillFolders.ts";
import { mentionedSkillNames, skillTurnContext } from "./SkillTurnContext.ts";

describe("mentionedSkillNames", () => {
  it("follows the composer's token rules", () => {
    expect(
      mentionedSkillNames("$review-code this, then €deploy and $review-code again. $plan. $5 cost"),
    ).toEqual(["review-code", "deploy"]);
  });
});

it.layer(NodeServices.layer)("skillTurnContext", (it) => {
  it.effect("attaches each named skill, workspace first, and only names the kept-on skills", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codenine-turn-skills-" });
      const baseDir = path.join(root, "codenine");
      const workspaceRoot = path.join(root, "acme-app");
      const writeSkill = (folder: string, description: string, body: string) =>
        fileSystem
          .makeDirectory(folder, { recursive: true })
          .pipe(
            Effect.andThen(
              fileSystem.writeFileString(
                path.join(folder, "SKILL.md"),
                `---\nname: ${path.basename(folder)}\ndescription: ${description}\n---\n\n${body}\n`,
              ),
            ),
          );
      const workspaceDeploy = path.join(workspaceRoot, ".agents", "skills", "deploy");
      yield* writeSkill(workspaceDeploy, "Ships this app.", "Run scripts/ship.sh.");
      yield* fileSystem.makeDirectory(path.join(workspaceDeploy, "scripts"));
      yield* fileSystem.writeFileString(path.join(workspaceDeploy, "scripts", "ship.sh"), "");
      yield* writeSkill(path.join(baseDir, "skills", "deploy"), "Ships anything.", "Generic.");
      yield* writeSkill(path.join(baseDir, "skills", "review-code"), "Reviews.", "Review it.");
      yield* writeSkill(path.join(baseDir, "skills", "write-clear-emails"), "Emails.", "Write.");

      const turn = yield* skillTurnContext({
        roots: skillRoots(
          { baseDir, workspace: { projectId: ProjectId.make("acme"), workspaceRoot } },
          path,
        ),
        text: "Use $deploy for staging, not $unknown.",
        keptOn: ["deploy", "write-clear-emails", "deleted-skill"],
      });

      expect(turn.skills).toEqual({
        available: [
          { name: "deploy", description: "Ships this app." },
          { name: "review-code", description: "Reviews." },
          { name: "write-clear-emails", description: "Emails." },
        ],
        attached: ["deploy"],
      });
      expect(turn.context).toHaveLength(2);
      expect(turn.context[0]).toContain(`folder="${workspaceDeploy}"`);
      expect(turn.context[0]).toContain("Its folder also holds scripts/ship.sh.");
      expect(turn.context[0]).toContain("Run scripts/ship.sh.");
      expect(turn.context[0]).not.toContain("Generic.");
      expect(turn.context[1]).toContain("keeps these skills on for this chat: write-clear-emails.");

      const quiet = yield* skillTurnContext({
        roots: skillRoots({ baseDir }, path),
        text: "Fix the build.",
        keptOn: [],
      });
      expect(quiet.context).toEqual([]);
      expect(quiet.skills.attached).toEqual([]);
    }),
  );
});
