import type { ThreadId } from "@codenine/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import type { McpProviderSessionConfig } from "./mcpSession.ts";

export class McpProviderSessions extends Context.Service<
  McpProviderSessions,
  {
    readonly set: (config: McpProviderSessionConfig) => Effect.Effect<void>;
    /** The thread's config with the connections it uses now. */
    readonly read: (threadId: ThreadId) => Effect.Effect<McpProviderSessionConfig | undefined>;
    readonly clear: (threadId: ThreadId) => Effect.Effect<void>;
    readonly setConnectors: (
      threadId: ThreadId,
      connectors: ReadonlyArray<string>,
    ) => Effect.Effect<void>;
  }
>()("@codenine/provider-core/server/McpProviderSessions") {}

const make = Effect.gen(function* () {
  const sessions = yield* Ref.make(new Map<ThreadId, McpProviderSessionConfig>());
  const connectors = yield* Ref.make(new Map<ThreadId, ReadonlyArray<string>>());
  return McpProviderSessions.of({
    set: Effect.fn("McpProviderSessions.set")(function (config) {
      return Ref.update(sessions, (current) => new Map(current).set(config.threadId, config));
    }),
    read: Effect.fn("McpProviderSessions.read")(function* (threadId) {
      const config = (yield* Ref.get(sessions)).get(threadId);
      const threadConnectors = (yield* Ref.get(connectors)).get(threadId);
      return config === undefined || threadConnectors === undefined
        ? config
        : { ...config, connectors: threadConnectors };
    }),
    clear: Effect.fn("McpProviderSessions.clear")(function (threadId) {
      return Ref.update(sessions, (current) => {
        const next = new Map(current);
        next.delete(threadId);
        return next;
      }).pipe(
        Effect.andThen(
          Ref.update(connectors, (current) => {
            const next = new Map(current);
            next.delete(threadId);
            return next;
          }),
        ),
      );
    }),
    setConnectors: Effect.fn("McpProviderSessions.setConnectors")(
      function (threadId, threadConnectors) {
        return Ref.update(connectors, (current) =>
          new Map(current).set(threadId, threadConnectors),
        );
      },
    ),
  });
});

export const layer = Layer.effect(McpProviderSessions, make);
