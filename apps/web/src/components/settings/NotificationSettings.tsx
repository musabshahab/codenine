import { settlePromise } from "@codenine/client-runtime/state/runtime";
import { useState } from "react";

import { getClientSettings } from "../../hooks/useSettings";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  notificationModeWith,
  unlockNotificationAudio,
} from "../../threadNotifications";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

type SystemPermission = NotificationPermission | "unsupported";

function readSystemPermission(): SystemPermission {
  return typeof Notification === "undefined" || !window.isSecureContext
    ? "unsupported"
    : Notification.permission;
}

function systemNotificationsDescription(permission: SystemPermission, storedOn: boolean) {
  if (permission === "unsupported") {
    return "Needs the desktop app, or a browser on HTTPS or localhost.";
  }
  if (permission === "denied") {
    return "Blocked in browser settings. Allow notifications for this site there, then turn this on.";
  }
  if (permission === "default" && storedOn) {
    return "Turn this on again and allow notifications when your browser asks.";
  }
  return "Notify when a chat finishes, fails, or needs you while Codenine is open in the background.";
}

export function NotificationSettings() {
  const mode = useScopedSettings((settings) => settings.notificationMode);
  const inAppEnabled = useScopedSettings((settings) => settings.inAppNotificationsEnabled);
  const updateSettings = useUpdateScopedSettings();
  const [permission, setPermission] = useState(readSystemPermission);
  const [requestFailed, setRequestFailed] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const desktopStored = hasDesktopNotifications(mode);
  // Read the latest mode: the other switch can change it while the permission prompt is open.
  const switchChannel = (change: Parameters<typeof notificationModeWith>[1]) =>
    updateSettings({
      notificationMode: notificationModeWith(getClientSettings().notificationMode, change),
    });

  const turnOnSystemNotifications = async () => {
    setRequestFailed(false);
    if (readSystemPermission() === "unsupported") {
      setPermission("unsupported");
      return;
    }
    setRequesting(true);
    const result = await settlePromise(() => Notification.requestPermission());
    setRequesting(false);
    if (result._tag === "Failure") {
      setRequestFailed(true);
      return;
    }
    setPermission(result.value);
    if (result.value !== "default") switchChannel({ desktop: result.value === "granted" });
  };

  return (
    <>
      <SettingsRow
        {...searchableSetting("thread-notifications")}
        description={
          requestFailed
            ? "Notifications are unavailable in this browser."
            : systemNotificationsDescription(permission, desktopStored)
        }
        controlPlacement="inline"
        control={
          <Switch
            checked={desktopStored && permission === "granted"}
            disabled={requesting || permission === "unsupported"}
            onCheckedChange={(checked) => {
              if (checked) void turnOnSystemNotifications();
              else switchChannel({ desktop: false });
            }}
            aria-label="System notifications"
          />
        }
      />
      <SettingsRow
        {...searchableSetting("notification-sound")}
        description="Play a sound when a chat finishes, fails, or needs you while Codenine is open."
        controlPlacement="inline"
        control={
          <Switch
            checked={hasNotificationSound(mode)}
            onCheckedChange={(checked) => {
              if (checked) unlockNotificationAudio();
              switchChannel({ sound: checked });
            }}
            aria-label="Sound"
          />
        }
      />
      <SettingsRow
        {...searchableSetting("in-app-notifications")}
        description="Show a toast when another chat finishes, fails, or needs you while Codenine is in front."
        controlPlacement="inline"
        control={
          <Switch
            checked={inAppEnabled}
            onCheckedChange={(checked) => updateSettings({ inAppNotificationsEnabled: checked })}
            aria-label="In-app toasts"
          />
        }
      />
    </>
  );
}
