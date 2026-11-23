import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@codenine/contracts";
import { planProjectRemoval } from "@codenine/client-runtime/state/projects";

import { isPersonalWorkspace, projectGroupKind } from "./ProjectSettingsPanel.logic";

it.each([
  [["work"], "work"],
  [["work", "work"], "work"],
  [["work", "code"], null],
  [["code", "code", "create"], null],
] as const)("reads the shared type of checkouts %j as %s", (kinds, expected) => {
  expect(projectGroupKind(kinds)).toBe(expected);
});

it.each([
  [[], false],
  [[{ isScratch: true as const }], true],
  [[{ isScratch: true as const }, { isScratch: true as const }], true],
  [[{ isScratch: true as const }, {}], false],
  [[{}], false],
])("treats %j as the Personal workspace: %s", (members, expected) => {
  expect(isPersonalWorkspace(members)).toBe(expected);
});

describe("project removal confirmation", () => {
  const local = {
    id: ProjectId.make("shared-id"),
    environmentId: EnvironmentId.make("local"),
    title: "Repo",
    workspaceRoot: "/work/repo",
    environmentLabel: "Local",
  };
  const remote = {
    ...local,
    environmentId: EnvironmentId.make("remote"),
    environmentLabel: "Remote",
  };

  const parentId = ThreadId.make("parent");
  const listed = { rootThreadId: parentId, parentThreadId: null, relationshipToParent: null };
  const child = { rootThreadId: parentId, parentThreadId: parentId };

  it("limits a checkout's thread count to its listed threads in that environment and project", () => {
    const plan = planProjectRemoval({
      members: [local],
      groupMemberCount: 2,
      hasOtherMembers: false,
      displayName: "Repo",
      threads: [
        { environmentId: local.environmentId, projectId: local.id, lineage: listed },
        {
          environmentId: local.environmentId,
          projectId: local.id,
          lineage: { ...child, relationshipToParent: "subagent" },
        },
        {
          environmentId: local.environmentId,
          projectId: local.id,
          lineage: { ...child, relationshipToParent: "fork", sideChat: true },
        },
        { environmentId: remote.environmentId, projectId: remote.id, lineage: listed },
      ],
    });
    expect(plan.projectThreads).toHaveLength(3);
    expect(plan.confirmationMessage).toBe(
      'Remove checkout "Repo" and its 1 chat?\nPath: /work/repo\nEnvironment: Local\nAny archived chats are deleted from Codenine.\nOther checkouts of this workspace are unaffected.\nThis can\'t be undone.',
    );
    const folderPlan = planProjectRemoval({
      members: [local],
      groupMemberCount: 1,
      hasOtherMembers: false,
      displayName: "Repo",
      threads: [{ environmentId: local.environmentId, projectId: local.id, lineage: listed }],
      deleteFolder: true,
    });
    expect(folderPlan.confirmationMessage).toBe(
      'Delete workspace "Repo" and its folder?\nFolder: /work/repo\nEnvironment: Local\nThis permanently deletes the folder and everything in it, including uncommitted work and the worktrees Codenine made for its chats.\nIts 1 chat and any archived chats are deleted from Codenine.\nIts workspace settings and actions are deleted too.\nThis can\'t be undone.',
    );
  });

  it("keeps an environment-filtered group scoped to its selected checkout", () => {
    const plan = planProjectRemoval({
      members: [remote],
      groupMemberCount: 1,
      hasOtherMembers: true,
      displayName: "Repo",
      threads: [],
    });
    expect(plan.targetKind).toBe("checkout");
    expect(plan.confirmationMessage).toContain("Environment: Remote");
    expect(plan.confirmationMessage).toContain("Other checkouts of this workspace are unaffected.");
    expect(plan.confirmationMessage).not.toContain("workspace settings");
    expect(plan.confirmationMessage).toContain("Any archived chats are deleted from Codenine.");
  });

  // regression: #21409 project-wide removal must count every checkout's threads and keep files
  it("states the full group count and preserves files when removing a project everywhere", () => {
    const plan = planProjectRemoval({
      members: [local, remote],
      groupMemberCount: 2,
      hasOtherMembers: false,
      displayName: "Repo",
      threads: [],
    });
    expect(plan.targetKind).toBe("workspace");
    expect(plan.confirmationMessage).toBe(
      'Remove workspace "Repo"?\nThis removes its 2 checkouts.\nAny archived chats are deleted from Codenine.\nIts workspace settings and actions are deleted too.\nFiles on disk are kept.\nThis can\'t be undone.',
    );
  });
});
