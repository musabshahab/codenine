import { createConnectorsEnvironmentAtoms } from "@codenine/client-runtime/state/connectors";

import { connectionAtomRuntime } from "../connection/runtime";

export const connectorsEnvironment = createConnectorsEnvironmentAtoms(connectionAtomRuntime);
