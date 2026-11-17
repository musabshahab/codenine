import type {
  EnvironmentId,
  ProjectId,
  ServerProviderSkill,
  SkillSummary,
} from "@codenine/contracts";

import { useEnvironmentQuery } from "../../state/query";
import { skillsEnvironment } from "../../state/skills";
import { composerSkills } from "./chatChoices.logic";

const NO_SKILLS: ReadonlyArray<SkillSummary> = [];

/** Codenine and workspace skills for a chat; empty while they load or when the server has none. */
export function useCodenineSkills(environmentId: EnvironmentId, projectId: ProjectId | null) {
  const list = useEnvironmentQuery(
    skillsEnvironment.list({ environmentId, input: projectId === null ? {} : { projectId } }),
  );
  return list.data?.skills ?? NO_SKILLS;
}

/** The skills `$` and `/` offer: Codenine's first, then the provider's own of other names. */
export function useComposerSkills(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
  providerSkills: ReadonlyArray<ServerProviderSkill>,
): ReadonlyArray<ServerProviderSkill> {
  const codenine = useCodenineSkills(environmentId, projectId);
  return composerSkills(codenine, providerSkills);
}
