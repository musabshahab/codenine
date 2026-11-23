import type { PdfFieldValue, PdfFormField, PdfRect } from "@codenine/contracts";
import {
  type PdfPageGeometry,
  pdfSignatureLayout,
  pdfToViewRect,
  viewToPdfRect,
} from "@codenine/shared/pdfGeometry";
import { MessageSquareTextIcon, XIcon } from "lucide-react";
import { type CSSProperties, type PointerEvent, useRef } from "react";

import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";

import type { PdfPageSurface } from "../PdfViewer";
import type { PdfListedAnnotation, PdfPendingEdit } from "./pdfEditSession";
import { moveViewBox, resizeViewBox, type ViewBox } from "./pdfPlacement";
import { signatureDataUrl } from "./signatureImage";

export type PdfTool = "select" | "highlight" | "note" | "sign";
export type PdfPendingSignature = Extract<PdfPendingEdit, { kind: "signature" }>;

export interface PdfPageOverlayProps {
  readonly surface: PdfPageSurface;
  readonly tool: PdfTool;
  readonly readOnly: boolean;
  readonly fillForm: boolean;
  readonly annotations: ReadonlyArray<PdfListedAnnotation>;
  readonly fields: ReadonlyArray<PdfFormField>;
  readonly fieldValues: ReadonlyMap<string, PdfFieldValue>;
  readonly signatures: ReadonlyArray<PdfPendingSignature>;
  readonly selected: string | null;
  readonly onSelect: (key: string | null) => void;
  /** A click on the page with the note or sign tool, in CSS pixels from its upper left corner. */
  readonly onPlace: (
    surface: PdfPageSurface,
    point: { readonly x: number; readonly y: number },
  ) => void;
  readonly onFieldChange: (name: string, value: PdfFieldValue) => void;
  readonly onSignatureRect: (key: string, rect: PdfRect) => void;
  readonly onRemoveSignature: (key: string) => void;
  readonly onContents: (key: string, contents: string) => void;
  readonly onRemoveAnnotation: (annotation: PdfListedAnnotation) => void;
  readonly onKeepAnnotation: (annotation: PdfListedAnnotation) => void;
}

const boxStyle = (box: ViewBox): CSSProperties => ({
  left: box.x,
  top: box.y,
  width: box.width,
  height: box.height,
});

const SIGNATURE_MIN_WIDTH = 60;

/** An unsaved signature: dragged to move it, and by its corner to resize it. */
function PdfSignatureBox(props: {
  readonly signature: PdfPendingSignature;
  readonly geometry: PdfPageGeometry;
  readonly page: { readonly width: number; readonly height: number };
  readonly readOnly: boolean;
  readonly onRect: (rect: PdfRect) => void;
  readonly onRemove: () => void;
}) {
  const { signature, geometry, page } = props;
  const box = pdfToViewRect(geometry, signature.rect);
  const drag = useRef<{ x: number; y: number; box: ViewBox; resize: boolean } | null>(null);
  const layout = pdfSignatureLayout(box.width / geometry.scale, box.height / geometry.scale);
  const begin = (resize: boolean) => (event: PointerEvent<HTMLElement>) => {
    if (props.readOnly) return;
    event.stopPropagation();
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, box, resize };
  };
  const move = (event: PointerEvent<HTMLElement>) => {
    const start = drag.current;
    // A save in progress has already sent this signature where it was.
    if (start === null || props.readOnly) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    const next = start.resize
      ? resizeViewBox(start.box, dx, page, SIGNATURE_MIN_WIDTH)
      : moveViewBox(start.box, dx, dy, page);
    props.onRect(viewToPdfRect(geometry, next));
  };
  const end = () => {
    drag.current = null;
  };
  return (
    <div
      role="group"
      aria-label={`Signature of ${signature.name}, not saved yet`}
      data-pdf-signature=""
      className="pointer-events-auto absolute touch-none rounded-sm select-none"
      style={{ ...boxStyle(box), cursor: props.readOnly ? "default" : "move" }}
      onPointerDown={begin(false)}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <img
        src={signatureDataUrl(signature.image)}
        alt=""
        draggable={false}
        className="pointer-events-none absolute top-0 left-0 w-full object-contain object-left-bottom"
        style={{ height: layout.imageHeight * geometry.scale }}
      />
      <div
        className="pointer-events-none absolute bottom-0 left-0 w-full overflow-hidden font-sans whitespace-nowrap"
        style={{
          height: layout.captionHeight * geometry.scale,
          fontSize: layout.fontSize * geometry.scale,
          lineHeight: `${layout.lineHeight * geometry.scale}px`,
        }}
      >
        <div>{signature.name}</div>
        <div>{signature.date}</div>
      </div>
      {props.readOnly ? null : (
        <>
          <button
            type="button"
            aria-label="Remove signature"
            data-pdf-signature-remove=""
            className="absolute -top-2.5 -right-2.5 flex size-5 items-center justify-center rounded-full"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={props.onRemove}
          >
            <XIcon className="size-3" />
          </button>
          <div
            role="slider"
            tabIndex={0}
            aria-label="Resize signature"
            aria-valuemin={SIGNATURE_MIN_WIDTH}
            aria-valuemax={Math.round(page.width)}
            aria-valuenow={Math.round(box.width)}
            data-pdf-signature-handle=""
            className="absolute -right-1.5 -bottom-1.5 size-3 rounded-full"
            style={{ cursor: "nwse-resize" }}
            onPointerDown={begin(true)}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            onKeyDown={(event) => {
              const step = event.key === "ArrowRight" ? 8 : event.key === "ArrowLeft" ? -8 : null;
              if (step === null) return;
              event.preventDefault();
              props.onRect(
                viewToPdfRect(geometry, resizeViewBox(box, step, page, SIGNATURE_MIN_WIDTH)),
              );
            }}
          />
        </>
      )}
    </div>
  );
}

function FieldInput(props: {
  readonly field: PdfFormField;
  readonly widget: PdfFormField["widgets"][number];
  readonly value: PdfFieldValue;
  readonly box: ViewBox;
  readonly disabled: boolean;
  readonly onChange: (value: PdfFieldValue) => void;
}) {
  const { field, widget, value, box } = props;
  const label = widget.option === undefined ? field.name : `${field.name}: ${widget.option}`;
  const surface = "pointer-events-auto absolute m-0 rounded-xs outline-none disabled:opacity-70";
  const fontSize = Math.max(8, Math.min(box.height * 0.6, 15));
  if (value.kind === "text") {
    const common = {
      "aria-label": label,
      value: value.text,
      disabled: props.disabled,
      ...(field.maxLength === undefined ? {} : { maxLength: field.maxLength }),
    };
    return field.multiline ? (
      <textarea
        {...common}
        data-pdf-field=""
        className={cn(surface, "resize-none px-1 py-0.5")}
        style={{ ...boxStyle(box), fontSize: Math.min(fontSize, 13) }}
        onChange={(event) => props.onChange({ kind: "text", text: event.target.value })}
      />
    ) : (
      <input
        {...common}
        type="text"
        data-pdf-field=""
        className={cn(surface, "px-1")}
        style={{ ...boxStyle(box), fontSize }}
        onChange={(event) => props.onChange({ kind: "text", text: event.target.value })}
      />
    );
  }
  if (value.kind === "checkbox") {
    return (
      <input
        type="checkbox"
        aria-label={label}
        checked={value.checked}
        disabled={props.disabled}
        data-pdf-check=""
        className="pointer-events-auto absolute m-0"
        style={boxStyle(box)}
        onChange={(event) => props.onChange({ kind: "checkbox", checked: event.target.checked })}
      />
    );
  }
  if (value.kind === "radio") {
    return (
      <input
        type="radio"
        aria-label={label}
        name={`pdf-field-${field.name}`}
        checked={widget.option !== undefined && value.option === widget.option}
        disabled={props.disabled || widget.option === undefined}
        data-pdf-check=""
        className="pointer-events-auto absolute m-0"
        style={boxStyle(box)}
        onChange={() => props.onChange({ kind: "radio", option: widget.option ?? null })}
      />
    );
  }
  const options = field.options ?? [];
  return field.multiple ? (
    <select
      multiple
      aria-label={label}
      value={[...value.options]}
      disabled={props.disabled}
      data-pdf-field=""
      className={surface}
      style={{ ...boxStyle(box), fontSize: Math.min(fontSize, 13) }}
      onChange={(event) =>
        props.onChange({
          kind: "choice",
          options: Array.from(event.target.selectedOptions, (option) => option.value),
        })
      }
    >
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  ) : (
    <select
      aria-label={label}
      value={value.options[0] ?? ""}
      disabled={props.disabled}
      data-pdf-field=""
      className={surface}
      style={{ ...boxStyle(box), fontSize }}
      onChange={(event) =>
        props.onChange({
          kind: "choice",
          options: event.target.value === "" ? [] : [event.target.value],
        })
      }
    >
      <option value="" />
      {/* A value typed into the PDF elsewhere stays selectable. */}
      {[...new Set([...value.options, ...options])].map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}

function AnnotationCard(props: {
  readonly annotation: PdfListedAnnotation;
  readonly box: ViewBox;
  readonly page: { readonly width: number; readonly height: number };
  readonly readOnly: boolean;
  readonly onContents: (contents: string) => void;
  readonly onRemove: () => void;
  readonly onKeep: () => void;
  readonly onClose: () => void;
}) {
  const { annotation, box, page } = props;
  const width = Math.min(260, page.width - 8);
  const left = Math.min(Math.max(4, box.x), Math.max(4, page.width - width - 4));
  // Under the annotation, or above it near the foot of the page.
  const below = box.y + box.height + 150 < page.height;
  const kind = annotation.kind === "highlight" ? "Highlight" : "Note";
  return (
    <div
      role="dialog"
      aria-label={kind}
      className="pointer-events-auto absolute z-10 flex flex-col gap-2 rounded-lg border bg-popover p-2.5 text-xs text-popover-foreground shadow-lg"
      style={{
        left,
        width,
        ...(below ? { top: box.y + box.height + 6 } : { bottom: page.height - box.y + 6 }),
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">
          {kind}
          {annotation.saved ? "" : ", not saved yet"}
        </span>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Close"
          onClick={props.onClose}
        >
          <XIcon />
        </Button>
      </div>
      {annotation.saved || props.readOnly ? (
        <p className="max-h-40 overflow-auto whitespace-pre-wrap text-muted-foreground">
          {annotation.contents === "" ? "No comment." : annotation.contents}
        </p>
      ) : (
        <Textarea
          autoFocus={annotation.kind === "note" && annotation.contents === ""}
          aria-label={annotation.kind === "note" ? "Note" : "Comment on this highlight"}
          placeholder={annotation.kind === "note" ? "Write a note" : "Add a comment (optional)"}
          value={annotation.contents}
          maxLength={10_000}
          rows={3}
          onChange={(event) => props.onContents(event.target.value)}
        />
      )}
      {props.readOnly ? null : annotation.removal !== null ? (
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">Removed when you save.</span>
          <Button type="button" size="micro" variant="outline" onClick={props.onKeep}>
            Keep it
          </Button>
        </div>
      ) : annotation.removable ? (
        <div className="flex justify-end">
          <Button type="button" size="micro" variant="destructive-outline" onClick={props.onRemove}>
            Remove
          </Button>
        </div>
      ) : (
        <span className="text-muted-foreground">
          Made in another app, so it can only be removed there.
        </span>
      )}
    </div>
  );
}

/** What is laid over one shown page: highlights, notes, form inputs and unsaved signatures. */
export function PdfPageOverlay(props: PdfPageOverlayProps) {
  const { surface, tool } = props;
  const { geometry, index } = surface;
  const page = { width: surface.width, height: surface.height };
  const annotations = props.annotations.filter((annotation) => annotation.page === index);
  const selected = annotations.find((annotation) => annotation.key === props.selected);
  const placing = !props.readOnly && (tool === "note" || tool === "sign");
  return (
    <>
      {annotations.map((annotation) =>
        annotation.kind === "highlight" ? (
          <button
            key={annotation.key}
            type="button"
            aria-label={`Highlight on page ${index + 1}${annotation.contents === "" ? "" : `: ${annotation.contents}`}`}
            // With the highlight tool the text under a highlight must stay selectable.
            className={cn(
              "absolute block",
              tool === "select" ? "pointer-events-auto" : "pointer-events-none",
            )}
            style={{ ...boxStyle(pdfToViewRect(geometry, annotation.rect)), cursor: "pointer" }}
            onClick={() => props.onSelect(annotation.key)}
          >
            {annotation.rects.map((rect, part) => {
              const outer = pdfToViewRect(geometry, annotation.rect);
              const inner = pdfToViewRect(geometry, rect);
              return (
                <span
                  // oxlint-disable-next-line react/no-array-index-key -- A highlight's lines have no identity but their order.
                  key={part}
                  // A saved highlight is already drawn by the page; an unsaved one is drawn here.
                  data-pdf-pending={annotation.saved ? undefined : ""}
                  data-pdf-selected={props.selected === annotation.key ? "" : undefined}
                  className={cn("absolute", annotation.removal !== null && "bg-white/75")}
                  style={boxStyle({ ...inner, x: inner.x - outer.x, y: inner.y - outer.y })}
                />
              );
            })}
          </button>
        ) : (
          <button
            key={annotation.key}
            type="button"
            aria-label={`Note on page ${index + 1}${annotation.contents === "" ? "" : `: ${annotation.contents}`}`}
            data-pdf-note=""
            data-pdf-selected={props.selected === annotation.key ? "" : undefined}
            className={cn(
              "pointer-events-auto absolute flex items-center justify-center rounded-xs",
              annotation.removal !== null && "opacity-40",
            )}
            style={{ ...boxStyle(pdfToViewRect(geometry, annotation.rect)), cursor: "pointer" }}
            onClick={() => props.onSelect(annotation.key)}
          >
            <MessageSquareTextIcon className="size-3/4" />
          </button>
        ),
      )}
      {props.fillForm
        ? props.fields.flatMap((field) =>
            field.readOnly
              ? []
              : field.widgets.flatMap((widget, position) => {
                  const value = props.fieldValues.get(field.name);
                  if (widget.page !== index || value === undefined) return [];
                  return [
                    <FieldInput
                      // oxlint-disable-next-line react/no-array-index-key -- A field's widgets are a fixed list in the file.
                      key={`${field.name}:${position}`}
                      field={field}
                      widget={widget}
                      value={value}
                      box={pdfToViewRect(geometry, widget.rect)}
                      disabled={props.readOnly}
                      onChange={(next) => props.onFieldChange(field.name, next)}
                    />,
                  ];
                }),
          )
        : null}
      {placing ? (
        <button
          type="button"
          aria-label={
            tool === "note"
              ? `Add a note on page ${index + 1}`
              : `Place the signature on page ${index + 1}`
          }
          className="pointer-events-auto absolute inset-0 block"
          style={{ cursor: "crosshair" }}
          onClick={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            props.onPlace(surface, {
              x: event.clientX - bounds.left,
              y: event.clientY - bounds.top,
            });
          }}
        />
      ) : null}
      {props.signatures
        .filter((signature) => signature.page === index)
        .map((signature) => (
          <PdfSignatureBox
            key={signature.key}
            signature={signature}
            geometry={geometry}
            page={page}
            readOnly={props.readOnly}
            onRect={(rect) => props.onSignatureRect(signature.key, rect)}
            onRemove={() => props.onRemoveSignature(signature.key)}
          />
        ))}
      {selected === undefined ? null : (
        <AnnotationCard
          annotation={selected}
          box={pdfToViewRect(geometry, selected.rect)}
          page={page}
          readOnly={props.readOnly}
          onContents={(contents) => props.onContents(selected.key, contents)}
          onRemove={() => props.onRemoveAnnotation(selected)}
          onKeep={() => props.onKeepAnnotation(selected)}
          onClose={() => props.onSelect(null)}
        />
      )}
    </>
  );
}
