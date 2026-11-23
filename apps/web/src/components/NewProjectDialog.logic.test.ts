import { sourceControlClients } from "@codenine/client-runtime/source-control-clients";
import { EnvironmentId, ProviderInstanceId } from "@codenine/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  abbreviateHomePath,
  cloneFolderLabel,
  defaultNewProjectMachine,
  emptyProjectFolder,
  type NewProjectForm,
  type NewProjectMachine,
  type NewProjectMachineSource,
  newProjectMachines,
  planNewProject,
  resolveNewProjectSource,
  suggestedProjectName,
} from "./NewProjectDialog.logic";

const LOCAL = EnvironmentId.make("local");
const REMOTE = EnvironmentId.make("remote");

const machine = (overrides: Partial<NewProjectMachine> = {}): NewProjectMachine => ({
  environmentId: LOCAL,
  label: "This device",
  machine: "laptop",
  platform: "Linux",
  homeDirectory: "/home/me",
  newProjectsRoot: "/home/me/.codenine/projects",
  addProjectBaseDirectory: "",
  ghqCloneLayout: false,
  ...overrides,
});

const form = (overrides: Partial<NewProjectForm> = {}): NewProjectForm => ({
  name: "Pinball Stats",
  source: "empty",
  folderPath: "",
  repository: "",
  publishTo: null,
  workspaceKind: "code",
  projectIcon: null,
  modelSelection: null,
  ...overrides,
});

describe("newProjectMachines", () => {
  const source = (
    environmentId: EnvironmentId,
    label: string,
    overrides: Partial<NewProjectMachineSource> = {},
  ): NewProjectMachineSource => ({
    environmentId,
    label,
    entry: { target: { _tag: "BearerConnectionTarget" } },
    connection: { phase: "connected" },
    serverConfig: {
      environment: { platform: { os: "windows", arch: "x64" } },
      settings: {
        addProjectBaseDirectory: "D:\\code",
        ghqCloneLayout: true,
        environmentIcon: null,
      },
      homeDirectory: "C:\\Users\\me",
    },
    ...overrides,
  });

  it("lists connected machines this device first, as the dialog reads them", () => {
    const machines = newProjectMachines([
      source(EnvironmentId.make("zeta"), "Zeta"),
      source(EnvironmentId.make("offline"), "Offline", { connection: { phase: "reconnecting" } }),
      source(EnvironmentId.make("loading"), "Loading", { serverConfig: null }),
      source(LOCAL, "Local", { entry: { target: { _tag: "PrimaryConnectionTarget" } } }),
      source(REMOTE, "Build box"),
    ]);
    expect(machines.map((entry) => entry.label)).toEqual(["This device", "Build box", "Zeta"]);
    expect(machines[1]).toEqual({
      environmentId: REMOTE,
      label: "Build box",
      machine: "server",
      platform: "Win32",
      homeDirectory: "C:\\Users\\me",
      newProjectsRoot: null,
      addProjectBaseDirectory: "D:\\code",
      ghqCloneLayout: true,
    });
  });
});

describe("defaultNewProjectMachine", () => {
  const olderServer = machine({ newProjectsRoot: null });
  const current = machine({ environmentId: REMOTE });

  it.each([
    { request: { environmentId: REMOTE, source: "folder" as const }, expected: REMOTE },
    { request: {}, expected: REMOTE },
    { request: { source: "empty" as const }, expected: REMOTE },
    { request: { source: "folder" as const }, expected: LOCAL },
    { request: { environmentId: EnvironmentId.make("gone") }, expected: REMOTE },
  ])("starts $request on $expected", ({ request, expected }) => {
    expect(defaultNewProjectMachine([olderServer, current], request)?.environmentId).toBe(expected);
  });

  it("falls back to any machine, and to none", () => {
    expect(defaultNewProjectMachine([olderServer], {})).toBe(olderServer);
    expect(defaultNewProjectMachine([], {})).toBeNull();
  });

  it("starts from a folder where empty projects are not supported", () => {
    expect(resolveNewProjectSource("empty", olderServer)).toBe("folder");
    expect(resolveNewProjectSource("clone", olderServer)).toBe("clone");
    expect(resolveNewProjectSource("empty", current)).toBe("empty");
  });
});

describe("planNewProject", () => {
  const github = sourceControlClients.get(undefined);

  it("creates an empty project with its name, type, publish target, icon and model", () => {
    const publishTo = { definition: github, owner: "octocat" };
    const projectIcon = { kind: "emoji", emoji: "🎯" } as const;
    const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
    expect(
      planNewProject(
        form({
          name: "  Pinball Stats  ",
          workspaceKind: "work",
          publishTo,
          projectIcon,
          modelSelection,
        }),
        machine(),
      ),
    ).toEqual({
      ok: true,
      plan: {
        kind: "empty",
        environmentId: LOCAL,
        title: "Pinball Stats",
        workspaceKind: "work",
        publishTo,
        projectIcon,
        defaultModelSelection: modelSelection,
      },
    });
  });

  it("adds a folder by its full path on the machine", () => {
    expect(
      planNewProject(form({ source: "folder", folderPath: " ~/code/app/ " }), machine()),
    ).toMatchObject({ ok: true, plan: { kind: "folder", workspaceRoot: "/home/me/code/app" } });
    expect(
      planNewProject(
        form({ source: "folder", folderPath: "~\\code\\app" }),
        machine({ platform: "Win32", homeDirectory: "C:\\Users\\me" }),
      ),
    ).toMatchObject({ ok: true, plan: { workspaceRoot: "C:\\Users\\me\\code\\app" } });
  });

  it.each([
    { remote: "acme/rocket", url: "https://github.com/acme/rocket.git", folder: "rocket" },
    { remote: "git@example.com:team/api.git", url: "git@example.com:team/api.git", folder: "api" },
  ])("clones $remote into the projects folder", ({ remote, url, folder }) => {
    expect(planNewProject(form({ source: "clone", repository: remote }), machine())).toMatchObject({
      ok: true,
      plan: {
        kind: "clone",
        remoteUrl: url,
        destinationPath: `/home/me/.codenine/projects/${folder}`,
      },
    });
  });

  it("clones into host folders below the start folder when asked", () => {
    expect(
      planNewProject(
        form({ source: "clone", repository: "acme/rocket" }),
        machine({ ghqCloneLayout: true, addProjectBaseDirectory: "~/ghq" }),
      ),
    ).toMatchObject({ plan: { destinationPath: "~/ghq/github.com/acme/rocket" } });
  });

  it.each([
    { field: "name", form: form({ name: "  " }), message: "Enter a name." },
    {
      field: "name",
      form: form({ name: "x".repeat(201) }),
      message: "Use 200 characters or fewer.",
    },
    {
      field: "folderPath",
      form: form({ source: "folder", folderPath: " " }),
      message: "Enter the folder's path.",
    },
    {
      field: "folderPath",
      form: form({ source: "folder", folderPath: "C:\\code\\app" }),
      message: "Windows paths only work on a Windows machine.",
    },
    {
      field: "folderPath",
      form: form({ source: "folder", folderPath: "../app" }),
      message: "Enter a full path, like ~/code/app.",
    },
    {
      field: "repository",
      form: form({ source: "clone", repository: "" }),
      message: "Enter a repository.",
    },
    {
      field: "repository",
      form: form({ source: "clone", repository: "acme/" }),
      message: "Enter the full owner/repository name.",
    },
    {
      field: "repository",
      form: form({ source: "clone", repository: "https://github.com" }),
      message: "Enter owner/repo or a Git URL.",
    },
  ])("says what is wrong with $field: $message", ({ field, form: input, message }) => {
    expect(planNewProject(input, machine())).toEqual({ ok: false, errors: { [field]: message } });
  });

  it("reports every invalid field at once", () => {
    expect(
      planNewProject(form({ name: "", source: "empty" }), machine({ newProjectsRoot: null })),
    ).toEqual({
      ok: false,
      errors: {
        name: "Enter a name.",
        source: "This device cannot start empty workspaces yet.",
      },
    });
  });
});

describe("dialog text", () => {
  it.each([
    { source: "folder" as const, value: " ~/code/my-app/ ", name: "my-app" },
    { source: "folder" as const, value: "~", name: "" },
    { source: "folder" as const, value: "/", name: "" },
    { source: "folder" as const, value: "C:\\", name: "" },
    { source: "clone" as const, value: "git@github.com:acme/rocket.git", name: "rocket" },
    { source: "clone" as const, value: "acme/", name: "" },
  ])("names a project after $source $value", ({ source, value, name }) => {
    expect(suggestedProjectName(source, value)).toBe(name);
  });

  it.each([
    { path: "/home/me", home: "/home/me/", shown: "~" },
    { path: "/home/me/code", home: "/home/me", shown: "~/code" },
    { path: "/home/meow/code", home: "/home/me", shown: "/home/meow/code" },
    { path: "C:\\Users\\me\\code", home: "C:\\Users\\me", shown: "~\\code" },
    { path: "/srv/code", home: null, shown: "/srv/code" },
  ])("shows $path as $shown", ({ path, home, shown }) => {
    expect(abbreviateHomePath(path, home)).toBe(shown);
  });

  it("names the folders new projects go in", () => {
    expect(emptyProjectFolder(machine(), " Pinball Stats ")).toBe(
      "~/.codenine/projects/pinball-stats",
    );
    expect(emptyProjectFolder(machine(), "")).toBe("~/.codenine/projects");
    expect(emptyProjectFolder(machine({ newProjectsRoot: null }), "App")).toBeNull();
    expect(cloneFolderLabel(machine())).toBe("~/.codenine/projects");
    expect(cloneFolderLabel(machine({ newProjectsRoot: null }))).toBe("~");
    expect(
      cloneFolderLabel(machine({ ghqCloneLayout: true, addProjectBaseDirectory: "/srv/" })),
    ).toBe("/srv");
  });
});
