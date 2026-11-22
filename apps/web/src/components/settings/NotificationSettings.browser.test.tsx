import { DEFAULT_CLIENT_SETTINGS, DEFAULT_SERVER_SETTINGS } from "@codenine/contracts/settings";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import {
  __setClientSettingsForTests,
  getClientSettings,
  persistClientSettingsPatch,
  useMergedSettings,
} from "../../hooks/useSettings";
import { NotificationSettings } from "./NotificationSettings";

// The rows only touch device settings, so the scope reads and writes this device's store.
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: ((selector: never) =>
    useMergedSettings(DEFAULT_SERVER_SETTINGS, selector)) as never,
  useUpdateScopedSettings: (() => (patch: object) =>
    void persistClientSettingsPatch(patch, async () => undefined)) as never,
}));

describe("NotificationSettings", () => {
  it.each([
    {
      stored: "off",
      permission: "default",
      answer: "granted",
      expected: "notifications-and-sound",
    },
    { stored: "notifications", permission: "denied", answer: "denied", expected: "sound" },
  ] as const)(
    "stored $stored, browser answers $answer after Sound turns on: $expected",
    async ({ stored, permission, answer, expected }) => {
      using stack = new DisposableStack();
      const previousSettings = getClientSettings();
      stack.defer(() => __setClientSettingsForTests(previousSettings));
      __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, notificationMode: stored });
      const permissionGetter = vi.spyOn(Notification, "permission", "get");
      stack.defer(() => permissionGetter.mockRestore());
      permissionGetter.mockReturnValue(permission);
      let answerPrompt = (_: NotificationPermission) => {};
      const requestPermission = vi.spyOn(Notification, "requestPermission").mockReturnValue(
        new Promise((resolve) => {
          answerPrompt = resolve;
        }),
      );
      stack.defer(() => requestPermission.mockRestore());
      await using screen = await render(<NotificationSettings />);

      await userEvent.click(screen.getByRole("switch", { name: "System notifications" }));
      await userEvent.click(screen.getByRole("switch", { name: "Sound" }));
      answerPrompt(answer);

      await vi.waitFor(() =>
        expect(screen.getByRole("switch", { name: "System notifications" })).toBeEnabled(),
      );
      expect(getClientSettings().notificationMode).toBe(expected);
    },
  );
});
