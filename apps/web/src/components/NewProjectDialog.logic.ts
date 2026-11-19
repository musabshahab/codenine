import type { EnvironmentConnectionPhase } from "@codenine/client-runtime/connection";
import {
  canCreateProjectInEnvironment,
  getAddProjectInitialQuery,
  getCloneDestinationPath,
  getCloneDirectoryName,
  getCloneDirectoryPath,
  getNewProjectPathPreview,
  githubIncompleteOwnerRepositoryMessage,
  normalizePastedCloneUrl,
  type NewProjectPublishTarget,
} from "@codenine/client-runtime/operations/projects";
import {
  inferProjectTitleFromPath,
  isUnsupportedWindowsProjectPath,
} from "@codenine/client-runtime/state/projects";
import {
  type EnvironmentId,
  type EnvironmentMachineKind,
  type ExecutionEnvironmentPlatform,
  type ModelSelection,
  type ProjectIconOverride,
  type ProjectId,
  resolveEnvironmentMachineKind,
  type ServerSettings,
  SourceControlProviderKind,
} from "@codenine/contracts";
import { isAbsolutePath, normalizeProjectPathForDispatch } from "@codenine/shared/path";

import { resolveEnvironmentOptionLabel } from "./BranchToolbar.logic";
import { getEnvironmentBrowsePlatform } from "./CommandPalette.logic";

/** Where a new project's files come from. */
export type NewProjectSource = "empty" | "folder" | "clone";

/** What an entry point asks the New workspace dialog to start with. */
export interface NewProjectRequest {
  readonly environmentId?: EnvironmentId;
  readonly source?: NewProjectSource;
  /** Fields filled in up front, as when a restore asks to find a workspace's folder again. */
  readonly name?: string;
  readonly folderPath?: string;
  readonly repository?: string;
  /** A workspace whose folder was lost: the folder picked here becomes its folder. */
  readonly relinkProjectId?: ProjectId;
}

/** What `newProjectMachines` reads from an environment. */
export interface NewProjectMachineSource {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly entry: { readonly target: { readonly _tag: string } };
  readonly connection: { readonly phase: EnvironmentConnectionPhase };
  readonly serverConfig: {
    readonly environment: { readonly platform: ExecutionEnvironmentPlatform };
    readonly settings: Pick<
      ServerSettings,
      "addProjectBaseDirectory" | "ghqCloneLayout" | "environmentIcon"
    >;
    readonly homeDirectory?: string;
    readonly newProjectsRoot?: string;
  } | null;
}

/** A connected machine that can hold the new project. */
export interface NewProjectMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly machine: EnvironmentMachineKind;
  /** The platform path checks expect, as `getEnvironmentBrowsePlatform` names it. */
  readonly platform: string;
  readonly homeDirectory: string | null;
  /** Where empty projects go. Older servers cannot create them and leave it out. */
  readonly newProjectsRoot: string | null;
  readonly addProjectBaseDirectory: string;
  readonly ghqCloneLayout: boolean;
}

export interface NewProjectForm {
  readonly name: string;
  readonly source: NewProjectSource;
  readonly folderPath: string;
  readonly repository: string;
  /** The host an empty project is also published to, or null to keep it on the machine. */
  readonly publishTo: NewProjectPublishTarget | null;
  readonly projectIcon: ProjectIconOverride | null;
  /** The account and model picked for new chats; null keeps following the machine's default. */
  readonly modelSelection: ModelSelection | null;
}

type NewProjectSourcePlan =
  | { readonly kind: "empty"; readonly publishTo: NewProjectPublishTarget | null }
  | { readonly kind: "folder"; readonly workspaceRoot: string }
  | { readonly kind: "clone"; readonly remoteUrl: string; readonly destinationPath: string };

export type NewProjectPlan = {
  readonly environmentId: EnvironmentId;
  readonly title: string;
  readonly projectIcon: ProjectIconOverride | null;
  /** Saved as the project's default; null leaves the machine's default in charge. */
  readonly defaultModelSelection: ModelSelection | null;
} & NewProjectSourcePlan;

export interface NewProjectErrors {
  readonly name?: string;
  readonly source?: string;
  readonly folderPath?: string;
  readonly repository?: string;
}

const NAME_MAX_LENGTH = 200;
// `owner/repo` reads as GitHub, so a bare `owner/` is a GitHub name missing its repository.
const GITHUB = SourceControlProviderKind.make("github");

/** Connected machines that can hold a project, this device first. */
export function newProjectMachines(
  environments: ReadonlyArray<NewProjectMachineSource>,
): ReadonlyArray<NewProjectMachine> {
  return environments
    .flatMap((environment) => {
      const config = environment.serverConfig;
      if (config === null || !canCreateProjectInEnvironment(environment.connection.phase)) {
        return [];
      }
      const isPrimary = environment.entry.target._tag === "PrimaryConnectionTarget";
      return [
        {
          isPrimary,
          environmentId: environment.environmentId,
          label: resolveEnvironmentOptionLabel({
            isPrimary,
            environmentId: environment.environmentId,
            runtimeLabel: environment.label,
          }),
          machine: resolveEnvironmentMachineKind(config),
          platform: getEnvironmentBrowsePlatform(config.environment.platform.os),
          homeDirectory: config.homeDirectory ?? null,
          newProjectsRoot: config.newProjectsRoot ?? null,
          addProjectBaseDirectory: config.settings.addProjectBaseDirectory,
          ghqCloneLayout: config.settings.ghqCloneLayout,
        },
      ];
    })
    .toSorted((left, right) =>
      left.isPrimary === right.isPrimary
        ? left.label.localeCompare(right.label)
        : left.isPrimary
          ? -1
          : 1,
    )
    .map(({ isPrimary: _isPrimary, ...machine }) => machine);
}

/**
 * The machine the dialog starts on: the one asked for, else for an empty project the first
 * that can create one. It follows machines as they connect until the user picks one.
 */
export function defaultNewProjectMachine(
  machines: ReadonlyArray<NewProjectMachine>,
  request: NewProjectRequest,
): NewProjectMachine | null {
  const requested = machines.find((machine) => machine.environmentId === request.environmentId);
  if (requested) return requested;
  const canStartEmpty =
    (request.source ?? "empty") === "empty"
      ? machines.find((machine) => machine.newProjectsRoot !== null)
      : undefined;
  return canStartEmpty ?? machines[0] ?? null;
}

/** A machine that cannot create empty projects starts from a folder instead. */
export function resolveNewProjectSource(
  source: NewProjectSource,
  machine: Pick<NewProjectMachine, "newProjectsRoot"> | null,
): NewProjectSource {
  return source === "empty" && machine?.newProjectsRoot === null ? "folder" : source;
}

export function abbreviateHomePath(path: string, homeDirectory: string | null): string {
  const home = homeDirectory?.replace(/[\\/]+$/, "") ?? "";
  if (home.length === 0) return path;
  if (path === home) return "~";
  const rest = path.slice(home.length);
  return path.startsWith(home) && /^[\\/]/.test(rest) ? `~${rest}` : path;
}

const HOME_PATH = /^~(?:$|[\\/])/;

/** Expands `~` with the machine's home, so the path can match a project's stored root. */
function expandHomePath(path: string, homeDirectory: string | null): string {
  const home = homeDirectory?.replace(/[\\/]+$/, "") ?? "";
  return home.length > 0 && HOME_PATH.test(path) ? `${home}${path.slice(1)}` : path;
}

/** The folder an empty project gets, or the folder it goes in while it has no name. */
export function emptyProjectFolder(
  machine: Pick<NewProjectMachine, "newProjectsRoot" | "homeDirectory">,
  name: string,
): string | null {
  if (machine.newProjectsRoot === null) return null;
  const folder =
    name.trim().length === 0
      ? machine.newProjectsRoot
      : getNewProjectPathPreview(machine.newProjectsRoot, name);
  return abbreviateHomePath(folder, machine.homeDirectory);
}

/** Clones go in the projects folder, or below "Add workspace starts in" in a ghq layout. */
function cloneBaseFolder(
  machine: Pick<
    NewProjectMachine,
    "newProjectsRoot" | "addProjectBaseDirectory" | "ghqCloneLayout"
  >,
): string {
  return machine.ghqCloneLayout || machine.newProjectsRoot === null
    ? getAddProjectInitialQuery(machine.addProjectBaseDirectory)
    : machine.newProjectsRoot;
}

/** The folder clones go in, as the dialog names it. */
export function cloneFolderLabel(
  machine: Pick<
    NewProjectMachine,
    "newProjectsRoot" | "addProjectBaseDirectory" | "ghqCloneLayout" | "homeDirectory"
  >,
): string {
  return abbreviateHomePath(
    normalizeProjectPathForDispatch(cloneBaseFolder(machine)),
    machine.homeDirectory,
  );
}

/** The name a folder or repository suggests while the user has not typed one. */
export function suggestedProjectName(source: "folder" | "clone", value: string): string {
  const trimmed = value.trim();
  if (source === "clone") {
    // Until a repository follows the owner, `acme` and `acme/` name nothing yet.
    return /[/:\\][^/:\\]/.test(trimmed)
      ? getCloneDirectoryName(normalizePastedCloneUrl(trimmed))
      : "";
  }
  const name = trimmed.length === 0 ? "" : inferProjectTitleFromPath(trimmed);
  // A home or drive root names no project.
  return /^(?:~|[a-zA-Z]:)?[\\/]*$/.test(name) ? "" : name;
}

function folderPathError(path: string, platform: string): string | null {
  if (path.length === 0) return "Enter the folder's path.";
  if (isUnsupportedWindowsProjectPath(path, platform)) {
    return "Windows paths only work on a Windows machine.";
  }
  return HOME_PATH.test(path) || isAbsolutePath(path)
    ? null
    : "Enter a full path, like ~/code/app.";
}

function planSource(
  form: NewProjectForm,
  machine: NewProjectMachine,
):
  | { readonly errors: null; readonly source: NewProjectSourcePlan }
  | { readonly errors: NewProjectErrors } {
  switch (form.source) {
    case "empty":
      return machine.newProjectsRoot === null
        ? { errors: { source: `${machine.label} cannot start empty workspaces yet.` } }
        : { errors: null, source: { kind: "empty", publishTo: form.publishTo } };
    case "folder": {
      const path = form.folderPath.trim();
      const error = folderPathError(path, machine.platform);
      return error !== null
        ? { errors: { folderPath: error } }
        : {
            errors: null,
            source: {
              kind: "folder",
              workspaceRoot: normalizeProjectPathForDispatch(
                expandHomePath(path, machine.homeDirectory),
              ),
            },
          };
    }
    case "clone": {
      const repository = form.repository.trim();
      if (repository.length === 0) return { errors: { repository: "Enter a repository." } };
      const incomplete = githubIncompleteOwnerRepositoryMessage(GITHUB, repository);
      if (incomplete !== null) return { errors: { repository: incomplete } };
      const remoteUrl = normalizePastedCloneUrl(repository);
      const folder = getCloneDirectoryPath(remoteUrl, machine.ghqCloneLayout);
      return folder.length === 0
        ? { errors: { repository: "Enter owner/repo or a Git URL." } }
        : {
            errors: null,
            source: {
              kind: "clone",
              remoteUrl,
              destinationPath: getCloneDestinationPath(cloneBaseFolder(machine), folder),
            },
          };
    }
  }
}

/** Turns the dialog's fields into what to create, or the errors to show beside them. */
export function planNewProject(
  form: NewProjectForm,
  machine: NewProjectMachine,
):
  | { readonly ok: true; readonly plan: NewProjectPlan }
  | { readonly ok: false; readonly errors: NewProjectErrors } {
  const title = form.name.trim();
  const nameError =
    title.length === 0
      ? "Enter a name."
      : title.length > NAME_MAX_LENGTH
        ? `Use ${NAME_MAX_LENGTH} characters or fewer.`
        : null;
  const planned = planSource(form, machine);
  if (nameError !== null || planned.errors !== null) {
    return {
      ok: false,
      errors: { ...(nameError === null ? {} : { name: nameError }), ...planned.errors },
    };
  }
  return {
    ok: true,
    plan: {
      environmentId: machine.environmentId,
      title,
      projectIcon: form.projectIcon,
      defaultModelSelection: form.modelSelection,
      ...planned.source,
    },
  };
}
