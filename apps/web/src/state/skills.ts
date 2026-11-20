import { createSkillsEnvironmentAtoms } from "@codenine/client-runtime/state/skills";

import { connectionAtomRuntime } from "../connection/runtime";

export const skillsEnvironment = createSkillsEnvironmentAtoms(connectionAtomRuntime);
