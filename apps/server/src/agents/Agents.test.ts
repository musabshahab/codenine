import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  type AgentDefinition,
  type AgentError,
  ProviderInstanceId,
  type ServerProvider,
} from "@codenine/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Agents from "./Agents.ts";

const claude = ProviderInstanceId.make("claude_work");

const snapshot = (instanceId: string, enabled: boolean, models: ReadonlyArray<string>) =>
  ({
    instanceId: ProviderInstanceId.make(instanceId),
    enabled,
    models: models.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
  }) as unknown as ServerProvider;

const reviewer: AgentDefinition = {
  name: "code-reviewer",
  title: "Code reviewer",
  description: "Reviews pull requests.",
  instructions: "Read the diff first.",
  model: { instanceId: claude, model: "claude-x", effort: "high" },
  skills: [],
  connectors: [],
  abilities: { readFiles: true, editFiles: false, runCommands: false, searchWeb: false },
};

const failure = <A>(effect: Effect.Effect<A, AgentError>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );

describe("agentModelStatus", () => {
  it.each([
    ["no model chosen", null, "no-model"],
    ["an account that is gone", { instanceId: "claude_gone", model: "claude-x" }, "account-off"],
    ["an account turned off", { instanceId: "claude_off", model: "claude-x" }, "account-off"],
    [
      "a model the account no longer offers",
      { instanceId: "claude_work", model: "old" },
      "model-missing",
    ],
    ["a model the account offers", { instanceId: "claude_work", model: "claude-x" }, "ready"],
  ] as const)("%s", (_label, model, status) => {
    expect(
      Agents.agentModelStatus(
        model === null
          ? null
          : {
              instanceId: ProviderInstanceId.make(model.instanceId),
              model: model.model,
              effort: "low",
            },
        [snapshot("claude_work", true, ["claude-x"]), snapshot("claude_off", false, ["claude-x"])],
      ),
    ).toBe(status);
  });
});

it.layer(NodeServices.layer)("Agents", (it) => {
  const withAgents = <A, E>(
    effect: Effect.Effect<A, E, Agents.Agents | FileSystem.FileSystem | Path.Path>,
  ) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.realPath(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "codenine-agents-" }),
      );
      return yield* effect.pipe(
        Effect.provide(
          Agents.layer.pipe(
            Layer.provide(ServerConfig.layerTest(baseDir, baseDir)),
            Layer.provide(
              Layer.mock(ProviderRegistry.ProviderRegistry)({
                getProviders: Effect.succeed([snapshot("claude_work", true, ["claude-x"])]),
              }),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped);

  it.effect("creates, lists by title, renames and deletes agents", () =>
    withAgents(
      Effect.gen(function* () {
        const agents = yield* Agents.Agents;
        const path = yield* Path.Path;
        const saved = yield* agents.save({ agent: reviewer });
        expect(saved.modelStatus).toBe("ready");
        expect(path.basename(saved.path)).toBe("code-reviewer");
        yield* agents.save({
          agent: { ...reviewer, name: "archivist", title: "Archivist", model: null },
        });
        expect(yield* failure(agents.save({ agent: { ...reviewer, title: "Twin" } }))).toBe(
          "exists",
        );

        const listed = yield* agents.list;
        expect(listed.agents.map((agent) => [agent.name, agent.modelStatus])).toEqual([
          ["archivist", "no-model"],
          ["code-reviewer", "ready"],
        ]);
        expect("instructions" in listed.agents[0]!).toBe(false);
        expect(yield* agents.read({ name: "code-reviewer" })).toMatchObject({
          ...reviewer,
          path: saved.path,
        });

        expect(
          yield* failure(
            agents.save({
              agent: { ...reviewer, name: "archivist" },
              previousName: "code-reviewer",
            }),
          ),
        ).toBe("exists");
        expect(yield* failure(agents.save({ agent: reviewer, previousName: "never-made" }))).toBe(
          "not-found",
        );
        yield* agents.save({
          agent: { ...reviewer, name: "reviewer", instructions: "Be brief." },
          previousName: "code-reviewer",
        });
        expect(yield* failure(agents.read({ name: "code-reviewer" }))).toBe("not-found");
        expect((yield* agents.read({ name: "reviewer" })).instructions).toBe("Be brief.");

        yield* agents.remove({ name: "reviewer" });
        expect(Option.isNone(yield* agents.find("reviewer"))).toBe(true);
        expect(yield* failure(agents.remove({ name: "reviewer" }))).toBe("not-found");
      }),
    ),
  );

  it.effect("leaves an unreadable AGENT.md out of the list, and no chat gets it", () =>
    withAgents(
      Effect.gen(function* () {
        const agents = yield* Agents.Agents;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const saved = yield* agents.save({ agent: reviewer });
        const root = path.dirname(saved.path);
        yield* fileSystem.makeDirectory(path.join(root, "broken"));
        yield* fileSystem.writeFileString(
          path.join(root, "broken", "AGENT.md"),
          "---\ntitle: [unclosed\n---\nBody\n",
        );
        yield* fileSystem.makeDirectory(path.join(root, "Not An Agent"));
        yield* fileSystem.writeFileString(path.join(root, "README.md"), "Notes.");

        expect((yield* agents.list).agents.map((agent) => agent.name)).toEqual(["code-reviewer"]);
        expect(yield* failure(agents.read({ name: "broken" }))).toBe("invalid");
        expect(Option.isNone(yield* agents.find("broken"))).toBe(true);
        expect(yield* agents.chatConnectors({ agent: "broken" })).toEqual({
          selection: [],
          approvals: new Map(),
        });
        // Deleting still works, so the user can start over.
        yield* agents.remove({ name: "broken" });
        expect(yield* fileSystem.exists(path.join(root, "broken"))).toBe(false);
      }),
    ),
  );
});
