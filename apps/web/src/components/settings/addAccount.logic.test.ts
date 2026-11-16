import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ServerProvider,
  type ServerSettings,
} from "@codenine/contracts";
import { describe, expect, it } from "vite-plus/test";

import { planSignInAccount, type SignInAccountDriver } from "./addAccount.logic";

function provider(
  id: string,
  driver: SignInAccountDriver,
  signedIn: boolean,
  overrides: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: signedIn ? "ready" : "error",
    auth: { status: signedIn ? "authenticated" : "unauthenticated" },
    checkedAt: "2026-11-16T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

const instances = (
  entries: Record<string, ProviderInstanceConfig>,
): ServerSettings["providerInstances"] =>
  Object.fromEntries(
    Object.entries(entries).map(([id, instance]) => [ProviderInstanceId.make(id), instance]),
  );

const plan = (
  driver: SignInAccountDriver,
  providers: ReadonlyArray<ServerProvider>,
  providerInstances: ServerSettings["providerInstances"] = {},
) => planSignInAccount({ driver, name: "Personal", providerInstances, providers });

describe("planSignInAccount", () => {
  it("signs the computer's own login in while no account uses it", () => {
    expect(plan("claudeAgent", [provider("claudeAgent", "claudeAgent", false)])).toEqual({
      operation: "upsert",
      instanceId: "claudeAgent",
      instance: { driver: "claudeAgent", enabled: true, displayName: "Personal" },
    });
    expect(plan("codex", [provider("codex", "codex", false)]).instanceId).toBe("codex");
  });

  it("gives a second Claude account a folder no other account signs into", () => {
    const signedIn = [provider("claudeAgent", "claudeAgent", true)];
    expect(plan("claudeAgent", signedIn).instance.config).toEqual({
      homePath: "~/.claude-personal",
    });
    const taken = plan(
      "claudeAgent",
      signedIn,
      instances({
        claudeAgent_mine: {
          driver: ProviderDriverKind.make("claudeAgent"),
          config: { homePath: "~/.claude-personal" },
        },
      }),
    );
    expect(taken).toMatchObject({
      operation: "create",
      instanceId: "claudeAgent_personal",
      instance: { config: { homePath: "~/.claude-personal-2" } },
    });
  });

  it("shares Codex history through a shadow home, unless no CLI account exists yet", () => {
    expect(plan("codex", [provider("codex", "codex", true)]).instance.config).toEqual({
      setupMode: "existing",
      homePath: "",
      shadowHomePath: "~/.codex-codenine/personal",
    });
    // A ChatGPT connection keeps its own home, so the first CLI account uses ~/.codex directly.
    const managed = plan(
      "codex",
      [provider("codex", "codex", true)],
      instances({
        codex: { driver: ProviderDriverKind.make("codex"), config: { setupMode: "managed" } },
      }),
    );
    expect(managed).toMatchObject({
      operation: "create",
      instanceId: "codex_personal",
      instance: { config: { setupMode: "existing" } },
    });
    expect(managed.instance.config).not.toHaveProperty("shadowHomePath");
  });
});
