import { ProviderDriverKind, ProviderInstanceId } from "@codenine/contracts";
import { describe, expect, it } from "vite-plus/test";

import { switchesToAccountWithOwnHistory } from "./accountSwitch.logic";

const account = (id: string, driver: string, groupKey?: string) => ({
  instanceId: ProviderInstanceId.make(id),
  driver: ProviderDriverKind.make(driver),
  ...(groupKey === undefined ? {} : { continuation: { groupKey } }),
});

describe("switchesToAccountWithOwnHistory", () => {
  it("asks only when the other account of the same agent keeps a separate history", () => {
    const work = account("claudeAgent", "claudeAgent", "claude:~/.claude");
    const personal = account("claudeAgent_personal", "claudeAgent", "claude:~/.claude-personal");
    expect(switchesToAccountWithOwnHistory(work, personal)).toBe(true);
    // Codex CLI accounts on one home share history, so the chat continues in place.
    expect(
      switchesToAccountWithOwnHistory(
        account("codex", "codex", "codex:home:/h/.codex"),
        account("codex_personal", "codex", "codex:home:/h/.codex"),
      ),
    ).toBe(false);
    // Another agent keeps its usual handoff.
    expect(
      switchesToAccountWithOwnHistory(work, account("codex", "codex", "codex:home:/h/.codex")),
    ).toBe(false);
    expect(switchesToAccountWithOwnHistory(work, work)).toBe(false);
    expect(switchesToAccountWithOwnHistory(work, account("claudeAgent_x", "claudeAgent"))).toBe(
      false,
    );
  });
});
