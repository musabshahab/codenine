import { EnvironmentId } from "@codenine/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@codenine/contracts/settings";
import { resolvePastedPath } from "@codenine/shared/path";
import { LayersIcon } from "lucide-react";

import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { ProjectSettingsPanel } from "./ProjectSettingsPanel";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { ScopedSwitch } from "./ScopedSwitch";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { ALL_ENVIRONMENTS_VALUE, selectEnvironmentAxis } from "./settingsScopeAxis";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function ProjectsSettings() {
  const { search: value, scope, selectScope } = useSettingsScope();
  const unavailable =
    scope.kind === "unavailable" ? (
      <SettingsPageContainer>
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-muted-foreground">{scope.message}</p>
          {value.machine || value.checkout ? (
            <Button
              variant="outline"
              size="xs"
              onClick={() => selectScope(selectEnvironmentAxis(value, ALL_ENVIRONMENTS_VALUE))}
            >
              <LayersIcon />
              Show all environments
            </Button>
          ) : null}
        </div>
      </SettingsPageContainer>
    ) : null;
  // Keep the panel mounted so it can follow members when regrouping changes the project key.
  const projectScope =
    scope.kind === "project" ||
    scope.kind === "checkout" ||
    (scope.kind === "unavailable" &&
      (scope.reason === "project-missing" || scope.reason === "checkout-missing"));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {value.project && projectScope ? (
        <ProjectSettingsPanel
          projectKey={value.project}
          environmentId={value.machine ? EnvironmentId.make(value.machine) : null}
          checkoutKey={value.checkout ?? null}
          unavailable={unavailable}
        />
      ) : unavailable ? (
        unavailable
      ) : (
        <SettingsPageContainer>
          <NewWorkspacesSection />
          <SettingsScopeNotice target="project" inline>
            Choose a workspace to manage its name, icon, checkouts and actions.
          </SettingsScopeNotice>
        </SettingsPageContainer>
      )}
    </div>
  );
}

function NewWorkspacesSection() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixedAddProjectBaseDirectory = useScopedSettingsMixed(["addProjectBaseDirectory"]);
  return (
    <SettingsSection id="new-projects" title="New workspaces">
      <SettingsRow
        serverScoped
        settingKeys={["addProjectBaseDirectory"]}
        {...searchableSetting("add-project-starts-in")}
        description="The folder suggested when you add a workspace from a folder. With Clone into host folders on, clones go here too. Leave empty for your home folder."
        resetAction={
          settings.addProjectBaseDirectory !== DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory ? (
            <SettingResetButton
              label="start folder"
              onClick={() =>
                updateSettings({
                  addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
                })
              }
            />
          ) : null
        }
        control={
          <DraftInput
            size="sm"
            className="w-full sm:w-72"
            value={mixedAddProjectBaseDirectory ? "" : settings.addProjectBaseDirectory}
            onCommit={(next) => updateSettings({ addProjectBaseDirectory: next })}
            normalizeDraft={resolvePastedPath}
            placeholder={mixedAddProjectBaseDirectory ? "Mixed" : "~/"}
            spellCheck={false}
            aria-label="Start folder"
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["ghqCloneLayout"]}
        {...searchableSetting("ghq-clone-layout")}
        description="Clones go to host/owner/repo under Start folder, like ghq. When off, new workspaces clone into Codenine's workspaces folder."
        resetAction={
          settings.ghqCloneLayout !== DEFAULT_UNIFIED_SETTINGS.ghqCloneLayout ? (
            <SettingResetButton
              label="clone into host folders"
              onClick={() =>
                updateSettings({ ghqCloneLayout: DEFAULT_UNIFIED_SETTINGS.ghqCloneLayout })
              }
            />
          ) : null
        }
        controlPlacement="inline"
        control={
          <ScopedSwitch
            settingKeys={["ghqCloneLayout"]}
            checked={settings.ghqCloneLayout}
            onCheckedChange={(checked) => updateSettings({ ghqCloneLayout: Boolean(checked) })}
            aria-label="Clone into host folders"
          />
        }
      />
    </SettingsSection>
  );
}
