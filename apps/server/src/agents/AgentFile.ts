import {
  type AgentAbilities,
  type AgentConnector,
  type AgentDefinition,
  AgentModel,
  type AgentName,
  ConnectionId,
  ConnectorApprovalMode,
  SkillName,
} from "@codenine/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Document } from "yaml";

import { instructionsOf, parseFrontmatterMap, splitFrontmatter } from "../skills/SkillFile.ts";

export const AGENTS_FOLDER = "agents";
export const AGENT_FILE = "AGENT.md";
const TITLE_MAX_LENGTH = 80;
const DESCRIPTION_MAX_LENGTH = 1024;
const APPROVAL_GROUPS = ["read", "change", "irreversible"] as const;

/** What an agent may do when its file says nothing or something unreadable about it. */
export const NO_ABILITIES: AgentAbilities = {
  readFiles: false,
  editFiles: false,
  runCommands: false,
  searchWeb: false,
};

const decodeModel = Schema.decodeUnknownOption(AgentModel);
const isSkillName = Schema.is(SkillName);
const isConnectionId = Schema.is(ConnectionId);
const isApprovalMode = Schema.is(ConnectorApprovalMode);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown, maxLength: number) => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().slice(0, maxLength).trimEnd();
  return trimmed === "" ? undefined : trimmed;
};

const connectorsOf = (value: unknown): ReadonlyArray<AgentConnector> => {
  if (!Array.isArray(value)) return [];
  const connectors = new Map<ConnectionId, AgentConnector>();
  for (const entry of value) {
    if (!isRecord(entry) || !isConnectionId(entry.id) || connectors.has(entry.id)) continue;
    const written = isRecord(entry.approvals) ? entry.approvals : {};
    const approvals: {
      -readonly [Group in keyof AgentConnector["approvals"]]: ConnectorApprovalMode;
    } = {};
    const unreadable = entry.approvals !== undefined && !isRecord(entry.approvals);
    for (const group of APPROVAL_GROUPS) {
      const mode = written[group];
      if (isApprovalMode(mode)) approvals[group] = mode;
      // A choice that is written but unreadable asks: left out, the connection's could allow it.
      else if (mode !== undefined || unreadable) approvals[group] = "ask";
    }
    connectors.set(entry.id, { id: entry.id, approvals });
  }
  return [...connectors.values()];
};

/**
 * Reads an AGENT.md as far as it can, keeping to the safe side: whatever is missing or unreadable
 * gives the agent less, never more. Undefined when the file has no frontmatter map at all.
 */
export function parseAgentFile(name: AgentName, contents: string): AgentDefinition | undefined {
  const { yaml, body } = splitFrontmatter(contents);
  const document = yaml === undefined ? undefined : parseFrontmatterMap(yaml);
  if (document === undefined) return undefined;
  const frontmatter: unknown = document.toJS();
  const fields = isRecord(frontmatter) ? frontmatter : {};
  const abilities = isRecord(fields.abilities) ? fields.abilities : {};
  const title = text(fields.title, TITLE_MAX_LENGTH) ?? name;
  return {
    name,
    title,
    description: text(fields.description, DESCRIPTION_MAX_LENGTH) ?? title,
    instructions: instructionsOf(body),
    model: Option.getOrNull(decodeModel(fields.model)),
    skills: Array.isArray(fields.skills) ? [...new Set(fields.skills.filter(isSkillName))] : [],
    connectors: connectorsOf(fields.connectors),
    abilities: {
      readFiles: abilities.readFiles === true,
      editFiles: abilities.editFiles === true,
      runCommands: abilities.runCommands === true,
      searchWeb: abilities.searchWeb === true,
      ...(abilities.makeImages === true ? { makeImages: true } : {}),
    },
  };
}

/** Writes AGENT.md, keeping any other frontmatter key of `existing`. */
export function renderAgentFile(agent: AgentDefinition, existing?: string): string {
  const previous = existing === undefined ? undefined : splitFrontmatter(existing).yaml;
  const document =
    (previous === undefined ? undefined : parseFrontmatterMap(previous)) ?? new Document({});
  document.set("name", agent.name);
  document.set("title", agent.title);
  document.set("description", agent.description);
  if (agent.model === null) document.delete("model");
  else {
    document.set("model", {
      instanceId: agent.model.instanceId,
      model: agent.model.model,
      effort: agent.model.effort,
    });
  }
  document.set("skills", [...agent.skills]);
  document.set(
    "connectors",
    agent.connectors.map((connector) => ({
      id: connector.id,
      approvals: { ...connector.approvals },
    })),
  );
  document.set("abilities", { ...agent.abilities });
  const instructions = agent.instructions.trim();
  // An unbounded line width keeps each value on one line, as SKILL.md does.
  return `---\n${document.toString({ lineWidth: 0 })}---\n${instructions === "" ? "" : `\n${instructions}\n`}`;
}
