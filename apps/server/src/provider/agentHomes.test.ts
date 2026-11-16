import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@codenine/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { findExistingAgentHomes } from "./agentHomes.ts";

it.layer(NodeServices.layer)("findExistingAgentHomes", (it) => {
  it.effect("finds each agent's login folder, honouring CLAUDE_CONFIG_DIR and CODEX_HOME", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codenine-agent-homes-" });
      const find = (environment: NodeJS.ProcessEnv) =>
        findExistingAgentHomes().pipe(
          Effect.provideService(HostProcess.HomeDirectory, home),
          Effect.provideService(HostProcess.Environment, environment),
        );

      expect(yield* find({})).toEqual([]);
      yield* fileSystem.makeDirectory(path.join(home, ".claude"));
      expect(yield* find({})).toEqual(["claudeAgent"]);
      // A configured folder replaces the default, so ~/.claude no longer counts.
      yield* fileSystem.makeDirectory(path.join(home, "codex-home"));
      expect(
        yield* find({ CLAUDE_CONFIG_DIR: path.join(home, "missing"), CODEX_HOME: "~/codex-home" }),
      ).toEqual(["codex"]);
    }),
  );
});
