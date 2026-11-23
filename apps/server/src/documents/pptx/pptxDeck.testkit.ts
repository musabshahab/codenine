import JSZip from "jszip";

const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS = `xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"`;
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const TYPE = "application/vnd.openxmlformats-officedocument.";
const GROUP =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>';

const relationships = (items: ReadonlyArray<readonly [id: string, type: string, target: string]>) =>
  `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items
    .map(
      ([id, type, target]) => `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"/>`,
    )
    .join("")}</Relationships>`;

const placeholder = (id: number, name: string, kind: string, text: string | null) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr><p:ph ${kind}/></p:nvPr></p:nvSpPr><p:spPr/>` +
  `<p:txBody><a:bodyPr/><a:lstStyle/>${
    text === null
      ? "<a:p/>"
      : `<a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="en-GB" b="1"/><a:t>${text}</a:t></a:r></a:p>`
  }</p:txBody></p:sp>`;

const layout = (name: string, shapes: string) =>
  `${HEAD}<p:sldLayout ${NS}><p:cSld name="${name}"><p:spTree>${GROUP}${shapes}</p:spTree></p:cSld></p:sldLayout>`;

const slide = (shapes: string) =>
  `${HEAD}<p:sld ${NS}><p:cSld><p:spTree>${GROUP}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;

/** A picture's bytes, which no deck operation may change. */
export const DECK_PICTURE = Uint8Array.from({ length: 300 }, (_, index) => (index * 7) % 251);

/**
 * A small deck: two layouts, and two slides, the second with a picture and a free text box.
 * It has no notes and no notes master.
 */
export async function deckFixture(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>` +
      `<Override PartName="/ppt/presentation.xml" ContentType="${TYPE}presentationml.presentation.main+xml"/>` +
      `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${TYPE}presentationml.slideMaster+xml"/>` +
      `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${TYPE}presentationml.slideLayout+xml"/>` +
      `<Override PartName="/ppt/slideLayouts/slideLayout2.xml" ContentType="${TYPE}presentationml.slideLayout+xml"/>` +
      `<Override PartName="/ppt/theme/theme1.xml" ContentType="${TYPE}theme+xml"/>` +
      `<Override PartName="/ppt/slides/slide1.xml" ContentType="${TYPE}presentationml.slide+xml"/>` +
      `<Override PartName="/ppt/slides/slide2.xml" ContentType="${TYPE}presentationml.slide+xml"/></Types>`,
  );
  zip.file("_rels/.rels", relationships([["rId1", "officeDocument", "ppt/presentation.xml"]]));
  zip.file(
    "ppt/presentation.xml",
    `${HEAD}<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
  );
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    relationships([
      ["rId1", "slideMaster", "slideMasters/slideMaster1.xml"],
      ["rId2", "slide", "slides/slide1.xml"],
      ["rId3", "slide", "slides/slide2.xml"],
      ["rId4", "theme", "theme/theme1.xml"],
    ]),
  );
  zip.file(
    "ppt/slideMasters/slideMaster1.xml",
    `${HEAD}<p:sldMaster ${NS}><p:cSld><p:spTree>${GROUP}</p:spTree></p:cSld><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/><p:sldLayoutId id="2147483650" r:id="rId2"/></p:sldLayoutIdLst></p:sldMaster>`,
  );
  zip.file(
    "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    relationships([
      ["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"],
      ["rId2", "slideLayout", "../slideLayouts/slideLayout2.xml"],
      ["rId3", "theme", "../theme/theme1.xml"],
    ]),
  );
  zip.file(
    "ppt/slideLayouts/slideLayout1.xml",
    layout(
      "Title Slide",
      placeholder(2, "Title 1", 'type="ctrTitle"', null) +
        placeholder(3, "Subtitle 2", 'type="subTitle" idx="1"', null) +
        placeholder(4, "Date 3", 'type="dt" sz="half" idx="10"', null),
    ),
  );
  zip.file(
    "ppt/slideLayouts/slideLayout2.xml",
    layout(
      "Title and Content",
      placeholder(2, "Title 1", 'type="title"', null) +
        placeholder(3, "Content 2", 'idx="1"', null),
    ),
  );
  for (const name of ["slideLayout1", "slideLayout2"]) {
    zip.file(
      `ppt/slideLayouts/_rels/${name}.xml.rels`,
      relationships([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]]),
    );
  }
  zip.file("ppt/theme/theme1.xml", `${HEAD}<a:theme xmlns:a="${A}" name="Office"/>`);
  zip.file(
    "ppt/slides/slide1.xml",
    slide(
      placeholder(2, "Title 1", 'type="ctrTitle"', "Quarterly review") +
        placeholder(3, "Subtitle 2", 'type="subTitle" idx="1"', "Draft &amp; notes"),
    ),
  );
  zip.file(
    "ppt/slides/_rels/slide1.xml.rels",
    relationships([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"]]),
  );
  zip.file(
    "ppt/slides/slide2.xml",
    slide(
      placeholder(2, "Title 1", 'type="title"', "Revenue") +
        placeholder(3, "Content 2", 'idx="1"', "Up 4%") +
        '<p:pic><p:nvPicPr><p:cNvPr id="4" name="Chart"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/></p:blipFill><p:spPr/></p:pic>' +
        '<p:sp><p:nvSpPr><p:cNvPr id="5" name="TextBox 4"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>Source: finance</a:t></a:r></a:p></p:txBody></p:sp>',
    ),
  );
  zip.file(
    "ppt/slides/_rels/slide2.xml.rels",
    relationships([
      ["rId1", "slideLayout", "../slideLayouts/slideLayout2.xml"],
      ["rId2", "image", "../media/image1.png"],
    ]),
  );
  zip.file("ppt/media/image1.png", DECK_PICTURE);
  zip.file(
    "docProps/custom.xml",
    `${HEAD}<Properties><property name="Owner">Acme</property></Properties>`,
  );
  return zip.generateAsync({ type: "uint8array" });
}
