import type {
  AgentConnector,
  ConnectorApprovalAnswer,
  ConnectorApprovalAnswerInput,
  ConnectorApprovalMode,
  ConnectorApprovals as ConnectorApprovalChoices,
  ConnectorRisk,
  OrchestrationV2ConnectorApprovalStatus,
  ThreadId,
  TurnItemId,
} from "@codenine/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import type { UpstreamTool } from "./ConnectorStore.ts";

/**
 * A pinned risk wins, then the service's annotations. A tool that says nothing may be destructive
 * (the MCP spec's own default), so it counts as irreversible.
 */
export const toolRisk = (
  tool: Pick<UpstreamTool, "name" | "annotations">,
  pinned: Readonly<Record<string, ConnectorRisk>> | undefined,
): ConnectorRisk => {
  const pin = pinned?.[tool.name];
  if (pin !== undefined) return pin;
  if (tool.annotations?.readOnlyHint === true) return "read";
  if (tool.annotations?.destructiveHint === false) return "change";
  return "irreversible";
};

/**
 * In an agent's chat, the agent's choice for the group decides, so its settings mean what they say.
 * Otherwise, and for a group the agent leaves to the connection, the user's choice for this one
 * action wins, then the connection's for the group.
 */
export const toolApproval = (input: {
  readonly tool: string;
  readonly risk: ConnectorRisk;
  readonly approvals: ConnectorApprovalChoices;
  readonly toolApprovals: Readonly<Record<string, ConnectorApprovalMode>>;
  readonly agentApprovals?: AgentConnector["approvals"] | undefined;
}): { readonly mode: ConnectorApprovalMode; readonly byAgent: boolean } => {
  const agentMode = input.agentApprovals?.[input.risk];
  return agentMode === undefined
    ? { mode: input.toolApprovals[input.tool] ?? input.approvals[input.risk], byAgent: false }
    : { mode: agentMode, byAgent: true };
};

export type ApprovalOutcome = "allowed" | "declined" | "cancelled";

const APPROVAL_WAIT = Duration.minutes(10);

const outcomeOf = (answer: ConnectorApprovalAnswer): ApprovalOutcome =>
  answer === "decline" ? "declined" : "allowed";

interface Waiting {
  readonly answered: Deferred.Deferred<ConnectorApprovalAnswer>;
  readonly settle: (answer: ConnectorApprovalAnswer) => Effect.Effect<void>;
}

export class ConnectorApprovals extends Context.Service<
  ConnectorApprovals,
  {
    /**
     * Shows the card through `record` and waits for the user. Nobody answering within the wait,
     * the call ending, or `ended` completing closes the card as cancelled.
     */
    readonly ask: (input: {
      readonly threadId: ThreadId;
      readonly turnItemId: TurnItemId;
      readonly record: (
        status: OrchestrationV2ConnectorApprovalStatus,
        remembered: boolean,
      ) => Effect.Effect<void>;
      /** Stops asking for this action on this connection; without it "always" allows once. */
      readonly remember?: Effect.Effect<void>;
      readonly ended: Effect.Effect<void>;
    }) => Effect.Effect<ApprovalOutcome>;
    /** `not-waiting` when no call is waiting on this card. */
    readonly answer: (
      input: ConnectorApprovalAnswerInput,
    ) => Effect.Effect<"answered" | "not-waiting">;
  }
>()("codenine/connectors/ConnectorApprovals") {}

const make = Effect.gen(function* () {
  // One answer or close at a time, so a card is recorded once whichever comes first.
  const lock = yield* Semaphore.make(1);
  const waiting = yield* Ref.make<ReadonlyMap<string, Waiting>>(new Map());
  const keyOf = (threadId: ThreadId, turnItemId: TurnItemId) => `${threadId}\u0000${turnItemId}`;

  const take = (key: string, only?: Waiting) =>
    Ref.modify(waiting, (current) => {
      const found = current.get(key);
      if (found === undefined || (only !== undefined && found !== only)) {
        return [undefined, current] as const;
      }
      const next = new Map(current);
      next.delete(key);
      return [found, next] as const;
    });

  const ask: ConnectorApprovals["Service"]["ask"] = Effect.fn("ConnectorApprovals.ask")(
    function* (input) {
      const key = keyOf(input.threadId, input.turnItemId);
      const entry: Waiting = {
        answered: yield* Deferred.make<ConnectorApprovalAnswer>(),
        settle: (answer) => {
          const remember = answer === "always" ? input.remember : undefined;
          return input
            .record(outcomeOf(answer), remember !== undefined)
            .pipe(Effect.andThen(remember ?? Effect.void));
        },
      };
      const closeUnanswered = lock.withPermits(1)(
        take(key, entry).pipe(
          Effect.flatMap((found) =>
            found === undefined
              ? Effect.succeed(false)
              : input.record("cancelled", false).pipe(Effect.as(true)),
          ),
        ),
      );
      yield* lock.withPermits(1)(
        Ref.update(waiting, (current) => new Map(current).set(key, entry)),
      );
      return yield* Effect.gen(function* () {
        yield* input.record("pending", false);
        const waited = yield* Deferred.await(entry.answered).pipe(
          Effect.asSome,
          Effect.raceFirst(input.ended.pipe(Effect.as(Option.none<ConnectorApprovalAnswer>()))),
          Effect.timeoutOption(APPROVAL_WAIT),
          Effect.map(Option.flatten),
        );
        if (Option.isSome(waited)) return outcomeOf(waited.value);
        if (yield* closeUnanswered) return "cancelled" as const;
        // An answer took the card first; it completes the deferred before releasing the lock.
        return outcomeOf(yield* Deferred.await(entry.answered));
      }).pipe(Effect.onInterrupt(() => closeUnanswered));
    },
  );

  const answer: ConnectorApprovals["Service"]["answer"] = Effect.fn("ConnectorApprovals.answer")(
    function* (input) {
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const entry = yield* take(keyOf(input.threadId, input.turnItemId));
          if (entry === undefined) return "not-waiting" as const;
          yield* entry.settle(input.answer);
          yield* Deferred.succeed(entry.answered, input.answer);
          return "answered" as const;
        }),
      );
    },
  );

  return ConnectorApprovals.of({ ask, answer });
});

export const layer = Layer.effect(ConnectorApprovals, make);
