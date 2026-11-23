import type { EnvironmentId, ProjectFileBaselineSource } from "@codenine/contracts";
import { executeAtomQuery } from "@codenine/client-runtime/state/runtime";
import { useEffect, useState } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";

export interface FileBaselineTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly source: ProjectFileBaselineSource;
}

export interface FileBaseline {
  readonly available: boolean;
  /** Null when the file did not exist in the baseline. */
  readonly contents: string | null;
  readonly revision?: string | undefined;
  /** The earlier contents are kept but are not text, so the file can only be put back whole. */
  readonly wholeFileOnly?: boolean | undefined;
}

const UNAVAILABLE: FileBaseline = { available: false, contents: null };
const MAX_CACHED_BASELINES = 16;
// Baselines are up to 1 MB each, so a refresh sends the held revision and keeps this copy on a match.
const baselines = new Map<string, FileBaseline>();

const baselineKey = (target: FileBaselineTarget) =>
  JSON.stringify([target.environmentId, target.cwd, target.relativePath, target.source]);

function remember(key: string, baseline: FileBaseline): void {
  baselines.delete(key);
  baselines.set(key, baseline);
  const oldest = baselines.keys().next();
  if (baselines.size > MAX_CACHED_BASELINES && !oldest.done) baselines.delete(oldest.value);
}

async function fetchFileBaseline(key: string, target: FileBaselineTarget): Promise<FileBaseline> {
  const held = baselines.get(key);
  // The checkpoint a turn started from never changes.
  if (held && target.source.kind === "turn") return held;
  const result = await executeAtomQuery(
    appAtomRegistry,
    projectEnvironment.readFileBaseline({
      environmentId: target.environmentId,
      input: {
        cwd: target.cwd,
        relativePath: target.relativePath,
        source: target.source,
        ...(held?.revision === undefined ? {} : { knownRevision: held.revision }),
      },
    }),
    { refresh: true, reportFailure: false, reportDefect: false },
  );
  if (result._tag !== "Success") return held ?? UNAVAILABLE;
  if (result.value.unchanged === true && held) return held;
  const baseline = {
    available: result.value.available,
    contents: result.value.contents,
    revision: result.value.revision,
    wholeFileOnly: result.value.wholeFileOnly,
  };
  remember(key, baseline);
  return baseline;
}

/**
 * A file's text at the last commit or at the start of a turn, read again whenever `refreshKey`
 * changes. Null until the first read settles, and for a null target.
 */
export function useFileBaseline(
  target: FileBaselineTarget | null,
  refreshKey: string | null,
): FileBaseline | null {
  const key = target === null ? null : baselineKey(target);
  const [loaded, setLoaded] = useState<{ key: string; baseline: FileBaseline } | null>(null);

  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- reads the baseline from the server for this file and workspace revision
  useEffect(() => {
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `key` stands for `target`, which is a new object each render.
    if (key === null || target === null) return;
    let current = true;
    void fetchFileBaseline(key, target).then((baseline) => {
      if (current) setLoaded({ key, baseline });
    });
    return () => {
      current = false;
    };
  }, [key, refreshKey]);

  if (key === null) return null;
  return loaded?.key === key ? loaded.baseline : (baselines.get(key) ?? null);
}
