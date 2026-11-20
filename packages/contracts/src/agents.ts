import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ConnectionId, ConnectorApprovalMode } from "./connectors.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { SkillName } from "./skills.ts";

/** An agent's id and folder name: lower case letters, digits and single hyphens. */
export const AgentName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  Schema.isMaxLength(64),
);
export type AgentName = typeof AgentName.Type;

/** Codenine's effort levels; each account's own levels are matched to these. */
export const AgentEffort = Schema.Literals(["low", "medium", "high", "max"]);
export type AgentEffort = typeof AgentEffort.Type;

export const AgentModel = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  effort: AgentEffort,
});
export type AgentModel = typeof AgentModel.Type;

/** A connector the agent uses; a group left out follows the connector's own choice. */
export const AgentConnector = Schema.Struct({
  id: ConnectionId,
  approvals: Schema.Struct({
    read: Schema.optionalKey(ConnectorApprovalMode),
    change: Schema.optionalKey(ConnectorApprovalMode),
    irreversible: Schema.optionalKey(ConnectorApprovalMode),
  }),
});
export type AgentConnector = typeof AgentConnector.Type;

/** What the agent may do on the computer it runs on, besides its connectors and skills. */
export const AgentAbilities = Schema.Struct({
  readFiles: Schema.Boolean,
  editFiles: Schema.Boolean,
  runCommands: Schema.Boolean,
  searchWeb: Schema.Boolean,
});
export type AgentAbilities = typeof AgentAbilities.Type;

export const AgentAbility = Schema.Literals(["readFiles", "editFiles", "runCommands", "searchWeb"]);
export type AgentAbility = typeof AgentAbility.Type;

export const AgentTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(80));
export const AgentDescription = TrimmedNonEmptyString.check(Schema.isMaxLength(1024));

/** Every event on a lead carries its plan or draft, so a suggested agent's instructions stay short. */
export const AGENT_SUGGESTION_INSTRUCTIONS_MAX_CHARS = 2_000;

/**
 * What a lead suggests for a part of the work none of the user's agents fits. The user creates
 * the agent from it, or gives the part to an agent they have; Codenine never creates one.
 */
export const AgentSuggestion = Schema.Struct({
  title: AgentTitle,
  description: AgentDescription,
  instructions: Schema.String.check(Schema.isMaxLength(AGENT_SUGGESTION_INSTRUCTIONS_MAX_CHARS)),
  /** Connections the agent would use. */
  connectors: Schema.Array(ConnectionId),
});
export type AgentSuggestion = typeof AgentSuggestion.Type;

export const AgentDefinition = Schema.Struct({
  name: AgentName,
  /** As the user typed it, such as "Code reviewer". */
  title: AgentTitle,
  /** "Use it for…": what chats and lead agents read to decide when it fits. */
  description: AgentDescription,
  instructions: Schema.String,
  /** Null until one is chosen. */
  model: Schema.NullOr(AgentModel),
  skills: Schema.Array(SkillName),
  connectors: Schema.Array(AgentConnector),
  abilities: AgentAbilities,
});
export type AgentDefinition = typeof AgentDefinition.Type;

/**
 * - `ready`: it can run on its model.
 * - `no-model`: none chosen yet.
 * - `account-off`: its account is turned off or gone.
 * - `model-missing`: its account no longer offers the model.
 */
export const AgentModelStatus = Schema.Literals([
  "ready",
  "no-model",
  "account-off",
  "model-missing",
]);
export type AgentModelStatus = typeof AgentModelStatus.Type;

const AgentFileFields = {
  /** The agent's folder on the server's computer. */
  path: Schema.String,
  updatedAt: IsoDateTime,
  modelStatus: AgentModelStatus,
};

export const AgentDetail = Schema.Struct({ ...AgentDefinition.fields, ...AgentFileFields });
export type AgentDetail = typeof AgentDetail.Type;

/** What the Agents page and pickers show; the instructions stay on the agent's own page. */
export const AgentSummary = AgentDetail.mapFields(
  ({ instructions: _instructions, ...rest }) => rest,
);
export type AgentSummary = typeof AgentSummary.Type;

export const AgentsEmptyInput = Schema.Struct({});
export const AgentsEmptyResult = Schema.Struct({});

export const AgentsListResult = Schema.Struct({ agents: Schema.Array(AgentSummary) });

export const AgentNameInput = Schema.Struct({ name: AgentName });

export const AgentSaveInput = Schema.Struct({
  agent: AgentDefinition,
  /** Editing: the agent's current name. Leave out to create; taken names fail. */
  previousName: Schema.optionalKey(AgentName),
});
export type AgentSaveInput = typeof AgentSaveInput.Type;

export class AgentError extends Schema.TaggedError<AgentError>()("AgentError", {
  reason: Schema.Literals(["not-found", "invalid", "exists", "failed"]),
  /** Shown to the user as is. */
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
