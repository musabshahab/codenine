/**
 * Marks a grid that takes typing, paste and editing keys itself, as a text field does, so the
 * composer and the app's shortcuts leave them to it.
 */
export const KEYBOARD_GRID_SELECTOR = "[data-keyboard-grid]";
export const KEYBOARD_GRID_PROPS = { "data-keyboard-grid": "" } as const;

export function isInKeyboardGrid(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(KEYBOARD_GRID_SELECTOR) !== null;
}

const EDITABLE_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  '[role="textbox"]',
  KEYBOARD_GRID_SELECTOR,
].join(",");

/** Includes focused descendants of open shadow roots, whose key events target the host. */
export function isEditableFocused(target: EventTarget | null = document.activeElement): boolean {
  let element = target instanceof Element ? target : null;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element !== null && element.closest(EDITABLE_SELECTOR) !== null;
}
