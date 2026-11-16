import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { isWithinRoot } from "./workspace/KnownWorkspaces.ts";

const SKILLS_FOLDER = "skills";
const SKILL_FILE = "SKILL.md";

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
- \`skills/\` holds skills every agent account can use. Each folder in it with a \`SKILL.md\` is one
  skill.
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

Each folder here that holds a \`SKILL.md\` is a skill every agent account can use, in Claude and in
Codex. Codenine links each skill into every account's own skills folder, so a new skill reaches an
account the next time Codenine checks it, such as when Codenine starts or after you sign in.

An account keeps its own skill when one here has the same name. Delete a skill here and Codenine
removes its links.
`;

/** Writes the folder's map and its skills folder; Codenine owns both READMEs. */
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
});

/**
 * Links each skill in the Codenine folder into one account's own skills folder. An account folder
 * that does not exist yet stays missing: Claude creates its own at sign-in, and Codenine never
 * creates ~/.claude or ~/.codex.
 */
export const linkCodenineSkills = Effect.fn("CodenineHome.linkSkills")(
  function* (input: { readonly baseDir: string; readonly accountHome: string }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!(yield* fileSystem.exists(input.accountHome))) return;
    const skillsRoot = path.join(input.baseDir, SKILLS_FOLDER);
    const accountSkills = path.join(input.accountHome, SKILLS_FOLDER);
    const readEntries = (directory: string) =>
      fileSystem
        .readDirectoryEntries(directory)
        .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])));
    // Only a broken link into the skills folder is Codenine's to remove; a doubtful one stays.
    for (const entry of yield* readEntries(accountSkills)) {
      if (entry.type !== "SymbolicLink") continue;
      const link = path.join(accountSkills, entry.name);
      const target = yield* fileSystem.readLink(link).pipe(Effect.option);
      if (Option.isNone(target)) continue;
      const resolved = path.resolve(accountSkills, target.value);
      const broken = !(yield* fileSystem.exists(resolved).pipe(Effect.orElseSucceed(() => true)));
      if (broken && isWithinRoot(path, resolved, skillsRoot)) {
        yield* fileSystem
          .remove(link)
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void));
      }
    }

    const skills: Array<string> = [];
    for (const entry of yield* readEntries(skillsRoot)) {
      if (entry.name.startsWith(".")) continue;
      const skillFile = path.join(skillsRoot, entry.name, SKILL_FILE);
      if (yield* fileSystem.exists(skillFile).pipe(Effect.orElseSucceed(() => false))) {
        skills.push(entry.name);
      }
    }
    if (skills.length === 0) return;
    yield* fileSystem.makeDirectory(accountSkills, { recursive: true });
    for (const name of skills) {
      const link = path.join(accountSkills, name);
      // Anything already there, even a broken link, belongs to the account.
      const taken = yield* fileSystem.lstat(link).pipe(
        Effect.as(true),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
      );
      if (taken) continue;
      // Accounts sharing one home link it at the same time; the loser finds the link made.
      yield* fileSystem
        .symlink(path.join(skillsRoot, name), link)
        .pipe(Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.void));
    }
  },
  Effect.ignore({
    log: "Warn",
    message: "Could not link the Codenine folder's skills into an account.",
  }),
);
