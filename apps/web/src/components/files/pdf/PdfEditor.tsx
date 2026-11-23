import {
  type PdfEditInput,
  type PdfEditResult,
  type PdfFieldValue,
  type PdfOpenResult,
  type PdfRect,
  type PdfRefusalReason,
  pdfRefusalMessage,
} from "@codenine/contracts";
import {
  normalizePdfRotation,
  type PdfPageGeometry,
  pdfPageViewSize,
  viewToPdfPoint,
  viewToPdfRect,
} from "@codenine/shared/pdfGeometry";
import {
  HighlighterIcon,
  ListIcon,
  MessageSquarePlusIcon,
  MousePointer2Icon,
  SignatureIcon,
  TextCursorInputIcon,
  Undo2Icon,
} from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { useStableCallback } from "~/hooks/useStableCallback";
import { isEditableFocused } from "~/lib/editableFocus";
import { cn } from "~/lib/utils";

import { FileSurfaceAction, FileSurfaceBar, FileSurfaceNotice } from "../fileSurfaceChrome";
import PdfViewer, { type PdfPageSurface, type PdfViewerHandle } from "../PdfViewer";
import {
  addPdfEdit,
  changePdfEdit,
  dropPdfEdit,
  listPdfAnnotations,
  PDF_HIGHLIGHT_COLOUR,
  pdfEditRequest,
  pdfFieldValues,
  type PdfListedAnnotation,
  type PdfPendingEdit,
  type PdfPendingEdits,
  rebasePdfEdits,
  undoPdfEdit,
} from "./pdfEditSession";
import { PdfPageOverlay, type PdfTool } from "./PdfPageOverlay";
import { clipViewBox, mergeLineBoxes, signatureBoxAt } from "./pdfPlacement";
import type { ChosenSignature } from "./PdfSignatureDialog";
import { captionImageBase64, needsCaptionImage } from "./signatureImage";

const PdfSignatureDialog = lazy(() => import("./PdfSignatureDialog"));

export type PdfResult<A> =
  | { readonly ok: true; readonly value: A }
  | {
      readonly ok: false;
      readonly failure:
        | { readonly kind: "conflict" }
        | { readonly kind: "failed"; readonly message: string };
    };

/** How the editor reaches the PDF: the server that holds the file, or a stand-in under test. */
export interface PdfTransport {
  readonly open: () => Promise<PdfResult<PdfOpenResult>>;
  readonly save: (
    edit: Pick<PdfEditInput, "operations" | "signatures">,
    expectedVersion: string,
  ) => Promise<PdfResult<PdfEditResult>>;
}

// Unsaved edits outlive the tab's view, which is unmounted when the user looks at another thread.
const unsavedEdits = new Map<string, PdfPendingEdits>();

type Opened =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | ({ readonly status: "ready"; readonly refusal?: PdfRefusalReason } & PdfEditResult);

const remember = (sessionKey: string, edits: PdfPendingEdits) => {
  if (edits.length === 0) unsavedEdits.delete(sessionKey);
  else unsavedEdits.set(sessionKey, edits);
  return edits;
};

let nextEditKey = 0;
const editKey = () => `edit-${++nextEditKey}`;

/** The geometry of a shown page, read from what the viewer wrote on its overlay. */
function shownPageGeometry(page: Element): PdfPageGeometry | null {
  const frame = page.querySelector("[data-pdf-box]");
  const box = frame?.getAttribute("data-pdf-box")?.split(",").map(Number);
  if (box === undefined || box.length !== 4 || box.some((value) => !Number.isFinite(value))) {
    return null;
  }
  const rotation = normalizePdfRotation(Number(frame?.getAttribute("data-pdf-rotation") ?? 0));
  const [left = 0, bottom = 0, right = 0, top = 0] = box;
  const unscaled = { box: [left, bottom, right, top] as const, rotation, scale: 1 };
  const width = page.getBoundingClientRect().width;
  return { ...unscaled, scale: width / pdfPageViewSize(unscaled).width };
}

/** The selected text as rectangles the file stores, for each shown page the selection touches. */
function selectedTextRects(root: HTMLElement): ReadonlyArray<{
  readonly page: number;
  readonly rects: ReadonlyArray<PdfRect>;
}> {
  const selection = window.getSelection();
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return [];
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return [];
  const boxes = Array.from(range.getClientRects());
  const found: Array<{ page: number; rects: ReadonlyArray<PdfRect> }> = [];
  for (const page of root.querySelectorAll("[data-pdf-page]")) {
    const geometry = shownPageGeometry(page);
    if (geometry === null) continue;
    const bounds = page.getBoundingClientRect();
    const size = { width: bounds.width, height: bounds.height };
    const onPage = boxes.flatMap((box) => {
      const clipped = clipViewBox(
        {
          x: box.left - bounds.left,
          y: box.top - bounds.top,
          width: box.width,
          height: box.height,
        },
        size,
      );
      return clipped === null ? [] : [clipped];
    });
    const rects = mergeLineBoxes(onPage).map((box) => viewToPdfRect(geometry, box));
    if (rects.length > 0) found.push({ page: Number(page.getAttribute("data-pdf-page")), rects });
  }
  return found;
}

function AnnotationList(props: {
  readonly annotations: ReadonlyArray<PdfListedAnnotation>;
  readonly selected: string | null;
  readonly onOpen: (annotation: PdfListedAnnotation) => void;
}) {
  return (
    <aside
      aria-label="Notes and highlights"
      className="flex w-56 max-w-[45%] shrink-0 flex-col overflow-auto border-l border-border/60 bg-background text-xs"
    >
      <h3 className="px-3 pt-2.5 pb-1.5 font-medium text-foreground">Notes and highlights</h3>
      {props.annotations.length === 0 ? (
        <p className="px-3 pb-3 text-muted-foreground">
          None yet. Select text with the highlight tool, or click a page with the note tool.
        </p>
      ) : (
        <ul className="flex flex-col pb-2">
          {props.annotations.map((annotation) => (
            <li key={annotation.key}>
              <button
                type="button"
                aria-current={props.selected === annotation.key}
                className={cn(
                  "flex w-full flex-col gap-0.5 px-3 py-1.5 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                  props.selected === annotation.key && "bg-accent",
                )}
                onClick={() => props.onOpen(annotation)}
              >
                <span className="flex items-center justify-between gap-2 text-muted-foreground">
                  <span>
                    Page {annotation.page + 1},{" "}
                    {annotation.kind === "highlight" ? "highlight" : "note"}
                  </span>
                  <span>
                    {annotation.removal !== null
                      ? "To be removed"
                      : annotation.saved
                        ? ""
                        : "Not saved"}
                  </span>
                </span>
                <span
                  className={cn(
                    "line-clamp-2 break-words text-foreground",
                    annotation.removal !== null && "line-through",
                  )}
                >
                  {annotation.contents === "" ? "No comment" : annotation.contents}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

/** Reads the PDF's contents once. The editor mounts a new one for each revision of the file. */
function PdfContentsReader(props: {
  readonly transport: PdfTransport;
  readonly onOpened: (result: PdfResult<PdfOpenResult>) => void;
}) {
  const { transport, onOpened } = props;
  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- Read the PDF's annotations and fields from the server, and drop the answer if the file changed again first.
  useEffect(() => {
    let cancelled = false;
    void transport.open().then((result) => {
      if (!cancelled) onOpened(result);
    });
    return () => {
      cancelled = true;
    };
  }, [transport, onOpened]);
  return null;
}

/**
 * A PDF for reading, marking up, filling in and signing. Edits are held here until the user
 * saves, and one save sends them all.
 */
export default function PdfEditor(props: {
  readonly transport: PdfTransport;
  /** Names the file, so its unsaved edits are found again after the view was unmounted. */
  readonly sessionKey: string;
  readonly src: string;
  /** Changes when the file on disk does, which loads the document and its contents again. */
  readonly revision: string;
  readonly title: string;
  readonly readOnly: boolean;
  readonly onPendingChange: (pending: boolean) => void;
  /** Asks for the file as it now is: after a save, or when a save found it changed. */
  readonly onReload: () => void;
}) {
  const { transport, sessionKey, revision } = props;
  const [edits, setEditsState] = useState<PdfPendingEdits>(
    () => unsavedEdits.get(sessionKey) ?? [],
  );
  const setEdits = (change: (edits: PdfPendingEdits) => PdfPendingEdits) =>
    setEditsState((current) => remember(sessionKey, change(current)));
  const [opened, setOpened] = useState<Opened>({ status: "loading" });
  // Bumped to read the file again when a save found it changed.
  const [reopens, setReopens] = useState(0);
  const [tool, setTool] = useState<PdfTool>("select");
  const [fillForm, setFillForm] = useState(true);
  const [listOpen, setListOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [signature, setSignature] = useState<ChosenSignature | null>(null);
  const [signatureDialogOpen, setSignatureDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const viewer = useRef<PdfViewerHandle>(null);

  const dirty = edits.length > 0;
  const reportPending = useStableCallback(props.onPendingChange);
  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- Tell the tab strip, which lives outside this view, whether the file has unsaved edits.
  useEffect(() => {
    reportPending(dirty);
  }, [dirty, reportPending]);

  const onOpened = useStableCallback((result: PdfResult<PdfOpenResult>) => {
    if (!result.ok) {
      setOpened({
        status: "failed",
        message:
          result.failure.kind === "failed"
            ? result.failure.message
            : "This PDF could not be opened for editing.",
      });
      return;
    }
    setOpened({ status: "ready", ...result.value });
    setEdits((current) => rebasePdfEdits(current, result.value));
  });

  const ready = opened.status === "ready" ? opened : null;
  const blocked =
    opened.status === "failed"
      ? opened.message
      : ready?.refusal !== undefined
        ? pdfRefusalMessage(ready.refusal)
        : null;
  const canEdit = !props.readOnly && ready !== null && ready.refusal === undefined && !conflict;
  const annotations = listPdfAnnotations(ready?.annotations ?? [], edits);
  const fields = ready?.fields ?? [];
  const fieldValues = pdfFieldValues(fields, edits);
  const signatures = edits.filter((edit) => edit.kind === "signature");
  const activeTool: PdfTool = canEdit ? tool : "select";

  const add = (edit: PdfPendingEdit) => setEdits((current) => addPdfEdit(current, edit));

  const save = async () => {
    if (saving || !dirty || ready === null || !canEdit) return;
    const sent = edits;
    setSaving(true);
    setFailure(null);
    const result = await transport.save(pdfEditRequest(sent), ready.version);
    setSaving(false);
    if (result.ok) {
      setOpened({ status: "ready", ...result.value });
      // Anything done while the save was on its way stays unsaved.
      setEdits((current) => current.filter((edit) => !sent.includes(edit)));
      setSelected(null);
      props.onReload();
      return;
    }
    if (result.failure.kind === "conflict") setConflict(true);
    else setFailure(result.failure.message);
  };

  const highlightSelection = () => {
    if (activeTool !== "highlight" || root.current === null) return;
    const found = selectedTextRects(root.current);
    if (found.length === 0) return;
    for (const { page, rects } of found) {
      add({
        kind: "highlight",
        key: editKey(),
        page,
        rects,
        colour: PDF_HIGHLIGHT_COLOUR,
        contents: "",
      });
    }
    window.getSelection()?.removeAllRanges();
  };

  const place = (surface: PdfPageSurface, point: { readonly x: number; readonly y: number }) => {
    if (activeTool === "note") {
      const key = editKey();
      add({
        kind: "note",
        key,
        page: surface.index,
        ...viewToPdfPoint(surface.geometry, point),
        contents: "",
      });
      setSelected(key);
      setTool("select");
      return;
    }
    if (activeTool !== "sign" || signature === null) return;
    // The date as this device writes it, kept as the text that is printed.
    const date = new Date().toLocaleDateString();
    const caption =
      needsCaptionImage(signature.name) || needsCaptionImage(date)
        ? captionImageBase64(signature.name, date)
        : undefined;
    add({
      kind: "signature",
      key: editKey(),
      page: surface.index,
      rect: viewToPdfRect(
        surface.geometry,
        signatureBoxAt(point, signature.image, surface.geometry.scale, surface),
      ),
      image: { mediaType: signature.image.mediaType, dataBase64: signature.image.dataBase64 },
      name: signature.name,
      date,
      ...(caption === undefined ? {} : { captionImageBase64: caption }),
    });
    setTool("select");
  };

  const chooseTool = (next: PdfTool) => {
    setSelected(null);
    setTool(next);
    if (next === "sign" && signature === null) setSignatureDialogOpen(true);
  };

  const status = saving ? "Saving..." : dirty ? "Unsaved" : "Saved";
  const hint =
    activeTool === "highlight"
      ? "Select text to highlight it."
      : activeTool === "note"
        ? "Click where the note should go."
        : activeTool === "sign" && signature !== null
          ? "Click where your signature should go. You can move and resize it until you save."
          : null;

  return (
    <div
      ref={root}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      onPointerUp={highlightSelection}
      onKeyDown={(event) => {
        if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
        if (event.key === "s") {
          event.preventDefault();
          event.stopPropagation();
          void save();
        } else if (event.key === "z" && !event.shiftKey && !isEditableFocused(event.target)) {
          event.preventDefault();
          event.stopPropagation();
          setEdits(undoPdfEdit);
        }
      }}
    >
      <PdfContentsReader key={`${revision}:${reopens}`} transport={transport} onOpened={onOpened} />
      <PdfViewer
        key={revision}
        handle={viewer}
        src={props.src}
        title={props.title}
        positionKey={sessionKey}
        toolbarStart={
          canEdit || dirty ? (
            <>
              <FileSurfaceAction
                label="Select"
                pressed={activeTool === "select"}
                onPress={() => chooseTool("select")}
              >
                <MousePointer2Icon className="size-3.5" />
              </FileSurfaceAction>
              <FileSurfaceAction
                label="Highlight text"
                pressed={activeTool === "highlight"}
                disabled={!canEdit}
                onPress={() => chooseTool("highlight")}
              >
                <HighlighterIcon className="size-3.5" />
              </FileSurfaceAction>
              <FileSurfaceAction
                label="Add a note"
                pressed={activeTool === "note"}
                disabled={!canEdit}
                onPress={() => chooseTool("note")}
              >
                <MessageSquarePlusIcon className="size-3.5" />
              </FileSurfaceAction>
              <FileSurfaceAction
                label="Sign"
                pressed={activeTool === "sign"}
                disabled={!canEdit}
                onPress={() => chooseTool("sign")}
              >
                <SignatureIcon className="size-3.5" />
              </FileSurfaceAction>
              {fields.length > 0 ? (
                <FileSurfaceAction
                  label="Fill in the form"
                  pressed={fillForm}
                  onPress={() => setFillForm((on) => !on)}
                >
                  <TextCursorInputIcon className="size-3.5" />
                </FileSurfaceAction>
              ) : null}
              <FileSurfaceAction
                label="Undo the last unsaved change"
                disabled={!dirty || saving}
                onPress={() => setEdits(undoPdfEdit)}
              >
                <Undo2Icon className="size-3.5" />
              </FileSurfaceAction>
              <span aria-hidden className="mx-1 h-4 w-px bg-border" />
            </>
          ) : null
        }
        toolbarEnd={
          <>
            <FileSurfaceAction
              label="Notes and highlights"
              pressed={listOpen}
              onPress={() => setListOpen((open) => !open)}
            >
              <ListIcon className="size-3.5" />
            </FileSurfaceAction>
            {canEdit || dirty ? (
              // Kept together so the status never wraps away from its button.
              <span className="flex items-center gap-1">
                <span role="status" className="flex items-center gap-1 px-1 text-muted-foreground">
                  {saving ? <Spinner className="size-3" /> : null}
                  {status}
                </span>
                <Button
                  type="button"
                  size="xs"
                  disabled={!dirty || saving || !canEdit}
                  onClick={() => void save()}
                >
                  Save
                </Button>
              </span>
            ) : null}
          </>
        }
        header={
          <>
            {blocked !== null ? <FileSurfaceNotice>{blocked}</FileSurfaceNotice> : null}
            {conflict ? (
              <FileSurfaceBar
                tone="warning"
                actions={
                  <>
                    <Button
                      type="button"
                      size="micro"
                      variant="outline"
                      onClick={() => {
                        setConflict(false);
                        props.onReload();
                        setReopens((count) => count + 1);
                      }}
                    >
                      Load the new file and keep my changes
                    </Button>
                    <Button
                      type="button"
                      size="micro"
                      variant="destructive-outline"
                      onClick={() => {
                        setEdits(() => []);
                        setConflict(false);
                        props.onReload();
                        setReopens((count) => count + 1);
                      }}
                    >
                      Discard my changes
                    </Button>
                  </>
                }
              >
                This PDF changed on disk while you were working, so your changes are not saved.
                Loading the new file keeps them for you to check and save again.
              </FileSurfaceBar>
            ) : null}
            {failure !== null ? (
              <FileSurfaceBar
                tone="warning"
                actions={
                  <Button
                    type="button"
                    size="micro"
                    variant="outline"
                    onClick={() => setFailure(null)}
                  >
                    Dismiss
                  </Button>
                }
              >
                {failure}
              </FileSurfaceBar>
            ) : null}
            {hint !== null ? (
              <FileSurfaceBar
                actions={
                  activeTool === "sign" ? (
                    <Button
                      type="button"
                      size="micro"
                      variant="outline"
                      onClick={() => setSignatureDialogOpen(true)}
                    >
                      Change signature
                    </Button>
                  ) : null
                }
              >
                {hint}
              </FileSurfaceBar>
            ) : signatures.length > 0 && !conflict ? (
              <FileSurfaceBar actions={null}>
                Saving makes your signature part of the page. It cannot be moved or removed
                afterwards, except by going back to an earlier version.
              </FileSurfaceBar>
            ) : null}
          </>
        }
        side={
          listOpen ? (
            <AnnotationList
              annotations={annotations}
              selected={selected}
              onOpen={(annotation) => {
                viewer.current?.showPage(annotation.page);
                setTool("select");
                setSelected(annotation.key);
              }}
            />
          ) : undefined
        }
        renderPageOverlay={(surface) => (
          <PdfPageOverlay
            surface={surface}
            tool={activeTool}
            readOnly={!canEdit}
            // Unsaved values stay in view while a changed file waits to be loaded.
            fillForm={fillForm && (canEdit || dirty)}
            annotations={annotations}
            fields={fields}
            fieldValues={fieldValues}
            signatures={signatures}
            selected={selected}
            onSelect={setSelected}
            onPlace={place}
            onFieldChange={(name: string, value: PdfFieldValue) =>
              add({ kind: "field", key: editKey(), name, value })
            }
            onSignatureRect={(key, rect) =>
              setEdits((current) => changePdfEdit(current, key, "signature", { rect }))
            }
            onRemoveSignature={(key) => setEdits((current) => dropPdfEdit(current, key))}
            onContents={(key, contents) =>
              setEdits((current) =>
                changePdfEdit(changePdfEdit(current, key, "note", { contents }), key, "highlight", {
                  contents,
                }),
              )
            }
            onRemoveAnnotation={(annotation) => {
              setSelected(null);
              if (annotation.saved) add({ kind: "remove", key: editKey(), id: annotation.key });
              else setEdits((current) => dropPdfEdit(current, annotation.key));
            }}
            onKeepAnnotation={(annotation) => {
              const { removal } = annotation;
              if (removal !== null) setEdits((current) => dropPdfEdit(current, removal));
            }}
          />
        )}
      />
      {signatureDialogOpen ? (
        <Suspense fallback={null}>
          <PdfSignatureDialog
            open
            onOpenChange={(open) => {
              setSignatureDialogOpen(open);
              // Leaving the dialog without a signature leaves the sign tool too.
              if (!open && signature === null) setTool("select");
            }}
            onChoose={(chosen) => {
              setSignature(chosen);
              setTool("sign");
              setSignatureDialogOpen(false);
            }}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
