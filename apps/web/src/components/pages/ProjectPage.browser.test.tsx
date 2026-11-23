import { createMemoryHistory } from "@tanstack/react-router";
import { WS_METHODS } from "@codenine/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@codenine/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

// Styles lay the app out, so the sidebar's workspace row is on screen to click.
import "~/index.css";

import { AppRoot } from "~/AppRoot";
// The draft route loads ChatView lazily, and its first transform takes several seconds;
// importing it here keeps that out of the test's timeout.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }, Layer] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
      import("../../../test/fakeEnvironment"),
      import("effect/Layer"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

// Its own file: the app's shell subscription outlives a test, and it must list this project.
it("starts a chat in the workspace from its home page, with the text typed there", async () => {
  using _environment = installFakeEnvironment([threadWithHistory("home-chat", 1)], {
    project: { kind: "work", title: "Customer ops" },
    // A new chat reads the folder's optional project file before it opens; there is none.
    answers: {
      [WS_METHODS.projectsReadFile]: (input: { relativePath: string }) => ({
        relativePath: input.relativePath,
        contents: "",
        byteLength: 0,
        truncated: false,
        exists: false,
      }),
    },
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    onboardingCompletedEnvironmentId: ENVIRONMENT_ID,
  });
  await page.viewport(1280, 800);
  const router = getRouter(createMemoryHistory({ initialEntries: ["/"] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await page.getByText("Customer ops").first().click();

  // The Work preset's question, and the workspace's chats, are on the page.
  const prompt = page.getByRole("textbox", { name: "What do you need done?" });
  await expect.element(prompt).toBeVisible();
  await expect
    .element(page.getByRole("region", { name: "Chats" }).getByText("Thread home-chat"))
    .toBeVisible();

  await prompt.fill("Summarise the vendor emails");
  await userEvent.keyboard("{Enter}");

  // The text is in the new chat's own composer, not sent.
  await vi.waitFor(() => expect(router.state.location.pathname).toMatch(/^\/draft\//));
  await expect
    .element(page.getByTestId("composer-editor").getByText("Summarise the vendor emails"))
    .toBeVisible();
});
