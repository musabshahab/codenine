import { createFileRoute } from "@tanstack/react-router";

import { BackupSettingsPanel } from "../components/backup/BackupSettings";

export const Route = createFileRoute("/_chat/settings/backup")({
  component: BackupSettingsPanel,
});
