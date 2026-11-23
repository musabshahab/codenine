import "@fontsource/satisfy/latin-400.css";
import "../pdfViewer.css";

import { type PointerEvent, useId, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { useLocalStorage } from "~/hooks/useLocalStorage";

import {
  drawnSignatureImage,
  paintStrokes,
  SAVED_SIGNATURE_STORAGE_KEY,
  SavedSignature,
  SIGNATURE_FONT_FAMILY,
  signatureDataUrl,
  type SignatureImage,
  type SignatureStroke,
  typedSignatureImage,
  uploadedSignatureImage,
} from "./signatureImage";

export interface ChosenSignature {
  readonly image: SignatureImage;
  readonly name: string;
}

type Mode = "draw" | "type" | "upload";
const PAD = { width: 440, height: 150 };

function SignaturePad(props: {
  readonly strokes: ReadonlyArray<SignatureStroke>;
  readonly onChange: (strokes: ReadonlyArray<SignatureStroke>) => void;
}) {
  const drawing = useRef(false);
  const paint = (canvas: HTMLCanvasElement | null, strokes: ReadonlyArray<SignatureStroke>) => {
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    paintStrokes(context, strokes);
  };
  const pointOf = (event: PointerEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    // The pad may be shown narrower than it is drawn, as on a phone.
    return {
      x: ((event.clientX - bounds.left) * PAD.width) / bounds.width,
      y: ((event.clientY - bounds.top) * PAD.height) / bounds.height,
    };
  };
  return (
    <canvas
      // Painting in the ref keeps the canvas in step with the strokes without an effect.
      ref={(canvas) => paint(canvas, props.strokes)}
      width={PAD.width}
      height={PAD.height}
      role="img"
      aria-label="Signature drawing area"
      className="block w-full touch-none rounded-md border border-input bg-white"
      style={{ aspectRatio: `${PAD.width} / ${PAD.height}`, cursor: "crosshair" }}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        drawing.current = true;
        props.onChange([...props.strokes, { points: [pointOf(event)] }]);
      }}
      onPointerMove={(event) => {
        const last = props.strokes.at(-1);
        if (!drawing.current || last === undefined) return;
        props.onChange([
          ...props.strokes.slice(0, -1),
          { points: [...last.points, pointOf(event)] },
        ]);
      }}
      onPointerUp={() => {
        drawing.current = false;
      }}
      onPointerCancel={() => {
        drawing.current = false;
      }}
    />
  );
}

/**
 * Where the user makes the signature they will place: drawn, typed in a handwriting font, or an
 * uploaded picture. A signature kept for next time stays in this browser's storage.
 */
export default function PdfSignatureDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The caller closes the dialog once it has the signature. */
  readonly onChoose: (signature: ChosenSignature) => void;
}) {
  const [saved, setSaved] = useLocalStorage(SAVED_SIGNATURE_STORAGE_KEY, null, SavedSignature);
  const [mode, setMode] = useState<Mode>("draw");
  const [name, setName] = useState(saved?.name ?? "");
  const [strokes, setStrokes] = useState<ReadonlyArray<SignatureStroke>>([]);
  const [uploaded, setUploaded] = useState<SignatureImage | null>(null);
  const [keep, setKeep] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const nameId = useId();
  const signer = name.trim();

  const place = async () => {
    if (signer === "") {
      setProblem("Enter your name. It is printed under the signature.");
      return;
    }
    const image =
      mode === "draw"
        ? drawnSignatureImage(strokes, PAD)
        : mode === "type"
          ? await typedSignatureImage(signer)
          : uploaded;
    if (image === null) {
      setProblem(
        mode === "draw"
          ? "Draw your signature first."
          : mode === "upload"
            ? "Choose an image of your signature first."
            : "The signature could not be made. Try drawing it instead.",
      );
      return;
    }
    if (keep) setSaved({ name: signer, image });
    props.onChoose({ image, name: signer });
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add your signature</DialogTitle>
          <DialogDescription>
            Your signature goes on the page with your name and today's date. It becomes part of the
            document when you save.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            {saved !== null ? (
              <div className="flex flex-wrap items-center gap-3 rounded-md border border-border/60 p-3">
                <img
                  src={signatureDataUrl(saved.image)}
                  alt={`Saved signature of ${saved.name}`}
                  className="h-12 max-w-40 rounded-sm bg-white object-contain"
                />
                <div className="min-w-0 flex-1 text-xs">
                  <p className="truncate font-medium text-foreground">{saved.name}</p>
                  <p className="text-muted-foreground">Kept on this device only.</p>
                </div>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() => props.onChoose({ image: saved.image, name: saved.name })}
                >
                  Use this signature
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="destructive-outline"
                  onClick={() => setSaved(null)}
                >
                  Delete from this device
                </Button>
              </div>
            ) : null}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={nameId}>Your name</Label>
              <Input
                id={nameId}
                value={name}
                maxLength={200}
                autoComplete="name"
                onChange={(event) => {
                  setName(event.target.value);
                  setProblem(null);
                }}
              />
            </div>
            <ToggleGroup
              aria-label="How to make the signature"
              className="w-full *:flex-1"
              value={[mode]}
              onValueChange={(next) => {
                const value = next[0];
                if (value === "draw" || value === "type" || value === "upload") setMode(value);
                setProblem(null);
              }}
            >
              <Toggle value="draw">Draw</Toggle>
              <Toggle value="type">Type</Toggle>
              <Toggle value="upload">Upload</Toggle>
            </ToggleGroup>
            {mode === "draw" ? (
              <div className="flex flex-col gap-1.5">
                <SignaturePad
                  strokes={strokes}
                  onChange={(next) => {
                    setStrokes(next);
                    setProblem(null);
                  }}
                />
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Sign with a mouse, a finger or a pen.</span>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={strokes.length === 0}
                    onClick={() => setStrokes([])}
                  >
                    Clear
                  </Button>
                </div>
              </div>
            ) : mode === "type" ? (
              <div
                data-pdf-signature-ink=""
                className="flex h-28 items-center justify-center overflow-hidden rounded-md border border-input bg-white px-4 text-4xl"
                style={{ fontFamily: SIGNATURE_FONT_FAMILY }}
              >
                {signer === "" ? (
                  <span data-pdf-signature-hint="" className="font-sans text-sm">
                    Enter your name above to see it signed.
                  </span>
                ) : (
                  <span className="truncate py-2">{signer}</span>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <input
                  type="file"
                  accept="image/png,image/jpeg"
                  aria-label="Signature image"
                  className="text-xs file:mr-3 file:cursor-pointer file:rounded-md file:border file:border-input file:bg-background file:px-2.5 file:py-1 file:text-xs file:text-foreground"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file === undefined) return;
                    void uploadedSignatureImage(file).then((result) => {
                      setUploaded(typeof result === "string" ? null : result);
                      setProblem(typeof result === "string" ? result : null);
                    });
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  A PNG or JPEG under 512 KB. A photo of a signature on white paper works well.
                </p>
                {uploaded !== null ? (
                  <img
                    src={signatureDataUrl(uploaded)}
                    alt="Uploaded signature"
                    className="h-24 self-start rounded-md border border-input bg-white object-contain"
                  />
                ) : null}
              </div>
            )}
            <label className="flex cursor-pointer items-start gap-2 text-xs">
              <Checkbox checked={keep} onCheckedChange={(checked) => setKeep(checked === true)} />
              <span>
                Keep this signature on this device
                <span className="block text-muted-foreground">
                  It is stored in this browser only, and you can delete it here at any time.
                </span>
              </span>
            </label>
            {problem !== null ? (
              <p role="alert" className="text-xs text-destructive">
                {problem}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void place()}>
            Place signature
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
