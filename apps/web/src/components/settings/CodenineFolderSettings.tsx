import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@codenine/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope, type EnvironmentId } from "@codenine/contracts";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { codenineFolderPath } from "../../lib/codenineFolder";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { shellEnvironment } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/** Where Codenine keeps everything on this computer, with a way to open it. */
export function CodenineFolderSettings() {
  const environmentId = usePrimaryEnvironmentId();
  return environmentId === null ? null : <CodenineFolderSection environmentId={environmentId} />;
}

function CodenineFolderSection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const folder = config?.codenineHome;
  if (config === null || folder === undefined) return null;

  const openFolder = async () => {
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    const result = await openInEditor({
      environmentId,
      input: { cwd: folder, editor: "file-manager" },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not open the Codenine folder",
        description: error instanceof Error ? error.message : "Try again.",
      });
    }
  };

  return (
    <SettingsSection id="codenine-folder" title="Codenine folder">
      <SettingsRow
        {...searchableSetting("codenine-folder")}
        description="Your workspaces, accounts, skills, settings and logs, all in one folder. Back it up to keep your setup."
        control={
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
            <code className="min-w-0 truncate text-xs text-muted-foreground">
              {codenineFolderPath(config)}
            </code>
            <Button variant="outline" size="sm" onClick={() => copyToClipboard(folder, undefined)}>
              {isCopied ? "Copied" : "Copy path"}
            </Button>
            {config.availableEditors.includes("file-manager") ? (
              <Button size="sm" onClick={() => void openFolder()}>
                Open
              </Button>
            ) : null}
          </div>
        }
      />
    </SettingsSection>
  );
}
