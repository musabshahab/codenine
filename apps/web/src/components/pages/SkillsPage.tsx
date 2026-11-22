import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted } from "@codenine/client-runtime/state/runtime";
import type { EnvironmentProject } from "@codenine/client-runtime/state/models";
import {
  type EnvironmentId,
  type FoundSkill,
  type LibrarySkill,
  type ProjectId,
  type SkillSummary,
  skillTitle,
} from "@codenine/contracts";
import { useNavigate } from "@tanstack/react-router";
import { SparklesIcon } from "lucide-react";
import { useState } from "react";

import { resolveDefaultProjectRef } from "../../hooks/useHandleNewThread";
import { commandErrorMessage } from "../../lib/commandError";
import { useProjects } from "../../state/entities";
import type { EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { skillsEnvironment } from "../../state/skills";
import { useAtomCommand } from "../../state/use-atom-command";
import { useUiStateStore } from "../../uiStateStore";
import { EnvironmentPagePicker } from "../settings/EnvironmentPagePicker";
import { useAccessEnvironment } from "../settings/useAccessEnvironment";
import { ImportSkillDialog } from "../skills/ImportSkillDialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { WorkspacePage } from "./WorkspacePage";

/** The workspaces a page can show skills for, and the one it shows: the asked-for one or the first. */
export function useSkillWorkspaces(
  environmentId: EnvironmentId | null,
  requested: ProjectId | null,
) {
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const workspaces = useProjects().filter(
    (project) =>
      project.environmentId === environmentId &&
      project.isScratch !== true &&
      project.archivedAt == null,
  );
  const workspace =
    workspaces.find((project) => project.id === requested) ??
    workspaces.find(
      (project) => project.id === resolveDefaultProjectRef(workspaces, projectOrder)?.projectId,
    ) ??
    null;
  return { workspaces, workspace };
}

/** Know-how agents follow: the user's skills, ones found in providers, and the library. */
export function SkillsPage(props: {
  readonly machine: EnvironmentId | null;
  readonly workspace: ProjectId | null;
}) {
  const navigate = useNavigate();
  const [selectedMachine, setSelectedMachine] = useState(props.machine);
  const [selectedWorkspace, setSelectedWorkspace] = useState(props.workspace);
  const { candidates, environment, label } = useAccessEnvironment(selectedMachine);
  const environmentId = environment?.environmentId ?? null;
  const { workspaces, workspace } = useSkillWorkspaces(environmentId, selectedWorkspace);
  const [importing, setImporting] = useState(false);
  const canSave = useAtomValue(skillsEnvironment.save.permissionAtom(environmentId));
  const connected = environment?.connection.phase === "connected";
  return (
    <WorkspacePage
      area="skills"
      title="Skills"
      actions={
        environmentId !== null && connected ? (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={!canSave}
              onClick={() => setImporting(true)}
            >
              Import
            </Button>
            <Button
              size="sm"
              disabled={!canSave}
              onClick={() =>
                void navigate({
                  to: "/skills/new",
                  search: { machine: environmentId, workspace: workspace?.id },
                })
              }
            >
              New skill
            </Button>
          </>
        ) : null
      }
    >
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-8 sm:px-6">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Know-how your agents follow for a kind of task. Every skill here works with every model,
          and lives in your Codenine folder.
        </p>
        {(candidates.length > 1 && environment !== null) || workspaces.length > 0 ? (
          <div className="-mx-3 flex flex-wrap items-center gap-y-2 sm:-mx-4">
            {candidates.length > 1 && environment !== null ? (
              <EnvironmentPagePicker
                label="Skills on"
                candidates={candidates}
                value={environment.environmentId}
                onChange={(next) => {
                  setSelectedMachine(next);
                  setSelectedWorkspace(null);
                }}
              />
            ) : null}
            {workspace !== null ? (
              <WorkspacePicker
                workspaces={workspaces}
                value={workspace}
                onChange={setSelectedWorkspace}
              />
            ) : null}
          </div>
        ) : null}
        {environment === null ? (
          <p className="text-sm text-muted-foreground">Connect an environment to see its skills.</p>
        ) : (
          <SkillsOnMachine
            key={`${environment.environmentId}:${workspace?.id ?? ""}`}
            environment={environment}
            label={label ?? environment.label}
            workspace={workspace}
            canSave={canSave}
          />
        )}
      </div>
      {importing && environmentId !== null ? (
        <ImportSkillDialog environmentId={environmentId} onClose={() => setImporting(false)} />
      ) : null}
    </WorkspacePage>
  );
}

function WorkspacePicker({
  workspaces,
  value,
  onChange,
}: {
  readonly workspaces: ReadonlyArray<EnvironmentProject>;
  readonly value: EnvironmentProject;
  readonly onChange: (projectId: ProjectId) => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 px-3 text-sm text-muted-foreground sm:px-4">
      <span className="shrink-0">Workspace skills from</span>
      <Select
        value={value.id}
        onValueChange={(next) => {
          if (next !== null) onChange(next);
        }}
      >
        <SelectTrigger size="sm" className="w-auto max-w-72" aria-label="Workspace">
          <SelectValue>
            {(selected: ProjectId) =>
              workspaces.find((project) => project.id === selected)?.title ?? null
            }
          </SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {workspaces.map((project) => (
            <SelectItem hideIndicator key={project.id} value={project.id}>
              {project.title}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

function SkillsOnMachine({
  environment,
  label,
  workspace,
  canSave,
}: {
  readonly environment: EnvironmentPresentation;
  readonly label: string;
  readonly workspace: EnvironmentProject | null;
  readonly canSave: boolean;
}) {
  const { environmentId } = environment;
  const connected = environment.connection.phase === "connected";
  const list = useEnvironmentQuery(
    connected
      ? skillsEnvironment.list({
          environmentId,
          input: workspace === null ? {} : { projectId: workspace.id },
        })
      : null,
  );
  if (!connected) {
    return <p className="text-sm text-muted-foreground">Reconnect {label} to see its skills.</p>;
  }
  if (list.data === null) {
    return list.error === null ? (
      <p className="text-sm text-muted-foreground">Loading skills…</p>
    ) : (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SparklesIcon />
          </EmptyMedia>
          <EmptyTitle>Skills could not load</EmptyTitle>
          <EmptyDescription>{list.error}</EmptyDescription>
        </EmptyHeader>
        <Button size="sm" variant="outline" onClick={list.refresh}>
          Try again
        </Button>
      </Empty>
    );
  }
  return (
    <>
      <YourSkills environmentId={environmentId} workspace={workspace} skills={list.data.skills} />
      <FoundSkills environmentId={environmentId} found={list.data.found} canSave={canSave} />
      <LibrarySkills environmentId={environmentId} library={list.data.library} canSave={canSave} />
    </>
  );
}

function YourSkills({
  environmentId,
  workspace,
  skills,
}: {
  readonly environmentId: EnvironmentId;
  readonly workspace: EnvironmentProject | null;
  readonly skills: ReadonlyArray<SkillSummary>;
}) {
  const navigate = useNavigate();
  const sorted = skills.toSorted((left, right) => left.name.localeCompare(right.name));
  return (
    <section aria-labelledby="skills-yours" className="flex flex-col gap-3">
      <h2 id="skills-yours" className="text-sm font-semibold text-foreground">
        Your skills <span className="font-normal text-muted-foreground">{skills.length}</span>
      </h2>
      {sorted.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          None yet. Write one with New skill, or add one from the library below.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-card">
          {sorted.map((skill) => (
            <li
              key={`${skill.scope}:${skill.name}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3"
            >
              <span className="flex min-w-60 flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium text-foreground">
                  {skillTitle(skill.name)}
                </span>
                {skill.description.trim() === "" ? null : (
                  <span className="text-xs text-muted-foreground">{skill.description}</span>
                )}
              </span>
              <span className="flex shrink-0 items-center gap-3">
                <Badge variant="secondary">
                  {skill.scope === "workspace"
                    ? (workspace?.title ?? "This workspace")
                    : "All workspaces"}
                </Badge>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void navigate({
                      to: "/skills/$scope/$name",
                      params: { scope: skill.scope, name: skill.name },
                      search: {
                        machine: environmentId,
                        workspace: skill.projectId ?? workspace?.id,
                      },
                    })
                  }
                >
                  Edit
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FoundSkills({
  environmentId,
  found,
  canSave,
}: {
  readonly environmentId: EnvironmentId;
  readonly found: ReadonlyArray<FoundSkill>;
  readonly canSave: boolean;
}) {
  const importSkill = useAtomCommand(skillsEnvironment.import, { reportFailure: false });
  const [busyPath, setBusyPath] = useState<string | null>(null);
  if (found.length === 0) return null;
  const add = async (skill: FoundSkill) => {
    setBusyPath(skill.path);
    const result = await importSkill({ environmentId, input: { path: skill.path } });
    setBusyPath(null);
    if (result._tag === "Success") {
      toastManager.add({ type: "success", title: `Added ${skillTitle(result.value.name)}` });
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: `Could not add ${skillTitle(skill.name)}`,
        description: commandErrorMessage(result, "Try again."),
      });
    }
  };
  return (
    <section aria-labelledby="skills-found" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id="skills-found" className="text-sm font-semibold text-foreground">
          Found in Claude Code and Codex{" "}
          <span className="font-normal text-muted-foreground">{found.length}</span>
        </h2>
        <p className="text-sm text-muted-foreground">
          These work only with the provider they came from. Add one to Codenine to use it with every
          model; the original stays where it is.
        </p>
      </div>
      <ul className="divide-y divide-border rounded-xl border border-border bg-card">
        {found.map((skill) => (
          <li
            key={`${skill.providerInstanceId}:${skill.path}`}
            className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3"
          >
            <span className="flex min-w-60 flex-1 flex-col gap-0.5">
              <span className="text-sm font-medium text-foreground">{skillTitle(skill.name)}</span>
              {skill.description.trim() === "" ? null : (
                <span className="text-xs text-muted-foreground">{skill.description}</span>
              )}
            </span>
            <span className="flex shrink-0 items-center gap-3">
              <span className="text-xs text-muted-foreground">{skill.providerName}</span>
              {skill.inCodenine ? (
                <Badge variant="success">Added</Badge>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canSave || busyPath !== null}
                  onClick={() => void add(skill)}
                >
                  {busyPath === skill.path ? "Adding…" : "Add"}
                </Button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function LibrarySkills({
  environmentId,
  library,
  canSave,
}: {
  readonly environmentId: EnvironmentId;
  readonly library: ReadonlyArray<LibrarySkill>;
  readonly canSave: boolean;
}) {
  const addFromLibrary = useAtomCommand(skillsEnvironment.addFromLibrary, {
    reportFailure: false,
  });
  const [busyName, setBusyName] = useState<string | null>(null);
  if (library.length === 0) return null;
  const add = async (skill: LibrarySkill) => {
    setBusyName(skill.name);
    const result = await addFromLibrary({ environmentId, input: { name: skill.name } });
    setBusyName(null);
    if (result._tag === "Success") {
      toastManager.add({ type: "success", title: `Added ${skillTitle(skill.name)}` });
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: `Could not add ${skillTitle(skill.name)}`,
        description: commandErrorMessage(result, "Try again."),
      });
    }
  };
  return (
    <section aria-labelledby="skills-library" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id="skills-library" className="text-sm font-semibold text-foreground">
          Library <span className="font-normal text-muted-foreground">{library.length}</span>
        </h2>
        <p className="text-sm text-muted-foreground">
          Skills that come with Codenine. Adding one copies it to your skills, where you can change
          it.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {library.map((skill) => (
          <div
            key={skill.name}
            className="flex flex-col gap-2.5 rounded-xl border border-border bg-card p-4"
          >
            <span className="text-sm font-medium text-foreground">{skillTitle(skill.name)}</span>
            <p className="flex-1 text-sm text-muted-foreground">{skill.description}</p>
            {skill.added ? (
              <Badge variant="success" className="self-start">
                Added
              </Badge>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="self-start"
                disabled={!canSave || busyName !== null}
                onClick={() => void add(skill)}
              >
                {busyName === skill.name ? "Adding…" : "Add"}
              </Button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
