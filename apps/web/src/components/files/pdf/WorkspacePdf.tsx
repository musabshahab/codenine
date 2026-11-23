import {
  type EnvironmentId,
  PdfOperationError,
  PdfRefusedError,
  ProjectWriteFileConflictError,
  type ScopedThreadRef,
} from "@codenine/contracts";
import {
  type AtomCommandResult,
  executeAtomQuery,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@codenine/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import { useStableCallback } from "~/hooks/useStableCallback";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";

import { BrowserDocumentFrame, nativePdfViewerAvailable } from "../BrowserDocumentFrame";
import { workspaceAssetResource } from "../filePreviewMode";
import { FileSurfaceLoading, FileSurfaceNotice } from "../fileSurfaceChrome";
import PdfEditor, { type PdfResult, type PdfTransport } from "./PdfEditor";
import { hasUnsavedPdfEdits, pdfSessionKey } from "./pdfUnsavedEdits";

const isConflict = Schema.is(ProjectWriteFileConflictError);
const isRefused = Schema.is(PdfRefusedError);
const isOperationError = Schema.is(PdfOperationError);
const QUIET = { reportFailure: false, reportDefect: false } as const;

function settle<A>(result: AtomCommandResult<A, unknown>, unreachable: string): PdfResult<A> {
  if (result._tag === "Success") return { ok: true, value: result.value };
  const cause = squashAtomCommandFailure(result);
  if (isConflict(cause)) return { ok: false, failure: { kind: "conflict" } };
  const message =
    isRefused(cause) || isOperationError(cause) || cause instanceof Error
      ? cause.message
      : unreachable;
  return { ok: false, failure: { kind: "failed", message } };
}

/** Reads and edits one workspace PDF through the server that holds it. */
function workspacePdfTransport(file: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
}): PdfTransport {
  const { environmentId, cwd, relativePath } = file;
  return {
    open: async () =>
      settle(
        await executeAtomQuery(
          appAtomRegistry,
          projectEnvironment.openPdf({ environmentId, input: { cwd, relativePath } }),
          { ...QUIET, refresh: true },
        ),
        "This PDF could not be opened for editing.",
      ),
    save: async (edit, expectedVersion) =>
      settle(
        await runAtomCommand(
          appAtomRegistry,
          projectEnvironment.editPdf,
          { environmentId, input: { cwd, relativePath, expectedVersion, ...edit } },
          QUIET,
        ),
        "The server could not be reached, so the PDF was not saved.",
      ),
  };
}

/** A workspace PDF in the file tab: the document from the server's asset path, and its editor. */
export default function WorkspacePdf(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly draft: boolean;
  readonly absolutePath: string;
  readonly workspaceRoot: string;
  readonly cwd: string;
  readonly relativePath: string;
  readonly title: string;
  /** Changes when the file may have changed on disk, as after an agent's turn or a restore. */
  readonly refreshKey: string;
  readonly readOnly: boolean;
  readonly onPendingChange: (relativePath: string, pending: boolean) => void;
}) {
  const { environmentId, cwd, relativePath } = props;
  // The parent remounts this for another file, so one transport lasts the mount.
  const [transport] = useState(() => workspacePdfTransport({ environmentId, cwd, relativePath }));
  // A save replaces the file, and a URL is minted for one file as it was, so each save and
  // reload names a new revision to mint for.
  const [reloads, setReloads] = useState(0);
  const resource = workspaceAssetResource({
    kind: "media-file",
    threadRef: props.threadRef,
    draft: props.draft,
    workspaceRoot: props.workspaceRoot,
    absolutePath: props.absolutePath,
  });
  const mintKey = `${props.refreshKey}:${reloads}`;
  const assetUrl = useAssetUrlState(environmentId, resource, mintKey);
  const minted =
    assetUrl._tag === "Success"
      ? {
          url: assetUrl.url,
          // Older servers do not name the file's revision, so there every mint is a new document.
          revision: assetUrl.fileRevision ?? mintKey,
        }
      : null;
  // The document stays up while a new URL is minted, and a renewed URL for the same revision
  // does not load it again.
  const [shown, setShown] = useState(minted);
  if (minted !== null && shown?.revision !== minted.revision) setShown(minted);
  const reportPending = useStableCallback((pending: boolean) =>
    props.onPendingChange(relativePath, pending),
  );
  // The viewer with the tools reads the whole file into memory, within limits. A PDF beyond
  // them is still read in the browser's own viewer, which loads it a part at a time.
  const [plain, setPlain] = useState(false);
  const file = { environmentId, cwd, relativePath };

  if (shown === null) {
    return assetUrl._tag === "Failure" ? (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-destructive">
        Unable to load file preview.
      </div>
    ) : (
      <FileSurfaceLoading />
    );
  }
  const { url, revision } = shown;
  const withRevision = (address: string) =>
    `${address}${address.includes("?") ? "&" : "?"}file-revision=${encodeURIComponent(revision)}`;
  if (plain) {
    return (
      <>
        <FileSurfaceNotice>
          This PDF is too large or too slow to load for marking up here, so it is shown for reading
          only.
        </FileSurfaceNotice>
        <BrowserDocumentFrame
          pdf
          src={withRevision(url)}
          title={props.title}
          documentKey={`${pdfSessionKey(file)}:${revision}`}
          documentId={pdfSessionKey(file)}
        />
      </>
    );
  }
  return (
    <PdfEditor
      transport={transport}
      sessionKey={pdfSessionKey(file)}
      src={withRevision(url)}
      freshSrc={withRevision(minted?.revision === revision ? minted.url : url)}
      revision={revision}
      title={props.title}
      readOnly={props.readOnly}
      onPendingChange={reportPending}
      onReload={() => setReloads((count) => count + 1)}
      onUnavailable={() => {
        if (nativePdfViewerAvailable() && !hasUnsavedPdfEdits(file)) setPlain(true);
      }}
    />
  );
}
