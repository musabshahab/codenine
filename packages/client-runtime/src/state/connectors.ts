import { type ConnectionId, type EnvironmentId, WS_METHODS } from "@codenine/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import type * as EnvironmentRegistry from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

const connectionKey = (environmentId: EnvironmentId, connectionId: ConnectionId) =>
  JSON.stringify([environmentId, connectionId]);

export function createConnectorsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
  options: {
    /** Runs when an approval is answered "always", which in an agent's chat rewrites the agent. */
    readonly agentsChanged: (
      target: { readonly environmentId: EnvironmentId },
      registry: AtomRegistry.AtomRegistry,
    ) => Effect.Effect<void>;
  },
) {
  // The catalogue, the connections and the saved apps; emits again on every change.
  const state = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:connectors:state",
    tag: WS_METHODS.subscribeConnectors,
  });
  const connection = (
    environmentId: EnvironmentId,
    connectionId: ConnectionId,
    get: Atom.AtomContext,
  ) =>
    AsyncResult.getOrElse(get(state({ environmentId, input: {} })), () => null)?.connections.find(
      (candidate) => candidate.id === connectionId,
    ) ?? null;

  // Per-action choices are not in the state stream, so saving them bumps this.
  const choicesSaved = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(0).pipe(Atom.keepAlive, Atom.withLabel(`connectors-choices-saved:${environmentId}`)),
  );
  const bumpChoices = (
    { environmentId }: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) => Effect.sync(() => registry.update(choicesSaved(environmentId), (count) => count + 1));
  const toolsRevision = Atom.family((key: string) => {
    const [environmentId, connectionId] = JSON.parse(key) as [EnvironmentId, ConnectionId];
    return Atom.make((get) => {
      const current = connection(environmentId, connectionId, get);
      return JSON.stringify([
        get(choicesSaved(environmentId)),
        current?.status ?? null,
        current?.toolCount ?? null,
        current?.approvals ?? null,
      ]);
    }).pipe(Atom.withLabel(`connectors-tools-revision:${key}`));
  });
  // A connection's last use moves with each action, so open activity reads it again.
  const activityRevision = Atom.family((key: string) => {
    const [environmentId, connectionId] = JSON.parse(key) as [EnvironmentId, ConnectionId];
    return Atom.make(
      (get) => connection(environmentId, connectionId, get)?.lastUsedAt ?? null,
    ).pipe(Atom.withLabel(`connectors-activity-revision:${key}`));
  });

  return {
    state,
    tools: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:connectors:tools",
      tag: WS_METHODS.connectorsTools,
      refreshTrigger: ({ environmentId, input }) =>
        toolsRevision(connectionKey(environmentId, input.connectionId)),
    }),
    activity: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:connectors:activity",
      tag: WS_METHODS.connectorsActivity,
      refreshTrigger: ({ environmentId, input }) =>
        activityRevision(connectionKey(environmentId, input.connectionId)),
    }),
    /** Returns the sign-in page to open, or null when the connector is ready. */
    connect: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:connectors:connect",
      tag: WS_METHODS.connectorsConnect,
    }),
    signIn: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:connectors:sign-in",
      tag: WS_METHODS.connectorsSignIn,
    }),
    // Serial per connection, so two quick changes land in the order they were made.
    update: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:connectors:update",
      tag: WS_METHODS.connectorsUpdate,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => connectionKey(environmentId, input.connectionId),
      },
      onSettled: bumpChoices,
    }),
    disconnect: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:connectors:disconnect",
      tag: WS_METHODS.connectorsDisconnect,
    }),
    test: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:connectors:test",
      tag: WS_METHODS.connectorsTest,
      onSuccess: bumpChoices,
    }),
    answerApproval: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:connectors:answer-approval",
      tag: WS_METHODS.connectorsAnswerApproval,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.threadId, input.turnItemId]),
      },
      onSuccess: (target, registry) =>
        target.input.answer === "always" ? options.agentsChanged(target, registry) : Effect.void,
    }),
  };
}
