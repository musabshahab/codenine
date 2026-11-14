import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render, stubGlobal } from "../../../test/render";
import { ControlEnrolSurface } from "./ControlEnrolSurface";

const PASSWORD = "correct horse battery staple";
const RECOVERY_CODES = Array.from({ length: 10 }, (_, index) => `AAAA${index}-BBBBB`);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const bodyOf = (init: RequestInit | undefined) =>
  JSON.parse(
    typeof init?.body === "string"
      ? init.body
      : init?.body instanceof Uint8Array
        ? new TextDecoder().decode(init.body)
        : "{}",
  ) as Record<string, string>;

/** Answers like the control server for one invitation link, "link-1". */
const fakeControlServer = () =>
  vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    const body = bodyOf(init);
    if (body["token"] !== "link-1") {
      return json(400, { _tag: "ControlAccountError", reason: "invalid-link" });
    }
    if (path === "/control/api/enrolment/start") {
      return json(200, {
        purpose: "invitation",
        email: "ada@acme.test",
        displayName: "Ada",
        authenticatorUri: "otpauth://totp/Codenine%3Aada%40acme.test?secret=JBSWY3DPEHPK3PXP",
        authenticatorSecret: "JBSWY3DPEHPK3PXP",
      });
    }
    if (path === "/control/api/enrolment/finish") {
      return body["code"] === "123456" && body["password"] === PASSWORD
        ? json(200, {
            me: { id: "per_ada", email: "ada@acme.test", displayName: "Ada", role: "owner" },
            recoveryCodes: RECOVERY_CODES,
          })
        : json(400, { _tag: "ControlAccountError", reason: "wrong-code" });
    }
    return json(404, {});
  });

describe("ControlEnrolSurface", () => {
  it("sets up a password and authenticator, then shows the recovery codes once", async () => {
    const onFinished = vi.fn();
    using _fetch = stubGlobal("fetch", fakeControlServer());
    await using _screen = await render(
      <ControlEnrolSurface onFinished={onFinished} token="link-1" />,
    );

    await expect
      .element(page.getByRole("img", { name: "Authenticator set-up code" }))
      .toBeVisible();
    await expect.element(page.getByText("JBSWY3DPEHPK3PXP")).toBeVisible();

    await page.getByLabelText("2. Choose a password").fill("too short");
    await page.getByLabelText("Type the password again").fill("too short");
    await page.getByLabelText("3. Enter the 6-digit code the app shows").fill("123456");
    await page.getByRole("button", { name: "Finish set-up" }).click();
    await expect.element(page.getByText("Use a password of at least 12 characters.")).toBeVisible();

    await page.getByLabelText("2. Choose a password").fill(PASSWORD);
    await page.getByLabelText("Type the password again").fill(`${PASSWORD}!`);
    await page.getByRole("button", { name: "Finish set-up" }).click();
    await expect.element(page.getByText("The two passwords are different.")).toBeVisible();

    await page.getByLabelText("Type the password again").fill(PASSWORD);
    await page.getByLabelText("3. Enter the 6-digit code the app shows").fill("000000");
    await page.getByRole("button", { name: "Finish set-up" }).click();
    await expect.element(page.getByText(/That code is not right/u)).toBeVisible();

    await page.getByLabelText("3. Enter the 6-digit code the app shows").fill("123456");
    await page.getByRole("button", { name: "Finish set-up" }).click();
    await expect.element(page.getByText("AAAA0-BBBBB")).toBeVisible();
    expect(onFinished).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "I have saved them" }).click();
    expect(onFinished).toHaveBeenCalledOnce();
  });

  it("explains a link that has been used or has expired", async () => {
    using _fetch = stubGlobal("fetch", fakeControlServer());
    await using _screen = await render(
      <ControlEnrolSurface onFinished={vi.fn()} token="used-link" />,
    );

    await expect.element(page.getByText("This link cannot be used")).toBeVisible();
    await expect.element(page.getByText(/already been used/u)).toBeVisible();
  });
});
