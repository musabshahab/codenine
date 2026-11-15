export type DesktopScheme = "codenine" | "codenine-dev";

const parse = (url: string) => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
};

/**
 * Where a `<scheme>://desktop-sign-in?code=…&state=…` link from the browser
 * finishes: the company's return page, which checks the state before using the
 * code. Anything else is not a sign-in and opens nothing.
 */
export const signInReturnUrl = (companyUrl: URL, scheme: DesktopScheme, link: string) => {
  const parsed = parse(link);
  const code = parsed?.searchParams.get("code");
  const state = parsed?.searchParams.get("state");
  if (
    parsed?.protocol !== `${scheme}:` ||
    parsed.hostname !== "desktop-sign-in" ||
    !code ||
    !state
  ) {
    return null;
  }
  const target = new URL("/admin/desktop-return", companyUrl);
  target.searchParams.set("code", code);
  target.searchParams.set("state", state);
  return target;
};

/** Only web pages leave the app, for the system browser. */
export const opensInBrowser = (url: string) => {
  const protocol = parse(url)?.protocol;
  return protocol === "https:" || protocol === "http:";
};

/** Whether a page belongs to the company's Codenine, and so may load in the window. */
export const staysInApp = (companyUrl: URL, url: string) =>
  parse(url)?.origin === companyUrl.origin;

/** The link a launch or a second launch was given, on Windows and Linux. */
export const linkInArgs = (scheme: DesktopScheme, argv: ReadonlyArray<string>) =>
  argv.find((arg) => arg.startsWith(`${scheme}://`)) ?? null;
