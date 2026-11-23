import type { PdfAnnotation, PdfFormField } from "@codenine/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addPdfEdit,
  changePdfEdit,
  dropPdfEdit,
  listPdfAnnotations,
  pdfEditRequest,
  pdfFieldValues,
  type PdfPendingEdits,
  rebasePdfEdits,
  undoPdfEdit,
} from "./pdfEditSession";

const rect = { x: 10, y: 700, width: 100, height: 12 };
const saved: ReadonlyArray<PdfAnnotation> = [
  { id: "codenine-1", page: 1, kind: "note", rect, contents: "Later page", removable: true },
  { id: "object-9", page: 0, kind: "highlight", rect, rects: [rect], removable: false },
];
const fields: ReadonlyArray<PdfFormField> = [
  { name: "tenant", value: { kind: "text", text: "" }, readOnly: false, widgets: [] },
  { name: "agree", value: { kind: "checkbox", checked: false }, readOnly: false, widgets: [] },
];
const signature = {
  kind: "signature",
  key: "s1",
  page: 0,
  rect: { x: 50, y: 50, width: 160, height: 70 },
  image: { mediaType: "image/png", dataBase64: "AAAA" },
  name: "Ada Lovelace",
  date: "23/11/2026",
} as const;

describe("pdfEditSession", () => {
  it("keeps typing in one field as one undo step and sends edits in the order made", () => {
    let edits: PdfPendingEdits = [];
    const type = (key: string, text: string) =>
      (edits = addPdfEdit(edits, {
        kind: "field",
        key,
        name: "tenant",
        value: { kind: "text", text },
      }));
    type("f1", "A");
    type("f2", "Ad");
    type("f3", "Ada");
    expect(edits).toHaveLength(1);
    edits = addPdfEdit(edits, {
      kind: "highlight",
      key: "h1",
      page: 0,
      rects: [rect],
      colour: "FFE066",
      contents: " ",
    });
    type("f4", "Ada L");
    edits = addPdfEdit(edits, { kind: "note", key: "n1", page: 0, x: 20, y: 400, contents: "" });
    edits = changePdfEdit(edits, "n1", "note", { contents: "Ask about this" });
    edits = addPdfEdit(edits, { kind: "remove", key: "r1", id: "codenine-1" });
    edits = addPdfEdit(edits, signature);
    edits = changePdfEdit(edits, "s1", "signature", {
      rect: { x: 60, y: 40, width: 160, height: 70 },
    });

    expect(pdfFieldValues(fields, edits).get("tenant")).toEqual({ kind: "text", text: "Ada L" });
    expect(pdfEditRequest(edits)).toEqual({
      operations: [
        { type: "setField", name: "tenant", value: { kind: "text", text: "Ada" } },
        { type: "addHighlight", page: 0, rects: [rect], colour: "FFE066" },
        { type: "setField", name: "tenant", value: { kind: "text", text: "Ada L" } },
        { type: "addNote", page: 0, x: 20, y: 400, contents: "Ask about this" },
        { type: "removeAnnotation", id: "codenine-1" },
      ],
      signatures: [
        {
          page: 0,
          rect: { x: 60, y: 40, width: 160, height: 70 },
          image: { mediaType: "image/png", dataBase64: "AAAA" },
          name: "Ada Lovelace",
          date: "23/11/2026",
        },
      ],
    });

    // Undo takes back the newest edit first, and the field returns to the typing before it.
    edits = undoPdfEdit(undoPdfEdit(undoPdfEdit(edits)));
    expect(edits.map((edit) => edit.key)).toEqual(["f1", "h1", "f4"]);
    edits = undoPdfEdit(edits);
    expect(pdfFieldValues(fields, edits).get("tenant")).toEqual({ kind: "text", text: "Ada" });
    expect(dropPdfEdit(edits, "h1").map((edit) => edit.key)).toEqual(["f1"]);
  });

  it("lists saved and unsaved highlights and notes in reading order", () => {
    const edits: PdfPendingEdits = [
      { kind: "note", key: "n1", page: 0, x: 20, y: 300, contents: "Lower" },
      { kind: "remove", key: "r1", id: "codenine-1" },
      {
        kind: "highlight",
        key: "h1",
        page: 0,
        rects: [
          { x: 10, y: 760, width: 80, height: 12 },
          { x: 10, y: 745, width: 40, height: 12 },
        ],
        colour: "FFE066",
        contents: "",
      },
    ];
    expect(
      listPdfAnnotations(saved, edits).map((item) => [
        item.key,
        item.page,
        item.saved,
        item.removal,
      ]),
    ).toEqual([
      ["h1", 0, false, null],
      ["object-9", 0, true, null],
      ["n1", 0, false, null],
      ["codenine-1", 1, true, "r1"],
    ]);
    expect(listPdfAnnotations(saved, edits)[0]!.rect).toEqual({
      x: 10,
      y: 745,
      width: 80,
      height: 27,
    });
    expect(listPdfAnnotations(saved, edits)[2]!.rect).toEqual({
      x: 20,
      y: 280,
      width: 20,
      height: 20,
    });
  });

  it("drops edits that no longer apply to a file that changed", () => {
    const edits: PdfPendingEdits = [
      { kind: "remove", key: "r1", id: "codenine-1" },
      { kind: "remove", key: "r2", id: "codenine-gone" },
      { kind: "field", key: "f1", name: "agree", value: { kind: "checkbox", checked: true } },
      { kind: "field", key: "f2", name: "removed", value: { kind: "text", text: "x" } },
      signature,
    ];
    expect(rebasePdfEdits(edits, { annotations: saved, fields }).map((edit) => edit.key)).toEqual([
      "r1",
      "f1",
      "s1",
    ]);
  });
});
