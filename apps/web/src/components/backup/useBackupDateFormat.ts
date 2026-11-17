import type { TimestampFormat } from "@codenine/contracts/settings";

import { useNowMinute } from "../../hooks/useNowMinute";
import { usePrimarySettings } from "../../hooks/useSettings";
import { formatMonthDay, formatShortTimestamp } from "../../timestampFormat";
import type { BackupDateFormat } from "./backup.logic";

function backupDateFormat(timestampFormat: TimestampFormat): BackupDateFormat {
  return {
    time: (date) => formatShortTimestamp(date.toISOString(), timestampFormat),
    date: formatMonthDay,
  };
}

/** Dates and times in the clock format the user picked in Settings. */
export function useBackupDateFormat(): BackupDateFormat {
  return backupDateFormat(usePrimarySettings((settings) => settings.timestampFormat));
}

/** The time now, a minute at a time, for labels such as "2 hours ago", with the date format. */
export function useBackupClock() {
  const nowMinute = useNowMinute();
  const format = useBackupDateFormat();
  return { nowMs: Date.parse(`${nowMinute}Z`), format };
}
