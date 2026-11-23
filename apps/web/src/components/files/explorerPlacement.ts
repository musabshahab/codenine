import { createContext } from "react";

/**
 * True while document view offers its left rail, open or collapsed, which then holds the
 * workspace's files instead of the file tab. Without a rail the file tab keeps its own explorer.
 */
export const ExplorerInRailContext = createContext(false);

/**
 * Set while the file is the stage of document view. The stage has one tool row: the editor's
 * tools go into `element`, beside the file's own actions, instead of a row of the editor's own.
 * `element` is null until the row is laid out.
 */
export const FileToolSlotContext = createContext<{ readonly element: HTMLElement | null } | null>(
  null,
);
/** True while the open file is the stage of document view. */
export const FileStageContext = createContext(false);
