import { createConnectorsEnvironmentAtoms } from "@codenine/client-runtime/state/connectors";

import { connectionAtomRuntime } from "../connection/runtime";
import { agentsEnvironment } from "./agents";

export const connectorsEnvironment = createConnectorsEnvironmentAtoms(connectionAtomRuntime, {
  agentsChanged: agentsEnvironment.changed,
});
