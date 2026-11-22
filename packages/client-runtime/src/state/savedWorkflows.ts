import { type EnvironmentId, WS_METHODS } from "@codenine/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";

import type * as EnvironmentRegistry from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/** Saved workflows; named apart from the provider-native workflow runs in `threadWorkflows`. */
export function createSavedWorkflowsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  // Bumped by every change, so open lists and editors read the workflows again; a run moves the
  // next scheduled time and the problems, so it counts as a change too.
  const revision = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(0).pipe(Atom.keepAlive, Atom.withLabel(`saved-workflows-revision:${environmentId}`)),
  );
  const changed = (
    { environmentId }: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) => Effect.sync(() => registry.update(revision(environmentId), (count) => count + 1));

  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:workflows:list",
      tag: WS_METHODS.workflowsList,
      refreshTrigger: ({ environmentId }) => revision(environmentId),
    }),
    read: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:workflows:read",
      tag: WS_METHODS.workflowsRead,
      refreshTrigger: ({ environmentId }) => revision(environmentId),
    }),
    save: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflows:save",
      tag: WS_METHODS.workflowsSave,
      onSettled: changed,
    }),
    delete: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflows:delete",
      tag: WS_METHODS.workflowsDelete,
      onSettled: changed,
    }),
    run: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflows:run",
      tag: WS_METHODS.workflowsRun,
      onSettled: changed,
    }),
    setEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflows:set-enabled",
      tag: WS_METHODS.workflowsSetEnabled,
      onSettled: changed,
    }),
  };
}
