import { createSavedWorkflowsEnvironmentAtoms } from "@codenine/client-runtime/state/savedWorkflows";

import { connectionAtomRuntime } from "../connection/runtime";

export const savedWorkflowsEnvironment =
  createSavedWorkflowsEnvironmentAtoms(connectionAtomRuntime);
