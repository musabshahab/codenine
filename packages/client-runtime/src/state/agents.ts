import { type EnvironmentId, WS_METHODS } from "@codenine/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";

import type * as EnvironmentRegistry from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createAgentsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  // Bumped by every change, so open lists, pickers and editors read the agents again.
  const revision = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(0).pipe(Atom.keepAlive, Atom.withLabel(`agents-revision:${environmentId}`)),
  );
  const changed = (
    { environmentId }: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) => Effect.sync(() => registry.update(revision(environmentId), (count) => count + 1));

  return {
    /** For a change made outside these commands, such as a chat's approval saved on its agent. */
    changed,
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:agents:list",
      tag: WS_METHODS.agentsList,
      refreshTrigger: ({ environmentId }) => revision(environmentId),
    }),
    read: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:agents:read",
      tag: WS_METHODS.agentsRead,
      refreshTrigger: ({ environmentId }) => revision(environmentId),
    }),
    save: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agents:save",
      tag: WS_METHODS.agentsSave,
      onSettled: changed,
    }),
    delete: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agents:delete",
      tag: WS_METHODS.agentsDelete,
      onSettled: changed,
    }),
  };
}
