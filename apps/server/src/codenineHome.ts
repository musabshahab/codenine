import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { AGENTS_FOLDER } from "./agents/AgentFile.ts";
import { WORKFLOWS_FOLDER } from "./workflows/WorkflowFile.ts";
import { isWithinRoot } from "./workspace/KnownWorkspaces.ts";

const SKILLS_FOLDER = "skills";

const MAINTAINED =
  "Codenine maintains this file and updates it when it starts, so edits here do not last.";

export const CODENINE_HOME_README = `${MAINTAINED}

# Codenine folder

This folder holds what Codenine keeps on this computer. Back it up to keep your setup.

- \`workspaces/\` holds your workspaces. \`personal/\` is Personal, where each chat started without a
  workspace gets its own folder. Every other folder is a workspace you created or cloned in
  Codenine. Older installs keep Personal in \`scratch/\` and new workspaces in \`projects/\`.
- \`accounts/\` holds the Claude and Codex accounts you add in Codenine, in \`claude/<account>/\` and
  \`codex/<account>/\`. \`codex/shared/\`, when present, holds the history those Codex accounts share.
  Logins you already had in \`~/.claude\` and \`~/.codex\` stay where they are. These folders hold
  sign-ins, so treat them like a password.
- \`skills/\` holds your skills. Each folder in it with a \`SKILL.md\` is one skill, and every agent
  Codenine runs can use it.
- \`agents/\` holds the agents you set up. Each folder in it with an \`AGENT.md\` is one agent: what it
  does, its model, skills and connectors, and what it may do on this computer. Edit them on
  Codenine's Agents page.
- \`workflows/\` holds your workflows. Each folder in it is one: \`workflow.json\` says what runs and
  when, \`notes.md\` holds what its lead noted for future runs, and \`state.json\` is Codenine's record
  of its runs. Edit them on Codenine's Workflows page.
- \`worktrees/\` holds the separate checkouts Codenine makes so an agent can work on its own branch.
- \`userdata/\` holds Codenine's database, settings, logs, and the keys you saved, stored as plain
  files. Treat this folder like a password.
- \`tools/\` holds tools Codenine installs for itself, such as Codex.
- \`caches/\` holds files Codenine can rebuild. It is safe to delete.
- \`runtime/\` and \`bin/\`, when present, hold downloaded Codenine versions, the background
  service's state, and the \`codenine\` command. \`service.env\`, when present, sets the background
  service's environment variables.

When something goes wrong, the logs in \`userdata/logs/\` show what happened.
`;

export const CODENINE_SKILLS_README = `${MAINTAINED}

# Skills

Each folder here that holds a \`SKILL.md\` is a skill. Codenine gives these skills to every agent it
runs, in Claude Code and in Codex alike: it tells the agent which skills exist, and the agent reads
one when a task fits it. A skill you name in a message as \`$name\` goes with that message.

A workspace can keep skills of its own in its \`.agents/skills/\` folder. A workspace skill wins over
a skill here with the same name.

Add and edit skills on Codenine's Skills page, or edit the files here. Delete a skill's folder to
remove it.
`;

/** Writes the folder's guides and its skills, agents and workflows folders. */
export const writeCodenineHomeGuide = Effect.fn("CodenineHome.writeGuide")(function* (
  baseDir: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const writeIfChanged = (file: string, contents: string) =>
    fileSystem.readFileString(file).pipe(
      Effect.option,
      Effect.flatMap((current) =>
        Option.getOrUndefined(current) === contents
          ? Effect.void
          : fileSystem.writeFileString(file, contents),
      ),
    );
  const skillsRoot = path.join(baseDir, SKILLS_FOLDER);
  yield* writeIfChanged(path.join(baseDir, "README.md"), CODENINE_HOME_README);
  yield* fileSystem.makeDirectory(skillsRoot, { recursive: true });
  yield* writeIfChanged(path.join(skillsRoot, "README.md"), CODENINE_SKILLS_README);
  yield* fileSystem.makeDirectory(path.join(baseDir, AGENTS_FOLDER), { recursive: true });
  yield* fileSystem.makeDirectory(path.join(baseDir, WORKFLOWS_FOLDER), { recursive: true });
});

/**
 * Removes the links older versions made from one account's skills folder into the Codenine
 * folder's skills. Codenine gives agents those skills itself now, so a link would list each one
 * twice. Real folders and links to anywhere else are the account's own and stay.
 */
export const unlinkCodenineSkills = Effect.fn("CodenineHome.unlinkSkills")(
  function* (input: { readonly baseDir: string; readonly accountHome: string }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const skillsRoot = path.join(input.baseDir, SKILLS_FOLDER);
    const accountSkills = path.join(input.accountHome, SKILLS_FOLDER);
    const entries = yield* fileSystem
      .readDirectoryEntries(accountSkills)
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])));
    for (const entry of entries) {
      if (entry.type !== "SymbolicLink") continue;
      const link = path.join(accountSkills, entry.name);
      const target = yield* fileSystem.readLink(link).pipe(Effect.option);
      if (Option.isNone(target)) continue;
      const resolved = path.resolve(accountSkills, target.value);
      if (resolved === skillsRoot || !isWithinRoot(path, resolved, skillsRoot)) continue;
      yield* fileSystem
        .remove(link)
        .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void));
    }
  },
  Effect.ignore({
    log: "Warn",
    message: "Could not remove the Codenine folder's old skill links from an account.",
  }),
);
