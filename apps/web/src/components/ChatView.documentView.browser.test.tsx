import { createMemoryHistory } from "@tanstack/react-router";
import { scopeThreadRef } from "@codenine/client-runtime/environment";
import { DEFAULT_CLIENT_SETTINGS } from "@codenine/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform takes seconds; importing it here
// keeps that out of the test's timeout.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { useRightPanelStore } from "~/rightPanelStore";
import { getRouter } from "~/router";
import { documentThread, installDocumentWorkspace } from "../../test/documentWorkspaceFixture";
import {
  ENVIRONMENT_ID,
  dispatchedCommands,
  emitProjectUpdate,
  installFakeEnvironment,
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

const query = <T extends Element = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector);
const sentMessages = () =>
  dispatchedCommands().filter((command) => command.type === "message.dispatch");
const chatLayout = () => query("[data-chat-column]")?.getAttribute("data-chat-column-layout");

// One test: the app's shell subscription outlives a test, and it must list this thread.
it("a Work file opens as the stage with the chat beside it, and switching views remounts nothing", async () => {
  const thread = documentThread("thread-document-view");
  using _environment = installFakeEnvironment([thread], { acceptCommands: true });
  using workspace = installDocumentWorkspace({ holdEdits: true });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    onboardingCompletedEnvironmentId: ENVIRONMENT_ID,
  });
  await page.viewport(1400, 860);
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect
    .element(page.getByText("Sorted the customers by waiting time, longest first."))
    .toBeVisible();
  await emitProjectUpdate({ kind: "work", title: "Customer ops" });
  useRightPanelStore.getState().openFile(scopeThreadRef(ENVIRONMENT_ID, thread.id), "budget.xlsx");

  // The Work preset puts the file in the middle, the chat in a column and the files in a rail.
  await vi.waitFor(() => expect(chatLayout()).toBe("column"));
  await expect.element(page.getByLabelText("Workspace documents")).toBeVisible();
  await vi.waitFor(() =>
    expect(query('[data-cell="B3"]')?.textContent).toBe("Refund not received"),
  );
  const chip = page.getByLabelText("Sent with your message");
  await expect.element(chip).toHaveTextContent("budget.xlsx, Emails!A1");
  await expect.element(page.getByRole("button", { name: "Summarise this sheet" })).toBeVisible();

  // The chip follows the selection, and a suggestion fills the composer without sending.
  await userEvent.click(query('[data-cell="B3"]')!);
  await expect.element(chip).toHaveTextContent("budget.xlsx, Emails!B3");
  await page.getByRole("button", { name: "Add a totals row" }).click();
  const composer = page.getByTestId("composer-editor");
  await expect.element(composer).toHaveTextContent("Add a totals row");
  await expect
    .element(page.getByRole("button", { name: "Summarise this sheet" }))
    .not.toBeInTheDocument();
  expect(sentMessages()).toEqual([]);

  // An edit the server has not answered stays unsaved in the grid.
  await userEvent.click(query('[data-cell="C3"]')!);
  await userEvent.keyboard("41{Enter}");
  await vi.waitFor(() => expect(workspace.edits).toHaveLength(1));
  const grid = query("[role=grid]")!;
  const editor = composer.element();
  grid.scrollTop = 48;

  // Chat view and back: the same grid and composer nodes, with their edit, scroll and draft.
  await page.getByRole("button", { name: "Document view" }).click();
  await vi.waitFor(() => expect(chatLayout()).toBe("main"));
  await expect.element(page.getByLabelText("Workspace documents")).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Document view" }).click();
  await vi.waitFor(() => expect(chatLayout()).toBe("column"));
  expect(query("[role=grid]")).toBe(grid);
  expect(grid.scrollTop).toBe(48);
  expect(query('[data-cell="C3"]')?.textContent).toBe("41");
  expect(composer.element()).toBe(editor);
  await expect.element(composer).toHaveTextContent("Add a totals row");

  // Maximise hides the chat and the rail, and the same control brings them back.
  await page.getByRole("button", { name: "Maximize panel" }).click();
  await vi.waitFor(() => expect(chatLayout()).toBe("hidden"));
  await expect.element(page.getByLabelText("Workspace documents")).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Restore panel size" }).click();
  await vi.waitFor(() => expect(chatLayout()).toBe("column"));

  // A narrow screen shows the file alone; its button slides the same chat over it and back.
  await page.viewport(400, 800);
  await vi.waitFor(() => expect(chatLayout()).toBe("slide-over"));
  expect(query("[data-chat-column]")?.hasAttribute("inert")).toBe(true);
  await page.getByRole("button", { name: "Show chat" }).click();
  await vi.waitFor(() => expect(query("[data-chat-column]")?.hasAttribute("inert")).toBe(false));
  expect(query("[role=grid]")).toBe(grid);
  expect(composer.element()).toBe(editor);
  await page.getByRole("button", { name: "Hide chat" }).click();
  await vi.waitFor(() => expect(query("[data-chat-column]")?.hasAttribute("inert")).toBe(true));
  await page.viewport(1400, 860);
  await vi.waitFor(() => expect(chatLayout()).toBe("column"));

  // A window with room for the chat but not the rail as well folds the rail away, and asking for
  // the rail folds the chat; the stage keeps a usable width throughout.
  await page.viewport(1200, 800);
  await expect.element(page.getByLabelText("Workspace documents")).not.toBeInTheDocument();
  expect(chatLayout()).toBe("column");
  expect(grid.getBoundingClientRect().width).toBeGreaterThanOrEqual(480);
  await page.getByRole("button", { name: "Show documents" }).click();
  await expect.element(page.getByLabelText("Workspace documents")).toBeVisible();
  expect(chatLayout()).toBe("strip");
  await page.getByRole("button", { name: "Show chat" }).click();
  await vi.waitFor(() => expect(chatLayout()).toBe("column"));
  // Too little room for the chat beside the stage: it slides over, as on a phone.
  await page.viewport(1000, 800);
  await vi.waitFor(() => expect(chatLayout()).toBe("slide-over"));
  expect(grid.getBoundingClientRect().width).toBeGreaterThanOrEqual(480);
  expect(query("[role=grid]")).toBe(grid);
  await page.viewport(1400, 860);
  await vi.waitFor(() => expect(chatLayout()).toBe("column"));

  // The chip taken off a message stays off until a message has gone, then returns.
  await page.getByRole("button", { name: /^Leave budget\.xlsx.* out of this message$/ }).click();
  await userEvent.click(composer);
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(sentMessages()).toHaveLength(1));
  expect(sentMessages()[0]).toMatchObject({ text: "Add a totals row" });
  await expect.element(chip).toHaveTextContent("budget.xlsx, Emails!C4");

  // Sending carries the file and its selection as a record the agent is handed.
  await userEvent.click(composer);
  await userEvent.keyboard("Total the refunds{Enter}");
  await vi.waitFor(() => expect(sentMessages()).toHaveLength(2));
  expect(sentMessages()[1]).toMatchObject({
    text: expect.stringMatching(/^Total the refunds\n\n\[budget\.xlsx, Emails!C4\]\(/),
    context: {
      records: [
        {
          kind: "document",
          label: "budget.xlsx, Emails!C4",
          payload: {
            path: "budget.xlsx",
            selection: { sheet: "Emails", range: "C4", values: "5" },
          },
        },
      ],
    },
  });
});
