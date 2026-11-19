import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ConnectionId,
  ConnectorCatalogId,
  DEFAULT_CONNECTOR_APPROVALS,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  NodeId,
  RunId,
  type TeamPlan,
  TeamPlanId,
  TeamTaskId,
  ThreadId,
} from "@codenine/contracts";
import type { ReviewedAction } from "@codenine/provider-core/server/textGenerationPrompts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Agents from "../agents/Agents.ts";
import * as ActionReviewer from "../approvals/ActionReviewer.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { catalogConnector } from "./catalog.ts";
import * as ConnectorApprovals from "./ConnectorApprovals.ts";
import * as ConnectorClients from "./ConnectorClients.ts";
import * as ConnectorGateway from "./ConnectorGateway.ts";
import * as Connectors from "./Connectors.ts";
import * as ConnectorSignIn from "./ConnectorSignIn.ts";
import * as ConnectorStore from "./ConnectorStore.ts";

const threadId = ThreadId.make("thread:connector-gateway");
const run = {
  id: RunId.make("run:connector-gateway"),
  status: "running",
  ordinal: 1,
  rootNodeId: NodeId.make("node:connector-gateway"),
} as unknown as OrchestrationV2Run;

describe("approval card wording", () => {
  it("names the action from the catalogue, else from the tool without the service's prefix", () => {
    assert.strictEqual(
      ConnectorGateway.actionText(catalogConnector(ConnectorCatalogId.make("gmail")), "send_draft"),
      "send a draft",
    );
    assert.strictEqual(
      ConnectorGateway.actionText(
        catalogConnector(ConnectorCatalogId.make("slack")),
        "slack_create_canvas",
      ),
      "create canvas",
    );
    assert.strictEqual(ConnectorGateway.actionText(undefined, "createIssue"), "create issue");
    const browser = catalogConnector(ConnectorCatalogId.make("playwright"));
    assert.strictEqual(ConnectorGateway.actionText(browser, "browser_navigate"), "open a page");
    // The Browser's tools start with its name rather than its id.
    assert.strictEqual(ConnectorGateway.actionText(browser, "browser_hover"), "hover");
  });

  it("labels short values and keeps one long text as the preview", () => {
    const body = "word ".repeat(100);
    const described = ConnectorGateway.describeArguments({
      channelId: "C123",
      text: body,
      unfurl: false,
      thread: null,
    });
    assert.deepStrictEqual(described.details, [
      { label: "Channel id", value: "C123" },
      { label: "Unfurl", value: "false" },
    ]);
    assert.strictEqual(described.preview, body);
  });

  it("says when fields are left out and when a value is cut", () => {
    const described = ConnectorGateway.describeArguments({
      a: 1,
      b: 2,
      c: 3,
      d: 4,
      e: 5,
      filter: { to: "x".repeat(300) },
      g: 7,
      h: 8,
    });
    assert.lengthOf(described.details, 7);
    assert.include(described.details[5]?.value, "characters not shown");
    assert.deepStrictEqual(described.details[6], { label: "Not shown", value: "2 more fields" });
  });
});

const call = (connectionId: string, method: string, params?: unknown) => ({
  connectionId,
  message: { jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) },
});

const makeHarness = (
  thread: Partial<OrchestrationV2AppThread>,
  lead?: Partial<OrchestrationV2AppThread>,
) =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
    const cardShown = yield* Deferred.make<OrchestrationV2ServerCommand>();
    const upstreamCalls = yield* Ref.make<ReadonlyArray<string>>([]);
    const decision = yield* Ref.make<ActionReviewer.ReviewDecision>({ type: "allow" });
    const reviewed = yield* Ref.make<ReadonlyArray<ReviewedAction>>([]);
    const callFailure = yield* Ref.make<ConnectorClients.ConnectorCallError | undefined>(undefined);
    /** When set, a call completes it once sent and then never gets an answer. */
    const unanswered = yield* Ref.make<Deferred.Deferred<void> | undefined>(undefined);
    const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadRecords: (id) =>
        Effect.succeed({
          thread: {
            id,
            title: "Release",
            interactionMode: "default",
            ...(id === threadId ? thread : lead),
          } as OrchestrationV2AppThread,
          runs: [run],
        } as never),
      getThreadEventSequence: () => Effect.succeed(0),
      streamStoredEventsFrom: () => Stream.never,
      dispatch: (command) =>
        Ref.update(dispatched, (current) => [...current, command]).pipe(
          Effect.andThen(
            command.type === "connector_approval.record" && command.approvalStatus === "pending"
              ? Deferred.succeed(cardShown, command)
              : Effect.void,
          ),
          Effect.as({ sequence: 1 } as never),
        ),
    });
    const clients = Layer.mock(ConnectorClients.ConnectorClients)({
      callTool: (input) =>
        Ref.update(upstreamCalls, (current) => [...current, input.name]).pipe(
          Effect.andThen(Ref.get(unanswered)),
          Effect.flatMap((sent) =>
            sent === undefined
              ? Effect.void
              : Deferred.succeed(sent, undefined).pipe(Effect.andThen(Effect.never)),
          ),
          Effect.andThen(Ref.get(callFailure)),
          Effect.flatMap((failure) =>
            failure === undefined
              ? Effect.succeed({
                  content: [{ type: "text" as const, text: `${input.name} done` }],
                })
              : Effect.fail(failure),
          ),
        ),
      close: () => Effect.void,
    });
    const reviewer = Layer.mock(ActionReviewer.ActionReviewer)({
      decide: (input) =>
        Ref.update(reviewed, (current) => [...current, input.action]).pipe(
          Effect.andThen(Ref.get(decision)),
        ),
    });
    const layer = ConnectorGateway.layer.pipe(
      Layer.provideMerge(Connectors.layer),
      Layer.provideMerge(ConnectorApprovals.layer),
      Layer.provideMerge(
        Layer.mergeAll(threads, clients, reviewer, Layer.mock(ConnectorSignIn.ConnectorSignIn)({})),
      ),
      Layer.provideMerge(ConnectorStore.layer),
      Layer.provideMerge(
        Agents.layer.pipe(
          Layer.provide(
            Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
          ),
        ),
      ),
      Layer.provideMerge(ServerSecretStore.layer),
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "codenine-connector-gateway-test-" }),
      ),
    );
    return {
      dispatched,
      cardShown,
      upstreamCalls,
      decision,
      reviewed,
      callFailure,
      unanswered,
      layer,
    };
  });

const connectGitHub = Effect.gen(function* () {
  const store = yield* ConnectorStore.ConnectorStore;
  const github = yield* store.create("github", (id) => ({
    id,
    catalogId: ConnectorCatalogId.make("github"),
    custom: null,
    name: "GitHub",
    onByDefault: true,
    approvals: DEFAULT_CONNECTOR_APPROVALS,
    toolApprovals: {},
    inputs: {},
    account: null,
    connectedAt: "2026-11-17T10:00:00.000Z",
    lastUsedAt: null,
  }));
  yield* store.writeSecrets(github.id, { token: "ghp", inputs: {} });
  yield* store.writeTools(github.id, [
    { name: "search_code", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
    { name: "merge_pull_request", inputSchema: { type: "object" } },
  ]);
  return github;
});

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("ConnectorGateway", (it) => {
  it.effect("runs reads at once and waits for the user before an irreversible action", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({});
      yield* Effect.gen(function* () {
        const gateway = yield* ConnectorGateway.ConnectorGateway;
        const store = yield* ConnectorStore.ConnectorStore;
        const github = yield* connectGitHub;
        const handle = (request: ReturnType<typeof call>) =>
          gateway.handle({ threadId, ...request });

        const listed = yield* handle(call(github.id, "tools/list"));
        assert.deepStrictEqual(
          listed !== undefined && "result" in listed
            ? (listed.result as { tools: ReadonlyArray<{ name: string }> }).tools.map(
                (tool) => tool.name,
              )
            : listed,
          ["search_code", "merge_pull_request"],
        );

        yield* handle(
          call(github.id, "tools/call", { name: "search_code", arguments: { q: "x" } }),
        );
        assert.deepStrictEqual(yield* Ref.get(harness.upstreamCalls), ["search_code"]);
        assert.deepStrictEqual(yield* Ref.get(harness.dispatched), []);

        const merging = yield* handle(
          call(github.id, "tools/call", { name: "merge_pull_request", arguments: { pull: 7 } }),
        ).pipe(Effect.forkChild);
        const card = yield* Deferred.await(harness.cardShown);
        assert.deepInclude(card, {
          type: "connector_approval.record",
          approvalStatus: "pending",
          action: "merge a pull request",
          risk: "irreversible",
        });
        assert.deepStrictEqual(yield* Ref.get(harness.upstreamCalls), ["search_code"]);
        assert.ok(card.type === "connector_approval.record");
        yield* gateway.answerApproval({ threadId, turnItemId: card.turnItemId, answer: "always" });
        const merged = yield* Fiber.join(merging);
        assert.deepStrictEqual(yield* Ref.get(harness.upstreamCalls), [
          "search_code",
          "merge_pull_request",
        ]);
        assert.deepStrictEqual(
          merged !== undefined && "result" in merged ? merged.result : merged,
          {
            content: [{ type: "text", text: "merge_pull_request done" }],
          },
        );
        assert.deepStrictEqual(
          (yield* Ref.get(harness.dispatched)).map((command) =>
            command.type === "connector_approval.record"
              ? [command.approvalStatus, command.remembered ?? false]
              : command.type,
          ),
          [
            ["pending", false],
            ["allowed", true],
          ],
        );
        assert.deepStrictEqual((yield* store.get(github.id))?.toolApprovals, {
          merge_pull_request: "auto",
        });
        assert.deepStrictEqual(
          (yield* store.readActivity(github.id, 10)).map((entry) => [entry.tool, entry.outcome]),
          [
            ["merge_pull_request", "allowed"],
            ["search_code", "auto"],
          ],
        );
        // Outside Auto, nothing reviews the action first.
        assert.deepStrictEqual(yield* Ref.get(harness.reviewed), []);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("a call the service turns down is not trouble with the connection", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({});
      yield* Effect.gen(function* () {
        const gateway = yield* ConnectorGateway.ConnectorGateway;
        const connectors = yield* Connectors.Connectors;
        const github = yield* connectGitHub;
        const search = gateway.handle({
          threadId,
          ...call(github.id, "tools/call", { name: "search_code", arguments: {} }),
        });
        const statusOf = connectors.state.pipe(
          Effect.map((state) => state.connections.find((one) => one.id === github.id)?.status),
        );
        const failWith = (kind: "refused" | "unreachable", detail: string) =>
          Ref.set(harness.callFailure, new ConnectorClients.ConnectorCallError({ kind, detail }));

        yield* failWith("refused", "GitHub turned the call down: q is required");
        const refused = yield* search;
        assert.include(JSON.stringify(refused), "q is required");
        assert.strictEqual(yield* statusOf, "connected");

        yield* failWith("unreachable", "Codenine could not reach GitHub.");
        yield* search;
        assert.strictEqual(yield* statusOf, "error");
        // The next call that gets an answer clears it.
        yield* Ref.set(harness.callFailure, undefined);
        yield* search;
        assert.strictEqual(yield* statusOf, "connected");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("a call stopped after it was sent is still in the activity", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({});
      yield* Effect.gen(function* () {
        const gateway = yield* ConnectorGateway.ConnectorGateway;
        const store = yield* ConnectorStore.ConnectorStore;
        const github = yield* connectGitHub;
        const sent = yield* Deferred.make<void>();
        yield* Ref.set(harness.unanswered, sent);
        const searching = yield* gateway
          .handle({
            threadId,
            ...call(github.id, "tools/call", { name: "search_code", arguments: { q: "x" } }),
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(sent);
        yield* Fiber.interrupt(searching);
        assert.deepStrictEqual(
          (yield* store.readActivity(github.id, 10)).map((entry) => [entry.tool, entry.outcome]),
          [["search_code", "interrupted"]],
        );
        assert.isNotNull((yield* store.get(github.id))?.lastUsedAt);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("refuses changes in Plan mode and connections the chat does not use", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        interactionMode: "plan",
        connectors: [ConnectionId.make("github")],
      });
      yield* Effect.gen(function* () {
        const gateway = yield* ConnectorGateway.ConnectorGateway;
        const github = yield* connectGitHub;
        const refused = yield* gateway.handle({
          threadId,
          ...call(github.id, "tools/call", { name: "merge_pull_request", arguments: {} }),
        });
        assert.deepInclude(
          refused !== undefined && "result" in refused ? (refused.result as object) : {},
          { isError: true },
        );
        const unused = yield* gateway.handle({ threadId, ...call("notion", "tools/list") });
        assert.deepInclude(unused !== undefined && "error" in unused ? unused.error : {}, {
          code: -32001,
        });
        assert.deepStrictEqual(yield* Ref.get(harness.upstreamCalls), []);
        assert.deepStrictEqual(yield* Ref.get(harness.dispatched), []);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("a chat's agent picks its connectors, and its own choices decide in its chats", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ agent: "triager" });
      yield* Effect.gen(function* () {
        const gateway = yield* ConnectorGateway.ConnectorGateway;
        const agents = yield* Agents.Agents;
        const store = yield* ConnectorStore.ConnectorStore;
        const github = yield* connectGitHub;
        const merge = gateway.handle({
          threadId,
          ...call(github.id, "tools/call", { name: "merge_pull_request", arguments: {} }),
        });
        const listTools = gateway.handle({ threadId, ...call(github.id, "tools/list") });
        const refusedCode = (response: ConnectorGateway.JsonRpcResponse | undefined) =>
          response !== undefined && "error" in response ? response.error.code : undefined;
        const triager = {
          name: "triager",
          title: "Triager",
          description: "Sorts new issues.",
          instructions: "",
          model: null,
          skills: [],
          connectors: [],
          abilities: { readFiles: false, editFiles: false, runCommands: false, searchWeb: false },
        };

        // GitHub is on by default, yet an agent that is gone or leaves it out reaches nothing.
        assert.strictEqual(refusedCode(yield* listTools), -32001);
        yield* agents.save({ agent: triager });
        assert.strictEqual(refusedCode(yield* listTools), -32001);

        // Asking for the agent, "always" changes the agent's own choice, which decides in its chats.
        yield* agents.save({
          agent: {
            ...triager,
            connectors: [{ id: github.id, approvals: { irreversible: "ask" } }],
          },
          previousName: "triager",
        });
        const merging = yield* merge.pipe(Effect.forkChild);
        const card = yield* Deferred.await(harness.cardShown);
        assert.deepInclude(card, { approvalStatus: "pending", agent: "triager" });
        assert.ok(card.type === "connector_approval.record");
        yield* gateway.answerApproval({ threadId, turnItemId: card.turnItemId, answer: "always" });
        yield* Fiber.join(merging);
        assert.deepStrictEqual(
          (yield* Ref.get(harness.dispatched)).map((command) =>
            command.type === "connector_approval.record"
              ? [command.approvalStatus, command.remembered ?? false]
              : command.type,
          ),
          [
            ["pending", false],
            ["allowed", true],
          ],
        );
        assert.deepStrictEqual((yield* agents.read({ name: "triager" })).connectors, [
          { id: github.id, approvals: { irreversible: "auto" } },
        ]);
        assert.deepStrictEqual((yield* store.get(github.id))?.toolApprovals, {});

        // Its choice wins over one the user made for the action outside its chats.
        yield* store.update(github.id, (current) => ({
          ...current,
          toolApprovals: { merge_pull_request: "ask" },
        }));
        yield* merge;
        assert.deepStrictEqual(yield* Ref.get(harness.upstreamCalls), [
          "merge_pull_request",
          "merge_pull_request",
        ]);
        assert.strictEqual((yield* Ref.get(harness.dispatched)).length, 2);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect(
    "in Auto the reviewer answers first: allow runs, block refuses, ask shows the card",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ runtimeMode: "auto" });
        yield* Effect.gen(function* () {
          const gateway = yield* ConnectorGateway.ConnectorGateway;
          const store = yield* ConnectorStore.ConnectorStore;
          const github = yield* connectGitHub;
          const merge = gateway.handle({
            threadId,
            ...call(github.id, "tools/call", {
              name: "merge_pull_request",
              arguments: { pull: 7 },
            }),
          });
          const resultOf = (response: ConnectorGateway.JsonRpcResponse | undefined) =>
            response !== undefined && "result" in response ? response.result : response;

          assert.deepStrictEqual(resultOf(yield* merge), {
            content: [{ type: "text", text: "merge_pull_request done" }],
          });
          yield* Ref.set(harness.decision, {
            type: "block",
            reason: "The user never asked to merge",
          });
          assert.deepStrictEqual(resultOf(yield* merge), {
            content: [
              {
                type: "text",
                text: "Auto blocked this action: The user never asked to merge. Find another way that fits what the user asked, or ask them.",
              },
            ],
            isError: true,
          });
          const autoReason = "Auto's review took too long, so it asks you.";
          yield* Ref.set(harness.decision, { type: "ask", reason: autoReason });
          const merging = yield* merge.pipe(Effect.forkChild);
          const card = yield* Deferred.await(harness.cardShown);
          assert.deepInclude(card, { approvalStatus: "pending", autoReason });
          assert.ok(card.type === "connector_approval.record");
          yield* gateway.answerApproval({ threadId, turnItemId: card.turnItemId, answer: "allow" });
          yield* Fiber.join(merging);

          assert.deepStrictEqual(yield* Ref.get(harness.upstreamCalls), [
            "merge_pull_request",
            "merge_pull_request",
          ]);
          assert.deepInclude((yield* Ref.get(harness.reviewed))[0], {
            service: "GitHub",
            tool: "merge_pull_request",
            group: "irreversible",
            summary: "merge a pull request",
            arguments: { pull: 7 },
          });
          // A reviewer's allow covers one call; it never stops the action asking.
          assert.deepStrictEqual((yield* store.get(github.id))?.toolApprovals, {});
          assert.deepStrictEqual(
            (yield* store.readActivity(github.id, 10)).map((entry) => entry.outcome),
            ["allowed", "blocked", "reviewed"],
          );
        }).pipe(Effect.provide(harness.layer));
      }),
  );

  it.effect("a step of a workflow run that never asks goes ahead without a card or review", () =>
    Effect.gen(function* () {
      const planId = TeamPlanId.make("plan:weekly");
      const leadId = ThreadId.make("thread:weekly-lead");
      const harness = yield* makeHarness(
        {
          runtimeMode: "auto",
          teamTask: { rootThreadId: leadId, planId, taskId: TeamTaskId.make("post"), attempt: 1 },
        },
        { team: { id: planId, run: { approvals: "never" } } as unknown as TeamPlan },
      );
      yield* Effect.gen(function* () {
        const gateway = yield* ConnectorGateway.ConnectorGateway;
        const github = yield* connectGitHub;
        yield* gateway.handle({
          threadId,
          ...call(github.id, "tools/call", { name: "merge_pull_request", arguments: {} }),
        });
        assert.deepStrictEqual(yield* Ref.get(harness.upstreamCalls), ["merge_pull_request"]);
        assert.deepStrictEqual(yield* Ref.get(harness.dispatched), []);
        assert.deepStrictEqual(yield* Ref.get(harness.reviewed), []);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("a step of a workflow run that asks waits for the answer, however long", () =>
    Effect.gen(function* () {
      const planId = TeamPlanId.make("plan:weekly");
      const leadId = ThreadId.make("thread:weekly-lead");
      const harness = yield* makeHarness(
        { teamTask: { rootThreadId: leadId, planId, taskId: TeamTaskId.make("post"), attempt: 1 } },
        { team: { id: planId, run: { approvals: "ask" } } as unknown as TeamPlan },
      );
      yield* Effect.gen(function* () {
        const gateway = yield* ConnectorGateway.ConnectorGateway;
        const github = yield* connectGitHub;
        const merging = yield* gateway
          .handle({
            threadId,
            ...call(github.id, "tools/call", { name: "merge_pull_request", arguments: {} }),
          })
          .pipe(Effect.forkChild);
        const card = yield* Deferred.await(harness.cardShown);
        assert.ok(card.type === "connector_approval.record");
        yield* TestClock.adjust("8 hours");
        yield* gateway.answerApproval({ threadId, turnItemId: card.turnItemId, answer: "allow" });
        yield* Fiber.join(merging);
        assert.deepStrictEqual(yield* Ref.get(harness.upstreamCalls), ["merge_pull_request"]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("a call the provider gives up on closes its card, so it cannot be allowed late", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({});
      yield* Effect.gen(function* () {
        const gateway = yield* ConnectorGateway.ConnectorGateway;
        const github = yield* connectGitHub;
        const merging = yield* gateway
          .handle({
            threadId,
            ...call(github.id, "tools/call", { name: "merge_pull_request", arguments: {} }),
          })
          .pipe(Effect.forkChild);
        const card = yield* Deferred.await(harness.cardShown);
        assert.ok(card.type === "connector_approval.record");
        yield* gateway.handle({
          threadId,
          connectionId: github.id,
          message: { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } },
        });
        yield* Fiber.join(merging);
        const answered = yield* gateway
          .answerApproval({ threadId, turnItemId: card.turnItemId, answer: "allow" })
          .pipe(Effect.exit);
        assert.ok(answered._tag === "Failure");
        assert.deepStrictEqual(yield* Ref.get(harness.upstreamCalls), []);
        assert.deepStrictEqual(
          (yield* Ref.get(harness.dispatched)).map((command) =>
            command.type === "connector_approval.record" ? command.approvalStatus : command.type,
          ),
          ["pending", "cancelled"],
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});
