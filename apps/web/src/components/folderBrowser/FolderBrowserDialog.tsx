import { ensureBrowseDirectoryPath } from "@codenine/client-runtime/state/projects";
import { isAtomCommandInterrupted } from "@codenine/client-runtime/state/runtime";
import type { EnvironmentId, FilesystemBrowseResult } from "@codenine/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  ArrowUpIcon,
  BriefcaseBusinessIcon,
  ChevronRightIcon,
  ClockIcon,
  FolderIcon,
  FolderPlusIcon,
  GitBranchIcon,
  HouseIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { type KeyboardEvent, useId, useRef, useState } from "react";

import { commandErrorMessage } from "../../lib/commandError";
import { cn } from "../../lib/utils";
import { useProjects } from "../../state/entities";
import { filesystemEnvironment, useFilesystemReadAccess } from "../../state/filesystem";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button, InlineButton } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Skeleton } from "../ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  folderCrumbs,
  folderName,
  folderPathForInput,
  type FolderPlace,
  folderPlaces,
  initialBrowsePath,
  listFolderRows,
  moveFolderHighlight,
  newFolderNameProblem,
  parentFolderPath,
} from "./folderBrowser.logic";

/** What the browser reads from the machine whose folders it lists. */
export interface FolderBrowserMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** The platform path checks expect, as `getEnvironmentBrowsePlatform` names it. */
  readonly platform: string;
  readonly homeDirectory: string | null;
  readonly newProjectsRoot: string | null;
  readonly addProjectBaseDirectory: string;
  /** Older servers cannot make a folder, so New folder is not offered there. */
  readonly folderCreation: boolean;
}

const PLACE_ICONS = {
  home: HouseIcon,
  workspaces: BriefcaseBusinessIcon,
  start: FolderIcon,
  recent: ClockIcon,
} as const satisfies Record<FolderPlace["kind"], unknown>;

const SKELETON_WIDTHS = ["w-40", "w-28", "w-52", "w-36", "w-44", "w-24"];

const scrollToEnd = (element: HTMLElement | null) => {
  if (element !== null) element.scrollLeft = element.scrollWidth;
};
const scrollIntoView = (element: HTMLElement | null) => {
  element?.scrollIntoView({ block: "nearest" });
};

/**
 * Picks a folder on a machine by listing that machine's folders, so it works the same when the
 * browser drives a server elsewhere. Mount it only while open: its place resets with it.
 */
export function FolderBrowserDialog(props: {
  readonly machine: FolderBrowserMachine;
  /** What the path box holds; the browser opens there when it is a folder path. */
  readonly typedPath: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onUse: (path: string) => void;
  /** The desktop app's own picker, where this machine is on the same computer. */
  readonly onOpenSystemDialog?: (() => void) | undefined;
}) {
  const { machine } = props;
  const id = useId();
  const { environmentId } = machine;
  const workspaceRoots = useProjects()
    .filter((project) => project.environmentId === environmentId && project.isScratch !== true)
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((project) => project.workspaceRoot);
  const places = folderPlaces({ ...machine, workspaceRoots });
  const [path, setPath] = useState(() =>
    initialBrowsePath({
      typedPath: props.typedPath,
      fallback: places[0]?.path ?? "~/",
      windows: /^win/i.test(machine.platform),
    }),
  );
  const [filter, setFilter] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const filterRef = useRef<HTMLInputElement>(null);

  const access = useFilesystemReadAccess(environmentId);
  const listing = useEnvironmentQuery(
    access.canReadFiles
      ? filesystemEnvironment.browse({
          environmentId,
          input: { partialPath: path, detectRepositories: true },
        })
      : null,
  );
  // The last folder that loaded stays on screen while the next one is read, so the list never
  // collapses and jumps between two folders.
  const [shown, setShown] = useState<{
    readonly path: string;
    readonly data: FilesystemBrowseResult;
  } | null>(null);
  if (listing.data !== null && shown?.data !== listing.data) {
    setShown({ path, data: listing.data });
  }
  const current = shown?.path === path ? shown.data : null;
  const canCreate =
    useAtomValue(filesystemEnvironment.createDirectory.permissionAtom(environmentId)) &&
    machine.folderCreation;
  const createDirectory = useAtomCommand(filesystemEnvironment.createDirectory, {
    reportFailure: false,
  });

  // A listing names the folder absolutely, which is what ~/ becomes once it has loaded.
  const location = current?.parentPath ?? path;
  const crumbs = folderCrumbs(location);
  const parent = parentFolderPath(location);
  const rows = listFolderRows({
    entries: (current ?? shown?.data)?.entries ?? [],
    filter,
    showHidden,
    workspaceRoots,
  });
  const active = Math.min(highlight, Math.max(0, rows.rows.length - 1));
  const activeRow = rows.rows[active];
  const pending = access.isPending || (listing.isPending && current === null);
  const missing =
    listing.failure !== null &&
    typeof listing.failure === "object" &&
    "pathMissing" in listing.failure &&
    listing.failure.pathMissing === true;
  const problem =
    !access.isPending && !access.canReadFiles
      ? (access.error ?? `You may not browse folders on ${machine.label}.`)
      : listing.error !== null && current === null
        ? missing
          ? "This folder does not exist."
          : `Codenine could not read this folder on ${machine.label}.`
        : current?.permissionDenied === true
          ? "Codenine may not read this folder."
          : null;

  const open = (nextPath: string) => {
    setPath(ensureBrowseDirectoryPath(nextPath));
    setFilter("");
    setHighlight(0);
    setNewFolder(null);
    setCreateError(null);
    filterRef.current?.focus();
  };
  // The rows of the folder before stay on screen while the next one loads; they do not open.
  const stale = current === null;
  const canUse = problem === null && crumbs.length > 0;
  const use = () => {
    if (!canUse) return;
    props.onUse(folderPathForInput(location));
    props.onOpenChange(false);
  };
  const onFilterKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.metaKey || event.ctrlKey) use();
      else if (activeRow !== undefined && !stale) open(activeRow.path);
      return;
    }
    if (event.key === "Backspace" && filter.length === 0) {
      // A held key that has just emptied the filter must not go on to climb folders.
      if (parent !== null && !event.repeat) {
        event.preventDefault();
        open(parent);
      }
      return;
    }
    const next = moveFolderHighlight(active, event.key, rows.rows.length);
    if (next === null) return;
    event.preventDefault();
    setHighlight(next);
  };
  const create = async () => {
    if (newFolder === null || creating) return;
    const name = newFolder.trim();
    const invalid = newFolderNameProblem(
      name,
      (current?.entries ?? []).map((entry) => entry.name),
    );
    if (invalid !== null) {
      setCreateError(invalid);
      return;
    }
    setCreating(true);
    const result = await createDirectory({
      environmentId,
      input: { parentPath: folderPathForInput(location), name },
    });
    setCreating(false);
    if (result._tag === "Success") {
      // The parent's listing is kept for a few seconds, and would come back without the folder.
      listing.refresh();
      open(result.value.path);
    } else if (!isAtomCommandInterrupted(result)) {
      setCreateError(commandErrorMessage(result, "The folder could not be made."));
    }
  };

  return (
    <Dialog open onOpenChange={props.onOpenChange}>
      <DialogPopup className="sm:max-w-2xl" initialFocus={filterRef}>
        <DialogHeader>
          <DialogTitle>Choose a folder</DialogTitle>
          <DialogDescription>Folders on {machine.label}.</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-3 px-6 pb-4 sm:flex-row sm:gap-4">
          <nav
            aria-label="Places"
            className="flex shrink-0 gap-1 overflow-x-auto max-sm:-mx-6 max-sm:px-6 sm:w-40 sm:flex-col sm:overflow-visible"
          >
            {places.map((place) => {
              const Icon = PLACE_ICONS[place.kind];
              const selected = folderPathForInput(place.path) === folderPathForInput(location);
              return (
                <Tooltip key={place.id}>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-current={selected ? "location" : undefined}
                        onClick={() => open(place.path)}
                        className={cn(
                          "flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-md px-2 text-start text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:h-7",
                          selected ? "bg-accent text-foreground" : "text-muted-foreground",
                        )}
                      />
                    }
                  >
                    <Icon aria-hidden className="size-3.5 shrink-0" />
                    <span className="truncate">{place.label}</span>
                  </TooltipTrigger>
                  <TooltipPopup side="right">
                    <code>{folderPathForInput(place.path)}</code>
                  </TooltipPopup>
                </Tooltip>
              );
            })}
          </nav>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex items-center gap-1">
              <Button
                variant="ghost-muted"
                size="icon-sm"
                aria-label="Up one folder"
                disabled={parent === null}
                onClick={() => parent !== null && open(parent)}
              >
                <ArrowUpIcon />
              </Button>
              <nav
                // Keyed so a longer path scrolls to its end, where the current folder is.
                key={location}
                ref={scrollToEnd}
                aria-label="Folder path"
                className="flex min-w-0 flex-1 items-center overflow-x-auto [scrollbar-width:none]"
              >
                {crumbs.map((crumb, index) => (
                  <span key={crumb.path} className="flex shrink-0 items-center">
                    {index === 0 ? null : (
                      <ChevronRightIcon aria-hidden className="size-3 text-muted-foreground/70" />
                    )}
                    <button
                      type="button"
                      aria-current={index === crumbs.length - 1 ? "location" : undefined}
                      onClick={() => open(crumb.path)}
                      className={cn(
                        "h-7 max-w-48 cursor-pointer truncate rounded-md px-1.5 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        index === crumbs.length - 1
                          ? "font-medium text-foreground"
                          : "text-muted-foreground",
                      )}
                    >
                      {crumb.label}
                    </button>
                  </span>
                ))}
              </nav>
            </div>
            <InputGroup>
              <InputGroupAddon>
                <SearchIcon aria-hidden />
              </InputGroupAddon>
              <InputGroupInput
                ref={filterRef}
                role="combobox"
                aria-label="Filter folders"
                aria-expanded
                aria-controls={`${id}-list`}
                aria-activedescendant={activeRow === undefined ? undefined : `${id}-row-${active}`}
                aria-autocomplete="list"
                placeholder={`Filter folders in ${folderName(location)}`}
                autoComplete="off"
                spellCheck={false}
                value={filter}
                onChange={(event) => {
                  setFilter(event.currentTarget.value);
                  setHighlight(0);
                }}
                onKeyDown={onFilterKeyDown}
              />
            </InputGroup>
            <div
              className="scrollbar-gutter-both flex h-64 flex-col overflow-y-auto rounded-lg border border-border bg-background/60 p-1 sm:h-72"
              aria-busy={listing.isPending}
            >
              {newFolder === null ? null : (
                <form
                  className="flex flex-col gap-1 p-1"
                  onSubmit={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void create();
                  }}
                >
                  <div className="flex items-center gap-2">
                    <FolderPlusIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <Input
                        autoFocus
                        size="sm"
                        aria-label="New folder name"
                        aria-invalid={createError !== null}
                        aria-describedby={createError === null ? undefined : `${id}-create-error`}
                        placeholder="Folder name"
                        autoComplete="off"
                        spellCheck={false}
                        value={newFolder}
                        disabled={creating}
                        onChange={(event) => {
                          setNewFolder(event.currentTarget.value);
                          setCreateError(null);
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== "Escape") return;
                          // Leaves the name row, not the whole browser.
                          event.stopPropagation();
                          setNewFolder(null);
                          setCreateError(null);
                          filterRef.current?.focus();
                        }}
                      />
                    </div>
                    <Button type="submit" size="sm" disabled={creating}>
                      {creating ? "Creating…" : "Create"}
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost-muted"
                      aria-label="Discard new folder"
                      disabled={creating}
                      onClick={() => {
                        setNewFolder(null);
                        setCreateError(null);
                        filterRef.current?.focus();
                      }}
                    >
                      <XIcon />
                    </Button>
                  </div>
                  {createError === null ? null : (
                    <p
                      id={`${id}-create-error`}
                      role="alert"
                      className="ps-6 text-destructive-foreground text-xs"
                    >
                      {createError}
                    </p>
                  )}
                </form>
              )}
              {problem !== null ? (
                <div
                  role="alert"
                  className="m-auto flex max-w-xs flex-col items-center gap-2 p-4 text-center"
                >
                  <p className="text-sm text-foreground">{problem}</p>
                  <p className="break-all font-mono text-muted-foreground text-xs">
                    {folderPathForInput(location)}
                  </p>
                  <div className="flex gap-2">
                    {parent === null ? null : (
                      <Button size="sm" variant="outline" onClick={() => open(parent)}>
                        Go up
                      </Button>
                    )}
                    {access.canReadFiles && current === null ? (
                      <Button size="sm" variant="outline" onClick={listing.refresh}>
                        Try again
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : pending && shown === null ? (
                <div aria-hidden className="flex flex-col gap-3 p-2">
                  {SKELETON_WIDTHS.map((width) => (
                    <div key={width} className="flex items-center gap-2">
                      <Skeleton className="size-4" />
                      <div className={width}>
                        <Skeleton className="h-3.5 w-full" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : rows.rows.length === 0 ? (
                <p className="m-auto max-w-xs p-4 text-center text-muted-foreground text-sm">
                  {filter.trim().length > 0
                    ? `No folder here matches "${filter.trim()}".`
                    : rows.hiddenCount > 0
                      ? "Only hidden folders are in here."
                      : "No folders in here. Use this folder, or make a new one."}
                </p>
              ) : (
                <ul
                  id={`${id}-list`}
                  role="listbox"
                  aria-label={`Folders in ${folderName(location)}`}
                  aria-disabled={stale || undefined}
                  className={cn("flex flex-col", stale && "pointer-events-none opacity-60")}
                >
                  {rows.rows.map((row, index) => (
                    <li
                      key={row.path}
                      id={`${id}-row-${index}`}
                      ref={index === active ? scrollIntoView : undefined}
                      role="option"
                      aria-selected={index === active}
                      // The filter box keeps focus, so the list is read through it.
                      onMouseDown={(event) => event.preventDefault()}
                      // The second click of a double click would open whatever row came under it.
                      onClick={(event) => {
                        if (!stale && event.detail <= 1) open(row.path);
                      }}
                      className={cn(
                        "flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-md px-2 text-sm",
                        index === active ? "bg-accent text-foreground" : "hover:bg-accent/60",
                      )}
                    >
                      <FolderIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{row.name}</span>
                      {row.isWorkspace ? (
                        <Badge variant="info" size="sm">
                          Workspace
                        </Badge>
                      ) : null}
                      {row.isGitRepository ? (
                        <Badge variant="outline" size="sm">
                          <GitBranchIcon aria-hidden />
                          Git
                        </Badge>
                      ) : null}
                      <ChevronRightIcon
                        aria-hidden
                        className="size-3.5 shrink-0 text-muted-foreground/60"
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {problem !== null ? null : (
              <p className="text-muted-foreground text-xs">
                This folder:{" "}
                <span className="break-all font-mono text-foreground">
                  {folderPathForInput(location)}
                </span>
              </p>
            )}
            <p className="flex min-h-5 flex-wrap items-center gap-x-2 text-muted-foreground text-xs">
              <span aria-live="polite">
                {problem !== null
                  ? null
                  : rows.overflowCount > 0
                    ? `Showing the first ${rows.rows.length} folders. Type to narrow them.`
                    : `${rows.rows.length} folder${rows.rows.length === 1 ? "" : "s"}`}
              </span>
              {showHidden ? (
                <InlineButton onClick={() => setShowHidden(false)}>
                  Hide hidden folders
                </InlineButton>
              ) : rows.hiddenCount > 0 ? (
                <InlineButton onClick={() => setShowHidden(true)}>
                  Show {rows.hiddenCount} hidden
                </InlineButton>
              ) : null}
              <span className="ms-auto max-sm:hidden">Enter opens · Backspace goes up</span>
            </p>
          </div>
        </div>
        <DialogFooter>
          <div className="flex flex-wrap gap-2 sm:me-auto">
            {canCreate ? (
              <Button
                size="sm"
                variant="outline"
                disabled={problem !== null || newFolder !== null}
                onClick={() => setNewFolder("")}
              >
                <FolderPlusIcon />
                New folder
              </Button>
            ) : null}
            {props.onOpenSystemDialog === undefined ? null : (
              <Button size="sm" variant="ghost" onClick={props.onOpenSystemDialog}>
                Open system dialog
              </Button>
            )}
          </div>
          <Button size="sm" variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={!canUse} onClick={use}>
            Use this folder
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
