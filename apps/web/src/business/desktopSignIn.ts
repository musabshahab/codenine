export type DesktopScheme = "codenine" | "codenine-dev";

/** The business desktop app names its link scheme in its user agent, so pages know they are in it. */
const DESKTOP_MARKER = /\bCodenineBusinessDesktop\/(codenine|codenine-dev)\b/u;
const STATE_KEY = "codenine.desktopSignInState";

export const isDesktopScheme = (value: unknown): value is DesktopScheme =>
  value === "codenine" || value === "codenine-dev";

/** The scheme the business desktop app opens links with, or null outside it. */
export const businessDesktopScheme = (): DesktopScheme | null => {
  const scheme = DESKTOP_MARKER.exec(navigator.userAgent)?.[1];
  return isDesktopScheme(scheme) ? scheme : null;
};

const randomState = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");

/** Opens the system browser to sign in there; it hands back a code for this window only. */
export const startBrowserSignIn = (scheme: DesktopScheme) => {
  const state = randomState();
  try {
    window.sessionStorage.setItem(STATE_KEY, state);
  } catch {
    // Without storage the returned link cannot be checked, so only a typed code works.
  }
  const url = new URL("/admin/desktop-code", window.location.origin);
  url.searchParams.set("state", state);
  url.searchParams.set("scheme", scheme);
  window.open(url.href, "_blank", "noopener,noreferrer");
};

/** Whether `state` is the sign-in this window started. */
export const browserSignInStarted = (state: string) => {
  try {
    const started = window.sessionStorage.getItem(STATE_KEY);
    return started !== null && started === state;
  } catch {
    return false;
  }
};

/** Forgets the sign-in this window started, so its link works once. */
export const forgetBrowserSignIn = () => {
  try {
    window.sessionStorage.removeItem(STATE_KEY);
  } catch {
    // Nothing was stored.
  }
};

/** The link that hands a code to the desktop app. */
export const desktopReturnLink = (scheme: DesktopScheme, code: string, state: string) => {
  const url = new URL(`${scheme}://desktop-sign-in`);
  url.searchParams.set("code", code);
  url.searchParams.set("state", state);
  return url.href;
};
