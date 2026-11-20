import { describe, expect, it } from "vite-plus/test";

import {
  draftHeroExamples,
  sendsComposerRequest,
  teamToggleAvailable,
  workflowToggleAvailable,
} from "./composerTeam.logic";

describe("teamToggleAvailable and workflowToggleAvailable", () => {
  const top = {
    parent: null,
    sideChat: false,
    inTeam: false,
    hasAgent: false,
    inProject: true,
  } as const;
  it.each([
    { name: "a draft or top-level thread", ...top, team: true, workflow: true },
    { name: "a fork", ...top, parent: "fork", team: true, workflow: true },
    { name: "a subagent", ...top, parent: "subagent", team: false, workflow: false },
    { name: "a side chat", ...top, parent: "fork", sideChat: true, team: false, workflow: false },
    { name: "a lead or team agent", ...top, inTeam: true, team: false, workflow: false },
    { name: "an agent's chat", ...top, hasAgent: true, team: false, workflow: false },
    { name: "a chat without a project", ...top, inProject: false, team: false, workflow: true },
  ] as const)(
    "offers Team on $name: $team, and Workflow: $workflow",
    ({ parent, sideChat, inTeam, hasAgent, inProject, team, workflow }) => {
      const lineage = { relationshipToParent: parent, sideChat };
      expect(teamToggleAvailable({ lineage, inTeam, hasAgent, inProject })).toBe(team);
      expect(workflowToggleAvailable({ lineage, inTeam, hasAgent })).toBe(workflow);
    },
  );
});

describe("sendsComposerRequest", () => {
  it.each([
    { requested: true, prompt: "Add sign-in with tests", sends: true },
    { requested: true, prompt: "  /compact", sends: false },
    { requested: false, prompt: "Add sign-in with tests", sends: false },
  ])("$prompt with the toggle $requested sends a request: $sends", (input) => {
    expect(sendsComposerRequest(input)).toBe(input.sends);
  });
});

describe("draftHeroExamples", () => {
  const start = { hasProject: true, composerEmpty: true, workflowRequested: false };
  it.each([
    { ...start, teamAvailable: true, teams: [true, false, false] },
    { ...start, teamAvailable: false, teams: [false, false] },
    { ...start, composerEmpty: false, teamAvailable: true, teams: [] },
    { ...start, hasProject: false, teamAvailable: true, teams: [] },
    { ...start, workflowRequested: true, teamAvailable: true, teams: [] },
  ])(
    "project $hasProject, empty $composerEmpty, Workflow $workflowRequested, Team $teamAvailable: $teams",
    ({ teams, ...input }) => {
      expect(draftHeroExamples(input).map((example) => example.team)).toEqual(teams);
    },
  );
});
