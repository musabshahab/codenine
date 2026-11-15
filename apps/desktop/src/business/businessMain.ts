import * as Electron from "electron";

import {
  type DesktopScheme,
  linkInArgs,
  opensInBrowser,
  signInReturnUrl,
  staysInApp,
} from "./businessLinks.ts";

declare const __CODENINE_BUSINESS_URL__: string;

/** Business builds open one window on the company's Codenine, served by its control server. */
const companyUrl = URL.canParse(__CODENINE_BUSINESS_URL__)
  ? new URL(__CODENINE_BUSINESS_URL__)
  : null;
const scheme: DesktopScheme = Electron.app.isPackaged ? "codenine" : "codenine-dev";
// Pages read their scheme from here to offer sign-in through the browser.
const USER_AGENT_MARKER = `CodenineBusinessDesktop/${scheme}`;

let window: Electron.BrowserWindow | null = null;
let pendingLink: string | null = null;

const openLink = (link: string) => {
  if (companyUrl === null) return;
  const target = signInReturnUrl(companyUrl, scheme, link);
  if (target === null) return;
  if (window === null) {
    pendingLink = link;
    return;
  }
  void window.loadURL(target.href);
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
};

const createWindow = (company: URL) => {
  const created = new Electron.BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    title: "Codenine",
    // No preload: the window shows a remote site, so it gets nothing a browser tab would not.
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const contents = created.webContents;
  contents.setUserAgent(`${contents.getUserAgent()} ${USER_AGENT_MARKER}`);
  contents.setWindowOpenHandler(({ url }) => {
    if (opensInBrowser(url)) void Electron.shell.openExternal(url);
    return { action: "deny" };
  });
  const keepToCompany = (event: Electron.Event, url: string) => {
    if (staysInApp(company, url)) return;
    event.preventDefault();
    if (opensInBrowser(url)) void Electron.shell.openExternal(url);
  };
  contents.on("will-navigate", keepToCompany);
  contents.on("will-redirect", keepToCompany);
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.session.setPermissionRequestHandler((_contents, permission, callback) =>
    callback(permission === "notifications" || permission === "clipboard-sanitized-write"),
  );
  created.once("ready-to-show", () => created.show());
  created.on("closed", () => {
    window = null;
  });
  window = created;
  void created.loadURL(company.href);
  if (pendingLink !== null) {
    const link = pendingLink;
    pendingLink = null;
    openLink(link);
  }
};

if (!Electron.app.requestSingleInstanceLock()) {
  Electron.app.quit();
} else {
  // macOS hands links to the running app, even before it is ready.
  Electron.app.on("open-url", (event, link) => {
    event.preventDefault();
    openLink(link);
  });
  // Windows and Linux start a second copy with the link, which hands it here and quits.
  Electron.app.on("second-instance", (_event, argv) => {
    const link = linkInArgs(scheme, argv);
    if (link !== null) openLink(link);
    window?.focus();
  });
  void Electron.app.whenReady().then(() => {
    if (companyUrl === null) {
      Electron.dialog.showErrorBox(
        "Codenine",
        "This copy of Codenine was built without your company's address. Ask your administrator for one that has it.",
      );
      Electron.app.quit();
      return;
    }
    Electron.app.setAsDefaultProtocolClient(scheme);
    createWindow(companyUrl);
    const link = linkInArgs(scheme, process.argv);
    if (link !== null) openLink(link);
  });
  // One window is the whole app, so closing it quits, on macOS too.
  Electron.app.on("window-all-closed", () => Electron.app.quit());
}
