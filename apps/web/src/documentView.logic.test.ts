import { describe, expect, it } from "vite-plus/test";

import {
  documentRoomStep,
  otherFileView,
  resolveDocumentLayout,
  type DocumentLayoutInput,
} from "./documentView.logic";

const WIDE_WORK: DocumentLayoutInput = {
  presetView: "document",
  storedView: undefined,
  fileOpen: true,
  embedded: false,
  narrow: false,
  room: Infinity,
  maximized: false,
  chatCollapsed: false,
  railCollapsed: false,
  slideOverOpen: false,
};

describe("resolveDocumentLayout", () => {
  it.each([
    ["a Work or Create file opens as the stage", {}, "document", true, "column", "open"],
    ["a Code file opens beside the chat", { presetView: "chat" }, "chat", false, "main", "hidden"],
    [
      "the user's choice for the workspace wins over the preset",
      { storedView: "chat" },
      "chat",
      false,
      "main",
      "hidden",
    ],
    [
      "and the other way round",
      { presetView: "chat", storedView: "document" },
      "document",
      true,
      "column",
      "open",
    ],
    [
      "without a file the chat is the page",
      { fileOpen: false },
      "document",
      false,
      "main",
      "hidden",
    ],
    [
      "a side chat pane keeps its own column",
      { embedded: true },
      "document",
      false,
      "main",
      "hidden",
    ],
    [
      "maximise hides the chat and the rail",
      { maximized: true },
      "document",
      true,
      "hidden",
      "hidden",
    ],
    ["the chat collapses to a strip", { chatCollapsed: true }, "document", true, "strip", "open"],
    [
      "the rail collapses on its own",
      { railCollapsed: true },
      "document",
      true,
      "column",
      "collapsed",
    ],
    [
      "a narrow screen shows the file alone",
      { narrow: true },
      "document",
      true,
      "hidden",
      "hidden",
    ],
    [
      "and the chat over it when asked",
      { narrow: true, slideOverOpen: true, chatCollapsed: true },
      "document",
      true,
      "slide-over",
      "hidden",
    ],
    [
      "a narrow screen makes an open file the page whatever the view, so switching remounts nothing",
      { narrow: true, storedView: "chat" },
      "chat",
      true,
      "hidden",
      "hidden",
    ],
    [
      "too little room for the chat beside a usable stage: the chat slides over instead",
      { room: documentRoomStep(744) },
      "document",
      true,
      "hidden",
      "hidden",
    ],
    [
      "room for the chat but not the rail as well: the rail gives way",
      { room: documentRoomStep(1000) },
      "document",
      true,
      "column",
      "collapsed",
    ],
    [
      "with the chat collapsed the rail fits again",
      { room: documentRoomStep(1000), chatCollapsed: true },
      "document",
      true,
      "strip",
      "open",
    ],
    ["room for all three", { room: documentRoomStep(1032) }, "document", true, "column", "open"],
    [
      "maximise on a narrow screen leaves no slide-over",
      { narrow: true, maximized: true, slideOverOpen: true },
      "document",
      true,
      "hidden",
      "hidden",
    ],
  ] as const)("%s", (_name, change, view, documentView, chat, rail) => {
    expect(resolveDocumentLayout({ ...WIDE_WORK, ...change })).toMatchObject({
      view,
      documentView,
      chat,
      rail,
    });
  });

  it("leaving maximise or the strip brings back what was there", () => {
    const maximised = resolveDocumentLayout({ ...WIDE_WORK, maximized: true, railCollapsed: true });
    expect(maximised.chat).toBe("hidden");
    expect(resolveDocumentLayout({ ...WIDE_WORK, railCollapsed: true })).toMatchObject({
      chat: "column",
      rail: "collapsed",
    });
    expect(otherFileView(otherFileView("document"))).toBe("document");
  });
});
