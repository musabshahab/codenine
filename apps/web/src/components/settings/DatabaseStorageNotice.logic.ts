import { DATABASE_COMPACTION_RECOMMENDED_BYTES } from "@codenine/contracts";
import * as Schema from "effect/Schema";

/** Reclaimable bytes per environment id when its notice was dismissed. */
export const DismissedReclaimableBytes = Schema.Record(Schema.String, Schema.Number);

/** A dismissed notice returns once another 1 GiB has become reclaimable. */
export function isDatabaseNoticeDismissed(
  dismissed: Readonly<Record<string, number>>,
  environmentId: string,
  reclaimableBytes: number,
): boolean {
  const dismissedAt = dismissed[environmentId];
  return (
    dismissedAt !== undefined &&
    reclaimableBytes < dismissedAt + DATABASE_COMPACTION_RECOMMENDED_BYTES
  );
}
