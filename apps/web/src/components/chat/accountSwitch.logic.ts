import type {
  AgentName,
  ModelSelection,
  ProviderInstanceId,
  ServerProvider,
} from "@codenine/contracts";

type AccountEntry = Pick<ServerProvider, "instanceId" | "driver" | "continuation">;

/** A started chat's pick of another account, held until the user chooses how to go on. */
export interface AccountSwitchRequest {
  readonly from: ProviderInstanceId;
  readonly selection: ModelSelection;
  /** The agent whose model was picked: the chat that goes on there talks to it. */
  readonly agent?: AgentName | undefined;
}

/**
 * Another account of the same agent that keeps its own conversation history, so a started chat
 * cannot simply continue there. Accounts that share a history, such as Codex CLI accounts on one
 * home, continue in place; a different agent keeps its usual handoff.
 */
export function switchesToAccountWithOwnHistory(
  current: AccountEntry | undefined,
  next: AccountEntry | undefined,
): boolean {
  if (current === undefined || next === undefined) return false;
  if (current.instanceId === next.instanceId || current.driver !== next.driver) return false;
  const from = current.continuation?.groupKey;
  const to = next.continuation?.groupKey;
  return from !== undefined && to !== undefined && from !== to;
}
