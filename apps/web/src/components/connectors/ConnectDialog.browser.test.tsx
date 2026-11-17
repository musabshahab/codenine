import {
  ConnectionId,
  ConnectorCatalogId,
  type ConnectorCatalogEntry,
  EnvironmentId,
} from "@codenine/contracts";
import { AsyncResult } from "effect/reactivity";
import { page, userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({ connect: vi.fn(), openTab: vi.fn() }));

vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.connect }));
vi.mock("../../state/connectors", () => ({ connectorsEnvironment: { connect: {} } }));
vi.mock(import("./signIn"), async (original) => ({
  ...(await original()),
  useSignInReturnOrigin: () => "http://localhost:3773",
  reserveSignInTab: () => ({ open: state.openTab, cancel: () => undefined }),
}));

import { ConnectDialog } from "./ConnectDialog";

const environmentId = EnvironmentId.make("local");
const calendar: ConnectorCatalogEntry = {
  id: ConnectorCatalogId.make("google-calendar"),
  name: "Google Calendar",
  description: "Find free time, create events and reply to invites.",
  category: "email-calendar",
  auth: "own-app",
  ownApp: "google",
  inputs: [],
  runsLocally: false,
};

function setup() {
  state.connect.mockReset().mockResolvedValue(
    AsyncResult.success({
      connectionId: ConnectionId.make("google-calendar"),
      authorizeUrl: "https://accounts.google.com/o/oauth2/auth?client_id=1",
    }),
  );
  state.openTab.mockReset().mockResolvedValue(true);
}

it("walks through creating the Google app until one is saved", async () => {
  setup();
  await using _screen = await render(
    <ConnectDialog
      environmentId={environmentId}
      entry={calendar}
      savedApps={[]}
      connections={[]}
      onClose={() => undefined}
    />,
  );
  await expect.element(page.getByText("Create the app in Google Cloud")).toBeVisible();
  await expect
    .element(page.getByText("http://localhost:3773/oauth/connectors/callback"))
    .toBeVisible();

  await userEvent.click(page.getByRole("button", { name: "Sign in with Google" }));
  await expect.element(page.getByText("Paste the client ID.")).toBeVisible();
  expect(state.connect).not.toHaveBeenCalled();

  await userEvent.type(page.getByLabelText("Client ID"), "client-id");
  await userEvent.type(page.getByLabelText("Client secret"), "client-secret");
  await userEvent.click(page.getByRole("button", { name: "Sign in with Google" }));
  await expect.element(page.getByText("Finish signing in to Google")).toBeVisible();
  expect(state.connect).toHaveBeenCalledWith({
    environmentId,
    input: {
      catalogId: "google-calendar",
      ownApp: { clientId: "client-id", clientSecret: "client-secret" },
      redirectOrigin: "http://localhost:3773",
    },
  });
  expect(state.openTab).toHaveBeenCalledWith(
    "https://accounts.google.com/o/oauth2/auth?client_id=1",
  );
});

it("goes straight to signing in with the Google app already saved", async () => {
  setup();
  await using _screen = await render(
    <ConnectDialog
      environmentId={environmentId}
      entry={calendar}
      savedApps={["google"]}
      connections={[]}
      onClose={() => undefined}
    />,
  );
  await expect.element(page.getByText("Uses the Google app you set up before.")).toBeVisible();
  await expect.element(page.getByText("Create the app in Google Cloud")).not.toBeInTheDocument();
  await expect.element(page.getByLabelText("Client ID")).not.toBeInTheDocument();

  await userEvent.click(page.getByRole("button", { name: "Sign in with Google" }));
  await expect.element(page.getByText("Finish signing in to Google")).toBeVisible();
  expect(state.connect).toHaveBeenCalledWith({
    environmentId,
    input: { catalogId: "google-calendar", redirectOrigin: "http://localhost:3773" },
  });
});
