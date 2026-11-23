import { useLayoutEffect, useState } from "react";

import { documentRoomStep } from "~/documentView.logic";
import { observeResize } from "~/lib/observeResize";

/** The width the rail, stage and chat share inside `element`, as a step of `documentRoomStep`. */
export function useDocumentRoom(element: HTMLElement | null): number {
  const [room, setRoom] = useState(Infinity);
  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- follows the laid-out width of a DOM element, before paint so the first frame is already arranged for it
  useLayoutEffect(() => {
    if (element === null) return;
    const measure = () => setRoom(documentRoomStep(element.clientWidth));
    measure();
    return observeResize(element, measure);
  }, [element]);
  return room;
}
