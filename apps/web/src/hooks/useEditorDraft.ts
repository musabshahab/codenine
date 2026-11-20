import { settlePromise } from "@codenine/client-runtime/state/runtime";
import { useBlocker } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { ensureLocalApi } from "../localApi";

/**
 * True once `read` has a newer answer than the one it had when the page opened on `query`. An
 * editor seeded from that cached answer would save old content over a newer file.
 */
export function useReadSinceOpened(
  query: object | null,
  read: {
    readonly dataUpdatedAt: number;
    readonly isPending: boolean;
    readonly isSuccess: boolean;
    readonly refresh: () => void;
  },
): boolean {
  const [opened, setOpened] = useState({ query, cachedAt: read.dataUpdatedAt, answered: false });
  const current = opened.query === query;
  const answered =
    current &&
    (opened.answered ||
      (read.isSuccess && !read.isPending && read.dataUpdatedAt > opened.cachedAt));
  if (!current) setOpened({ query, cachedAt: read.dataUpdatedAt, answered: false });
  else if (answered && !opened.answered) setOpened({ ...opened, answered: true });
  const { isPending, refresh } = read;
  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- a cached read is only refetched once stale, and an editor needs the file as it is now
  useEffect(() => {
    if (query !== null && !isPending) refresh();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Once per opened query, not once per answer.
  }, [query]);
  return answered;
}

/**
 * An editor form's unsaved edits over what it was read from. An untouched draft follows a newer
 * read of `source`; an edited one keeps the edits and reports the newer read as `newer`, and
 * leaving the page asks before dropping them.
 */
export function useEditorDraft<Source, Draft extends object>(
  source: Source,
  toDraft: (source: Source) => Draft,
  busy: boolean,
) {
  const [seed, setSeed] = useState(() => ({ source, draft: toDraft(source) }));
  const [draft, setDraft] = useState(seed.draft);
  const dirty = draft !== seed.draft && JSON.stringify(draft) !== JSON.stringify(seed.draft);
  const follow = () => {
    const next = toDraft(source);
    setSeed({ source, draft: next });
    setDraft(next);
  };
  if (source !== seed.source && !dirty && !busy) follow();
  const newer =
    dirty &&
    source !== seed.source &&
    JSON.stringify(toDraft(source)) !== JSON.stringify(seed.draft);
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
    /** The source changed under an edited draft, so saving would undo that change. */
    newer,
    /** Drops the edits for the newer source. */
    follow,
    change: (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch })),
    release,
    /** The draft is what is saved now, so it is no longer an edit. */
    saved: () => {
      release();
      setSeed((current) => ({ ...current, draft }));
    },
  };
}
