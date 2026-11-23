import type { PdfEditInput, PdfEditResult, PdfOpenResult } from "@codenine/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../../test/render";

// As in the viewer's test: a blob of the raw worker skips the dev server's transform of it.
vi.mock(import("pdfjs-dist/build/pdf.worker.min.mjs?url"), async () => {
  const { default: source } = await import("pdfjs-dist/build/pdf.worker.min.mjs?raw");
  return {
    default: URL.createObjectURL(new Blob([source], { type: "text/javascript" })),
  };
});

import PdfEditor, { type PdfResult, type PdfTransport } from "./PdfEditor";
import { textBoxesInRange } from "./pdfPlacement";

/** One page, 400 by 300 points, with a line of text near its top and a link under it. */
function onePagePdf() {
  const text = "BT /F1 20 Tf 40 250 Td (Lease agreement) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R /Annots [6 0 R] >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Annot /Subtype /Link /Rect [40 200 140 215] /Border [0 0 0] /A << /S /URI /URI (https://example.com/terms) >> >>",
  ];
  let source = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(source.length);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = source.length;
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Blob([source], { type: "application/pdf" });
}

const ok = <A,>(value: A): PdfResult<A> => ({ ok: true, value });

function fakeFile() {
  const contents: Pick<PdfOpenResult, "annotations" | "fields"> = {
    annotations: [],
    fields: [
      {
        name: "tenant",
        value: { kind: "text", text: "" },
        readOnly: false,
        widgets: [{ page: 0, rect: { x: 40, y: 150, width: 200, height: 22 } }],
      },
    ],
  };
  const state = {
    version: 1,
    conflictNext: false,
    // A save answers once this settles.
    gate: Promise.resolve(),
    saves: [] as Array<{
      edit: Pick<PdfEditInput, "operations" | "signatures">;
      expectedVersion: string;
    }>,
  };
  const transport: PdfTransport = {
    open: async () => ok({ version: `v${state.version}`, ...contents }),
    save: async (edit, expectedVersion) => {
      state.saves.push({ edit, expectedVersion });
      await state.gate;
      if (state.conflictNext) return { ok: false, failure: { kind: "conflict" } };
      state.version += 1;
      const saved: PdfEditResult = { version: `v${state.version}`, ...contents };
      return ok(saved);
    },
  };
  return { state, transport };
}

it("reviews, fills in, signs and saves a PDF, and keeps edits when the file changed", async () => {
  const url = URL.createObjectURL(onePagePdf());
  const { state, transport } = fakeFile();
  const onReload = vi.fn();
  const onPendingChange = vi.fn();
  try {
    using _date = vi.spyOn(Date.prototype, "toLocaleDateString").mockReturnValue("23/11/2026");
    const container = document.createElement("div");
    container.style.cssText = "display:flex;width:760px;height:640px";
    await using screen = await render(
      <PdfEditor
        transport={transport}
        sessionKey="test:lease.pdf"
        src={url}
        freshSrc={url}
        revision="r1"
        title="lease.pdf"
        readOnly={false}
        onPendingChange={onPendingChange}
        onReload={onReload}
      />,
      { container },
    );
    await expect.element(screen.getByText("Page 1 of 1"), { timeout: 10_000 }).toBeVisible();
    const save = screen.getByRole("button", { name: "Save", exact: true });
    await expect.element(save).toBeDisabled();
    // A link in the document can be followed while no tool is in hand.
    await expect
      .element(screen.getByRole("link", { name: "https://example.com/terms" }))
      .toHaveAttribute("target", "_blank");

    // Highlight: selecting text with the tool makes a highlight of what was selected.
    await screen.getByRole("button", { name: "Highlight text" }).click();
    const region = screen.getByRole("region", { name: "lease.pdf" }).element();
    const line = await vi.waitFor(() => {
      const span = Array.from(region.querySelectorAll("[data-pdf-text-layer] span")).find(
        (node) => node.textContent === "Lease agreement",
      );
      expect(span).toBeDefined();
      return span!;
    });
    const range = document.createRange();
    range.selectNodeContents(line);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    line.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    await expect
      .element(screen.getByRole("button", { name: "Highlight on page 1" }))
      .toBeInTheDocument();
    await expect.element(save).toBeEnabled();
    expect(window.getSelection()!.isCollapsed).toBe(true);

    // Form: the field is an input laid over the page.
    await screen.getByRole("textbox", { name: "tenant" }).fill("Ada Lovelace");

    // Note: a click with the tool drops a note and opens it for writing.
    await screen.getByRole("button", { name: "Add a note", exact: true }).click();
    await userEvent.click(screen.getByRole("button", { name: "Add a note on page 1" }), {
      position: { x: 300, y: 40 },
    });
    await screen.getByRole("textbox", { name: "Note", exact: true }).fill("Check the dates");
    await screen.getByRole("button", { name: "Close" }).click();

    // Sign: make a typed signature, then place it on the page.
    await screen.getByRole("button", { name: "Sign", exact: true }).click();
    await screen.getByRole("textbox", { name: "Your name" }).fill("Ada Lovelace");
    await screen.getByRole("button", { name: "Type", exact: true }).click();
    await screen.getByRole("button", { name: "Place signature" }).click();
    await userEvent.click(screen.getByRole("button", { name: "Place the signature on page 1" }), {
      position: { x: 200, y: 300 },
    });
    await expect
      .element(screen.getByRole("group", { name: "Signature of Ada Lovelace, not saved yet" }))
      .toBeVisible();
    await expect.element(screen.getByText("Unsaved", { exact: true })).toBeVisible();
    expect(onPendingChange).toHaveBeenLastCalledWith(true);

    // The list shows what was added and jumps to it.
    await screen.getByRole("button", { name: "More for this PDF" }).click();
    await page.getByRole("menuitemcheckbox", { name: "Notes and highlights" }).click();
    await expect.element(screen.getByText("Check the dates")).toBeVisible();

    // What a save has sent is in the file, so it cannot be changed until the save has answered.
    let answer = () => {};
    state.gate = new Promise<void>((resolve) => {
      answer = resolve;
    });
    await expect.element(screen.getByRole("button", { name: "Remove signature" })).toBeVisible();
    await save.click();
    await expect.element(screen.getByText("Saving...", { exact: true })).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Remove signature" }))
      .not.toBeInTheDocument();
    answer();
    await expect.element(screen.getByText("Saved", { exact: true })).toBeVisible();
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(state.saves).toHaveLength(1);
    const { edit, expectedVersion } = state.saves[0]!;
    expect(expectedVersion).toBe("v1");
    expect(edit.operations.map((operation) => operation.type)).toEqual([
      "addHighlight",
      "setField",
      "addNote",
    ]);
    const [highlight, field, note] = edit.operations;
    // The selection, in the file's own units: the text sits at (40, 250) in 20 point type.
    if (highlight?.type !== "addHighlight") throw new Error("Expected a highlight first");
    expect(highlight.page).toBe(0);
    expect(highlight.rects).toHaveLength(1);
    const [marked] = highlight.rects;
    expect(marked!.x).toBeGreaterThan(34);
    expect(marked!.x).toBeLessThan(44);
    expect(marked!.y).toBeGreaterThan(236);
    expect(marked!.y).toBeLessThan(252);
    expect(marked!.y + marked!.height).toBeGreaterThan(262);
    expect(marked!.width).toBeGreaterThan(110);
    expect(marked!.width).toBeLessThan(180);
    expect(field).toEqual({
      type: "setField",
      name: "tenant",
      value: { kind: "text", text: "Ada Lovelace" },
    });
    expect(note).toMatchObject({ type: "addNote", page: 0, contents: "Check the dates" });
    expect(edit.signatures).toHaveLength(1);
    const [signed] = edit.signatures!;
    expect(signed).toMatchObject({
      page: 0,
      name: "Ada Lovelace",
      image: { mediaType: "image/png" },
    });
    expect(signed!.date).toBe("23/11/2026");
    expect(signed!.image.dataBase64.length).toBeGreaterThan(100);
    expect(signed!.rect.width).toBeCloseTo(170, 0);
    expect(signed!.captionImageBase64).toBeUndefined();

    // A save that finds the file changed keeps the edit and says so.
    state.conflictNext = true;
    await screen.getByRole("textbox", { name: "tenant" }).fill("Grace Hopper");
    await save.click();
    await expect.element(screen.getByText(/changed on disk while you were working/)).toBeVisible();
    expect(state.saves[1]!.expectedVersion).toBe("v2");
    await screen.getByRole("button", { name: "Load the new file and keep my changes" }).click();
    await expect.element(screen.getByText("Unsaved", { exact: true })).toBeVisible();
    expect(onReload).toHaveBeenCalledTimes(2);

    // Undo takes the unsaved edit back.
    await screen.getByRole("button", { name: "Undo the last unsaved change" }).click();
    await expect.element(screen.getByText("Saved", { exact: true })).toBeVisible();
    await expect.element(screen.getByRole("textbox", { name: "tenant" })).toHaveValue("");
    expect(onPendingChange).toHaveBeenLastCalledWith(false);
  } finally {
    URL.revokeObjectURL(url);
  }
});

it("measures only the text of a selection that runs from one page into the next", () => {
  const host = document.createElement("div");
  // Each page as the viewer lays it out: canvas, text layer, then an overlay.
  host.innerHTML = [460, 20]
    .map(
      (top) =>
        `<div style="position:relative;width:400px;height:500px"><canvas style="display:block;width:100%;height:100%"></canvas><div data-layer style="position:absolute;inset:0"><span style="position:absolute;left:40px;top:${top}px;font:16px sans-serif">Some text on the page</span></div><div style="position:absolute;inset:0"></div></div>`,
    )
    .join("");
  document.body.append(host);
  try {
    const [first, second] = Array.from(host.querySelectorAll("[data-layer]"));
    const range = document.createRange();
    range.setStart(first!.querySelector("span")!.firstChild!, 5);
    range.setEnd(second!.querySelector("span")!.firstChild!, 4);
    // The range itself also reports the whole pages between the two runs of text.
    expect(Array.from(range.getClientRects()).some((box) => box.height > 400)).toBe(true);

    const whole = second!.querySelector("span")!.getBoundingClientRect();
    for (const layer of [first!, second!]) {
      const boxes = textBoxesInRange(range, layer);
      expect(boxes.length).toBeGreaterThan(0);
      expect(boxes.every((box) => box.height < 40 && box.width < whole.width)).toBe(true);
    }
  } finally {
    host.remove();
  }
});
