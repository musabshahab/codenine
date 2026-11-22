import * as Option from "effect/Option";
import type { SourceControlProviderAuth } from "@codenine/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  credentialProblem,
  groupHostAccounts,
  nextHostAccountChoices,
} from "./SourceControlAccountSettings.logic";

describe("groupHostAccounts", () => {
  it("groups logins by host, keeping broken and environment logins out of the picker", () => {
    expect(
      groupHostAccounts([
        { host: "github.com", account: "personal", active: true, authenticated: true },
        { host: "github.com", account: "work", active: false, authenticated: true },
        { host: "github.com", account: "old", active: false, authenticated: false, error: "bad" },
        {
          host: "github.com",
          account: "bot",
          active: false,
          authenticated: true,
          environmentVariable: "GH_TOKEN",
        },
        { host: "ghe.acme.test", account: "jm", active: false, authenticated: true },
      ]),
    ).toEqual([
      {
        host: "github.com",
        activeAccount: "personal",
        selectable: ["personal", "work"],
        broken: [
          { host: "github.com", account: "old", active: false, authenticated: false, error: "bad" },
        ],
        environmentVariable: "GH_TOKEN",
      },
      {
        host: "ghe.acme.test",
        activeAccount: "jm",
        selectable: ["jm"],
        broken: [],
        environmentVariable: null,
      },
    ]);
  });

  it("keeps a host turned off in Settings switchable after its logins are gone", () => {
    expect(
      groupHostAccounts(
        [{ host: "ghe.acme.test", account: "jm", active: true, authenticated: true }],
        { "github.com": { enabled: false }, "ghe.acme.test": { enabled: false } },
      ).map((group) => group.host),
    ).toEqual(["ghe.acme.test", "github.com"]);
  });
});

describe("nextHostAccountChoices", () => {
  it("pins an account, keeps other hosts, and drops a host back on the CLI defaults", () => {
    const other = { "ghe.acme.test": { enabled: false } };
    const pinned = nextHostAccountChoices(other, "github.com", { account: "work" });
    expect(pinned).toEqual({ ...other, "github.com": { enabled: true, account: "work" } });

    const disabled = nextHostAccountChoices(pinned, "github.com", { enabled: false });
    expect(disabled["github.com"]).toEqual({ enabled: false, account: "work" });

    expect(
      nextHostAccountChoices(disabled, "github.com", { enabled: true, account: null }),
    ).toEqual(other);
  });
});

describe("credentialProblem", () => {
  const brokenLogin = {
    host: "github.com",
    account: "jm",
    active: true,
    authenticated: false,
    error: "The token in keyring is invalid.",
  };
  const auth = (
    detail: string,
    host?: string,
    accounts?: SourceControlProviderAuth["accounts"],
  ): SourceControlProviderAuth => ({
    status: "unauthenticated",
    account: Option.none(),
    host: Option.fromNullishOr(host),
    detail: Option.some(detail),
    ...(accounts === undefined ? {} : { accounts }),
  });

  it.each([
    {
      name: "gh not signed in",
      auth: auth(
        "Run `gh auth login` to authenticate GitHub CLI with an active account.",
        undefined,
        [],
      ),
      expected: null,
    },
    {
      name: "gh login error",
      auth: auth(brokenLogin.error, "github.com", [brokenLogin]),
      expected: null,
    },
    {
      name: "refused GH_TOKEN beside a broken gh login",
      auth: auth("GitHub refused the token in GH_TOKEN.", "github.com", [brokenLogin]),
      expected: "GitHub refused the token in GH_TOKEN.",
    },
    {
      name: "unreadable saved token",
      auth: auth("Could not read the credential.", "github.com"),
      expected: "Could not read the credential.",
    },
  ])("$name", ({ auth, expected }) => {
    expect(credentialProblem(auth)).toBe(expected);
  });
});
