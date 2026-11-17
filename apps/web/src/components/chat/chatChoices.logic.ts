import type { ThreadChoices } from "@codenine/client-runtime/operations";
import {
  type ConnectionId,
  type ConnectionSnapshot,
  type ServerProviderSkill,
  type SkillName,
  type SkillSummary,
  skillTitle,
} from "@codenine/contracts";

/** What a chat picked for itself. `connectors` absent: the ones on by default. */
export interface ChatChoices {
  readonly connectors?: ReadonlyArray<ConnectionId> | undefined;
  readonly skills?: ReadonlyArray<SkillName> | undefined;
}

type ConnectionChoice = Pick<ConnectionSnapshot, "id" | "onByDefault">;

/** The connections a chat uses, in the connections' order. */
export function activeConnections<T extends ConnectionChoice>(
  choices: ChatChoices,
  connections: ReadonlyArray<T>,
): T[] {
  const own = choices.connectors === undefined ? null : new Set(choices.connectors);
  return connections.filter((connection) =>
    own === null ? connection.onByDefault : own.has(connection.id),
  );
}

/** The chat's whole list after turning one connection on or off. */
export function toggledConnections(
  choices: ChatChoices,
  connections: ReadonlyArray<ConnectionChoice>,
  connectionId: ConnectionId,
  on: boolean,
): ConnectionId[] {
  return connections
    .filter((connection) =>
      connection.id === connectionId ? on : activeConnections(choices, [connection]).length > 0,
    )
    .map((connection) => connection.id);
}

export function withSkill(skills: ReadonlyArray<SkillName> | undefined, name: SkillName) {
  return skills?.includes(name) ? [...skills] : [...(skills ?? []), name];
}

export function withoutSkill(skills: ReadonlyArray<SkillName> | undefined, name: SkillName) {
  return (skills ?? []).filter((skill) => skill !== name);
}

/** A new chat's choices for its thread: only what the user changed, or nothing. */
export function threadChoicesFromDraft(
  choices: ChatChoices | undefined,
): ThreadChoices | undefined {
  const skills = choices?.skills ?? [];
  const connectors = choices?.connectors;
  if (connectors === undefined && skills.length === 0) return undefined;
  return {
    ...(connectors === undefined ? {} : { connectors }),
    ...(skills.length === 0 ? {} : { skills }),
  };
}

/**
 * Codenine skills as composer skills, ahead of provider skills of the same name. A workspace
 * skill wins over a Codenine one of the same name, as it does when the chat runs.
 */
export function composerSkills(
  codenine: ReadonlyArray<Pick<SkillSummary, "name" | "description" | "scope" | "path">>,
  provider: ReadonlyArray<ServerProviderSkill>,
): ReadonlyArray<ServerProviderSkill> {
  if (codenine.length === 0) return provider;
  const ordered = [
    ...codenine.filter((skill) => skill.scope === "workspace"),
    ...codenine.filter((skill) => skill.scope === "codenine"),
  ];
  const names = new Set<string>();
  const own: ServerProviderSkill[] = [];
  for (const skill of ordered) {
    if (names.has(skill.name)) continue;
    names.add(skill.name);
    const description = skill.description.trim();
    own.push({
      name: skill.name,
      path: skill.path,
      scope: skill.scope,
      enabled: true,
      displayName: skillTitle(skill.name),
      ...(description === "" ? {} : { description }),
    });
  }
  return [...own, ...provider.filter((skill) => !names.has(skill.name.trim().toLowerCase()))];
}
