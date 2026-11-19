import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@codenine/client-runtime/environment";
import type { EnvironmentProject } from "@codenine/client-runtime/state/models";
import { isAtomCommandInterrupted, settlePromise } from "@codenine/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ProjectId,
  type SkillDetail,
  type SkillName,
  type SkillScope,
  skillTitle,
} from "@codenine/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, FileIcon } from "lucide-react";
import { useId, useState } from "react";

import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useScratchProject } from "../../hooks/useScratchProject";
import { commandErrorMessage } from "../../lib/commandError";
import { ensureLocalApi } from "../../localApi";
import { useEditorDraft, useReadSinceOpened } from "../../hooks/useEditorDraft";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { shellEnvironment } from "../../state/shell";
import { skillsEnvironment } from "../../state/skills";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAccessEnvironment, useOpenedEnvironment } from "../settings/useAccessEnvironment";
import { checkSkillDraft, skillNameFromTitle, type SkillDraftErrors } from "../skills/skills.logic";
import { TextField } from "../TextField";
import { Button, InlineButton } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Label } from "../ui/label";
import { RadioCard, RadioGroup } from "../ui/radio-group";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { useSkillWorkspaces } from "./SkillsPage";
import { WorkspacePage } from "./WorkspacePage";

const WRITE_A_SKILL: SkillName = "write-a-skill";

export type SkillEditorTarget =
  | { readonly kind: "new" }
  | { readonly kind: "edit"; readonly scope: SkillScope; readonly name: SkillName }
  | { readonly kind: "invalid" };

/** Writes a new skill or changes one: its name, when to use it, its instructions and where it lives. */
export function SkillEditorPage(props: {
  readonly target: SkillEditorTarget;
  readonly machine: EnvironmentId | null;
  readonly workspace: ProjectId | null;
}) {
  const { environment } = useAccessEnvironment(props.machine);
  const environmentId = environment?.environmentId ?? null;
  const connected = environment?.connection.phase === "connected";
  const opened = useOpenedEnvironment(environmentId, connected);
  const { workspace } = useSkillWorkspaces(environmentId, props.workspace);
  const editing = props.target.kind === "edit" ? props.target : null;
  const read =
    editing !== null && environmentId !== null && opened
      ? skillsEnvironment.read({
          environmentId,
          input: {
            name: editing.name,
            scope: editing.scope,
            ...(editing.scope === "workspace" && workspace !== null
              ? { projectId: workspace.id }
              : {}),
          },
        })
      : null;
  const detail = useEnvironmentQuery(read);
  const answered = useReadSinceOpened(read, detail);
  const title = props.target.kind === "edit" ? skillTitle(props.target.name) : "New skill";
  const navigate = useNavigate();
  const breadcrumb = (
    <span className="flex min-w-0 items-center gap-1">
      <Link
        to="/skills"
        search={{ machine: environmentId ?? undefined, workspace: workspace?.id }}
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        Skills
      </Link>
      <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{title}</span>
    </span>
  );
  return (
    <WorkspacePage area="skill" title={breadcrumb}>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6">
        {props.target.kind === "invalid" ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>This skill is not here</EmptyTitle>
              <EmptyDescription>The address does not name a skill.</EmptyDescription>
            </EmptyHeader>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void navigate({
                  to: "/skills",
                  search: { machine: environmentId ?? undefined, workspace: workspace?.id },
                })
              }
            >
              Back to skills
            </Button>
          </Empty>
        ) : environmentId === null || !opened ? (
          <p className="text-sm text-muted-foreground">
            Connect the computer the skill is on to change it.
          </p>
        ) : editing === null ? (
          <SkillForm
            environmentId={environmentId}
            workspace={workspace}
            skill={null}
            connected={connected}
          />
        ) : detail.data === null || !answered ? (
          detail.error === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>This skill could not open</EmptyTitle>
                <EmptyDescription>{detail.error}</EmptyDescription>
              </EmptyHeader>
              <Button size="sm" variant="outline" onClick={detail.refresh}>
                Try again
              </Button>
            </Empty>
          )
        ) : (
          // Keyed by place: a newer read of the same skill reaches the form, which keeps its edits.
          <SkillForm
            key={`${detail.data.scope}:${detail.data.name}`}
            environmentId={environmentId}
            workspace={workspace}
            skill={detail.data}
            connected={connected}
          />
        )}
      </div>
    </WorkspacePage>
  );
}

function draftOf(skill: SkillDetail | null) {
  const scope: SkillScope = skill?.scope ?? "codenine";
  return {
    title: skill === null ? "" : skillTitle(skill.name),
    description: skill?.description ?? "",
    instructions: skill?.instructions ?? "",
    scope,
  };
}

function SkillForm({
  environmentId,
  workspace,
  skill,
  connected,
}: {
  readonly environmentId: EnvironmentId;
  readonly workspace: EnvironmentProject | null;
  readonly skill: SkillDetail | null;
  /** False while the computer is away: the form stays open, and saving waits. */
  readonly connected: boolean;
}) {
  const formId = useId();
  const keepId = useId();
  const instructionsId = useId();
  const navigate = useNavigate();
  const canSave = useAtomValue(skillsEnvironment.save.permissionAtom(environmentId));
  const save = useAtomCommand(skillsEnvironment.save, { reportFailure: false });
  const remove = useAtomCommand(skillsEnvironment.delete, { reportFailure: false });
  const [errors, setErrors] = useState<SkillDraftErrors & { readonly form?: string }>({});
  const [busy, setBusy] = useState(false);
  const { draft, newer, follow, change, release, saved } = useEditorDraft(skill, draftOf, busy);
  const { title, description, instructions, scope } = draft;
  const cannotSave = busy || !canSave || !connected;
  const savedName = skillNameFromTitle(title);
  const projectId = skill?.projectId ?? workspace?.id ?? null;
  const backToSkills = () =>
    void navigate({
      to: "/skills",
      search: { machine: environmentId, workspace: projectId ?? undefined },
    });

  const submit = async () => {
    if (busy) return;
    const checked = checkSkillDraft({ title, description });
    if (checked.errors !== undefined) {
      setErrors(checked.errors);
      return;
    }
    if (scope === "workspace" && projectId === null) {
      setErrors({ form: "Pick a workspace on the Skills page first." });
      return;
    }
    setErrors({});
    setBusy(true);
    const result = await save({
      environmentId,
      input: {
        name: checked.name,
        description: description.trim(),
        instructions,
        scope,
        ...(scope === "workspace" && projectId !== null ? { projectId } : {}),
        // The server moves the folder, files and all, when the place changed.
        ...(skill === null
          ? {}
          : {
              previousName: skill.name,
              previousScope: skill.scope,
              ...(skill.projectId === null ? {} : { previousProjectId: skill.projectId }),
            }),
      },
    });
    if (result._tag === "Failure") {
      setBusy(false);
      if (!isAtomCommandInterrupted(result)) {
        setErrors({ form: commandErrorMessage(result, "The skill was not saved.") });
      }
      return;
    }
    setBusy(false);
    saved();
    toastManager.add({ type: "success", title: `Saved ${skillTitle(checked.name)}` });
    backToSkills();
  };

  const deleteSkill = async () => {
    if (skill === null || busy) return;
    const confirmed = await settlePromise(() =>
      ensureLocalApi().dialogs.confirm(
        `Delete ${skillTitle(skill.name)}?\nIts folder and files are removed, and chats that kept it on stop using it.`,
        { variant: "destructive" },
      ),
    );
    if (confirmed._tag !== "Success" || !confirmed.value) return;
    setBusy(true);
    const result = await remove({
      environmentId,
      input: {
        name: skill.name,
        scope: skill.scope,
        ...(skill.projectId === null ? {} : { projectId: skill.projectId }),
      },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setErrors({ form: commandErrorMessage(result, "The skill was not deleted.") });
      }
      return;
    }
    release();
    toastManager.add({ type: "success", title: `Deleted ${skillTitle(skill.name)}` });
    backToSkills();
  };

  return (
    <>
      <header className="flex flex-col gap-1.5">
        <h2 className="text-2xl font-semibold text-foreground">
          {skill === null ? "New skill" : skillTitle(skill.name)}
        </h2>
        <p className="text-sm text-muted-foreground">
          Write down how you like something done, once. Any agent or chat can then follow it, on any
          model.
          {skill === null ? (
            <WriteWithSkillLink environmentId={environmentId} workspace={workspace} />
          ) : null}
        </p>
      </header>
      <form
        id={formId}
        noValidate
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <TextField
          label="Name"
          placeholder="Our email tone"
          value={title}
          disabled={busy || !canSave}
          error={errors.title}
          hint={savedName === "" ? undefined : `Saved as ${savedName}`}
          onChange={(next) => change({ title: next })}
        />
        <TextField
          label="Use it when…"
          placeholder="Writing or replying to any email for me."
          value={description}
          disabled={busy || !canSave}
          error={errors.description}
          hint="Agents read this line to decide whether the skill fits, so name the task, not the content."
          onChange={(next) => change({ description: next })}
        />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={instructionsId}>Instructions</Label>
          <Textarea
            id={instructionsId}
            font="mono"
            rows={12}
            spellCheck={false}
            value={instructions}
            disabled={busy || !canSave}
            onChange={(event) => change({ instructions: event.currentTarget.value })}
          />
        </div>
        <SkillFiles environmentId={environmentId} skill={skill} />
        <div className="flex flex-col gap-2">
          <h3 id={keepId} className="text-base font-semibold text-foreground">
            Keep it
          </h3>
          <RadioGroup
            aria-labelledby={keepId}
            value={scope}
            disabled={busy || !canSave}
            onValueChange={(value) => {
              if (value === "codenine" || value === "workspace") change({ scope: value });
            }}
          >
            <RadioCard
              value="codenine"
              title="For all my workspaces"
              description="Saved in your Codenine folder."
              selected={scope === "codenine"}
            />
            <RadioCard
              value="workspace"
              title={
                workspace === null && skill?.projectId == null
                  ? "Only in this workspace"
                  : `Only in ${workspace?.title ?? "this workspace"}`
              }
              description="Saved with the workspace's files, so people who share the workspace get it too."
              selected={scope === "workspace"}
              disabled={projectId === null}
            />
          </RadioGroup>
        </div>
        {errors.form === undefined ? null : (
          <p role="alert" className="text-sm text-destructive-foreground">
            {errors.form}
          </p>
        )}
        {connected ? null : (
          <p role="status" className="text-sm text-muted-foreground">
            This computer is not connected. You can save once it is back.
          </p>
        )}
        {newer ? (
          <p
            role="status"
            className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
          >
            This skill changed since you opened it. Saving replaces that change.
            <Button variant="outline" size="xs" disabled={busy} onClick={follow}>
              Load the newer skill
            </Button>
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Saved as a standard skill file, so other tools that read skills can use it too.
        </p>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          {skill === null ? (
            <span />
          ) : (
            <Button
              variant="destructive-outline"
              size="sm"
              disabled={cannotSave}
              onClick={() => void deleteSkill()}
            >
              Delete skill
            </Button>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                release();
                backToSkills();
              }}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={cannotSave}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </form>
    </>
  );
}

function SkillFiles({
  environmentId,
  skill,
}: {
  readonly environmentId: EnvironmentId;
  readonly skill: SkillDetail | null;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  const canOpen = config?.availableEditors.includes("file-manager") === true;
  const openFolder = async () => {
    if (skill === null || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
      return;
    }
    const result = await openInEditor({
      environmentId,
      input: { cwd: skill.path, editor: "file-manager" },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: "Could not open the skill's folder",
        description: commandErrorMessage(result, "Try again."),
      });
    }
  };
  const heading = (
    <h3 className="text-base font-semibold text-foreground">
      Files <span className="font-normal text-muted-foreground">optional</span>
    </h3>
  );
  if (skill === null) {
    return (
      <section aria-label="Files" className="flex flex-col gap-2">
        {heading}
        <p className="text-xs text-muted-foreground">
          Examples, templates or scripts the skill can use. Save the skill, then add them to its
          folder.
        </p>
      </section>
    );
  }
  return (
    <section aria-label="Files" className="flex flex-col gap-2">
      {heading}
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-card px-3.5 py-3">
        {skill.files.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {skill.files.map((file) => (
              <li key={file} className="flex items-center gap-2 text-sm text-foreground">
                <FileIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate font-mono text-xs">{file}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="min-w-60 flex-1 text-xs text-muted-foreground">
            Examples, templates or scripts the skill can use. Agents open them only when they need
            them.
          </span>
          {canOpen ? (
            <Button variant="outline" size="sm" onClick={() => void openFolder()}>
              Open folder
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/** Starts a chat that writes the skill with the library's Write a skill skill, when it is there. */
function WriteWithSkillLink({
  environmentId,
  workspace,
}: {
  readonly environmentId: EnvironmentId;
  readonly workspace: EnvironmentProject | null;
}) {
  const handleNewThread = useNewThreadHandler();
  const { openScratchProject } = useScratchProject();
  const addFromLibrary = useAtomCommand(skillsEnvironment.addFromLibrary, {
    reportFailure: false,
  });
  const list = useEnvironmentQuery(
    skillsEnvironment.list({
      environmentId,
      input: workspace === null ? {} : { projectId: workspace.id },
    }),
  );
  const owned = list.data?.skills.some((skill) => skill.name === WRITE_A_SKILL) === true;
  const inLibrary = list.data?.library.some((skill) => skill.name === WRITE_A_SKILL) === true;
  if (!owned && !inLibrary) return null;

  const start = async () => {
    if (!owned) {
      const added = await addFromLibrary({ environmentId, input: { name: WRITE_A_SKILL } });
      if (added._tag === "Failure") {
        if (!isAtomCommandInterrupted(added)) {
          toastManager.add({
            type: "error",
            title: "Could not add Write a skill",
            description: commandErrorMessage(added, "Try again."),
          });
        }
        return;
      }
    }
    const project = workspace ?? (await openScratchProject(environmentId));
    if (project === null) return;
    await handleNewThread(scopeProjectRef(project.environmentId, project.id), {
      prompt: `$${WRITE_A_SKILL} `,
    });
  };
  return (
    <>
      {" Not sure where to start? "}
      <InlineButton onClick={() => void start()}>
        Write it with the Write a skill skill
      </InlineButton>
      .
    </>
  );
}
