import {
  ConnectionId,
  ConnectorError,
  EnvironmentId,
  ThreadId,
  TurnItemId,
} from "@codenine/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({ answer: vi.fn() }));

vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.answer }));
vi.mock("../../state/connectors", () => ({ connectorsEnvironment: { answerApproval: {} } }));

import { ConnectorApprovalCard, type ConnectorApprovalItem } from "./ConnectorApprovalCard";

const environmentId = EnvironmentId.make("local");

function approval(overrides: Partial<ConnectorApprovalItem> = {}): ConnectorApprovalItem {
  return {
    type: "connector_approval",
    id: TurnItemId.make("approval-1"),
    threadId: ThreadId.make("thread-1"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 3,
    status: "waiting",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-11-17T10:42:00.000Z"),
    connectionId: ConnectionId.make("gmail"),
    connectorName: "Gmail",
    tool: "send_draft",
    risk: "irreversible",
    action: "send a draft",
    details: [
      { label: "To", value: "sam@example.com" },
      { label: "Subject", value: "Re: Release date" },
    ],
    preview: "Hi Sam, the release moves to Friday.",
    approvalStatus: "pending",
    ...overrides,
  };
}

it("answers with the button's choice and keeps the card when the answer fails", async () => {
  state.answer
    .mockReset()
    .mockResolvedValueOnce(
      AsyncResult.failure(
        Cause.fail(new ConnectorError({ reason: "unreachable", detail: "Gmail did not answer." })),
      ),
    )
    .mockResolvedValueOnce(AsyncResult.success({}));
  await using screen = await render(
    <ConnectorApprovalCard
      environmentId={environmentId}
      item={approval()}
      visibility="local"
      canAnswer
    />,
  );
  await expect
    .element(screen.getByRole("heading", { name: "Gmail wants to send a draft" }))
    .toBeVisible();
  await expect.element(screen.getByText("sam@example.com")).toBeVisible();

  await screen.getByRole("button", { name: "Always send without asking" }).click();
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Gmail did not answer.");
  await screen.getByRole("button", { name: "Don't send" }).click();

  expect(state.answer.mock.calls.map(([call]) => call)).toEqual([
    {
      environmentId,
      input: { threadId: "thread-1", turnItemId: "approval-1", answer: "always" },
    },
    {
      environmentId,
      input: { threadId: "thread-1", turnItemId: "approval-1", answer: "decline" },
    },
  ]);
  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
});

it("words other actions as allowing, and leaves one quiet line once answered", async () => {
  state.answer.mockReset();
  await using screen = await render(
    <ConnectorApprovalCard
      environmentId={environmentId}
      item={approval({ action: "delete the thread", details: [], preview: undefined })}
      visibility="local"
      canAnswer
    />,
  );
  await expect.element(screen.getByRole("button", { name: "Always allow" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Don't allow" })).toBeVisible();

  await screen.rerender(
    <ConnectorApprovalCard
      environmentId={environmentId}
      item={approval({ approvalStatus: "allowed", remembered: true })}
      visibility="local"
      canAnswer
    />,
  );
  await expect
    .element(screen.getByText("Gmail · send a draft · Allowed, won't ask again"))
    .toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Send" })).not.toBeInTheDocument();
});
