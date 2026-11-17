import {
  type AgentConnector,
  CommandId,
  ConnectionId,
  type ConnectorActivityOutcome,
  type ConnectorApprovalAnswerInput,
  ConnectorError,
  type ConnectorRisk,
  type OrchestrationV2ConnectorApprovalStatus,
  type ThreadId,
  TurnItemId,
} from "@codenine/contracts";
import type { CallToolResult } from "@modelcontextprotocol/client";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import packageJson from "../../package.json" with { type: "json" };
import * as Agents from "../agents/Agents.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { type CatalogConnector } from "./catalog.ts";
import { codenineTools, describeDraft, GMAIL_SEND_DRAFT, sendDraft } from "./codenineTools.ts";
import { connectionCatalog } from "./connectionServer.ts";
import * as ConnectorApprovals from "./ConnectorApprovals.ts";
import * as ConnectorClients from "./ConnectorClients.ts";
import { ConnectorFetch } from "./ConnectorFetch.ts";
import * as Connectors from "./Connectors.ts";
import * as ConnectorSignIn from "./ConnectorSignIn.ts";
import * as ConnectorStore from "./ConnectorStore.ts";

/** Protocol revisions whose tools messages Codenine's gateway speaks. */
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const DETAIL_LIMIT = 160;
const PREVIEW_LIMIT = 1_500;
const MAX_DETAILS = 6;
const LAST_USED_EVERY_MS = 60_000;

const JsonRpcMessage = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number, Schema.Null])),
  method: Schema.String,
  params: Schema.optional(Schema.Unknown),
});
const decodeJsonRpcMessage = Schema.decodeUnknownOption(JsonRpcMessage);
const ToolCallParams = Schema.Struct({
  name: Schema.String,
  arguments: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
const decodeToolCallParams = Schema.decodeUnknownOption(ToolCallParams);
const InitializeParams = Schema.Struct({ protocolVersion: Schema.String });
const decodeInitializeParams = Schema.decodeUnknownOption(InitializeParams);
const decodeConnectionId = Schema.decodeUnknownOption(ConnectionId);

export type JsonRpcResponse =
  | {
      readonly jsonrpc: "2.0";
      readonly id: string | number | null;
      readonly result: unknown;
    }
  | {
      readonly jsonrpc: "2.0";
      readonly id: string | number | null;
      readonly error: { readonly code: number; readonly message: string };
    };

const toolError = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

const truncate = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;

const words = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_\-.]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());

/** What the action does, finishing "Gmail wants to …". */
export const actionText = (catalog: CatalogConnector | undefined, tool: string): string => {
  const pinned = catalog?.actions?.[tool];
  if (pinned !== undefined) return pinned;
  const parts = words(tool);
  const prefixes =
    catalog === undefined ? [] : [words(catalog.entry.id), words(catalog.entry.name)];
  const prefix = prefixes.find(
    (candidate) =>
      candidate.length > 0 &&
      candidate.length < parts.length &&
      candidate.every((word, index) => parts[index] === word),
  );
  const trimmed = prefix === undefined ? parts : parts.slice(prefix.length);
  return trimmed.length > 0 ? trimmed.join(" ") : `use ${tool}`;
};

const label = (key: string) => {
  const parts = words(key);
  const sentence = parts.join(" ");
  return sentence.length === 0 ? key : `${sentence[0]?.toUpperCase()}${sentence.slice(1)}`;
};

/** Labelled argument values for the approval card; one long text becomes its preview. */
export const describeArguments = (
  args: Readonly<Record<string, unknown>>,
): {
  readonly details: ReadonlyArray<{ readonly label: string; readonly value: string }>;
  readonly preview: string | undefined;
} => {
  const entries = Object.entries(args).flatMap(([key, value]) => {
    if (value === undefined || value === null || value === "") return [];
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text === undefined ? [] : [[key, text] as const];
  });
  const long = entries
    .filter(([, text]) => text.length > DETAIL_LIMIT && !text.startsWith("{"))
    .toSorted(([, left], [, right]) => right.length - left.length)[0];
  const details = entries
    .filter((entry) => entry !== long)
    .slice(0, MAX_DETAILS)
    .map(([key, text]) => ({ label: label(key), value: truncate(text, DETAIL_LIMIT) }));
  return {
    details,
    preview: long === undefined ? undefined : truncate(long[1], PREVIEW_LIMIT),
  };
};

interface PreparedCall {
  readonly details: ReadonlyArray<{ readonly label: string; readonly value: string }>;
  readonly preview: string | undefined;
  /** The activity line: what happened when it ran, and what was asked otherwise. */
  readonly summary: (ran: boolean) => string;
  readonly run: Effect.Effect<
    CallToolResult,
    ConnectorClients.ConnectorCallError | ConnectorStore.ConnectorStoreError
  >;
}

export class ConnectorGateway extends Context.Service<
  ConnectorGateway,
  {
    /** Answers one JSON-RPC message an agent sent to a connection's endpoint; nothing for a notification. */
    readonly handle: (input: {
      readonly threadId: ThreadId;
      readonly connectionId: string;
      readonly message: unknown;
    }) => Effect.Effect<JsonRpcResponse | undefined>;
    readonly answerApproval: (
      input: ConnectorApprovalAnswerInput,
    ) => Effect.Effect<void, ConnectorError>;
  }
>()("codenine/connectors/ConnectorGateway") {}

const make = Effect.gen(function* () {
  const store = yield* ConnectorStore.ConnectorStore;
  const connectors = yield* Connectors.Connectors;
  const clients = yield* ConnectorClients.ConnectorClients;
  const signIn = yield* ConnectorSignIn.ConnectorSignIn;
  const approvals = yield* ConnectorApprovals.ConnectorApprovals;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const agents = yield* Agents.Agents;
  const random = yield* SecureRandom.SecureRandom;

  const readThread = (threadId: ThreadId) =>
    threads.getThreadRecords(threadId, ["runs"], { turnItemTypes: [], messageRoles: [] });

  /** The chat's connection, when it is one the chat uses. */
  const chatConnection = Effect.fn("ConnectorGateway.chatConnection")(function* (
    threadId: ThreadId,
    connectionId: string,
  ) {
    const id = decodeConnectionId(connectionId);
    if (id._tag === "None") return undefined;
    const connection = yield* store.get(id.value);
    if (connection === undefined) return undefined;
    const records = yield* readThread(threadId).pipe(Effect.option);
    if (records._tag === "None") return undefined;
    const chat = yield* agents.chatConnectors(records.value.thread);
    const reachable = ConnectorStore.effectiveConnectionIds(chat.selection, [
      { ...connection, ready: yield* store.isReady(connection) },
    ]);
    return reachable.length === 0
      ? undefined
      : {
          connection,
          records: records.value,
          agentApprovals: chat.approvals.get(connection.id),
        };
  });

  const tokenFor = (connectionId: ConnectionId, renew: boolean) =>
    signIn.accessToken(connectionId, { renew }).pipe(
      Effect.mapError(
        (error) =>
          new ConnectorClients.ConnectorCallError({
            kind:
              error._tag === "ConnectorCredentialError" && error.kind === "unreachable"
                ? "unreachable"
                : "needs-sign-in",
            detail: error.message,
            cause: error,
          }),
      ),
    );

  const prepare = Effect.fn("ConnectorGateway.prepare")(function* (input: {
    readonly connection: ConnectorStore.StoredConnection;
    readonly catalog: CatalogConnector | undefined;
    readonly tool: string;
    readonly args: Readonly<Record<string, unknown>>;
  }) {
    const { connection, tool, args } = input;
    if (tool === GMAIL_SEND_DRAFT.name && input.catalog?.codenineTools === "gmail") {
      const fetchFn = yield* ConnectorFetch;
      const draft = yield* tokenFor(connection.id, false).pipe(
        Effect.flatMap((token) => describeDraft(fetchFn, token, args)),
        Effect.catchTags({
          CodenineToolError: (error) =>
            error.reason === "unauthorized"
              ? tokenFor(connection.id, true).pipe(
                  Effect.flatMap((token) => describeDraft(fetchFn, token, args)),
                )
              : Effect.fail(error),
        }),
      );
      const subject = draft.subject.length === 0 ? "(no subject)" : draft.subject;
      return {
        details: [
          { label: "To", value: truncate(draft.to, DETAIL_LIMIT) },
          ...(draft.cc === undefined
            ? []
            : [{ label: "Cc", value: truncate(draft.cc, DETAIL_LIMIT) }]),
          { label: "Subject", value: truncate(subject, DETAIL_LIMIT) },
        ],
        preview: draft.text.length === 0 ? undefined : truncate(draft.text, PREVIEW_LIMIT),
        summary: (ran: boolean) =>
          ran
            ? `Sent the draft "${subject}" to ${draft.to}`
            : `Send the draft "${subject}" to ${draft.to}`,
        run: tokenFor(connection.id, false).pipe(
          Effect.flatMap((token) => sendDraft(fetchFn, token, args)),
          Effect.catchTags({
            CodenineToolError: (error) =>
              error.reason === "unauthorized"
                ? tokenFor(connection.id, true).pipe(
                    Effect.flatMap((token) => sendDraft(fetchFn, token, args)),
                  )
                : Effect.fail(error),
          }),
          Effect.map((sent): CallToolResult => ({
            content: [
              {
                type: "text",
                text: `Sent. Message ${sent.id}${sent.threadId === undefined ? "" : ` in thread ${sent.threadId}`}.`,
              },
            ],
          })),
          Effect.catchTags({
            CodenineToolError: (error) => Effect.succeed(toolError(error.message)),
          }),
        ),
      } satisfies PreparedCall;
    }
    const described = describeArguments(args);
    const action = actionText(input.catalog, tool);
    const first = described.details[0];
    const line = `${action[0]?.toUpperCase() ?? ""}${action.slice(1)}${first === undefined ? "" : ` (${first.label}: ${first.value})`}`;
    return {
      ...described,
      summary: () => truncate(line, 200),
      run: clients.callTool({ connection, name: tool, arguments: args }),
    } satisfies PreparedCall;
  });

  /** Completes when the run ends, so its card stops waiting. */
  const runEnded = Effect.fn("ConnectorGateway.runEnded")(
    function* (threadId: ThreadId, runId: string) {
      const after = yield* threads.getThreadEventSequence(threadId);
      const current = yield* readThread(threadId);
      const run = current.runs.find((candidate) => candidate.id === runId);
      if (run === undefined || ThreadManagement.isTerminalRunStatus(run.status)) return;
      yield* threads
        .streamStoredEventsFrom({ threadId, afterSequence: after, eventType: "run.updated" })
        .pipe(
          Stream.filter(
            ({ event }) =>
              event.type === "run.updated" &&
              event.payload.id === runId &&
              ThreadManagement.isTerminalRunStatus(event.payload.status),
          ),
          Stream.runHead,
        );
    },
    // Without the run's events the wait falls back to its own limit.
    Effect.catch(() => Effect.never),
  );

  const callTool = Effect.fn("ConnectorGateway.callTool")(function* (input: {
    readonly threadId: ThreadId;
    readonly connection: ConnectorStore.StoredConnection;
    readonly records: Effect.Success<ReturnType<typeof readThread>>;
    readonly agentApprovals: AgentConnector["approvals"] | undefined;
    readonly tool: string;
    readonly args: Readonly<Record<string, unknown>>;
  }) {
    const { connection, threadId, tool } = input;
    yield* Effect.annotateCurrentSpan({ "connector.id": connection.id, "connector.tool": tool });
    const catalog = connectionCatalog(connection);
    const extra = codenineTools(catalog?.codenineTools).find(
      (candidate) => candidate.name === tool,
    );
    const listed =
      extra ??
      (yield* connectors.upstreamTools(connection).pipe(Effect.orElseSucceed(() => []))).find(
        (candidate) => candidate.name === tool,
      );
    const risk: ConnectorRisk = ConnectorApprovals.toolRisk(
      listed ?? { name: tool },
      catalog?.risks,
    );
    const approval = ConnectorApprovals.toolApproval({
      tool,
      risk,
      approvals: connection.approvals,
      toolApprovals: connection.toolApprovals,
      agentApprovals: input.agentApprovals,
    });
    const thread = input.records.thread;
    const action = actionText(catalog, tool);
    if (risk !== "read" && thread.interactionMode === "plan") {
      return toolError(
        `This chat is in Plan mode, which only reads, so ${connection.name} cannot ${action}. Ask the user to leave Plan mode first.`,
      );
    }
    const prepared = yield* prepare({ connection, catalog, tool, args: input.args }).pipe(
      Effect.result,
    );
    if (prepared._tag === "Failure") {
      const failure = prepared.failure;
      return toolError(failure.message);
    }
    const call = prepared.success;
    const logActivity = Effect.fn("ConnectorGateway.logActivity")(
      function* (outcome: ConnectorActivityOutcome, ran: boolean) {
        const now = yield* DateTime.now;
        yield* store.appendActivity(connection.id, {
          at: DateTime.formatIso(now),
          tool,
          summary: call.summary(ran),
          threadId,
          threadTitle: thread.title,
          outcome,
        });
        const last =
          connection.lastUsedAt === null ? undefined : DateTime.make(connection.lastUsedAt);
        const recent =
          last !== undefined &&
          Option.isSome(last) &&
          DateTime.toEpochMillis(now) - DateTime.toEpochMillis(last.value) < LAST_USED_EVERY_MS;
        if (ran && !recent) {
          yield* store.update(connection.id, (current) => ({
            ...current,
            lastUsedAt: DateTime.formatIso(now),
          }));
        }
      },
      Effect.catch((error) =>
        Effect.logWarning("could not record connector activity", {
          connectionId: connection.id,
          error: error.message,
        }),
      ),
    );

    if (approval === "ask") {
      const run = ThreadManagement.latestActiveRun(input.records);
      if (run === undefined || run.rootNodeId === null) {
        yield* logActivity("cancelled", false);
        return toolError(
          `The user asks before ${connection.name} can ${action}, and there is no turn running to ask in. Ask them in the chat.`,
        );
      }
      const runId = run.id;
      const nodeId = run.rootNodeId;
      const turnItemId = TurnItemId.make(`turn-item:connector-approval:${yield* random.uuidV4()}`);
      const record = (status: OrchestrationV2ConnectorApprovalStatus, remembered: boolean) =>
        threads
          .dispatch({
            type: "connector_approval.record",
            commandId: CommandId.make(`${turnItemId}:${status}`),
            threadId,
            runId,
            nodeId,
            turnItemId,
            connectionId: connection.id,
            connectorName: connection.name,
            tool,
            risk,
            action,
            details: call.details,
            ...(call.preview === undefined ? {} : { preview: call.preview }),
            approvalStatus: status,
            ...(remembered ? { remembered: true } : {}),
          })
          .pipe(
            Effect.asVoid,
            Effect.catch((error) =>
              Effect.logWarning("could not record a connector approval card", {
                connectionId: connection.id,
                status,
                error: error.message,
              }),
            ),
          );
      const outcome = yield* approvals.ask({
        threadId,
        turnItemId,
        record,
        remember: store
          .update(connection.id, (current) => ({
            ...current,
            toolApprovals: { ...current.toolApprovals, [tool]: "auto" },
          }))
          .pipe(Effect.ignore),
        ended: runEnded(threadId, runId),
      });
      if (outcome === "declined") {
        yield* logActivity("declined", false);
        return toolError(
          `The user declined: ${connection.name} did not ${action}. Do not try again unless they ask you to in the chat.`,
        );
      }
      if (outcome === "cancelled") {
        yield* logActivity("cancelled", false);
        return toolError(
          `Nobody answered, so ${connection.name} did not ${action}. Ask the user in the chat before trying again.`,
        );
      }
    }

    const result = yield* call.run.pipe(Effect.result);
    if (result._tag === "Failure") {
      const failure = result.failure;
      if (failure._tag === "ConnectorCallError") {
        yield* connectors.noteCallFailure(connection.id, failure);
      }
      yield* logActivity("failed", false);
      return toolError(failure.message);
    }
    yield* logActivity(
      result.success.isError === true ? "failed" : approval === "ask" ? "allowed" : "auto",
      result.success.isError !== true,
    );
    return result.success;
  });

  const handle: ConnectorGateway["Service"]["handle"] = Effect.fn("ConnectorGateway.handle")(
    function* (input) {
      const decoded = decodeJsonRpcMessage(input.message);
      if (decoded._tag === "None") {
        return {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Invalid request." },
        } satisfies JsonRpcResponse;
      }
      const message = decoded.value;
      if (message.id === undefined) return undefined;
      const id = message.id;
      const reply = (result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
      const fail = (code: number, text: string): JsonRpcResponse => ({
        jsonrpc: "2.0",
        id,
        error: { code, message: text },
      });

      const found = yield* chatConnection(input.threadId, input.connectionId).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (found === undefined) {
        return fail(-32001, "This chat does not use that connector.");
      }
      const { connection } = found;
      switch (message.method) {
        case "initialize": {
          const requested = decodeInitializeParams(message.params);
          const protocolVersion =
            requested._tag === "Some" && PROTOCOL_VERSIONS.includes(requested.value.protocolVersion)
              ? requested.value.protocolVersion
              : PROTOCOL_VERSIONS[0];
          return reply({
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: {
              name: connection.id,
              title: connection.name,
              version: packageJson.version,
            },
            instructions: `${connection.name}, through Codenine. Some actions wait until the user allows them.`,
          });
        }
        case "ping":
          return reply({});
        case "tools/list": {
          const catalog = connectionCatalog(connection);
          const upstream = yield* connectors.upstreamTools(connection).pipe(Effect.result);
          if (upstream._tag === "Failure") {
            const failure = upstream.failure;
            if (failure._tag === "ConnectorCallError") {
              yield* connectors.noteCallFailure(connection.id, failure);
            }
            return fail(-32002, failure.message);
          }
          const extras = codenineTools(catalog?.codenineTools);
          const extraNames = new Set(extras.map((tool) => tool.name));
          return reply({
            tools: [...upstream.success.filter((tool) => !extraNames.has(tool.name)), ...extras],
          });
        }
        case "tools/call": {
          const params = decodeToolCallParams(message.params);
          if (params._tag === "None") return fail(-32602, "tools/call needs a tool name.");
          return reply(
            yield* callTool({
              threadId: input.threadId,
              connection,
              records: found.records,
              agentApprovals: found.agentApprovals,
              tool: params.value.name,
              args: params.value.arguments ?? {},
            }),
          );
        }
        default:
          return fail(-32601, `${message.method} is not supported.`);
      }
    },
  );

  const answerApproval: ConnectorGateway["Service"]["answerApproval"] = Effect.fn(
    "ConnectorGateway.answerApproval",
  )(function* (input) {
    if ((yield* approvals.answer(input)) === "answered") return;
    const item = yield* threads
      .getTurnItem({ threadId: input.threadId, itemId: input.turnItemId })
      .pipe(
        Effect.map((result) => result.item),
        Effect.orElseSucceed(() => null),
      );
    if (item === null || item.type !== "connector_approval") {
      return yield* new ConnectorError({
        reason: "not-found",
        detail: "This request is no longer waiting for an answer.",
      });
    }
    if (item.approvalStatus !== "pending") {
      return yield* new ConnectorError({
        reason: "already-answered",
        detail: "This request was already answered.",
      });
    }
    // Left pending by a restart: nothing waits on it any more, so close it.
    if (item.runId !== null && item.nodeId !== null) {
      yield* threads
        .dispatch({
          type: "connector_approval.record",
          commandId: CommandId.make(`${item.id}:cancelled`),
          threadId: input.threadId,
          runId: item.runId,
          nodeId: item.nodeId,
          turnItemId: item.id,
          connectionId: item.connectionId,
          connectorName: item.connectorName,
          tool: item.tool,
          risk: item.risk,
          action: item.action,
          details: item.details,
          ...(item.preview === undefined ? {} : { preview: item.preview }),
          approvalStatus: "cancelled",
        })
        .pipe(Effect.ignore);
    }
    return yield* new ConnectorError({
      reason: "not-found",
      detail: "This request is no longer waiting. Ask the agent to try again.",
    });
  });

  return ConnectorGateway.of({ handle, answerApproval });
});

export const layer = Layer.effect(ConnectorGateway, make);
