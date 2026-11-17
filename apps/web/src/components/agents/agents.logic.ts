import {
  type AgentAbilities,
  type AgentConnector,
  type AgentDefinition,
  type AgentEffort,
  type AgentModel,
  type AgentModelStatus,
  AgentName,
  type ConnectionSnapshot,
  type ConnectorApprovalMode,
  type ConnectorRisk,
  DEFAULT_CONNECTOR_APPROVALS,
  type ProviderInstanceId,
  type ServerProviderModelInfo,
  type SkillName,
  skillTitle,
} from "@codenine/contracts";
import * as Schema from "effect/Schema";

import { skillNameFromTitle } from "../skills/skills.logic";

const isAgentName = Schema.is(AgentName);
const AGENT_NAME_MAX_LENGTH = 64;
const AGENT_TITLE_MAX_LENGTH = 80;
const AGENT_DESCRIPTION_MAX_LENGTH = 1024;

export const AGENT_EFFORTS = [
  "low",
  "medium",
  "high",
  "max",
] as const satisfies ReadonlyArray<AgentEffort>;

export const AGENT_EFFORT_LABELS: Record<AgentEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  max: "Max",
};

export const NO_ABILITIES: AgentAbilities = {
  readFiles: false,
  editFiles: false,
  runCommands: false,
  searchWeb: false,
};

export interface AgentDraft {
  readonly title: string;
  readonly description: string;
  readonly instructions: string;
  readonly model: AgentModel | null;
  readonly skills: ReadonlyArray<SkillName>;
  readonly connectors: ReadonlyArray<AgentConnector>;
  readonly abilities: AgentAbilities;
}

export interface AgentDraftErrors {
  readonly title?: string;
  readonly description?: string;
  readonly model?: string;
}

/** The agent to save, named after its title as skills are, or why the form cannot be saved yet. */
export function checkAgentDraft(
  draft: AgentDraft,
  /** Whether the chosen model can use tools; null when its account does not say. */
  modelUsesTools: boolean | null,
):
  | { readonly agent: AgentDefinition; readonly errors?: undefined }
  | { readonly errors: AgentDraftErrors } {
  const name = skillNameFromTitle(draft.title);
  const title = draft.title.trim();
  const description = draft.description.trim();
  const errors: { title?: string; description?: string; model?: string } = {};
  if (title === "") errors.title = "Give the agent a name.";
  else if (name === "") errors.title = "Use letters or numbers in the name.";
  else if (title.length > AGENT_TITLE_MAX_LENGTH || name.length > AGENT_NAME_MAX_LENGTH) {
    errors.title = "Use a shorter name.";
  }
  if (description === "") errors.description = "Say what to use it for.";
  else if (description.length > AGENT_DESCRIPTION_MAX_LENGTH) {
    errors.description = `Keep this under ${AGENT_DESCRIPTION_MAX_LENGTH.toLocaleString("en-US")} characters.`;
  }
  if (draft.model !== null && draft.connectors.length > 0 && modelUsesTools === false) {
    errors.model =
      "This model can't use connectors. Choose another model or remove the connectors.";
  }
  if (Object.keys(errors).length > 0 || !isAgentName(name)) return { errors };
  return {
    agent: {
      name,
      title,
      description,
      instructions: draft.instructions,
      model: draft.model,
      skills: [...draft.skills],
      connectors: [...draft.connectors],
      abilities: draft.abilities,
    },
  };
}

/** A title for a copy that no other agent's name takes: "Gmail copy", then "Gmail copy 2". */
export function copyTitle(title: string, takenNames: ReadonlyArray<string>): string {
  const taken = new Set(takenNames);
  for (let number = 1; ; number++) {
    const candidate = number === 1 ? `${title} copy` : `${title} copy ${number}`;
    if (!taken.has(skillNameFromTitle(candidate))) return candidate;
  }
}

/** Why an agent cannot run on its model: the full warning, and a short reason for pickers. */
export function agentModelProblem(
  status: AgentModelStatus,
): { readonly warning: string; readonly short: string } | null {
  switch (status) {
    case "ready":
      return null;
    case "no-model":
      return {
        warning: "It has no model yet. Choose one to use this agent.",
        short: "Choose a model to use it",
      };
    case "account-off":
      return {
        warning: "Its account is turned off. Choose another model to use this agent.",
        short: "Its account is off. Choose another model to use it",
      };
    case "model-missing":
      return {
        warning: "Its account no longer offers this model. Choose another model to use this agent.",
        short: "Its model is gone. Choose another to use it",
      };
  }
}

/** "Claude Sonnet 5.5 · Medium effort · Claude (Work)"; effort is null when the model has none. */
export function agentModelLine(
  model: {
    readonly name: string;
    readonly effort: AgentEffort | null;
    readonly account: string | null;
  } | null,
): string {
  if (model === null) return "None yet";
  return [
    model.name,
    model.effort === null ? null : `${AGENT_EFFORT_LABELS[model.effort]} effort`,
    model.account,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

const RISKS = ["read", "change", "irreversible"] as const satisfies ReadonlyArray<ConnectorRisk>;
const ASKS_BEFORE: Record<ConnectorRisk, string> = {
  read: "reading",
  change: "changes",
  irreversible: "what can't be undone",
};

type ConnectionApprovals = Pick<ConnectionSnapshot, "id" | "name" | "approvals">;

/** What the agent does for one group of a connector's actions: its own choice, else the connector's. */
export function effectiveApproval(
  connector: AgentConnector,
  connection: Pick<ConnectionSnapshot, "approvals"> | null,
  risk: ConnectorRisk,
): ConnectorApprovalMode {
  return (
    connector.approvals[risk] ?? connection?.approvals[risk] ?? DEFAULT_CONNECTOR_APPROVALS[risk]
  );
}

function joinWords(words: ReadonlyArray<string>): string {
  return words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/**
 * "Gmail, GitHub · asks before changes": each connector, saying what asks first unless it is only
 * what can't be undone, as connectors start out.
 */
export function agentConnectorsLine(
  connectors: ReadonlyArray<AgentConnector>,
  connections: ReadonlyArray<ConnectionApprovals>,
): string {
  if (connectors.length === 0) return "None";
  return connectors
    .map((connector) => {
      const connection = connections.find((candidate) => candidate.id === connector.id) ?? null;
      if (connection === null) return `${connector.id} (not connected)`;
      const asks = RISKS.filter((risk) => effectiveApproval(connector, connection, risk) === "ask");
      if (asks.length === 1 && asks[0] === "irreversible") return connection.name;
      const note =
        asks.length === 0
          ? "never asks"
          : asks.length === RISKS.length
            ? "asks before every action"
            : `asks before ${joinWords(asks.map((risk) => ASKS_BEFORE[risk]))}`;
      return `${connection.name} · ${note}`;
    })
    .join(", ");
}

export function agentSkillsLine(skills: ReadonlyArray<SkillName>): string {
  return skills.length === 0 ? "None" : skills.map(skillTitle).join(", ");
}

/** "Reads files and runs commands", or that it may do nothing on the computer. */
export function agentAbilitiesLine(abilities: AgentAbilities): string {
  const parts = [
    abilities.readFiles ? "reads files" : null,
    abilities.editFiles ? "edits files" : null,
    abilities.runCommands ? "runs commands" : null,
    abilities.searchWeb ? "searches the web" : null,
  ].filter((part) => part !== null);
  if (parts.length === 0) return "Nothing: no files, commands or web";
  const line = joinWords(parts);
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/** The chat header's line: "Uses Gmail · Write clear emails, Our email tone". */
export function agentUsesLine(
  connectorNames: ReadonlyArray<string>,
  skills: ReadonlyArray<SkillName>,
): string {
  const parts = [connectorNames.join(", "), skills.map(skillTitle).join(", ")].filter(
    (part) => part !== "",
  );
  return parts.length === 0 ? "No connectors or skills" : `Uses ${parts.join(" · ")}`;
}

const priceFormat = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 3,
});

/** "Uses tools · Reads images · $3 / $15 per million tokens", from what the account says. */
export function modelInfoLine(info: ServerProviderModelInfo | null | undefined): string {
  if (info == null) return "";
  return [
    info.usesTools === true ? "Uses tools" : info.usesTools === false ? "Can't use tools" : null,
    info.readsImages === true ? "Reads images" : null,
    info.price === null
      ? null
      : `${priceFormat.format(info.price.input)} / ${priceFormat.format(info.price.output)} per million tokens`,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

export interface AgentModelAccount {
  readonly instanceId: ProviderInstanceId;
  readonly name: string;
  readonly models: ReadonlyArray<{
    readonly slug: string;
    readonly name: string;
    readonly info: ServerProviderModelInfo | null;
  }>;
}

export interface AgentModelChoice {
  readonly instanceId: ProviderInstanceId;
  readonly slug: string;
  readonly name: string;
  readonly info: ServerProviderModelInfo | null;
  readonly disabledReason: string | null;
}

/**
 * The model picker's accounts and their models that match the search. With connectors, a model
 * its account says can't use tools stays listed but can't be chosen.
 */
export function agentModelGroups(
  accounts: ReadonlyArray<AgentModelAccount>,
  options: { readonly query: string; readonly needsTools: boolean },
): Array<{
  readonly instanceId: ProviderInstanceId;
  readonly name: string;
  readonly models: AgentModelChoice[];
}> {
  const query = options.query.trim().toLowerCase();
  return accounts.flatMap((account) => {
    const accountMatches = account.name.toLowerCase().includes(query);
    const models = account.models
      .filter(
        (model) =>
          query === "" ||
          accountMatches ||
          model.name.toLowerCase().includes(query) ||
          model.slug.toLowerCase().includes(query),
      )
      .map((model) => ({
        instanceId: account.instanceId,
        slug: model.slug,
        name: model.name,
        info: model.info,
        disabledReason:
          options.needsTools && model.info?.usesTools === false
            ? "Can't use connectors, which this agent needs"
            : null,
      }));
    return models.length === 0
      ? []
      : [{ instanceId: account.instanceId, name: account.name, models }];
  });
}
