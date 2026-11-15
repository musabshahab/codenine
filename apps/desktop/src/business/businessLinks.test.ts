import { describe, expect, it } from "vite-plus/test";

import { linkInArgs, opensInBrowser, signInReturnUrl, staysInApp } from "./businessLinks.ts";

const company = new URL("https://codenine.acme.test");

describe("business desktop links", () => {
  it("finishes only a complete sign-in link of this app's own scheme, on the company's page", () => {
    expect(
      signInReturnUrl(company, "codenine", "codenine://desktop-sign-in?code=AB12C-DE34F&state=s1")
        ?.href,
    ).toBe("https://codenine.acme.test/admin/desktop-return?code=AB12C-DE34F&state=s1");
    for (const link of [
      "codenine-dev://desktop-sign-in?code=AB12C-DE34F&state=s1",
      "codenine://pair?code=AB12C-DE34F&state=s1",
      "codenine://desktop-sign-in?code=AB12C-DE34F",
      "codenine://desktop-sign-in?state=s1",
      "https://codenine.acme.test/admin/desktop-return?code=x&state=y",
      "not a link",
    ]) {
      expect(signInReturnUrl(company, "codenine", link)).toBeNull();
    }
  });

  it("keeps the window on the company's address and sends only web pages to the browser", () => {
    expect(staysInApp(company, "https://codenine.acme.test/admin/sign-in")).toBe(true);
    expect(staysInApp(company, "https://codenine.acme.test.evil.test/")).toBe(false);
    expect(staysInApp(company, "http://codenine.acme.test/")).toBe(false);
    expect(opensInBrowser("https://github.com/acme")).toBe(true);
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "codenine://x",
      "smb://share",
    ]) {
      expect(opensInBrowser(url)).toBe(false);
    }
  });

  it("finds the link a second launch was given", () => {
    expect(
      linkInArgs("codenine", ["/app/codenine", "--flag", "codenine://desktop-sign-in?x"]),
    ).toBe("codenine://desktop-sign-in?x");
    expect(linkInArgs("codenine", ["/app/codenine", "codenine-dev://desktop-sign-in"])).toBeNull();
  });
});
