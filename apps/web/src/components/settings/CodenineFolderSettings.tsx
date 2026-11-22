import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@codenine/contracts";
import { Link } from "@tanstack/react-router";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { codenineFolderPath } from "../../lib/codenineFolder";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { OpenFolderButton } from "../OpenFolderButton";
import { Button, InlineButton } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/** Where Codenine keeps everything on this computer, with a way to open it. */
export function CodenineFolderSettings() {
  const environmentId = usePrimaryEnvironmentId();
  return environmentId === null ? null : <CodenineFolderSection environmentId={environmentId} />;
}

function CodenineFolderSection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const folder = config?.codenineHome;
  if (config === null || folder === undefined) return null;

  return (
    <SettingsSection id="storage" title="Storage">
      <SettingsRow
        {...searchableSetting("codenine-folder")}
        description={
          <>
            Your workspaces, accounts, skills, settings and logs, all in one folder.{" "}
            <InlineButton render={<Link to="/settings/backup" />}>Backup settings</InlineButton>
            <span className="mt-1 block font-mono break-all text-foreground">
              {codenineFolderPath(config)}
            </span>
          </>
        }
        control={
          <div className="flex shrink-0 items-center gap-2">
            <OpenFolderButton
              environmentId={environmentId}
              path={folder}
              failureTitle="Could not open the Codenine folder"
            >
              Open
            </OpenFolderButton>
            <Button variant="outline" size="sm" onClick={() => copyToClipboard(folder, undefined)}>
              {isCopied ? "Copied" : "Copy path"}
            </Button>
          </div>
        }
      />
    </SettingsSection>
  );
}
