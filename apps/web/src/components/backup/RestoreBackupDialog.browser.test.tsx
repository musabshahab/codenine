import {
  BackupError,
  type BackupFileInfo,
  type BackupRestoreSummary,
  EnvironmentId,
} from "@codenine/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";

const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  restore: vi.fn(),
  awaitRestart: vi.fn(),
  resumeRestore: vi.fn(),
  restoreReport: { current: null as unknown },
  backups: { current: null as unknown },
}));

vi.mock(import("../../state/backup"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    backupEnvironment: {
      ...actual.backupEnvironment,
      backups: (() => mocks.backups.current) as never,
      inspect: mocks.inspect as never,
      restore: mocks.restore as never,
      awaitRestart: mocks.awaitRestart as never,
      resumeRestore: mocks.resumeRestore as never,
      restoreReport: (() => mocks.restoreReport.current) as never,
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => command) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
}));

import { openRestoreDialog, useBackupDialogStore } from "../../backupDialogStore";
import { RestoreBackupDialogHost } from "./RestoreBackupDialog";

const environmentId = EnvironmentId.make("local");
const file: BackupFileInfo = {
  path: "/Backups/studio.c9backup",
  fileName: "studio.c9backup",
  createdAt: "2026-11-16T03:00:00.000Z",
  computerName: "Studio",
  codenineVersion: "0.1.7",
  kind: "automatic",
  sizeBytes: 214 * 1024 * 1024,
};
const summary: BackupRestoreSummary = {
  file,
  contents: { workspaces: 3, chats: 128, accounts: 2, savedKeys: 3, skills: 5 },
  fromThisComputer: false,
  blockedReason: null,
};

function setup(overrides: { readonly blockedReason?: string } = {}) {
  useBackupDialogStore.setState({ restore: null, restoreOpen: false });
  mocks.backups.current = Atom.make(AsyncResult.success([file])).pipe(Atom.keepAlive);
  mocks.inspect
    .mockReset()
    .mockImplementation(async ({ input }: { input: { password: string } }) =>
      input.password === "right password"
        ? AsyncResult.success({ ...summary, blockedReason: overrides.blockedReason ?? null })
        : AsyncResult.failure(
            Cause.fail(
              new BackupError({
                reason: "wrong-password",
                detail: "That password does not open this backup.",
              }),
            ),
          ),
    );
  mocks.restore.mockReset().mockResolvedValue(AsyncResult.success({ restarting: true }));
  mocks.restoreReport.current = Atom.make(
    AsyncResult.success({ report: { restoredAt: "2026-11-01T00:00:00.000Z" } }),
  ).pipe(Atom.keepAlive);
  mocks.resumeRestore.mockReset().mockResolvedValue(AsyncResult.success({ outcome: "notBack" }));
  mocks.awaitRestart.mockReset().mockResolvedValue(AsyncResult.success(false));
}

async function unlock(password: string) {
  const field = page.getByLabelText("Backup password");
  await userEvent.clear(field);
  await userEvent.type(field, password);
  await userEvent.click(page.getByRole("button", { name: "Unlock" }));
}

async function openAndUnlock() {
  await act(() => openRestoreDialog({ environmentId }));
  await expect.element(page.getByRole("radio", { name: "Studio" })).toBeChecked();
  await userEvent.click(page.getByRole("button", { name: "Continue" }));
  await unlock("right password");
}

describe("RestoreBackupDialog", () => {
  it("keeps a wrong password on Unlock, then reviews what comes back", async () => {
    setup();
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <RestoreBackupDialogHost />
      </AppAtomRegistryProvider>,
    );
    await act(() => openRestoreDialog({ environmentId }));
    await userEvent.click(page.getByRole("button", { name: "Continue" }));

    await unlock("wrong password");
    await expect.element(page.getByText("That password does not open this backup.")).toBeVisible();
    await expect
      .element(page.getByLabelText("Backup password"))
      .toHaveAttribute("aria-invalid", "true");

    await unlock("right password");
    await expect.element(page.getByText("2 accounts and 3 saved keys")).toBeVisible();
    await expect.element(page.getByText("This backup comes from another computer")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Restore and restart" })).toBeEnabled();
  });

  it("holds a restore this Codenine cannot do", async () => {
    setup({ blockedReason: "This backup needs a newer Codenine." });
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <RestoreBackupDialogHost />
      </AppAtomRegistryProvider>,
    );
    await openAndUnlock();
    await expect.element(page.getByText("This backup needs a newer Codenine.")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Restore and restart" })).toBeDisabled();
  });

  it("waits for the restart, and offers a reload when Codenine does not come back", async () => {
    setup();
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <RestoreBackupDialogHost />
      </AppAtomRegistryProvider>,
    );
    await openAndUnlock();
    await userEvent.click(page.getByRole("button", { name: "Restore and restart" }));

    await expect.element(page.getByText("Codenine has not come back yet")).toBeVisible();
    expect(mocks.restore).toHaveBeenCalledWith({
      environmentId,
      input: { path: file.path, password: "right password" },
    });
    expect(mocks.awaitRestart).toHaveBeenCalledWith({ environmentId, input: undefined });
    await expect.element(page.getByRole("button", { name: "Reload" })).toBeVisible();
  });

  it("follows a restore whose request lost its connection, and not one the server refused", async () => {
    setup();
    mocks.restore.mockResolvedValueOnce(
      AsyncResult.failure(
        Cause.fail(new BackupError({ reason: "busy", detail: "A backup is already running." })),
      ),
    );
    mocks.restore.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new Error("socket closed"))),
    );
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <RestoreBackupDialogHost />
      </AppAtomRegistryProvider>,
    );
    await openAndUnlock();

    await userEvent.click(page.getByRole("button", { name: "Restore and restart" }));
    await expect.element(page.getByText("A backup is already running.")).toBeVisible();
    expect(mocks.resumeRestore).not.toHaveBeenCalled();

    await userEvent.click(page.getByRole("button", { name: "Restore and restart" }));
    await expect.element(page.getByText("Codenine has not come back yet")).toBeVisible();
    expect(mocks.resumeRestore).toHaveBeenCalledWith({
      environmentId,
      input: { lastRestoredAt: "2026-11-01T00:00:00.000Z" },
    });
  });
});
