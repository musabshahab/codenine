import { createBackupEnvironmentAtoms } from "@codenine/client-runtime/state/backup";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentAtomList } from "./environmentAtomList";

export const backupEnvironment = createBackupEnvironmentAtoms(connectionAtomRuntime);

export const backupNeedsAttentionAtom = environmentAtomList(
  "web-backup-needs-attention",
  backupEnvironment.needsAttention,
);
export const restoreReportsAtom = environmentAtomList(
  "web-backup-restore-reports",
  (environmentId) => backupEnvironment.restoreReport({ environmentId, input: {} }),
);
