import { type EnvironmentId, WS_METHODS } from "@codenine/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";

import type * as EnvironmentRegistry from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createSkillsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  // Bumped by every change, so open lists and editors read the folders again.
  const revision = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(0).pipe(Atom.keepAlive, Atom.withLabel(`skills-revision:${environmentId}`)),
  );
  const changed = (
    { environmentId }: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) => Effect.sync(() => registry.update(revision(environmentId), (count) => count + 1));

  return {
    /** Codenine skills, a workspace's own when `projectId` is given, found and library skills. */
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:skills:list",
      tag: WS_METHODS.skillsList,
      refreshTrigger: ({ environmentId }) => revision(environmentId),
    }),
    read: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:skills:read",
      tag: WS_METHODS.skillsRead,
      refreshTrigger: ({ environmentId }) => revision(environmentId),
    }),
    save: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:skills:save",
      tag: WS_METHODS.skillsSave,
      onSettled: changed,
    }),
    delete: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:skills:delete",
      tag: WS_METHODS.skillsDelete,
      onSettled: changed,
    }),
    addFromLibrary: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:skills:add-from-library",
      tag: WS_METHODS.skillsAddFromLibrary,
      onSettled: changed,
    }),
    import: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:skills:import",
      tag: WS_METHODS.skillsImport,
      onSettled: changed,
    }),
  };
}
