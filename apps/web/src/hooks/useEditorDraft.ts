import { settlePromise } from "@codenine/client-runtime/state/runtime";
import { useBlocker } from "@tanstack/react-router";
import { useRef, useState } from "react";

import { ensureLocalApi } from "../localApi";

/**
 * An editor form's unsaved edits over what it was read from. An untouched draft follows a newer
 * read of `source`; an edited one keeps the edits, and leaving the page asks before dropping them.
 */
export function useEditorDraft<Source, Draft extends object>(
  source: Source,
  toDraft: (source: Source) => Draft,
  busy: boolean,
) {
  const [seed, setSeed] = useState(() => ({ source, draft: toDraft(source) }));
  const [draft, setDraft] = useState(seed.draft);
  const dirty = draft !== seed.draft && JSON.stringify(draft) !== JSON.stringify(seed.draft);
  if (source !== seed.source && !dirty && !busy) {
    const next = toDraft(source);
    setSeed({ source, draft: next });
    setDraft(next);
  }
  // The draft a save, delete or Cancel let go of: navigation right after it does not ask.
  const releasedRef = useRef<Draft | null>(null);
  useBlocker({
    disabled: !dirty,
    shouldBlockFn: async () => {
      if (releasedRef.current === draft) return false;
      const leave = await settlePromise(() =>
        ensureLocalApi().dialogs.confirm("Leave without saving?\nYour changes will be lost."),
      );
      return !(leave._tag === "Success" && leave.value);
    },
    // Electron cancels a quit silently when unload is blocked.
    enableBeforeUnload: false,
  });
  const release = () => {
    releasedRef.current = draft;
  };
  return {
    draft,
    change: (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch })),
    release,
    /** The draft is what is saved now, so it is no longer an edit. */
    saved: () => {
      release();
      setSeed((current) => ({ ...current, draft }));
    },
  };
}
