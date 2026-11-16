import { ProviderDriverKind } from "@codenine/contracts";
import { expandHomePath } from "@codenine/provider-core/server/pathExpansion";
import * as HostProcess from "@codenine/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveClaudeHomePath } from "./Drivers/ClaudeHome.ts";

/**
 * Agents whose own default login folder already exists on this machine. A new account for an
 * agent listed here signs in where the agent's command-line tool already keeps its login.
 */
export const findExistingAgentHomes = Effect.fn("findExistingAgentHomes")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const environment = yield* HostProcess.Environment;
  const codexFromEnvironment = environment.CODEX_HOME?.trim() ?? "";
  const homes = [
    [
      ProviderDriverKind.make("claudeAgent"),
      yield* resolveClaudeHomePath({ homePath: "" }, environment),
    ],
    [
      ProviderDriverKind.make("codex"),
      codexFromEnvironment.length > 0
        ? path.resolve(expandHomePath(codexFromEnvironment, home))
        : path.join(home, ".codex"),
    ],
  ] as const;
  const found: Array<ProviderDriverKind> = [];
  for (const [driver, folder] of homes) {
    if (yield* fileSystem.exists(folder).pipe(Effect.orElseSucceed(() => false)))
      found.push(driver);
  }
  return found;
});
