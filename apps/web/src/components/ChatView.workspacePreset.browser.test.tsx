import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@codenine/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform (React Compiler over ~4k lines)
// takes 6-11s; importing it here keeps that out of the test's timeout.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  emitProjectUpdate,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

// Its own file: the app's shell subscription outlives a test, and it must list this thread.
it("a thread's Git controls follow its workspace type's preset", async () => {
  const thread = threadWithHistory("thread-preset", 1);
  using _environment = installFakeEnvironment([thread]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    onboardingCompletedEnvironmentId: ENVIRONMENT_ID,
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText("Answer 0 for thread-preset.")).toBeVisible();
  await page.getByRole("button", { name: "Toggle right panel" }).click();
  // The empty panel lists the tabs it can open by their keys: Terminal, Files, Diff.
  const launcher = page.getByLabelText("Open a surface");
  await expect.element(launcher).toHaveAttribute("data-surface-launcher-keys", "TFD");

  // Ends on code, where the chord that did nothing in the other types opens the Diff tab.
  // A Work workspace lists Sources and Activity first; the others keep them in the add menu.
  for (const { kind, git, keys } of [
    { kind: "work", git: false, keys: "RATF" },
    { kind: "create", git: false, keys: "TF" },
    { kind: "code", git: true, keys: "TFD" },
  ] as const) {
    await emitProjectUpdate({ kind });
    await expect.element(launcher).toHaveAttribute("data-surface-launcher-keys", keys);
    // The narrow header hides its tools from the accessibility tree, so look in the document.
    await vi.waitFor(() =>
      expect(document.querySelector('button[aria-label="Changes"]') !== null).toBe(git),
    );
    await userEvent.keyboard("{Control>}d{/Control}");
    if (git) await expect.element(launcher).not.toBeInTheDocument();
    else await expect.element(launcher).toBeVisible();
  }
});
