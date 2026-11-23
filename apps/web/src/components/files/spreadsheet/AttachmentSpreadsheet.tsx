import { useEffect, useState } from "react";

import { FileSurfaceLoading } from "../fileSurfaceChrome";
import type { SheetMethods } from "../office/sheet-protocol";
import { createWorkerClient } from "../office/worker-rpc";
import { attachmentSpreadsheetTransport } from "./attachmentSpreadsheetTransport";
import SpreadsheetEditor from "./SpreadsheetEditor";
import type { SpreadsheetTransport } from "./spreadsheetSession";

const NO_PENDING = () => {};

/**
 * A workbook that is not a workspace file, in the grid that edits workspace files: the same
 * cells, fonts and clipping, read only.
 */
export default function AttachmentSpreadsheet(props: {
  readonly bytes: ArrayBuffer;
  readonly name: string;
  /** Distinguishes this file from another of the same name. */
  readonly sessionKey: string;
}) {
  const { bytes: source } = props;
  const [transport, setTransport] = useState<SpreadsheetTransport | null>(null);
  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- owns the workbook worker that reads this file's cells, and ends it when the file goes away
  useEffect(() => {
    const worker = new Worker(new URL("../office/spreadsheet.worker.ts", import.meta.url), {
      type: "module",
    });
    const engine = createWorkerClient<SheetMethods>(worker);
    // oxlint-disable-next-line react/set-state-in-effect -- the transport is made with the worker the effect owns
    setTransport(
      attachmentSpreadsheetTransport({
        open: () => {
          const bytes = source.slice(0);
          return engine.call("open", { bytes }, { transfer: [bytes] });
        },
        show: (sheet) => engine.call("show", { sheet }),
        cells: (sheet, range) => engine.call("cells", { sheet, range }),
      }),
    );
    return () => engine.close();
  }, [source]);
  if (transport === null) return <FileSurfaceLoading />;
  return (
    <SpreadsheetEditor
      transport={transport}
      sessionKey={`attachment\u0000${props.sessionKey}`}
      name={props.name}
      readOnly
      refreshKey={null}
      onPendingChange={NO_PENDING}
      fallback={null}
    />
  );
}
