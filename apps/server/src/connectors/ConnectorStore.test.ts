import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ConnectionId,
  ConnectorCatalogId,
  DEFAULT_CONNECTOR_APPROVALS,
  ThreadId,
} from "@codenine/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ConnectorStore from "./ConnectorStore.ts";

const connection = (
  id: ConnectionId,
  catalogId: string | null,
): ConnectorStore.StoredConnection => ({
  id,
  catalogId: catalogId === null ? null : ConnectorCatalogId.make(catalogId),
  custom:
    catalogId === null
      ? { transport: { type: "http", url: "https://mcp.example.com/mcp" }, auth: "none" }
      : null,
  name: catalogId ?? "Example",
  onByDefault: true,
  approvals: DEFAULT_CONNECTOR_APPROVALS,
  toolApprovals: {},
  inputs: {},
  account: null,
  connectedAt: "2026-11-17T10:00:00.000Z",
  lastUsedAt: null,
});

const activity = (index: number) => ({
  at: `2026-11-17T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
  tool: `tool-${index}`,
  summary: `Call ${index}`,
  threadId: ThreadId.make("thread:connector-store"),
  threadTitle: "A chat",
  outcome: "auto" as const,
});

const freshStore = ConnectorStore.ConnectorStore.pipe(
  Effect.provide(Layer.fresh(ConnectorStore.layer)),
);

// Fresh per test, so every test starts with its own empty state folder.
const layerStoreDependencies = Layer.fresh(
  ServerSecretStore.layer.pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "codenine-connector-store-test-" }),
    ),
  ),
);

describe("effectiveConnectionIds", () => {
  const ids = (selection: ReadonlyArray<string> | undefined) =>
    ConnectorStore.effectiveConnectionIds(
      selection?.map((id) => ConnectionId.make(id)),
      [
        { id: ConnectionId.make("gmail"), onByDefault: true, ready: true },
        { id: ConnectionId.make("github"), onByDefault: false, ready: true },
        { id: ConnectionId.make("notion"), onByDefault: true, ready: false },
      ],
    );

  it("a chat without its own list uses the ready connections on by default", () => {
    assert.deepStrictEqual<ReadonlyArray<string>>(ids(undefined), ["gmail"]);
  });

  it("a chat's own list wins, minus connections it cannot use or that are gone", () => {
    assert.deepStrictEqual<ReadonlyArray<string>>(ids(["github", "notion", "removed"]), ["github"]);
    assert.deepStrictEqual<ReadonlyArray<string>>(ids([]), []);
  });
});

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("ConnectorStore", (it) => {
  it.effect("keeps connections across a restart and forgets everything on removal", () =>
    Effect.gen(function* () {
      const store = yield* freshStore;
      // A new subscriber gets a signal at once, so subscribeConnectors sends the state first.
      yield* store.changes.pipe(Stream.take(1), Stream.runDrain);
      const gmail = yield* store.create("gmail", (id) => connection(id, "gmail"));
      const secondGmail = yield* store.create("gmail", (id) => connection(id, "gmail"));
      const custom = yield* store.create("Codenine", (id) => connection(id, null));
      assert.deepStrictEqual(
        [gmail.id, secondGmail.id, custom.id],
        ["gmail", "gmail-2", "codenine-2"],
      );
      yield* store.update(gmail.id, (current) => ({
        ...current,
        onByDefault: false,
        toolApprovals: { send_draft: "auto" },
      }));
      yield* store.writeSecrets(gmail.id, {
        token: "token",
        inputs: { databaseUrl: "postgres://" },
      });
      yield* store.writeTools(gmail.id, [
        { name: "search_threads", inputSchema: { type: "object" } },
      ]);
      for (const index of [1, 2, 3]) yield* store.appendActivity(gmail.id, activity(index));

      const reopened = yield* freshStore;
      assert.deepStrictEqual(
        (yield* reopened.list).map((stored) => stored.id),
        ["gmail", "gmail-2", "codenine-2"],
      );
      const saved = yield* reopened.get(gmail.id);
      assert.strictEqual(saved?.onByDefault, false);
      assert.deepStrictEqual(saved?.toolApprovals, { send_draft: "auto" });
      assert.deepStrictEqual(yield* reopened.readSecrets(gmail.id), {
        token: "token",
        inputs: { databaseUrl: "postgres://" },
      });
      assert.deepStrictEqual(
        (yield* reopened.readTools(gmail.id))?.map((tool) => tool.name),
        ["search_threads"],
      );
      assert.deepStrictEqual(
        (yield* reopened.readActivity(gmail.id, 2)).map((entry) => entry.tool),
        ["tool-3", "tool-2"],
      );

      yield* reopened.remove(gmail.id);
      assert.isUndefined(yield* reopened.get(gmail.id));
      assert.deepStrictEqual(yield* reopened.readSecrets(gmail.id), { inputs: {} });
      assert.isUndefined(yield* reopened.readTools(gmail.id));
      assert.deepStrictEqual(yield* reopened.readActivity(gmail.id, 10), []);
      assert.isDefined(yield* reopened.get(secondGmail.id));
    }).pipe(Effect.provide(layerStoreDependencies)),
  );

  it.effect("keeps the newest 500 activity entries", () =>
    Effect.gen(function* () {
      const store = yield* freshStore;
      const github = yield* store.create("github", (id) => connection(id, "github"));
      for (let index = 1; index <= 601; index += 1) {
        yield* store.appendActivity(github.id, activity(index));
      }
      const entries = yield* (yield* freshStore).readActivity(github.id, 1_000);
      assert.strictEqual(entries.length, 500);
      assert.strictEqual(entries[0]?.tool, "tool-601");
      assert.strictEqual(entries.at(-1)?.tool, "tool-102");
    }).pipe(Effect.provide(layerStoreDependencies)),
  );

  it.effect("a connection is ready once it holds what its sign-in needs", () =>
    Effect.gen(function* () {
      const store = yield* freshStore;
      const ready = (stored: ConnectorStore.StoredConnection) => store.isReady(stored);
      const context7 = yield* store.create("context7", (id) => connection(id, "context7"));
      const github = yield* store.create("github", (id) => connection(id, "github"));
      const notion = yield* store.create("notion", (id) => connection(id, "notion"));
      const postgres = yield* store.create("postgres", (id) => connection(id, "postgres"));
      assert.deepStrictEqual(yield* Effect.forEach([context7, github, notion, postgres], ready), [
        true,
        false,
        false,
        false,
      ]);
      yield* store.writeSecrets(github.id, { token: "ghp", inputs: {} });
      yield* store.writeAuth(notion.id, {
        accessToken: "access",
        authorizationEndpoint: "https://example.com/authorize",
        tokenEndpoint: "https://example.com/token",
        client: { kind: "registered", key: "key" },
      });
      yield* store.writeSecrets(postgres.id, { inputs: { databaseUrl: "postgres://db" } });
      assert.deepStrictEqual(yield* Effect.forEach([context7, github, notion, postgres], ready), [
        true,
        true,
        true,
        true,
      ]);
      yield* store.update(context7.id, (current) => ({ ...current, onByDefault: false }));
      assert.deepStrictEqual<ReadonlyArray<string>>(
        yield* store.effectiveConnectionIds(undefined),
        ["github", "notion", "postgres"],
      );
    }).pipe(Effect.provide(layerStoreDependencies)),
  );
});
