import { describe, expect, it } from "@effect/vitest";
import {
  degrees,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFString,
  decodePDFRawStream,
} from "@cantoo/pdf-lib";
import {
  PDF_SIGNATURE_IMAGE_MAX_BYTES,
  type PdfOperation,
  type PdfSignaturePlacement,
} from "@codenine/contracts";
import * as DateTime from "effect/DateTime";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";

import { editPdf, inspectPdf, PdfProblem } from "./pdfEdits.ts";

const NOW = DateTime.toDateUtc(DateTime.makeUnsafe("2026-11-23T10:00:00Z"));
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const JPEG =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";

/** Two pages: a form on the first, and a second that is cropped and shown turned a quarter. */
async function fixture(change: (document: PDFDocument) => void = () => {}) {
  const document = await PDFDocument.create();
  document.setTitle("Lease agreement");
  const first = document.addPage([400, 600]);
  first.drawText("Agreement between the parties", { x: 40, y: 540, size: 14 });
  const link = document.context.register(
    document.context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [40, 500, 140, 515],
      A: { Type: "Action", S: "URI", URI: PDFString.of("https://example.com/terms") },
    }),
  );
  first.node.addAnnot(link);
  const form = document.getForm();
  form.createTextField("tenant").addToPage(first, { x: 40, y: 440, width: 200, height: 20 });
  const locked = form.createTextField("reference");
  locked.setText("L-17");
  locked.enableReadOnly();
  locked.addToPage(first, { x: 40, y: 410, width: 200, height: 20 });
  form.createCheckBox("agree").addToPage(first, { x: 40, y: 380, width: 14, height: 14 });
  const term = form.createRadioGroup("term");
  term.addOptionToPage("one year", first, { x: 40, y: 350, width: 14, height: 14 });
  term.addOptionToPage("two years", first, { x: 80, y: 350, width: 14, height: 14 });
  const country = form.createDropdown("country");
  country.addOptions(["United Kingdom", "France"]);
  country.addToPage(first, { x: 40, y: 320, width: 120, height: 20 });
  const extras = form.createOptionList("extras");
  extras.addOptions(["Parking", "Storage", "Garden"]);
  extras.enableMultiselect();
  extras.addToPage(first, { x: 40, y: 250, width: 120, height: 60 });

  const second = document.addPage([500, 700]);
  second.setCropBox(50, 100, 400, 500);
  second.setRotation(degrees(90));
  second.drawText("Signed by the tenant", { x: 80, y: 300, size: 12 });
  change(document);
  return document.save();
}

async function read(bytes: Uint8Array) {
  const task = getDocument({ data: bytes.slice(), verbosity: 0 });
  const document = await task.promise;
  const page = async (index: number) => {
    const proxy = await document.getPage(index + 1);
    const text = await proxy.getTextContent();
    const operators = await proxy.getOperatorList();
    return {
      annotations: await proxy.getAnnotations(),
      text: text.items.flatMap((item) =>
        "str" in item ? [{ text: item.str, transform: item.transform as number[] }] : [],
      ),
      images: operators.fnArray.filter((operator) => operator === OPS.paintImageXObject).length,
    };
  };
  const pages = [await page(0), await page(1)];
  const metadata = await document.getMetadata();
  await task.destroy();
  return { pageCount: pages.length, pages, title: (metadata.info as { Title?: string }).Title };
}

const edit = (
  bytes: Uint8Array,
  operations: ReadonlyArray<PdfOperation>,
  signatures: ReadonlyArray<PdfSignaturePlacement> = [],
) => editPdf(bytes, { operations, signatures, now: NOW });

const refusal = async (attempt: Promise<unknown>) => {
  const cause = await attempt.then(
    () => null,
    (error: unknown) => error,
  );
  if (!(cause instanceof PdfProblem)) throw new Error(`Expected a refusal, got ${String(cause)}`);
  return { ...cause.detail, index: cause.index };
};

const signature = (overrides: Partial<PdfSignaturePlacement> = {}): PdfSignaturePlacement => ({
  page: 0,
  rect: { x: 200, y: 100, width: 150, height: 60 },
  image: { mediaType: "image/png", dataBase64: PNG },
  name: "Ada Lovelace",
  date: "23/11/2026",
  ...overrides,
});

describe("pdfEdits", () => {
  it("stores highlights and notes as standard annotations and removes the ones made here", async () => {
    const original = await fixture();
    const saved = await edit(original, [
      {
        type: "addHighlight",
        page: 0,
        rects: [
          { x: 40, y: 538, width: 200, height: 16 },
          { x: 40, y: 520, width: 90, height: 16 },
        ],
        colour: "FFE066",
        contents: "Check the parties",
      },
      { type: "addNote", page: 1, x: 120, y: 480, contents: "Ask about the deposit" },
    ]);

    const contents = await inspectPdf(saved);
    expect(contents.refusal).toBeUndefined();
    const [highlight, note] = contents.annotations;
    expect(highlight).toMatchObject({
      page: 0,
      kind: "highlight",
      colour: "FFE066",
      contents: "Check the parties",
      removable: true,
      rect: { x: 40, y: 520, width: 200, height: 34 },
      rects: [
        { x: 40, y: 538, width: 200, height: 16 },
        { x: 40, y: 520, width: 90, height: 16 },
      ],
    });
    expect(note).toMatchObject({
      page: 1,
      kind: "note",
      contents: "Ask about the deposit",
      removable: true,
      rect: { x: 120, y: 460, width: 20, height: 20 },
    });

    // Another reader finds the same annotations, each with an appearance to draw.
    const other = await read(saved);
    expect(other.pageCount).toBe(2);
    expect(other.title).toBe("Lease agreement");
    expect(other.pages[0]!.text.map((item) => item.text)).toContain(
      "Agreement between the parties",
    );
    const seen = other.pages[0]!.annotations.find(
      (annotation) => annotation.subtype === "Highlight",
    );
    expect(seen).toMatchObject({
      contentsObj: { str: "Check the parties" },
      hasAppearance: true,
      rect: [40, 520, 240, 554],
    });
    expect(Array.from(seen.color as Uint8ClampedArray)).toEqual([255, 224, 102]);
    expect(Array.from(seen.quadPoints as Float32Array)).toHaveLength(16);
    expect(
      other.pages[0]!.annotations.find((annotation) => annotation.subtype === "Link"),
    ).toMatchObject({ url: "https://example.com/terms" });
    expect(other.pages[1]!.annotations).toMatchObject([
      { subtype: "Text", contentsObj: { str: "Ask about the deposit" }, hasAppearance: true },
    ]);

    const removed = await edit(saved, [{ type: "removeAnnotation", id: highlight!.id }]);
    expect((await inspectPdf(removed)).annotations.map((annotation) => annotation.kind)).toEqual([
      "note",
    ]);
    expect((await read(removed)).pages[0]!.annotations.map((a) => a.subtype)).not.toContain(
      "Highlight",
    );
    expect(await refusal(edit(removed, [{ type: "removeAnnotation", id: highlight!.id }]))).toEqual(
      { kind: "operation", reason: "unknown-annotation", index: 0 },
    );
  });

  it("leaves annotations from other apps in place", async () => {
    const original = await fixture((document) => {
      const page = document.getPages()[0]!;
      page.node.addAnnot(
        document.context.register(
          document.context.obj({
            Type: "Annot",
            Subtype: "Highlight",
            Rect: [40, 538, 240, 554],
            QuadPoints: [40, 554, 240, 554, 40, 538, 240, 538],
            C: [0, 1, 0],
            NM: PDFString.of("reader-1"),
          }),
        ),
      );
    });
    const [foreign] = (await inspectPdf(original)).annotations;
    expect(foreign).toMatchObject({ kind: "highlight", colour: "00FF00", removable: false });
    expect(await refusal(edit(original, [{ type: "removeAnnotation", id: foreign!.id }]))).toEqual({
      kind: "operation",
      reason: "annotation-not-removable",
      index: 0,
    });
  });

  it("fills form fields, redraws them and refuses values a field cannot take", async () => {
    const original = await fixture();
    const opened = await inspectPdf(original);
    expect(opened.fields.map((field) => [field.name, field.value, field.readOnly])).toEqual([
      ["tenant", { kind: "text", text: "" }, false],
      ["reference", { kind: "text", text: "L-17" }, true],
      ["agree", { kind: "checkbox", checked: false }, false],
      ["term", { kind: "radio", option: null }, false],
      ["country", { kind: "choice", options: [] }, false],
      ["extras", { kind: "choice", options: [] }, false],
    ]);
    expect(opened.fields[3]).toMatchObject({
      options: ["one year", "two years"],
      widgets: [
        { page: 0, option: "one year" },
        { page: 0, option: "two years" },
      ],
    });
    // The rectangle the file stores, which includes the field's border.
    expect(opened.fields[0]!.widgets[0]!.rect).toEqual({
      x: 39.5,
      y: 439.5,
      width: 201,
      height: 21,
    });

    const saved = await edit(original, [
      { type: "setField", name: "tenant", value: { kind: "text", text: "Ada Lovelace" } },
      { type: "setField", name: "agree", value: { kind: "checkbox", checked: true } },
      { type: "setField", name: "term", value: { kind: "radio", option: "two years" } },
      { type: "setField", name: "country", value: { kind: "choice", options: ["France"] } },
      {
        type: "setField",
        name: "extras",
        value: { kind: "choice", options: ["Parking", "Garden"] },
      },
    ]);
    const values = Object.fromEntries(
      (await inspectPdf(saved)).fields.map((field) => [field.name, field.value]),
    );
    expect(values).toMatchObject({
      tenant: { kind: "text", text: "Ada Lovelace" },
      agree: { kind: "checkbox", checked: true },
      term: { kind: "radio", option: "two years" },
      country: { kind: "choice", options: ["France"] },
      extras: { kind: "choice", options: ["Parking", "Garden"] },
    });

    const widgets = (await read(saved)).pages[0]!.annotations.filter(
      (annotation) => annotation.subtype === "Widget",
    );
    const widget = (fieldName: string) => widgets.filter((w) => w.fieldName === fieldName);
    expect(widget("tenant")[0]).toMatchObject({ fieldValue: "Ada Lovelace", hasAppearance: true });
    expect(widget("agree")[0]).toMatchObject({ fieldValue: "Yes" });
    expect(widget("term").map((w) => w.fieldValue === w.buttonValue)).toEqual([false, true]);
    expect(widget("country")[0]).toMatchObject({ fieldValue: ["France"] });
    expect(widget("extras")[0]).toMatchObject({ fieldValue: ["Parking", "Garden"] });

    // The text field's own appearance now draws the value, for readers that do not rebuild it.
    const reopened = await PDFDocument.load(saved);
    const tenant = reopened.getForm().getTextField("tenant").acroField.getWidgets()[0]!;
    const normal = tenant.getAppearances()?.normal;
    const stream = normal instanceof PDFDict ? undefined : normal;
    expect(stream).toBeInstanceOf(PDFRawStream);
    expect(
      new TextDecoder("latin1").decode(decodePDFRawStream(stream as PDFRawStream).decode()),
    ).toContain(`<${Buffer.from("Ada Lovelace", "latin1").toString("hex").toUpperCase()}> Tj`);

    // Text the built-in font cannot draw is stored and left for each reader to draw.
    const japanese = await edit(original, [
      { type: "setField", name: "tenant", value: { kind: "text", text: "山田 太郎" } },
    ]);
    expect((await inspectPdf(japanese)).fields[0]!.value).toEqual({
      kind: "text",
      text: "山田 太郎",
    });
    const needs = (await PDFDocument.load(japanese)).catalog
      .getAcroForm()!
      .dict.lookup(PDFName.of("NeedAppearances"));
    expect(String(needs)).toBe("true");

    const refusals: ReadonlyArray<readonly [PdfOperation, string]> = [
      [{ type: "setField", name: "missing", value: { kind: "text", text: "x" } }, "unknown-field"],
      [
        { type: "setField", name: "reference", value: { kind: "text", text: "x" } },
        "field-read-only",
      ],
      [
        { type: "setField", name: "agree", value: { kind: "text", text: "yes" } },
        "field-value-invalid",
      ],
      [
        { type: "setField", name: "term", value: { kind: "radio", option: "ten years" } },
        "field-value-invalid",
      ],
      [
        { type: "setField", name: "country", value: { kind: "choice", options: ["Spain"] } },
        "field-value-invalid",
      ],
      [{ type: "addNote", page: 9, x: 0, y: 0, contents: "" }, "unknown-page"],
    ];
    for (const [operation, reason] of refusals) {
      const valid: PdfOperation = {
        type: "setField",
        name: "agree",
        value: { kind: "checkbox", checked: true },
      };
      expect(await refusal(edit(original, [valid, operation]))).toEqual({
        kind: "operation",
        reason,
        index: 1,
      });
    }
  });

  it("draws a signature into the page, upright on a turned and cropped page", async () => {
    const original = await fixture();
    const before = await read(original);
    const saved = await edit(
      original,
      [],
      [
        signature(),
        signature({
          page: 1,
          // Shown 100 wide and 50 tall on the turned page.
          rect: { x: 300, y: 200, width: 50, height: 100 },
          image: { mediaType: "image/jpeg", dataBase64: JPEG },
        }),
      ],
    );
    const after = await read(saved);

    // Part of the page, not an annotation a reader could move or delete.
    expect(after.pages.map((page) => page.annotations.length)).toEqual(
      before.pages.map((page) => page.annotations.length),
    );
    expect((await inspectPdf(saved)).annotations).toEqual([]);
    expect(after.pages.map((page) => page.images)).toEqual([1, 1]);

    const printed = (page: number, text: string) =>
      after.pages[page]!.text.find((item) => item.text === text)!.transform;
    const name = printed(0, "Ada Lovelace");
    const date = printed(0, "23/11/2026");
    // Upright text inside the block, the date under the name.
    expect(name.slice(0, 4).map((value) => Math.sign(Math.round(value)))).toEqual([1, 0, 0, 1]);
    expect(name[4]).toBeCloseTo(200, 1);
    expect(name[5]!).toBeGreaterThan(date[5]!);
    expect(date[5]!).toBeGreaterThanOrEqual(100);
    expect(name[5]!).toBeLessThan(160);

    // On the page turned a quarter, the text runs up the stored page so that it reads level.
    const turned = printed(1, "Ada Lovelace");
    expect(turned.slice(0, 4).map((value) => Math.sign(Math.round(value)))).toEqual([0, 1, -1, 0]);
    expect(turned[4]!).toBeGreaterThan(300);
    expect(turned[4]!).toBeLessThanOrEqual(350);
    expect(turned[5]).toBeCloseTo(200, 1);
    expect(printed(1, "23/11/2026")[4]!).toBeGreaterThan(turned[4]!);
    expect(after.pages[1]!.text.map((item) => item.text)).toContain("Signed by the tenant");
  });

  it("refuses signature images and text it cannot print", async () => {
    const original = await fixture();
    const oversized = Buffer.alloc(PDF_SIGNATURE_IMAGE_MAX_BYTES + 1);
    oversized.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // A PNG header that claims 4,000 by 4,000 pixels in a few bytes.
    const huge = Buffer.from(PNG, "base64");
    huge.writeUInt32BE(4000, 16);
    huge.writeUInt32BE(4000, 20);
    const cases: ReadonlyArray<readonly [Partial<PdfSignaturePlacement>, string]> = [
      [
        { image: { mediaType: "image/png", dataBase64: huge.toString("base64") } },
        "signature-image-too-large",
      ],
      [
        { image: { mediaType: "image/png", dataBase64: oversized.toString("base64") } },
        "signature-image-too-large",
      ],
      [{ image: { mediaType: "image/png", dataBase64: JPEG } }, "signature-image-invalid"],
      [
        {
          image: { mediaType: "image/jpeg", dataBase64: Buffer.from("<svg/>").toString("base64") },
        },
        "signature-image-invalid",
      ],
      [{ image: { mediaType: "image/png", dataBase64: "not base64!" } }, "signature-image-invalid"],
      [{ page: 4 }, "unknown-page"],
      [{ name: "山田 太郎" }, "signature-text-unprintable"],
    ];
    for (const [overrides, reason] of cases) {
      expect(await refusal(edit(original, [], [signature(), signature(overrides)]))).toEqual({
        kind: "operation",
        reason,
        index: 1,
      });
    }
    expect(await refusal(edit(original, []))).toMatchObject({ reason: "nothing-to-save" });

    // A name the built-in font cannot print is drawn from the picture of it the client sends.
    const saved = await edit(
      original,
      [],
      [signature({ name: "山田 太郎", captionImageBase64: PNG })],
    );
    expect((await read(saved)).pages[0]!.images).toBe(2);
  });

  it("refuses protected and certificate-signed files", async () => {
    const encrypted = await PDFDocument.load(await fixture());
    encrypted.encrypt({ userPassword: "open", ownerPassword: "owner" });
    const signed = await fixture((document) => {
      const value = document.context.register(
        document.context.obj({
          Type: "Sig",
          Filter: "Adobe.PPKLite",
          SubFilter: "adbe.pkcs7.detached",
          ByteRange: [0, 100, 200, 300],
          Contents: PDFString.of("00"),
        }),
      );
      const field = document.context.register(
        document.context.obj({ FT: "Sig", T: PDFString.of("approval"), V: value }),
      );
      document.getForm().acroForm.addField(field);
    });
    const cases = [
      [await encrypted.save(), "encrypted"],
      [signed, "certificate-signed"],
      [new TextEncoder().encode("not a pdf"), "damaged"],
    ] as const;
    for (const [bytes, reason] of cases) {
      expect(await inspectPdf(bytes)).toEqual({ refusal: reason, annotations: [], fields: [] });
      expect(
        await refusal(edit(bytes, [{ type: "addNote", page: 0, x: 10, y: 10, contents: "x" }])),
      ).toEqual({ kind: "refused", reason, index: undefined });
    }
  });
});
