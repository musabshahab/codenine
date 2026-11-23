/** How a chat screen with an open file is arranged. */
export type FileView = "document" | "chat";

export interface DocumentLayoutInput {
  /** The workspace type's default for an opened file. */
  readonly presetView: FileView;
  /** The user's last choice for this workspace. */
  readonly storedView: FileView | undefined;
  /** The right panel is open with at least one file tab. */
  readonly fileOpen: boolean;
  /** A side chat pane has no panel of its own. */
  readonly embedded: boolean;
  /** The screen is narrow enough that a panel beside the chat would be a sheet over it. */
  readonly narrow: boolean;
  /** The width the rail, stage and chat share, as `documentRoomStep` reports it. */
  readonly room: number;
  readonly maximized: boolean;
  readonly chatCollapsed: boolean;
  readonly railCollapsed: boolean;
  readonly slideOverOpen: boolean;
}

export interface DocumentLayout {
  /** What the switch shows and toggles from, whether or not a file is open. */
  readonly view: FileView;
  /** True while the file is the main stage. */
  readonly documentView: boolean;
  /**
   * `main`: the chat is the wide column. `column`: beside the stage. `strip`: collapsed to its
   * edge. `slide-over`: over the stage on a narrow screen. `hidden`: closed or maximised away.
   */
  readonly chat: "main" | "column" | "strip" | "slide-over" | "hidden";
  readonly rail: "open" | "collapsed" | "hidden";
  /** The chat is offered over the stage, because there is no room for it beside the stage. */
  readonly slideOver: boolean;
}

const DOCUMENT_RAIL_WIDTH = 232;
export const DOCUMENT_CHAT_MIN_WIDTH = 320;
/** The stage keeps at least this; the rail and then the chat column give way first. */
const DOCUMENT_STAGE_MIN_WIDTH = 480;
const ROOM_FOR_CHAT = DOCUMENT_STAGE_MIN_WIDTH + DOCUMENT_CHAT_MIN_WIDTH;
const ROOM_FOR_RAIL_AND_CHAT = ROOM_FOR_CHAT + DOCUMENT_RAIL_WIDTH;

/**
 * The widths at which the arrangement changes. A measured width is reported as the largest step
 * it reaches, so resizing re-renders the screen only when a step is crossed.
 */
export function documentRoomStep(width: number): number {
  return width >= ROOM_FOR_RAIL_AND_CHAT
    ? ROOM_FOR_RAIL_AND_CHAT
    : width >= ROOM_FOR_CHAT
      ? ROOM_FOR_CHAT
      : 0;
}

const CHAT_VIEW = { documentView: false, chat: "main", rail: "hidden", slideOver: false } as const;

export function resolveDocumentLayout(input: DocumentLayoutInput): DocumentLayout {
  const view = input.storedView ?? input.presetView;
  if (input.embedded || !input.fileOpen) return { view, ...CHAT_VIEW };
  // On a narrow screen an open file is always the page, so the switch never swaps a sheet for
  // an inline panel, which would remount the editor.
  if (view === "chat" && !input.narrow) return { view, ...CHAT_VIEW };
  if (input.maximized) {
    return { view, documentView: true, chat: "hidden", rail: "hidden", slideOver: false };
  }
  if (input.narrow || input.room < ROOM_FOR_CHAT) {
    return {
      view,
      documentView: true,
      chat: input.slideOverOpen ? "slide-over" : "hidden",
      rail: "hidden",
      slideOver: true,
    };
  }
  const chat = input.chatCollapsed ? "strip" : "column";
  // The chat column outranks the rail: the rail gives way when both do not fit.
  const railFits = chat === "strip" || input.room >= ROOM_FOR_RAIL_AND_CHAT;
  return {
    view,
    documentView: true,
    chat,
    rail: input.railCollapsed || !railFits ? "collapsed" : "open",
    slideOver: false,
  };
}

export function otherFileView(view: FileView): FileView {
  return view === "document" ? "chat" : "document";
}
