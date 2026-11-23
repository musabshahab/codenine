import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MediaModelId,
  ProviderInstanceId,
  type RuntimeMode,
  ThreadId,
} from "@codenine/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { McpSchema, McpServer } from "effect/ai";
import { HttpClient } from "effect/http";

import * as CheckpointStore from "../../../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as ConnectorStore from "../../../connectors/ConnectorStore.ts";
import * as FileVersionStorage from "../../../fileVersions/FileVersionStorage.ts";
import * as FileVersions from "../../../fileVersions/FileVersions.ts";
import * as Media from "../../../media/Media.ts";
import type { MediaAdapter, MediaAdapterRequest } from "../../../media/MediaAdapter.ts";
import { MediaAdapters } from "../../../media/MediaProviders.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as KnownWorkspaces from "../../../workspace/KnownWorkspaces.ts";
import * as WorkspaceEntries from "../../../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../../../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";

const KEY = "key-live-0123456789";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const threadId = ThreadId.make("media-thread");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("media-environment"),
  requestNamespace: "media-session",
  thread: {
    threadId,
    providerSessionId: "media-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "media", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "media", version: "1" },
  },
  getClient: Effect.die("unused"),
});

// The chat and its provider, set by each test's `setup` and read by the mocks below.
const chat = {
  root: "",
  interactionMode: "default" as "default" | "plan",
  runtimeMode: "full-access" as RuntimeMode,
  hasKey: true,
  requests: [] as Array<MediaAdapterRequest>,
};

const studio: MediaAdapter = {
  id: "studio",
  name: "Studio",
  setup: { where: "connectors", hint: "Add the Studio connector." },
  keyUrl: "https://studio.example/keys",
  models: [
    {
      id: MediaModelId.make("draw"),
      name: "Draw",
      textToImage: true,
      imageEdit: true,
      mask: true,
      aspectRatios: ["1:1", "16:9"],
      maxCount: 4,
      estimatedUsdPerImage: 0.1,
    },
  ],
  key: Effect.sync(() => (chat.hasKey ? Option.some(Redacted.make(KEY)) : Option.none())),
  run: (request) =>
    Effect.sync(() => {
      chat.requests.push(request);
      return {
        images: Array.from({ length: request.count }, () => ({
          kind: "bytes" as const,
          bytes: PNG,
          mimeType: "image/png",
        })),
        costUsd: undefined,
        seed: undefined,
      };
    }),
};

const layer = McpHttpServer.layerMediaToolkit.pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provide(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.sync(() => ({
          ...McpToolAccessTestkit.liveThreadShell(id),
          interactionMode: chat.interactionMode,
          runtimeMode: chat.runtimeMode,
        })),
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectService.ProjectService)({
      getById: () => Effect.sync(() => Option.some({ workspaceRoot: chat.root } as never)),
    }),
  ),
  Layer.provide(
    Media.layer.pipe(
      Layer.provide(Layer.succeed(MediaAdapters, [studio])),
      Layer.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("must not send a request")),
        ),
      ),
      Layer.provide(Layer.mock(ConnectorStore.ConnectorStore)({})),
      Layer.provide(
        Layer.mock(KnownWorkspaces.KnownWorkspaces)({ assertContains: () => Effect.void }),
      ),
      Layer.provide(
        ServerSettings.ServerSettingsService.layerTest({
          media: { monthlyLimitUsd: 0.5, perRequestLimitUsd: 0.3 },
        }),
      ),
    ),
  ),
  Layer.provideMerge(FileVersions.layer),
  Layer.provide(FileVersionStorage.layer),
  Layer.provide(
    Layer.mock(CheckpointStore.CheckpointStore)({ isGitRepository: () => Effect.succeed(false) }),
  ),
  Layer.provideMerge(
    WorkspaceFileSystem.layer.pipe(
      Layer.provide(
        Layer.mock(KnownWorkspaces.KnownWorkspaces)({ assertContains: () => Effect.void }),
      ),
      Layer.provide(Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void })),
    ),
  ),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "codenine-mcp-media-" }),
  ),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const setup = Effect.fn("MediaToolkitTest.setup")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const server = yield* McpServer.McpServer;
  const versions = yield* FileVersions.FileVersions;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codenine-mcp-media-" });
  Object.assign(chat, {
    root: cwd,
    interactionMode: "default",
    runtimeMode: "full-access",
    hasKey: true,
    requests: [],
  });
  yield* fileSystem.writeFile(path.join(cwd, "photo.png"), PNG);
  yield* versions.syncWorkspace({ cwd, origin: { kind: "turn-start", threadId } });
  const call = (name: string, args: Record<string, unknown>) =>
    server.callTool({ name, arguments: args }).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provideService(McpSchema.McpServerClient, client),
      Effect.map((result) => ({
        ok: result.isError !== true,
        value: (result.isError === true
          ? JSON.parse((result.content[0] as { text: string }).text)
          : result.structuredContent) as Record<string, any>,
      })),
    );
  return { cwd, call, versions };
});

it.layer(layer)("image tools", (it) => {
  it.effect("make and edit images in the chat's folder as the turn's changes", () =>
    Effect.gen(function* () {
      const { cwd, call, versions } = yield* setup();
      const made = yield* call("codenine_image_generate", {
        prompt: "A lighthouse at dusk",
        aspectRatio: "16:9",
      });
      expect(made).toEqual({
        ok: true,
        value: {
          files: ["media/a-lighthouse-at-dusk.png"],
          model: "draw",
          costUsd: 0.1,
          spentThisMonthUsd: 0.1,
        },
      });
      const edited = yield* call("codenine_image_edit", {
        // An absolute path inside the folder names the same file.
        path: `${cwd}/photo.png`,
        mask: "photo.png",
        prompt: "Make the sky pink",
        folder: "edits",
      });
      expect(edited.value).toMatchObject({ files: ["edits/make-the-sky-pink.png"] });
      expect(chat.requests).toMatchObject([
        { prompt: "A lighthouse at dusk", aspectRatio: "16:9", count: 1 },
        { source: { mimeType: "image/png" }, mask: { mimeType: "image/png" } },
      ]);
      expect(JSON.stringify([made, edited])).not.toContain(KEY);

      // The walk that ends the turn lists the new files, so the user can review and discard them.
      yield* versions.syncWorkspace({ cwd, origin: { kind: "agent", threadId, turnCount: 1 } });
      expect((yield* versions.turnChanges({ cwd, threadId, turnCount: 1 })).toSorted()).toEqual([
        "edits/make-the-sky-pink.png",
        "media/a-lighthouse-at-dusk.png",
      ]);
    }),
  );

  it.effect("spend nothing where the chat may not change files, or the limit or key says no", () =>
    Effect.gen(function* () {
      const { call } = yield* setup();
      const generate = (args: Record<string, unknown> = {}) =>
        call("codenine_image_generate", { prompt: "A lighthouse", ...args });

      chat.interactionMode = "plan";
      expect(yield* generate()).toMatchObject({ ok: false, value: { code: "capability_denied" } });
      chat.interactionMode = "default";

      // A chat that asks before each change has no approval for a paid image to wait on.
      chat.runtimeMode = "approval-required";
      const unapproved = [
        yield* generate(),
        yield* call("codenine_image_edit", { path: "photo.png", prompt: "Brighter" }),
      ];
      for (const refused of unapproved) {
        expect(refused).toMatchObject({ ok: false, value: { code: "capability_denied" } });
        expect(refused.value.message).toContain("asks the user before each file change");
      }
      chat.runtimeMode = "full-access";

      const overLimit = yield* generate({ count: 4 });
      expect(overLimit).toMatchObject({ ok: false, value: { code: "invalid_request" } });
      expect(overLimit.value.message).toContain("over the limit of $0.30 for one request");

      chat.hasKey = false;
      const noProvider = yield* generate();
      expect(noProvider.ok).toBe(false);
      expect(noProvider.value.message).toContain("Add one in Settings, under Media");
      expect(noProvider.value.message).toContain("Tell the user this");

      expect(chat.requests).toEqual([]);
    }),
  );
});
