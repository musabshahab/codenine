import type { EnvironmentConnectionPhase } from "../connection/presentation.ts";
import type {
  EnvironmentId,
  ServerConfig,
  SourceControlDiscoveryResult,
  SourceControlProviderKind,
} from "@codenine/contracts";
import { cloneUrlRepositoryPath } from "@codenine/shared/cloneUrl";
import { newProjectFolderName } from "@codenine/shared/path";
import * as Option from "effect/Option";

import { ensureBrowseDirectoryPath, findProjectByPath } from "../state/projects.ts";
import type { EnvironmentProject } from "../state/models.ts";
import { sourceControlClients } from "../sourceControlClients.ts";
import type { SourceControlDefinition } from "../sourceControlClients.ts";

export type AddProjectRemoteSource = SourceControlProviderKind | "url";

export function canCreateProjectInEnvironment(
  connectionPhase: EnvironmentConnectionPhase | null | undefined,
): boolean {
  return connectionPhase === "connected";
}

export function availableScratchWorkspaceRoot(
  connectionPhase: EnvironmentConnectionPhase | null | undefined,
  serverConfig: Pick<ServerConfig, "scratchWorkspaceRoot"> | null | undefined,
): string | null {
  return canCreateProjectInEnvironment(connectionPhase)
    ? (serverConfig?.scratchWorkspaceRoot ?? null)
    : null;
}

interface AddProjectRemoteSourceReadinessEntry {
  readonly ready: boolean;
  readonly hint: string | null;
}

const REPOSITORY_SHORTHAND = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]+(?:\.git)?$/;

/**
 * The clone URL of `owner/name` on the public host of the host a repository reads as before it
 * reports one. Null when that host has no public host.
 */
function defaultHostCloneUrl(repository: string): string | null {
  const definition = sourceControlClients.get(undefined);
  if (definition.publicHost === null) return null;
  const path = repository.endsWith(".git") ? repository : `${repository}.git`;
  return definition.defaultCloneTransport === "https"
    ? `https://${definition.publicHost}/${path}`
    : `git@${definition.publicHost}:${path}`;
}

/** Owner present, repository name missing: `owner/` or `owner//`. */
const INCOMPLETE_GITHUB_OWNER_PATH = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,38})\/+$/;

const INCOMPLETE_GITHUB_OWNER_REPOSITORY_MESSAGE = "Enter the full owner/repository name.";

/**
 * Message to show when a GitHub add-project field is only `owner/`.
 * Lookup would send that to GitHub and come back as a generic failure.
 * Returns null for complete names, bare repo names, URLs, and other sources.
 */
export function githubIncompleteOwnerRepositoryMessage(
  source: AddProjectRemoteSource,
  input: string,
): string | null {
  if (source !== "github") return null;
  if (!INCOMPLETE_GITHUB_OWNER_PATH.test(input.trim())) return null;
  return INCOMPLETE_GITHUB_OWNER_REPOSITORY_MESSAGE;
}

export function normalizePastedCloneUrl(input: string): string {
  const trimmed = input.trim();
  return REPOSITORY_SHORTHAND.test(trimmed) ? (defaultHostCloneUrl(trimmed) ?? trimmed) : trimmed;
}

const READY: AddProjectRemoteSourceReadinessEntry = { ready: true, hint: null };
const UNAVAILABLE: AddProjectRemoteSourceReadinessEntry = {
  ready: false,
  hint: "Provider status unavailable. Open Source Control settings and rescan.",
};

function buildAddProjectRemoteSourceReadiness(
  discovery: SourceControlDiscoveryResult | null,
): (source: AddProjectRemoteSource) => AddProjectRemoteSourceReadinessEntry {
  const providerByKind = new Map(
    (discovery?.sourceControlProviders ?? []).map((provider) => [provider.kind, provider]),
  );
  return (source) => {
    if (source === "url") return READY;
    const provider = providerByKind.get(source);
    if (!provider) return UNAVAILABLE;
    if (provider.status !== "available") return { ready: false, hint: provider.installHint };
    if (provider.auth.status === "unauthenticated") {
      return {
        ready: false,
        hint:
          Option.getOrNull(provider.auth.detail) ??
          `${provider.label} is not authenticated. Open Source Control settings for setup guidance.`,
      };
    }
    return READY;
  };
}

export function getAddProjectInitialQuery(baseDirectory: string | null | undefined): string {
  const trimmed = baseDirectory?.trim() ?? "";
  return trimmed.length === 0 ? "~/" : ensureBrowseDirectoryPath(trimmed);
}

export function getCloneDirectoryName(repositoryOrRemoteUrl: string | null | undefined): string {
  const withoutQuery = (repositoryOrRemoteUrl ?? "").split(/[?#]/)[0]?.trim() ?? "";
  const schemeIndex = withoutQuery.indexOf("://");
  const hasHost = schemeIndex >= 0 || /^[^/\\:]+@[^/\\:]+:/.test(withoutQuery);
  const pathPart = schemeIndex >= 0 ? withoutQuery.slice(schemeIndex + "://".length) : withoutQuery;
  const segments = pathPart.split(/[/\\:]+/).filter((segment) => segment.trim().length > 0);
  if (hasHost && segments.length < 2) {
    return "";
  }

  const lastSegment = segments.at(-1)?.trim() ?? "";
  if (hasHost && segments.length === 2 && /^\d+$/.test(lastSegment)) {
    return "";
  }
  return lastSegment.endsWith(".git") ? lastSegment.slice(0, -".git".length) : lastSegment;
}

/** The folder a clone gets below its base: `<repo>`, or `<host>/<owner>/<repo>` like ghq. */
export function getCloneDirectoryPath(
  remoteUrl: string,
  ghqCloneLayout: boolean,
  repository = remoteUrl,
): string {
  return (
    (ghqCloneLayout ? cloneUrlRepositoryPath(remoteUrl) : null) ?? getCloneDirectoryName(repository)
  );
}

export function getCloneDestinationPath(
  directoryPath: string,
  directoryName: string | null | undefined,
): string {
  const name = directoryName?.trim() ?? "";
  if (name.length === 0) {
    return directoryPath;
  }
  const base = ensureBrowseDirectoryPath(directoryPath);
  return `${base}${base.endsWith("\\") ? name.replaceAll("/", "\\") : name}`;
}

export function getNewProjectPathPreview(newProjectsRoot: string, name: string): string {
  return getCloneDestinationPath(newProjectsRoot, newProjectFolderName(name));
}

export interface NewProjectPublishTarget {
  readonly definition: SourceControlDefinition;
  readonly owner: string | null;
}

export function getNewProjectPublishTargets(
  discovery: SourceControlDiscoveryResult | null,
): ReadonlyArray<NewProjectPublishTarget> {
  const readiness = buildAddProjectRemoteSourceReadiness(discovery);
  return sourceControlClients.definitions.flatMap((definition) => {
    if (!readiness(definition.kind).ready) return [];
    const provider = discovery?.sourceControlProviders.find(
      (candidate) => candidate.kind === definition.kind,
    );
    const placement = definition.newRepositoryOwner(
      provider ? Option.getOrNull(provider.auth.account) : null,
    );
    return placement === null ? [] : [{ definition, owner: placement.owner }];
  });
}

export function getNewProjectPublishTarget(
  targets: ReadonlyArray<NewProjectPublishTarget>,
  kind: SourceControlProviderKind | null,
): NewProjectPublishTarget | null {
  return targets.find((target) => target.definition.kind === kind) ?? targets[0] ?? null;
}

export function getNewProjectRepository(
  target: Pick<NewProjectPublishTarget, "owner">,
  workspaceRoot: string,
): string {
  const folderName = workspaceRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  return target.owner ? `${target.owner}/${folderName}` : folderName;
}

export function findExistingAddProject(input: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly environmentId: EnvironmentId;
  readonly path: string;
}): EnvironmentProject | null {
  return (
    findProjectByPath(
      input.projects.filter((project) => project.environmentId === input.environmentId),
      input.path,
    ) ?? null
  );
}
