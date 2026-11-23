import type { PdfRect } from "@codenine/contracts";
import { pdfToViewRect, type PdfPageGeometry } from "@codenine/shared/pdfGeometry";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../../test/render";
import type { PdfPageSurface } from "../PdfViewer";
import type { PdfPendingEdit } from "./pdfEditSession";
import { PdfPageOverlay, type PdfPageOverlayProps } from "./PdfPageOverlay";
import { signatureBoxAt } from "./pdfPlacement";
import { viewToPdfRect } from "@codenine/shared/pdfGeometry";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

// A cropped page shown turned a quarter and at one and a half times its size: 600 by 450.
const geometry: PdfPageGeometry = { box: [50, 100, 350, 500], rotation: 90, scale: 1.5 };
const surface: PdfPageSurface = { index: 0, geometry, width: 600, height: 450 };

function Page(props: Partial<PdfPageOverlayProps>) {
  const unused = () => {};
  return (
    <div style={{ position: "relative", width: 600, height: 450, margin: 40 }}>
      <PdfPageOverlay
        surface={surface}
        tool="select"
        readOnly={false}
        fillForm
        annotations={[]}
        fields={[]}
        fieldValues={new Map()}
        signatures={[]}
        selected={null}
        onSelect={unused}
        onPlace={unused}
        onFieldChange={unused}
        onSignatureRect={unused}
        onRemoveSignature={unused}
        onContents={unused}
        onRemoveAnnotation={unused}
        onKeepAnnotation={unused}
        {...props}
      />
    </div>
  );
}

it("places a signature where the page is clicked, then moves and resizes it", async () => {
  const onPlace = vi.fn<PdfPageOverlayProps["onPlace"]>();
  const onSignatureRect = vi.fn<(key: string, rect: PdfRect) => void>();
  // router: false -- the overlay is a leaf with no links or route state.
  await using screen = await render(<Page tool="sign" onPlace={onPlace} />, { router: false });

  await userEvent.click(screen.getByRole("button", { name: "Place the signature on page 1" }), {
    position: { x: 300, y: 200 },
  });
  expect(onPlace).toHaveBeenCalledTimes(1);
  const [placedOn, point] = onPlace.mock.calls[0]!;
  expect(placedOn).toBe(surface);
  expect(point.x).toBeCloseTo(300, 0);
  expect(point.y).toBeCloseTo(200, 0);

  // The editor stores the block in the file's own units, and the overlay shows it back in place.
  const placed = signatureBoxAt(point, { width: 400, height: 120 }, geometry.scale, surface);
  const signature: Extract<PdfPendingEdit, { kind: "signature" }> = {
    kind: "signature",
    key: "s1",
    page: 0,
    rect: viewToPdfRect(geometry, placed),
    image: { mediaType: "image/png", dataBase64: PNG },
    name: "Ada Lovelace",
    date: "23/11/2026",
  };
  await screen.rerender(
    <Page tool="select" signatures={[signature]} onSignatureRect={onSignatureRect} />,
  );
  const box = screen.getByRole("group", { name: "Signature of Ada Lovelace, not saved yet" });
  await expect.element(box).toBeVisible();
  await expect.element(screen.getByText("23/11/2026")).toBeVisible();
  const shown = box.element().getBoundingClientRect();
  expect(shown.width).toBeCloseTo(placed.width, 0);
  expect(shown.height).toBeCloseTo(placed.height, 0);

  const drag = (target: Element, dx: number, dy: number) => {
    const from = target.getBoundingClientRect();
    const x = from.left + from.width / 2;
    const y = from.top + from.height / 2;
    const pointer = { pointerId: 1, bubbles: true, isPrimary: true, button: 0 };
    target.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, clientX: x, clientY: y }));
    target.dispatchEvent(
      new PointerEvent("pointermove", { ...pointer, clientX: x + dx, clientY: y + dy }),
    );
    target.dispatchEvent(
      new PointerEvent("pointerup", { ...pointer, clientX: x + dx, clientY: y + dy }),
    );
  };

  drag(box.element(), 40, -30);
  await vi.waitFor(() => expect(onSignatureRect).toHaveBeenCalled());
  const moved = pdfToViewRect(geometry, onSignatureRect.mock.lastCall![1]);
  expect(moved.x).toBeCloseTo(placed.x + 40, 0);
  expect(moved.y).toBeCloseTo(placed.y - 30, 0);
  expect(moved.width).toBeCloseTo(placed.width, 0);

  onSignatureRect.mockClear();
  drag(screen.getByRole("slider", { name: "Resize signature" }).element(), -60, 0);
  await vi.waitFor(() => expect(onSignatureRect).toHaveBeenCalled());
  const resized = pdfToViewRect(geometry, onSignatureRect.mock.lastCall![1]);
  expect(resized.width).toBeCloseTo(placed.width - 60, 0);
  expect(resized.height / resized.width).toBeCloseTo(placed.height / placed.width, 2);
  expect(resized.x).toBeCloseTo(placed.x, 0);
});
