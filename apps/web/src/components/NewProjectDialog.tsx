import {
  getAddProjectInitialQuery,
  getNewProjectPublishTarget,
  getNewProjectPublishTargets,
  getNewProjectRepository,
} from "@codenine/client-runtime/operations/projects";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectIconOverride,
  SourceControlProviderKind,
  WorkspaceKind,
} from "@codenine/contracts";
import { useNavigate } from "@tanstack/react-router";
import { FolderIcon } from "lucide-react";
import { lazy, type RefObject, Suspense, useId, useRef, useState } from "react";

import { useEnvironmentSettings } from "../hooks/useSettings";
import { useNewProject } from "../hooks/useNewProject";
import { useProjectFolderPicker } from "../hooks/useProjectFolderPicker";
import { resolveEffectiveDefaultModelSelection } from "../modelSelection";
import {
  clearNewProjectDialog,
  closeNewProjectDialog,
  useNewProjectDialogStore,
} from "../newProjectDialogStore";
import { deriveProjectIdentity } from "../projectIdentity";
import {
  resolveDefaultProviderModelSelection,
  resolveProjectDefaultProviderModelSelection,
} from "../providerInstances";
import { useEnvironmentProviders, useEnvironments } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { EMPTY_SERVER_PROVIDERS } from "../state/server";
import { sourceControlEnvironment } from "../state/sourceControl";
import { isWorkspaceKind, WORKSPACE_KIND_OPTIONS } from "../workspaceKind";
import { TeamModelPicker, teamModelText, useTeamModelCatalog } from "./chat/TeamAgentModel";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import {
  cloneFolderLabel,
  defaultNewProjectMachine,
  emptyProjectFolder,
  type NewProjectErrors,
  type NewProjectMachine,
  type NewProjectRequest,
  type NewProjectSource,
  newProjectMachines,
  planNewProject,
  resolveNewProjectSource,
  suggestedProjectName,
} from "./NewProjectDialog.logic";
import { ProjectFavicon } from "./ProjectFavicon";
import { ProjectMonogram } from "./ProjectMonogram";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { RadioCard, RadioGroup } from "./ui/radio-group";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";

// All Lucide icons load with the picker, only once the user opens it.
const ProjectIconPickerDialog = lazy(() =>
  import("./settings/ProjectIconPickerDialog").then((module) => ({
    default: module.ProjectIconPickerDialog,
  })),
);

const SOURCES = ["empty", "folder", "clone"] as const satisfies ReadonlyArray<NewProjectSource>;

function isNewProjectSource(value: unknown): value is NewProjectSource {
  return SOURCES.some((source) => source === value);
}

/** Hosted once at the root, so every New workspace button opens the same dialog. */
export function NewProjectDialogHost() {
  const request = useNewProjectDialogStore((state) => state.request);
  const open = useNewProjectDialogStore((state) => state.open);
  const session = useNewProjectDialogStore((state) => state.session);
  return request === null ? null : <NewProjectDialog key={session} request={request} open={open} />;
}

function NewProjectDialog({ request, open }: { request: NewProjectRequest; open: boolean }) {
  const id = useId();
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const openedAt = useNewProjectDialogStore((state) => state.openedAt);
  const createProject = useNewProject();
  const machines = newProjectMachines(environments);
  const [pickedEnvironmentId, setPickedEnvironmentId] = useState<EnvironmentId | null>(null);
  // Follows machines as they connect until the user picks one.
  const machine =
    machines.find((candidate) => candidate.environmentId === pickedEnvironmentId) ??
    defaultNewProjectMachine(machines, request);
  const [name, setName] = useState(request.name ?? "");
  const [nameEdited, setNameEdited] = useState(request.name !== undefined);
  const [pickedSource, setPickedSource] = useState<NewProjectSource>(request.source ?? "empty");
  const source = resolveNewProjectSource(pickedSource, machine);
  const [folderPath, setFolderPath] = useState(request.folderPath ?? "");
  const [repository, setRepository] = useState(request.repository ?? "");
  const [publishes, setPublishes] = useState(false);
  const [publishKind, setPublishKind] = useState<SourceControlProviderKind | null>(null);
  const [workspaceKind, setWorkspaceKind] = useState<WorkspaceKind>("code");
  const [projectIcon, setProjectIcon] = useState<ProjectIconOverride | null>(null);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  // Account ids belong to one machine, so a pick only holds on the machine it was made on.
  const [pickedModel, setPickedModel] = useState<{
    readonly environmentId: EnvironmentId;
    readonly selection: ModelSelection;
  } | null>(null);
  const modelSelection =
    pickedModel !== null && pickedModel.environmentId === machine?.environmentId
      ? pickedModel.selection
      : null;
  const [errors, setErrors] = useState<NewProjectErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const repositoryInputRef = useRef<HTMLInputElement>(null);
  // The field each source starts in; an empty workspace starts with its name.
  const sourceInputRef = { empty: nameInputRef, folder: folderInputRef, clone: repositoryInputRef }[
    source
  ];

  const discovery = useEnvironmentQuery(
    machine !== null && source === "empty"
      ? sourceControlEnvironment.discovery({ environmentId: machine.environmentId, input: {} })
      : null,
  );
  const publishTargets = getNewProjectPublishTargets(discovery.data ?? null);
  const publishTarget = getNewProjectPublishTarget(publishTargets, publishKind);
  const emptyFolder = machine ? emptyProjectFolder(machine, name) : null;

  const suggestName = (nextSource: "folder" | "clone", value: string) => {
    if (!nameEdited) setName(suggestedProjectName(nextSource, value));
  };
  const clearError = (field: keyof NewProjectErrors) => {
    if (errors[field] !== undefined) setErrors(withoutError(errors, field));
  };

  const submit = async () => {
    if (machine === null || submitting) return;
    const planned = planNewProject(
      {
        name,
        source,
        folderPath,
        repository,
        publishTo: publishes ? publishTarget : null,
        workspaceKind,
        projectIcon,
        modelSelection,
      },
      machine,
    );
    if (!planned.ok) {
      setErrors(planned.errors);
      (planned.errors.name !== undefined ? nameInputRef : sourceInputRef).current?.focus();
      return;
    }
    setErrors({});
    setSubmitError(null);
    setSubmitting(true);
    const result = await createProject(planned.plan, {
      onCreated: closeNewProjectDialog,
      folderMustExist: true,
      ...(request.relinkProjectId === undefined
        ? {}
        : { relinkProjectId: request.relinkProjectId }),
    });
    if (result.ok) {
      closeNewProjectDialog();
      return;
    }
    setSubmitting(false);
    setSubmitError(result.message);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        // Closing mid-request would leave the request to open a chat behind the user's back.
        if (!nextOpen && !submitting) closeNewProjectDialog();
      }}
      onOpenChangeComplete={(nextOpen) => {
        if (!nextOpen) clearNewProjectDialog();
      }}
    >
      <DialogPopup
        className="sm:max-w-xl"
        initialFocus={sourceInputRef}
        // Once the new workspace opened, its composer owns focus.
        finalFocus={() => window.location.href === openedAt}
      >
        <form
          className="flex min-h-0 flex-col"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>New workspace</DialogTitle>
            <DialogDescription>
              A workspace keeps a project's files, chats and tasks together.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {machine === null ? (
              <p className="text-muted-foreground text-sm">
                No connected computer can hold a workspace right now.{" "}
                <Button
                  variant="link"
                  size="xs"
                  onClick={() => {
                    closeNewProjectDialog();
                    void navigate({ to: "/settings/connections" });
                  }}
                >
                  Open Environments
                </Button>
              </p>
            ) : null}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-name`}>Name</Label>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Choose an icon"
                  onClick={() => setIconPickerOpen(true)}
                >
                  <ProjectIconPreview
                    name={name}
                    projectIcon={projectIcon}
                    environmentId={machine?.environmentId ?? null}
                  />
                </Button>
                <Input
                  ref={nameInputRef}
                  id={`${id}-name`}
                  value={name}
                  placeholder="Pinball Stats"
                  autoComplete="off"
                  aria-invalid={errors.name !== undefined}
                  aria-describedby={errors.name === undefined ? undefined : `${id}-name-error`}
                  onChange={(event) => {
                    setName(event.target.value);
                    // Cleared, it takes the next folder's or repository's name again.
                    setNameEdited(event.target.value.trim().length > 0);
                    clearError("name");
                  }}
                />
              </div>
              <FieldError id={`${id}-name-error`} message={errors.name} />
            </div>

            {request.relinkProjectId === undefined && machine?.workspaceKinds === true ? (
              <div className="flex flex-col gap-1.5">
                <Label id={`${id}-type`} render={<div />}>
                  Type
                </Label>
                <RadioGroup
                  className="grid sm:grid-cols-3"
                  aria-labelledby={`${id}-type`}
                  value={workspaceKind}
                  onValueChange={(value) => {
                    if (isWorkspaceKind(value)) setWorkspaceKind(value);
                  }}
                >
                  {WORKSPACE_KIND_OPTIONS.map((option) => (
                    <RadioCard
                      key={option.kind}
                      value={option.kind}
                      title={option.label}
                      description={option.description}
                      selected={workspaceKind === option.kind}
                    />
                  ))}
                </RadioGroup>
              </div>
            ) : null}

            <div className="flex flex-col gap-1.5">
              <Label id={`${id}-files`} render={<div />}>
                Files
              </Label>
              <RadioGroup
                aria-labelledby={`${id}-files`}
                value={source}
                onValueChange={(value) => {
                  if (!isNewProjectSource(value)) return;
                  setPickedSource(value);
                  clearError("source");
                }}
              >
                <RadioCard
                  value="empty"
                  title="Start empty"
                  description={
                    machine?.newProjectsRoot === null
                      ? `Update Codenine on ${machine.label} to start empty workspaces`
                      : "A new folder in your Codenine folder"
                  }
                  selected={source === "empty"}
                  disabled={machine?.newProjectsRoot === null}
                >
                  {emptyFolder === null ? null : (
                    <p className="break-all text-muted-foreground text-xs">
                      {name.trim().length > 0
                        ? `Creates ${emptyFolder}`
                        : `Creates a folder in ${emptyFolder}`}
                    </p>
                  )}
                  {publishTarget === null ? null : (
                    <div className="flex flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <label className="flex cursor-pointer items-center gap-2 text-sm">
                          <Checkbox
                            checked={publishes}
                            onCheckedChange={(checked) => setPublishes(checked)}
                          />
                          {publishTargets.length > 1
                            ? "Also create a private repository on"
                            : `Also create a private repository on ${publishTarget.definition.label}`}
                        </label>
                        {publishTargets.length > 1 ? (
                          <Select
                            value={publishTarget.definition.kind}
                            onValueChange={(kind) => {
                              if (kind !== null) setPublishKind(kind);
                            }}
                          >
                            <SelectTrigger
                              size="xs"
                              className="w-auto min-w-0"
                              aria-label="Host for the new repository"
                            >
                              <SelectValue>
                                {(kind: SourceControlProviderKind) =>
                                  publishTargets.find((target) => target.definition.kind === kind)
                                    ?.definition.label ?? kind
                                }
                              </SelectValue>
                            </SelectTrigger>
                            <SelectPopup>
                              {publishTargets.map((target) => (
                                <SelectItem
                                  key={target.definition.kind}
                                  value={target.definition.kind}
                                >
                                  {target.definition.label}
                                </SelectItem>
                              ))}
                            </SelectPopup>
                          </Select>
                        ) : null}
                      </div>
                      {publishes && name.trim().length > 0 && emptyFolder !== null ? (
                        <p className="ps-6 text-muted-foreground text-xs">
                          {getNewProjectRepository(publishTarget, emptyFolder)}
                        </p>
                      ) : null}
                    </div>
                  )}
                </RadioCard>
                <RadioCard
                  value="folder"
                  title="Use a folder"
                  description="Files already on this computer"
                  selected={source === "folder"}
                >
                  {machine === null ? null : (
                    <FolderField
                      id={`${id}-folder-path`}
                      inputRef={folderInputRef}
                      machine={machine}
                      value={folderPath}
                      error={errors.folderPath}
                      onChange={(path) => {
                        setFolderPath(path);
                        suggestName("folder", path);
                        clearError("folderPath");
                      }}
                      onPicked={(environmentId, path) => {
                        setPickedEnvironmentId(environmentId);
                        setFolderPath(path);
                        suggestName("folder", path);
                        clearError("folderPath");
                      }}
                      onPickFailed={setSubmitError}
                    />
                  )}
                </RadioCard>
                <RadioCard
                  value="clone"
                  title="Clone a repository"
                  description="From GitHub or any Git URL"
                  selected={source === "clone"}
                >
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`${id}-repository`}>Repository</Label>
                    <Input
                      ref={repositoryInputRef}
                      id={`${id}-repository`}
                      value={repository}
                      placeholder="owner/repo or a Git URL"
                      autoComplete="off"
                      spellCheck={false}
                      aria-invalid={errors.repository !== undefined}
                      aria-describedby={`${id}-repository-hint${errors.repository === undefined ? "" : ` ${id}-repository-error`}`}
                      onChange={(event) => {
                        setRepository(event.target.value);
                        suggestName("clone", event.target.value);
                        clearError("repository");
                      }}
                    />
                    {machine === null ? null : (
                      <p id={`${id}-repository-hint`} className="text-muted-foreground text-xs">
                        Codenine downloads it into {cloneFolderLabel(machine)}
                      </p>
                    )}
                    <FieldError id={`${id}-repository-error`} message={errors.repository} />
                  </div>
                </RadioCard>
              </RadioGroup>
              <FieldError id={`${id}-source-error`} message={errors.source} />
            </div>

            {machine === null ? null : (
              <DefaultAgentField
                key={machine.environmentId}
                machine={machine}
                value={modelSelection}
                onChange={(selection) =>
                  setPickedModel({ environmentId: machine.environmentId, selection })
                }
              />
            )}

            {submitError === null ? null : (
              <p role="alert" className="text-destructive-foreground text-sm">
                {submitError}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            {machine !== null && machines.length > 1 ? (
              <div className="flex items-center gap-2 sm:me-auto">
                <span id={`${id}-machine`} className="text-muted-foreground text-sm">
                  On
                </span>
                <Select
                  value={machine.environmentId}
                  disabled={submitting}
                  onValueChange={(environmentId) => {
                    if (environmentId !== null) setPickedEnvironmentId(environmentId);
                  }}
                  items={machines.map((candidate) => ({
                    value: candidate.environmentId,
                    label: candidate.label,
                  }))}
                >
                  <SelectTrigger
                    size="sm"
                    className="w-auto min-w-0"
                    aria-labelledby={`${id}-machine`}
                  >
                    <EnvironmentMachineIcon kind={machine.machine} className="size-3.5" />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {machines.map((candidate) => (
                      <SelectItem key={candidate.environmentId} value={candidate.environmentId}>
                        <span className="inline-flex items-center gap-1.5">
                          <EnvironmentMachineIcon kind={candidate.machine} className="size-3" />
                          {candidate.label}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={submitting}
              onClick={closeNewProjectDialog}
            >
              Cancel
            </Button>
            <Button size="sm" type="submit" disabled={machine === null || submitting}>
              {submitting ? "Creating…" : "Create workspace"}
            </Button>
          </DialogFooter>
        </form>
        {iconPickerOpen ? (
          <Suspense fallback={null}>
            <ProjectIconPickerDialog
              current={projectIcon}
              projectName={name.trim() || "Workspace"}
              open
              onOpenChange={setIconPickerOpen}
              onSelect={setProjectIcon}
            />
          </Suspense>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function withoutError(errors: NewProjectErrors, field: keyof NewProjectErrors): NewProjectErrors {
  const { [field]: _cleared, ...rest } = errors;
  return rest;
}

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  return message === undefined ? null : (
    <p id={id} className="text-destructive-foreground text-xs">
      {message}
    </p>
  );
}

/** The chosen icon, else the name's initials, as the new workspace will show them. */
function ProjectIconPreview({
  name,
  projectIcon,
  environmentId,
}: {
  name: string;
  projectIcon: ProjectIconOverride | null;
  environmentId: EnvironmentId | null;
}) {
  if (projectIcon !== null && environmentId !== null) {
    return (
      <ProjectFavicon
        project={{ environmentId, workspaceRoot: "", title: name, faviconPath: null, projectIcon }}
        className="size-5"
      />
    );
  }
  if (name.trim().length === 0) return <FolderIcon aria-hidden />;
  const identity = deriveProjectIdentity(name);
  return <ProjectMonogram text={identity.monogram} color={identity.color} className="size-5" />;
}

function FolderField({
  id,
  inputRef,
  machine,
  value,
  error,
  onChange,
  onPicked,
  onPickFailed,
}: {
  id: string;
  inputRef: RefObject<HTMLInputElement | null>;
  machine: NewProjectMachine;
  value: string;
  error: string | undefined;
  onChange: (path: string) => void;
  onPicked: (environmentId: EnvironmentId, path: string) => void;
  onPickFailed: (message: string) => void;
}) {
  const folderPicker = useProjectFolderPicker();
  const [picking, setPicking] = useState(false);
  const startsIn = getAddProjectInitialQuery(machine.addProjectBaseDirectory);
  const browse = async () => {
    setPicking(true);
    const picked = await folderPicker.pickFolder({
      environmentId: machine.environmentId,
      platform: machine.platform,
      initialPath: value.trim() || startsIn,
    });
    setPicking(false);
    if (picked.kind === "picked") onPicked(picked.environmentId, picked.path);
    else if (picked.kind === "failed") onPickFailed(picked.message);
  };
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>Folder</Label>
      <div className="flex items-center gap-2">
        <Input
          ref={inputRef}
          id={id}
          value={value}
          placeholder={`${startsIn}my-app`}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error !== undefined}
          aria-describedby={`${id}-hint${error === undefined ? "" : ` ${id}-error`}`}
          onChange={(event) => onChange(event.target.value)}
        />
        {folderPicker.canPickFolder(machine.environmentId) ? (
          <Button variant="outline" disabled={picking} onClick={() => void browse()}>
            Browse
          </Button>
        ) : null}
      </div>
      <p id={`${id}-hint`} className="text-muted-foreground text-xs">
        The files stay where they are.
      </p>
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}

/** Starts on the machine's default account and model; a pick becomes the workspace's default. */
function DefaultAgentField(props: {
  machine: NewProjectMachine;
  value: ModelSelection | null;
  onChange: (selection: ModelSelection) => void;
}) {
  const { environmentId } = props.machine;
  const catalog = useTeamModelCatalog(environmentId, null);
  const settings = useEnvironmentSettings(environmentId);
  const providers = useEnvironmentProviders().get(environmentId) ?? EMPTY_SERVER_PROVIDERS;
  const stored =
    settings.defaultModelSelection === null
      ? resolveProjectDefaultProviderModelSelection(providers, settings, null)
      : resolveDefaultProviderModelSelection(providers, settings.defaultModelSelection);
  const selection =
    props.value ??
    (stored === null ? null : resolveEffectiveDefaultModelSelection(settings, providers, stored));
  const described = selection === null ? null : teamModelText(catalog, selection);
  return (
    <div className="flex flex-col gap-1.5">
      <Label render={<div />}>Default model</Label>
      {selection === null || described === null ? (
        <p className="text-muted-foreground text-sm">
          No account is set up on {props.machine.label} yet.
        </p>
      ) : (
        <div className="flex">
          <TeamModelPicker
            catalog={catalog}
            selection={selection}
            label={`Default model: ${[described.entry?.displayName, described.name].filter(Boolean).join(", ")}`}
            disabled={false}
            onChange={props.onChange}
          />
        </div>
      )}
      <p className="text-muted-foreground text-xs">
        New chats here start on this account and model. You can change it later.
      </p>
    </div>
  );
}
