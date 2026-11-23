import * as Schema from "effect/Schema";
import { GitPreparePullRequestThreadInput, GitRunStackedActionInput } from "./git.ts";
import {
  AuthEnvironmentMaintainScope,
  AuthFilesystemWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS } from "./rpc.ts";

/** Incremental client enforcement; the server still authorizes every request. */
export const CLIENT_GUARDED_RPC_SCOPES = {
  [WS_METHODS.providerAuthRemoveMethod]: AuthProvidersManageScope,
  [WS_METHODS.serverRunStorageCleanup]: AuthSettingsWriteScope,
  // Restarts the server, as an update does.
  [WS_METHODS.serverReclaimDatabaseSpace]: AuthEnvironmentMaintainScope,
  // Backups hold every saved key and sign-in, and a restore replaces all data and restarts.
  [WS_METHODS.backupCreate]: AuthEnvironmentMaintainScope,
  [WS_METHODS.backupSetPassword]: AuthEnvironmentMaintainScope,
  [WS_METHODS.backupSuggestFolders]: AuthEnvironmentMaintainScope,
  [WS_METHODS.backupList]: AuthEnvironmentMaintainScope,
  [WS_METHODS.backupDelete]: AuthEnvironmentMaintainScope,
  [WS_METHODS.backupDownloadUrl]: AuthEnvironmentMaintainScope,
  [WS_METHODS.backupInspect]: AuthEnvironmentMaintainScope,
  [WS_METHODS.backupRestore]: AuthEnvironmentMaintainScope,
  [WS_METHODS.backupUndoRestore]: AuthEnvironmentMaintainScope,
  [WS_METHODS.backupDismissRestoreReport]: AuthEnvironmentMaintainScope,
  // Connectors hold sign-ins and decide what agents can reach, as saved tokens in Settings do.
  [WS_METHODS.connectorsConnect]: AuthSettingsWriteScope,
  [WS_METHODS.connectorsSignIn]: AuthSettingsWriteScope,
  [WS_METHODS.connectorsUpdate]: AuthSettingsWriteScope,
  [WS_METHODS.connectorsDisconnect]: AuthSettingsWriteScope,
  [WS_METHODS.connectorsTest]: AuthSettingsWriteScope,
  // Skills steer every agent that uses them.
  [WS_METHODS.skillsSave]: AuthSettingsWriteScope,
  [WS_METHODS.skillsDelete]: AuthSettingsWriteScope,
  [WS_METHODS.skillsAddFromLibrary]: AuthSettingsWriteScope,
  [WS_METHODS.skillsImport]: AuthSettingsWriteScope,
  // Agents decide what a chat may reach, as connectors and skills do.
  [WS_METHODS.agentsSave]: AuthSettingsWriteScope,
  [WS_METHODS.agentsDelete]: AuthSettingsWriteScope,
  // A workflow runs agents unattended, on a schedule, so making one is a settings change.
  [WS_METHODS.workflowsSave]: AuthSettingsWriteScope,
  [WS_METHODS.workflowsDelete]: AuthSettingsWriteScope,
  [WS_METHODS.workflowsSetEnabled]: AuthSettingsWriteScope,
  [WS_METHODS.workflowsRun]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverCheckOtlpEndpoint]: AuthSettingsWriteScope,
  // Listing models spends the stored API key, so only those who can choose a model may.
  [WS_METHODS.serverListTextGeneratorModels]: AuthSettingsWriteScope,
  [WS_METHODS.serverRefreshProviders]: AuthOrchestrationReadScope,
  [WS_METHODS.projectsCreateFromThread]: AuthOrchestrationOperateScope,
  // Rewrites or deletes a workspace file, as a save does.
  [WS_METHODS.projectsRevertFileChange]: AuthFilesystemWriteScope,
  [WS_METHODS.projectsRestoreFileVersion]: AuthFilesystemWriteScope,
  [WS_METHODS.documentsEditSpreadsheet]: AuthFilesystemWriteScope,
  // Changes a PDF, and is the only way a signature is placed on one.
  [WS_METHODS.documentsEditPdf]: AuthFilesystemWriteScope,
  [WS_METHODS.documentsSaveReplyFile]: AuthFilesystemWriteScope,
  // Making an image spends the user's money with a provider, as running an agent does.
  [WS_METHODS.mediaGenerateImage]: AuthOrchestrationOperateScope,
  [WS_METHODS.mediaEditImage]: AuthOrchestrationOperateScope,
  [WS_METHODS.mediaCancelJob]: AuthOrchestrationOperateScope,
  [WS_METHODS.documentsCopyAttachment]: AuthFilesystemWriteScope,
  [WS_METHODS.sourceControlCloneRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlPublishRepository]: AuthSourceControlWriteScope,
  // Signing in replaces the server's GitHub credential, as saving a token in Settings does.
  [WS_METHODS.sourceControlSignInStart]: AuthSettingsWriteScope,
  [WS_METHODS.sourceControlSignInWait]: AuthSettingsWriteScope,
  [WS_METHODS.sourceControlSignInCancel]: AuthSettingsWriteScope,
  [WS_METHODS.projectCloneStart]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneCancel]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneRetry]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPull]: AuthSourceControlWriteScope,
  [WS_METHODS.gitRunStackedAction]: AuthSourceControlWriteScope,
  [WS_METHODS.gitPreparePullRequestThread]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsRemoveWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsSwitchRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsInit]: AuthSourceControlWriteScope,

  [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: AuthOrchestrationOperateScope,
  // Force stop kills agent processes, as Stop on a terminal does.
  [ORCHESTRATION_V2_WS_METHODS.forceStopThread]: AuthOrchestrationOperateScope,
} as const;
export type ClientGuardedRpcTag = keyof typeof CLIENT_GUARDED_RPC_SCOPES;

const decodePrepareThread = Schema.decodeUnknownSync(GitPreparePullRequestThreadInput);
const decodeStackedAction = Schema.decodeUnknownSync(GitRunStackedActionInput);

export function clientRpcRequiredScopes(
  method: string,
  input: unknown,
): readonly AuthEnvironmentScope[] {
  if (method === WS_METHODS.gitPreparePullRequestThread && input !== undefined) {
    const payload = decodePrepareThread(input);
    if (payload.mode === "worktree" && payload.threadId !== undefined)
      return [AuthSourceControlWriteScope, AuthOrchestrationOperateScope];
  }
  if (method === WS_METHODS.gitRunStackedAction && input !== undefined) {
    const payload = decodeStackedAction(input);
    if (
      payload.threadId !== undefined &&
      (payload.action === "create_pr" || payload.action === "commit_push_pr")
    )
      return [AuthSourceControlWriteScope, AuthOrchestrationReadScope];
  }
  return Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)
    ? [CLIENT_GUARDED_RPC_SCOPES[method as ClientGuardedRpcTag]]
    : [];
}
