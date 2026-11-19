import { scopeProjectRef, scopeThreadRef } from "@codenine/client-runtime/environment";
import {
  findExistingAddProject,
  getNewProjectRepository,
  type NewProjectPublishTarget,
} from "@codenine/client-runtime/operations/projects";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@codenine/client-runtime/state/runtime";
import type { EnvironmentProject } from "@codenine/client-runtime/state/shell";
import { getLatestThreadForProject } from "@codenine/client-runtime/state/thread-sort";
import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ScopedProjectRef,
} from "@codenine/contracts";
import { useNavigate } from "@tanstack/react-router";

import type { NewProjectPlan } from "~/components/NewProjectDialog.logic";
import { isSidebarHiddenThread } from "~/components/Sidebar.logic";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useComposerDraftStore } from "~/composerDraftStore";
import { newProjectId } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readProjects, waitForProject } from "~/state/entities";
import { projectEnvironment } from "~/state/projects";
import { serverEnvironment } from "~/state/server";
import { readEnvironmentScope } from "~/state/session";
import { sourceControlEnvironment } from "~/state/sourceControl";
import { environmentThreadShells } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { suggestAppAccessForRemote } from "../components/sourceControlAppAccessToast";
import { useNewThreadHandler } from "./useHandleNewThread";
import { reportProjectFailure } from "./useProjectGroupUpdate";
import { getClientSettings } from "./useSettings";

/** A failure's `message` is null when the request was interrupted and there is nothing to show. */
export type NewProjectResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string | null };

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "An error occurred.";
}

function failure(result: AtomCommandResult<unknown, unknown>): NewProjectResult {
  return {
    ok: false,
    message:
      result._tag === "Failure" && !isAtomCommandInterrupted(result)
        ? errorMessage(squashAtomCommandFailure(result))
        : null,
  };
}

/**
 * Creates a project from a plan and opens a new chat in it. A folder that already is a
 * project opens that project instead, unarchived. `onCreated` runs once the project exists and
 * before its chat opens, so a dialog can close first; a failure before then is returned.
 */
export function useNewProject() {
  const createNew = useAtomCommand(projectEnvironment.createNew, { reportFailure: false });
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const updateProject = useOrchestrationCommand(projectEnvironment.update, {
    reportFailure: false,
  });
  const startProjectClone = useAtomCommand(sourceControlEnvironment.startProjectClone, {
    reportFailure: false,
  });
  const publishRepository = useAtomCommand(sourceControlEnvironment.publishRepository, {
    reportFailure: false,
  });
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const handleNewThread = useNewThreadHandler();
  const navigate = useNavigate();

  const publishNewRepository = async (input: {
    readonly environmentId: EnvironmentId;
    readonly workspaceRoot: string;
    readonly target: NewProjectPublishTarget;
  }) => {
    const { label } = input.target.definition;
    const result = await publishRepository({
      environmentId: input.environmentId,
      input: {
        cwd: input.workspaceRoot,
        provider: input.target.definition.kind,
        repository: getNewProjectRepository(input.target, input.workspaceRoot),
        visibility: "private",
      },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Could not create the ${label} repository`,
            description: `${errorMessage(squashAtomCommandFailure(result))} Use Publish Repository in the Git menu to try again.`,
          }),
        );
      }
      return;
    }
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: `Published to ${label}`,
        description: result.value.repository.nameWithOwner,
      }),
    );
    void suggestAppAccessForRemote(input.environmentId, result.value.remoteUrl);
  };

  const saveDefaultModel = async (projectRef: ScopedProjectRef, selection: ModelSelection) => {
    if (!readEnvironmentScope(projectRef.environmentId, AuthSettingsWriteScope)) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Default agent not saved",
          description: "This connection cannot change settings, so new chats keep the default.",
        }),
      );
      return;
    }
    const result = await updateSettings({
      environmentId: projectRef.environmentId,
      input: {
        patch: {
          projectSettingsOverrides: {
            [projectRef.projectId]: { defaultModelSelection: selection },
          },
        },
      },
    });
    reportProjectFailure("Default agent not saved", result);
  };

  // The project exists either way, so these only report their own failures.
  const applyChoices = (projectRef: ScopedProjectRef, plan: NewProjectPlan) => {
    if (plan.projectIcon !== null) {
      void updateProject({
        environmentId: projectRef.environmentId,
        input: { projectId: projectRef.projectId, projectIcon: plan.projectIcon },
      }).then((result) => reportProjectFailure("Workspace icon not saved", result));
    }
    if (plan.defaultModelSelection !== null) {
      void saveDefaultModel(projectRef, plan.defaultModelSelection);
    }
  };

  const openNewChat = async (
    projectRef: ScopedProjectRef,
    modelSelection: ModelSelection | null,
  ) => {
    const opened = await settlePromise(() => handleNewThread(projectRef));
    if (opened._tag === "Failure") {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to open workspace",
          description: errorMessage(squashAtomCommandFailure(opened)),
        }),
      );
      return;
    }
    // The saved default reaches this client after the chat opens, so the chat gets the pick here.
    if (modelSelection !== null && opened.value !== null) {
      useComposerDraftStore.getState().setModelSelection(opened.value.draftId, modelSelection, {
        replaceOptions: true,
      });
    }
  };

  const openExisting = async (
    existing: EnvironmentProject,
    onOpen: (() => void) | undefined,
  ): Promise<NewProjectResult> => {
    // Adding an archived project's folder again brings the project back.
    if (existing.archivedAt != null) {
      void updateProject({
        environmentId: existing.environmentId,
        input: { projectId: existing.id, archived: false },
      }).then((result) => reportProjectFailure("Failed to unarchive workspace", result));
    }
    const threads = appAtomRegistry
      .get(environmentThreadShells.visibleThreadShellsAtom)
      .filter(
        (thread) =>
          thread.environmentId === existing.environmentId && !isSidebarHiddenThread(thread),
      );
    const latestThread = getLatestThreadForProject(
      threads,
      existing.id,
      getClientSettings().sidebarThreadSortOrder,
    );
    if (latestThread && latestThread.settledOverride !== "settled") {
      onOpen?.();
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(latestThread.environmentId, latestThread.id)),
      });
      return { ok: true };
    }
    const opened = await settlePromise(() =>
      handleNewThread(scopeProjectRef(existing.environmentId, existing.id)),
    );
    if (opened._tag === "Failure") {
      return { ok: false, message: errorMessage(squashAtomCommandFailure(opened)) };
    }
    onOpen?.();
    return { ok: true };
  };

  const createEmpty = async (
    plan: Extract<NewProjectPlan, { kind: "empty" }>,
    onCreated: (() => void) | undefined,
  ): Promise<NewProjectResult> => {
    const result = await createNew({
      environmentId: plan.environmentId,
      input: { name: plan.title },
    });
    if (result._tag === "Failure") return failure(result);
    const { projectId, workspaceRoot, commitError } = result.value;
    const projectRef = scopeProjectRef(plan.environmentId, projectId);
    onCreated?.();
    toastManager.add(
      stackedThreadToast(
        commitError === undefined
          ? { type: "success", title: `Created ${plan.title}`, description: workspaceRoot }
          : {
              type: "warning",
              title: `Created ${plan.title} without a first commit`,
              description: `${commitError} The workspace is in ${workspaceRoot}.`,
            },
      ),
    );
    if (plan.publishTo) {
      void publishNewRepository({
        environmentId: plan.environmentId,
        workspaceRoot,
        target: plan.publishTo,
      });
    }
    applyChoices(projectRef, plan);
    // Wait for the stored project path; drafts use it as their key.
    const project = await waitForProject(projectRef).catch((error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to open workspace",
          description: `${errorMessage(error)} It will appear in the sidebar once this client catches up.`,
        }),
      );
      return null;
    });
    if (project !== null) await openNewChat(projectRef, plan.defaultModelSelection);
    return { ok: true };
  };

  const addFolder = async (
    plan: Extract<NewProjectPlan, { kind: "folder" }>,
    onCreated: (() => void) | undefined,
    relinkProjectId: ProjectId | undefined,
  ): Promise<NewProjectResult> => {
    const existing = findExistingAddProject({
      projects: readProjects(),
      environmentId: plan.environmentId,
      path: plan.workspaceRoot,
    });
    const lost =
      relinkProjectId === undefined
        ? undefined
        : readProjects().find(
            (project) =>
              project.environmentId === plan.environmentId && project.id === relinkProjectId,
          );
    // A workspace that lost its folder takes the new one, so its chats come along.
    if (lost !== undefined && existing?.id !== lost.id) {
      if (existing !== null) {
        return { ok: false, message: `${existing.title} already uses that folder.` };
      }
      if (!readEnvironmentScope(plan.environmentId, AuthOrchestrationOperateScope)) {
        return { ok: false, message: "This connection cannot change workspaces." };
      }
      const moved = await updateProject({
        environmentId: plan.environmentId,
        input: { projectId: lost.id, title: plan.title, workspaceRoot: plan.workspaceRoot },
      });
      if (moved._tag === "Failure") return failure(moved);
      return openExisting(lost, onCreated);
    }
    if (existing !== null) return openExisting(existing, onCreated);
    if (!readEnvironmentScope(plan.environmentId, AuthOrchestrationOperateScope)) {
      return { ok: false, message: "This connection cannot add workspaces." };
    }
    const projectId = newProjectId();
    const result = await createProject({
      environmentId: plan.environmentId,
      input: {
        projectId,
        title: plan.title,
        workspaceRoot: plan.workspaceRoot,
        createWorkspaceRootIfMissing: true,
        defaultModelSelection: null,
      },
    });
    if (result._tag === "Failure") return failure(result);
    const projectRef = scopeProjectRef(plan.environmentId, projectId);
    onCreated?.();
    applyChoices(projectRef, plan);
    await openNewChat(projectRef, plan.defaultModelSelection);
    return { ok: true };
  };

  const cloneRepository = async (
    plan: Extract<NewProjectPlan, { kind: "clone" }>,
    onCreated: (() => void) | undefined,
  ): Promise<NewProjectResult> => {
    if (
      !readEnvironmentScope(plan.environmentId, AuthSourceControlWriteScope) ||
      !readEnvironmentScope(plan.environmentId, AuthOrchestrationOperateScope)
    ) {
      return {
        ok: false,
        message: "This connection needs permission to write source control and add workspaces.",
      };
    }
    const projectId = newProjectId();
    const result = await startProjectClone({
      environmentId: plan.environmentId,
      input: {
        projectId,
        title: plan.title,
        createdAt: new Date().toISOString(),
        remoteUrl: plan.remoteUrl,
        destinationPath: plan.destinationPath,
      },
    });
    if (result._tag === "Failure") return failure(result);
    const projectRef = scopeProjectRef(plan.environmentId, projectId);
    onCreated?.();
    void suggestAppAccessForRemote(plan.environmentId, plan.remoteUrl);
    applyChoices(projectRef, plan);
    // The project opens while it clones; its composer holds sends until the files are in place.
    await waitForProject(projectRef, 3_000).catch(() => null);
    await openNewChat(projectRef, plan.defaultModelSelection);
    return { ok: true };
  };

  return (
    plan: NewProjectPlan,
    options?: { readonly onCreated?: () => void; readonly relinkProjectId?: ProjectId },
  ): Promise<NewProjectResult> => {
    switch (plan.kind) {
      case "empty":
        return createEmpty(plan, options?.onCreated);
      case "folder":
        return addFolder(plan, options?.onCreated, options?.relinkProjectId);
      case "clone":
        return cloneRepository(plan, options?.onCreated);
    }
  };
}
