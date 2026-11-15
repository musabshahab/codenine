import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render, stubGlobal } from "../../../test/render";
import { ControlSignInSurface } from "./ControlSignInSurface";

const PASSWORD = "correct horse battery staple";

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

/**
 * Answers like the control server for one person with one password and one
 * code. Without mail, forgotten-password links are refused.
 */
const fakeControlServer = ({ mail = true } = {}) =>
  vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    const body = bodyOf(init);
    if (path === "/control/api/password-reset") {
      return mail
        ? json(200, { ok: true })
        : json(400, { _tag: "ControlAccountError", reason: "email-off" });
    }
    if (path === "/control/api/sign-in") {
      return body["password"] === PASSWORD
        ? json(200, { ticket: "ticket-1" })
        : json(401, { _tag: "ControlSignInError", reason: "wrong-credentials" });
    }
    if (path === "/control/api/sign-in/code") {
      return body["ticket"] === "ticket-1" && body["code"] === "123456"
        ? json(200, { id: "per_ada", email: "ada@acme.test", displayName: "Ada", role: "owner" })
        : json(401, { _tag: "ControlSignInError", reason: "wrong-code" });
    }
    return json(404, {});
  });

describe("ControlSignInSurface", () => {
  it("asks for the password, then the code, and reports each mistake", async () => {
    const onSignedIn = vi.fn();
    using _fetch = stubGlobal("fetch", fakeControlServer());
    await using _screen = await render(<ControlSignInSurface onSignedIn={onSignedIn} />);

    await page.getByLabelText("Email address").fill("ada@acme.test");
    await page.getByLabelText("Password").fill("not the password");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect.element(page.getByText("The email address or password is wrong.")).toBeVisible();

    await page.getByLabelText("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabelText("Code").fill("000000");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect.element(page.getByText("That code is not right.")).toBeVisible();
    expect(onSignedIn).not.toHaveBeenCalled();

    await page.getByLabelText("Code").fill("123456");
    await page.getByRole("button", { name: "Sign in" }).click();
    await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledOnce());
  });

  it("emails a new-password link without saying whether the account exists", async () => {
    using _fetch = stubGlobal("fetch", fakeControlServer());
    await using _screen = await render(<ControlSignInSurface onSignedIn={vi.fn()} />);

    await page.getByRole("button", { name: "Forgot your password?" }).click();
    await page.getByLabelText("Email address").fill("someone@acme.test");
    await page.getByRole("button", { name: "Email me a link" }).click();
    await expect
      .element(page.getByText(/If an account uses someone@acme\.test, we have emailed it a link/u))
      .toBeVisible();
  });

  it("says to ask an admin when the installation sends no email", async () => {
    using _fetch = stubGlobal("fetch", fakeControlServer({ mail: false }));
    await using _screen = await render(<ControlSignInSurface onSignedIn={vi.fn()} />);

    await page.getByRole("button", { name: "Forgot your password?" }).click();
    await page.getByLabelText("Email address").fill("ada@acme.test");
    await page.getByRole("button", { name: "Email me a link" }).click();
    await expect.element(page.getByText(/Ask an admin to reset your sign-in/u)).toBeVisible();
  });
});
