import {
  type AgentConnector,
  type AgentDefinition,
  type AgentDetail,
  AgentError,
  type AgentModel,
  type AgentModelStatus,
  AgentName,
  type AgentSaveInput,
  type AgentSummary,
  type AgentsListResult,
  type ConnectionId,
  type OrchestrationV2AppThread,
  type ServerProvider,
} from "@codenine/contracts";
import { writeFileStringAtomically } from "@codenine/shared/atomicWrite";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { isWithinRoot } from "../workspace/KnownWorkspaces.ts";
import { AGENT_FILE, AGENTS_FOLDER, parseAgentFile, renderAgentFile } from "./AgentFile.ts";

const AGENT_FILE_MAX_BYTES = 1024 * 1024;

const isAgentName = Schema.is(AgentName);

/** Whether an agent can run on its model, judged from the accounts' current snapshots. */
export const agentModelStatus = (
  model: AgentModel | null,
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "enabled" | "models">>,
): AgentModelStatus => {
  if (model === null) return "no-model";
  const provider = providers.find((candidate) => candidate.instanceId === model.instanceId);
  if (provider === undefined || !provider.enabled) return "account-off";
  return provider.models.some((candidate) => candidate.slug === model.model)
    ? "ready"
    : "model-missing";
};

type AgentRead =
  | { readonly _tag: "missing" }
  | { readonly _tag: "broken"; readonly folder: string }
  | {
      readonly _tag: "found";
      readonly agent: AgentDefinition;
      readonly folder: string;
      readonly updatedAt: string;
    };

export class Agents extends Context.Service<
  Agents,
  {
    /** By title. An agent whose AGENT.md cannot be read is logged and left out. */
    readonly list: Effect.Effect<typeof AgentsListResult.Type, AgentError>;
    readonly read: (input: { readonly name: AgentName }) => Effect.Effect<AgentDetail, AgentError>;
    /** Without `previousName` creates an agent and never replaces one; with it, edits or renames that agent. */
    readonly save: (input: AgentSaveInput) => Effect.Effect<AgentSummary, AgentError>;
    readonly remove: (input: { readonly name: AgentName }) => Effect.Effect<void, AgentError>;
    /** The agent a chat names; none when its file is gone or cannot be read. */
    readonly find: (name: AgentName) => Effect.Effect<Option.Option<AgentDefinition>>;
    /**
     * The connections a chat picks, with its agent's approvals for each: the agent's when it talks
     * to one (none when that agent is gone), else its own list (undefined: the ones on by default).
     */
    readonly chatConnectors: (
      thread: Pick<OrchestrationV2AppThread, "agent" | "connectors">,
    ) => Effect.Effect<{
      readonly selection: ReadonlyArray<ConnectionId> | undefined;
      readonly approvals: ReadonlyMap<ConnectionId, AgentConnector["approvals"]>;
    }>;
  }
>()("codenine/agents/Agents") {}

const toSummary = ({ instructions: _instructions, ...summary }: AgentDetail): AgentSummary =>
  summary;

/** Logs what went wrong and tells the user only what failed. */
const failed = (detail: string) => (cause: unknown) =>
  Effect.logWarning(detail, { cause }).pipe(
    Effect.andThen(Effect.fail(new AgentError({ reason: "failed", detail }))),
  );

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { baseDir } = yield* ServerConfig.ServerConfig;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const root = path.join(baseDir, AGENTS_FOLDER);
  const fileOf = (name: string) => path.join(root, name, AGENT_FILE);
  const withFileSystem = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  // Untraced: it runs once per agent inside the traced list, read and find that call it.
  const readAgent = Effect.fnUntraced(function* (name: AgentName): Effect.fn.Return<AgentRead> {
    const folder = path.join(root, name);
    const info = yield* fileSystem.stat(fileOf(name)).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "File") return { _tag: "missing" };
    const contents =
      Number(info.value.size) > AGENT_FILE_MAX_BYTES
        ? undefined
        : yield* fileSystem.readFileString(fileOf(name)).pipe(Effect.option);
    const agent =
      contents === undefined || Option.isNone(contents)
        ? undefined
        : parseAgentFile(name, contents.value);
    if (agent === undefined) {
      yield* Effect.logWarning("Codenine could not read an agent's AGENT.md.", { folder });
      return { _tag: "broken", folder };
    }
    return {
      _tag: "found",
      agent,
      folder,
      updatedAt: DateTime.formatIso(
        Option.match(info.value.mtime, {
          onNone: () => DateTime.makeUnsafe(0),
          onSome: DateTime.fromDateUnsafe,
        }),
      ),
    };
  });

  const detailOf = (
    found: Extract<AgentRead, { readonly _tag: "found" }>,
    snapshots: ReadonlyArray<ServerProvider>,
  ): AgentDetail => ({
    ...found.agent,
    path: found.folder,
    updatedAt: found.updatedAt,
    modelStatus: agentModelStatus(found.agent.model, snapshots),
  });

  const readOrFail = Effect.fn("Agents.readOrFail")(function* (name: AgentName) {
    const read = yield* readAgent(name);
    switch (read._tag) {
      case "missing":
        return yield* new AgentError({
          reason: "not-found",
          detail: `There is no agent named ${name}.`,
        });
      case "broken":
        return yield* new AgentError({
          reason: "invalid",
          detail: `Codenine cannot read ${path.join(read.folder, AGENT_FILE)}. Fix its frontmatter, or delete the agent.`,
        });
      case "found":
        return detailOf(read, yield* providers.getProviders);
    }
  });

  const list: Agents["Service"]["list"] = Effect.gen(function* () {
    const entries = yield* fileSystem
      .readDirectoryEntries(root)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<FileSystem.DirectoryEntry> => []));
    const names = entries
      .filter((entry) => entry.type !== "File")
      .map((entry) => entry.name)
      .filter(isAgentName);
    const reads = yield* Effect.forEach(names, readAgent, { concurrency: 8 });
    const snapshots = yield* providers.getProviders;
    return {
      agents: reads
        .flatMap((read) => (read._tag === "found" ? [toSummary(detailOf(read, snapshots))] : []))
        .sort(
          (left, right) =>
            left.title.localeCompare(right.title, undefined, { sensitivity: "base" }) ||
            left.name.localeCompare(right.name),
        ),
    };
  }).pipe(Effect.withSpan("Agents.list"));

  const read: Agents["Service"]["read"] = Effect.fn("Agents.read")(function* (input) {
    return yield* readOrFail(input.name);
  });

  const occupied = (target: string) =>
    fileSystem.lstat(target).pipe(
      Effect.as(true),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
      Effect.catchTags({ PlatformError: failed("Could not check the agents folder.") }),
    );

  const write = (name: AgentName, contents: string) =>
    withFileSystem(writeFileStringAtomically({ filePath: fileOf(name), contents }));

  const save: Agents["Service"]["save"] = Effect.fn("Agents.save")(function* (input) {
    const { agent, previousName } = input;
    const target = path.join(root, agent.name);
    const couldNotSave = failed("Could not save the agent.");
    if (new TextEncoder().encode(renderAgentFile(agent)).length > AGENT_FILE_MAX_BYTES) {
      return yield* new AgentError({
        reason: "invalid",
        detail: "These instructions are too long to save. Keep them under 1 MB.",
      });
    }
    const taken = new AgentError({
      reason: "exists",
      detail: `An agent named ${agent.name} already exists.`,
    });
    yield* fileSystem
      .makeDirectory(root, { recursive: true })
      .pipe(Effect.catchTags({ PlatformError: couldNotSave }));
    if (previousName === undefined) {
      // Claiming the folder first means two creates of one name cannot both write it.
      yield* fileSystem.makeDirectory(target).pipe(
        Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.fail(taken)),
        Effect.catchTags({ PlatformError: couldNotSave }),
      );
      yield* write(agent.name, renderAgentFile(agent)).pipe(
        Effect.catchTags({ PlatformError: couldNotSave }),
        Effect.tapError(() => fileSystem.remove(target, { recursive: true }).pipe(Effect.ignore)),
      );
      return toSummary(yield* readOrFail(agent.name));
    }
    if ((yield* readAgent(previousName))._tag === "missing") {
      return yield* new AgentError({
        reason: "not-found",
        detail: `There is no agent named ${previousName}.`,
      });
    }
    if (previousName !== agent.name) {
      if (yield* occupied(target)) return yield* taken;
      yield* fileSystem
        .rename(path.join(root, previousName), target)
        .pipe(Effect.catchTags({ PlatformError: couldNotSave }));
    }
    const existing = yield* fileSystem.readFileString(fileOf(agent.name)).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined),
      Effect.catchTags({ PlatformError: couldNotSave }),
    );
    yield* write(agent.name, renderAgentFile(agent, existing)).pipe(
      Effect.catchTags({ PlatformError: couldNotSave }),
    );
    return toSummary(yield* readOrFail(agent.name));
  });

  const remove: Agents["Service"]["remove"] = Effect.fn("Agents.remove")(function* (input) {
    const target = path.join(root, input.name);
    const couldNotDelete = failed("Could not delete the agent.");
    const info = yield* fileSystem.lstat(target).pipe(
      Effect.catchReason("PlatformError", "NotFound", () =>
        Effect.fail(
          new AgentError({ reason: "not-found", detail: `There is no agent named ${input.name}.` }),
        ),
      ),
      Effect.catchTags({ PlatformError: couldNotDelete }),
    );
    // A linked agent folder loses only its link; what it points at is someone else's.
    if (info.type === "SymbolicLink") {
      return yield* fileSystem
        .remove(target)
        .pipe(Effect.catchTags({ PlatformError: couldNotDelete }));
    }
    const [realRoot, realTarget] = yield* Effect.all([
      fileSystem.realPath(root),
      fileSystem.realPath(target),
    ]).pipe(Effect.catchTags({ PlatformError: couldNotDelete }));
    if (realTarget === realRoot || !isWithinRoot(path, realTarget, realRoot)) {
      return yield* new AgentError({
        reason: "invalid",
        detail: "That folder is outside the agents folder.",
      });
    }
    yield* fileSystem
      .remove(target, { recursive: true })
      .pipe(Effect.catchTags({ PlatformError: couldNotDelete }));
  });

  const find: Agents["Service"]["find"] = Effect.fn("Agents.find")(function* (name) {
    const read = yield* readAgent(name);
    return read._tag === "found" ? Option.some(read.agent) : Option.none();
  });

  const chatConnectors: Agents["Service"]["chatConnectors"] = Effect.fn("Agents.chatConnectors")(
    function* (thread) {
      if (thread.agent === undefined) return { selection: thread.connectors, approvals: new Map() };
      const connectors = Option.match(yield* find(thread.agent), {
        onNone: (): ReadonlyArray<AgentConnector> => [],
        onSome: (agent) => agent.connectors,
      });
      return {
        selection: connectors.map((connector) => connector.id),
        approvals: new Map(connectors.map((connector) => [connector.id, connector.approvals])),
      };
    },
  );

  return Agents.of({ list, read, save, remove, find, chatConnectors });
});

export const layer = Layer.effect(Agents, make);
