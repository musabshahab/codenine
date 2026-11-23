import { expect, it } from "@effect/vitest";
import type { DeckOperation } from "@codenine/contracts";
import JSZip from "jszip";

import { DeckProblem, PptxDeck } from "./pptxDeck.ts";
import { DECK_PICTURE, deckFixture } from "./pptxDeck.testkit.ts";

const LIMITS = { maxUnpackedBytes: 8 * 1024 * 1024 };

async function edit(operations: ReadonlyArray<DeckOperation>, bytes?: Uint8Array) {
  const deck = await PptxDeck.open(bytes ?? (await deckFixture()), LIMITS);
  await deck.apply(operations);
  const saved = await deck.save();
  // Read again from the bytes, as another app would.
  const reopened = await PptxDeck.open(saved, LIMITS);
  return { saved, zip: await JSZip.loadAsync(saved), ...(await reopened.contents()) };
}

const text = (zip: JSZip, path: string) => zip.file(path)!.async("string");

it("lists each slide's layout, text shapes and notes", async () => {
  const { slides, layouts } = await edit([{ type: "setNotes", slide: 2, notes: "Say why" }]);
  expect(layouts).toEqual(["Title Slide", "Title and Content"]);
  expect(slides).toEqual([
    {
      slide: 1,
      layout: "Title Slide",
      shapes: [
        { id: "2", name: "Title 1", placeholder: "ctrTitle", text: "Quarterly review" },
        { id: "3", name: "Subtitle 2", placeholder: "subTitle", text: "Draft & notes" },
      ],
      notes: "",
    },
    {
      slide: 2,
      layout: "Title and Content",
      shapes: [
        { id: "2", name: "Title 1", placeholder: "title", text: "Revenue" },
        { id: "3", name: "Content 2", placeholder: "body", text: "Up 4%" },
        { id: "5", name: "TextBox 4", text: "Source: finance" },
      ],
      notes: "Say why",
    },
  ]);
});

it("replaces a shape's text and keeps its formatting and every other part", async () => {
  const before = await JSZip.loadAsync(await deckFixture());
  const { zip, slides } = await edit([
    { type: "setText", slide: 2, shape: "body", text: "Up 6% <year on year>\n\nMargin flat" },
    { type: "setText", slide: 1, shape: "title", text: "Annual review" },
    { type: "setText", slide: 2, shape: "5", text: "Source: audit" },
  ]);
  expect(slides[1]?.shapes.map((shape) => shape.text)).toEqual([
    "Revenue",
    "Up 6% <year on year>\n\nMargin flat",
    "Source: audit",
  ]);
  expect(slides[0]?.shapes[0]?.text).toBe("Annual review");
  const slide = await text(zip, "ppt/slides/slide2.xml");
  expect(slide).toContain(
    '<a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="en-GB" b="1"/><a:t>Up 6% &lt;year on year&gt;</a:t></a:r></a:p><a:p><a:pPr algn="ctr"/></a:p>',
  );
  expect(slide).toContain('<a:blip r:embed="rId2"/>');
  expect(await zip.file("ppt/media/image1.png")!.async("uint8array")).toEqual(DECK_PICTURE);
  for (const path of [
    "docProps/custom.xml",
    "ppt/theme/theme1.xml",
    "ppt/slideLayouts/slideLayout2.xml",
    "ppt/slideMasters/slideMaster1.xml",
    "ppt/slides/_rels/slide2.xml.rels",
    "ppt/presentation.xml",
    "[Content_Types].xml",
  ]) {
    expect(await text(zip, path), path).toBe(await text(before, path));
  }
  expect(Object.keys(zip.files).toSorted()).toEqual(Object.keys(before.files).toSorted());
});

it("adds a slide from a layout, with its placeholders, at the asked position", async () => {
  const { zip, slides } = await edit([
    {
      type: "addSlide",
      layout: "title and content",
      at: 2,
      text: [
        { shape: "title", text: "Costs" },
        { shape: "body", text: "Down 2%" },
      ],
      notes: "Mention the one-off",
    },
    { type: "addSlide", layout: "Title Slide" },
  ]);
  expect(slides.map((slide) => [slide.slide, slide.layout, slide.shapes[0]?.text])).toEqual([
    [1, "Title Slide", "Quarterly review"],
    [2, "Title and Content", "Costs"],
    [3, "Title and Content", "Revenue"],
    [4, "Title Slide", ""],
  ]);
  expect(slides[1]?.notes).toBe("Mention the one-off");
  // The date placeholder stays on the layout.
  expect(slides[3]?.shapes.map((shape) => shape.placeholder)).toEqual(["ctrTitle", "subTitle"]);
  expect(await text(zip, "ppt/presentation.xml")).toContain(
    '<p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="258" r:id="rId5"/><p:sldId id="257" r:id="rId3"/><p:sldId id="259" r:id="rId7"/></p:sldIdLst>',
  );
  const types = await text(zip, "[Content_Types].xml");
  for (const part of [
    "/ppt/slides/slide3.xml",
    "/ppt/slides/slide4.xml",
    "/ppt/notesSlides/notesSlide1.xml",
    "/ppt/notesMasters/notesMaster1.xml",
    "/ppt/theme/theme2.xml",
  ]) {
    expect(types).toContain(`PartName="${part}"`);
  }
  expect(await text(zip, "ppt/slides/_rels/slide3.xml.rels")).toContain(
    'Target="../slideLayouts/slideLayout2.xml"',
  );
  // The notes master is listed straight after the slide masters, where the format wants it.
  expect(await text(zip, "ppt/presentation.xml")).toMatch(
    /<\/p:sldMasterIdLst><p:notesMasterIdLst><p:notesMasterId r:id="rId6"\/><\/p:notesMasterIdLst><p:sldIdLst>/,
  );
  expect(await text(zip, "ppt/notesSlides/_rels/notesSlide1.xml.rels")).toContain(
    'Target="../slides/slide3.xml"',
  );
});

it("deletes and reorders slides, and drops a deleted slide's parts", async () => {
  const withNotes = (await edit([{ type: "setNotes", slide: 1, notes: "Open warmly" }])).saved;
  const { zip, slides } = await edit(
    [
      { type: "addSlide", layout: "Title Slide", text: [{ shape: "title", text: "Thanks" }] },
      { type: "moveSlide", slide: 3, to: 1 },
      { type: "deleteSlide", slide: 2 },
    ],
    withNotes,
  );
  expect(slides.map((slide) => slide.shapes[0]?.text)).toEqual(["Thanks", "Revenue"]);
  expect(zip.file("ppt/slides/slide1.xml")).toBeNull();
  expect(zip.file("ppt/slides/_rels/slide1.xml.rels")).toBeNull();
  expect(zip.file("ppt/notesSlides/notesSlide1.xml")).toBeNull();
  const types = await text(zip, "[Content_Types].xml");
  expect(types).not.toContain("/ppt/slides/slide1.xml");
  expect(types).not.toContain("/ppt/notesSlides/notesSlide1.xml");
  expect(await text(zip, "ppt/_rels/presentation.xml.rels")).not.toContain("slides/slide1.xml");
  expect(await zip.file("ppt/media/image1.png")!.async("uint8array")).toEqual(DECK_PICTURE);

  // A custom show names a slide by relationship and a section by slide id.
  const listed = await JSZip.loadAsync(await deckFixture());
  listed.file(
    "ppt/presentation.xml",
    (await text(listed, "ppt/presentation.xml")).replace(
      "</p:presentation>",
      '<p:custShowLst><p:custShow name="Short" id="0"><p:sldLst><p:sld r:id="rId2"/><p:sld r:id="rId3"/></p:sldLst></p:custShow></p:custShowLst>' +
        '<p:extLst><p:ext uri="{521415D9-36F7-43E2-AB2F-B90AF26B5E84}"><p14:sectionLst xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main"><p14:section name="All" id="{0}"><p14:sldIdLst><p14:sldId id="256"/><p14:sldId id="257"/></p14:sldIdLst></p14:section></p14:sectionLst></p:ext></p:extLst></p:presentation>',
    ),
  );
  const shown = await edit(
    [{ type: "deleteSlide", slide: 2 }],
    await listed.generateAsync({ type: "uint8array" }),
  );
  const presentation = await text(shown.zip, "ppt/presentation.xml");
  expect(presentation).toContain('<p:sldLst><p:sld r:id="rId2"/></p:sldLst>');
  expect(presentation).toContain('<p14:sldIdLst><p14:sldId id="256"/></p14:sldIdLst>');
  expect(presentation).toContain('<p:sldMasterId id="2147483648" r:id="rId1"/>');
});

it.each([
  ["a slide number past the end", { type: "setNotes", slide: 3, notes: "x" }, "unknown-slide"],
  [
    "a shape the slide lacks",
    { type: "setText", slide: 1, shape: "body", text: "x" },
    "unknown-shape",
  ],
  ["a layout the deck lacks", { type: "addSlide", layout: "Comparison" }, "unknown-layout"],
  ["a move past the end", { type: "moveSlide", slide: 1, to: 3 }, "unknown-slide"],
] as const)("refuses %s and names the operation", async (_name, operation, reason) => {
  const failure = await edit([{ type: "setNotes", slide: 1, notes: "ok" }, operation]).catch(
    (cause: unknown) => cause,
  );
  expect(failure).toBeInstanceOf(DeckProblem);
  expect(failure).toMatchObject({ reason, operationIndex: 1 });
});

it("refuses to delete the only slide, a file that is not a deck, and one that unpacks too far", async () => {
  await expect(
    edit([
      { type: "deleteSlide", slide: 1 },
      { type: "deleteSlide", slide: 1 },
    ]),
  ).rejects.toMatchObject({ reason: "last-slide" });
  await expect(PptxDeck.open(new TextEncoder().encode("not a zip"), LIMITS)).rejects.toMatchObject({
    reason: "not-a-deck",
  });
  await expect(PptxDeck.open(await deckFixture(), { maxUnpackedBytes: 600 })).rejects.toMatchObject(
    { reason: "too-large" },
  );
});
