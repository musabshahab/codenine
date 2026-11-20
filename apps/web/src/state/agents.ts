import { createAgentsEnvironmentAtoms } from "@codenine/client-runtime/state/agents";

import { connectionAtomRuntime } from "../connection/runtime";

export const agentsEnvironment = createAgentsEnvironmentAtoms(connectionAtomRuntime);
