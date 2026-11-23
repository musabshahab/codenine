import { scopedThreadKey } from "@codenine/client-runtime/environment";
import { squashAtomCommandFailure } from "@codenine/client-runtime/state/runtime";
import {
  AuthFilesystemWriteScope,
  type EnvironmentId,
  REPLY_FILE_MAX_LENGTH,
  type ReplyFileFormat,
  ReplyFileExistsError,
  type ScopedThreadRef,
} from "@codenine/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import { useId, useState } from "react";

import { useEnvironmentScope } from "~/state/session";
import { useRightPanelStore } from "~/rightPanelStore";
import { projectEnvironment } from "~/state/projects";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  defaultReplyFileName,
  REPLY_FILE_FORMATS,
  replyFilePath,
  replyHasTable,
} from "./saveReply.logic";
import { useSaveReplyStore } from "./saveReplyStore";

const isExists = Schema.is(ReplyFileExistsError);

/** Whether this chat can save a reply into its workspace: the server and the connection allow it. */
export function useCanSaveReply(environmentId: EnvironmentId | null, workspaceRoot?: string) {
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const canWrite = useEnvironmentScope(environmentId, AuthFilesystemWriteScope);
  return (
    workspaceRoot !== undefined &&
    canWrite &&
    serverConfig?.environment.capabilities.replyFiles === true
  );
}

/** Mounted once per chat: shows while a reply of this chat is being saved as a file. */
export function SaveReplyDialog(props: {
  readonly threadRef: ScopedThreadRef;
  readonly workspaceRoot: string | undefined;
}) {
  const request = useSaveReplyStore((state) => state.request);
  if (
    request === null ||
    props.workspaceRoot === undefined ||
    request.threadKey !== scopedThreadKey(props.threadRef)
  ) {
    return null;
  }
  return (
    <ConnectedSaveReplyForm
      // A new request starts from its own reply's name.
      key={request.markdown}
      threadRef={props.threadRef}
      cwd={props.workspaceRoot}
      markdown={request.markdown}
    />
  );
}

export type SaveReplyOutcome =
  | { readonly kind: "saved"; readonly relativePath: string }
  /** A file is already there. Saving again with its version replaces it. */
  | { readonly kind: "exists"; readonly currentVersion: string }
  | { readonly kind: "failed"; readonly message: string };

function ConnectedSaveReplyForm(props: {
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string;
  readonly markdown: string;
}) {
  const { threadRef, cwd, markdown } = props;
  const close = useSaveReplyStore((state) => state.close);
  const saveReplyFile = useAtomCommand(projectEnvironment.saveReplyFile, { reportFailure: false });
  return (
    <SaveReplyForm
      markdown={markdown}
      onClose={close}
      save={async (file) => {
        const result = await saveReplyFile({
          environmentId: threadRef.environmentId,
          input: { cwd, markdown, ...file },
        });
        if (result._tag === "Success") {
          close();
          useRightPanelStore.getState().openFile(threadRef, result.value.relativePath);
          toastManager.add({
            type: "success",
            title: "Reply saved",
            description: result.value.relativePath,
          });
          return { kind: "saved", relativePath: result.value.relativePath };
        }
        const failure = squashAtomCommandFailure(result);
        if (isExists(failure)) return { kind: "exists", currentVersion: failure.currentVersion };
        return {
          kind: "failed",
          message: failure instanceof Error ? failure.message : "The reply could not be saved.",
        };
      }}
    />
  );
}

export function SaveReplyForm(props: {
  readonly markdown: string;
  readonly onClose: () => void;
  readonly save: (file: {
    readonly relativePath: string;
    readonly format: ReplyFileFormat;
    readonly replaceVersion?: string;
  }) => Promise<SaveReplyOutcome>;
}) {
  const { markdown, onClose: close } = props;
  const id = useId();
  const hasTable = replyHasTable(markdown);
  const [format, setFormat] = useState<ReplyFileFormat>("markdown");
  const [name, setName] = useState(() => defaultReplyFileName(markdown));
  const [folder, setFolder] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // The file found at the path, which the user must agree to replace.
  const [existing, setExisting] = useState<{ path: string; version: string } | null>(null);
  const path = replyFilePath(folder, name, format);
  const tooLong = markdown.length > REPLY_FILE_MAX_LENGTH;
  const replacing = path.ok && existing?.path === path.relativePath ? existing : null;

  const save = async () => {
    if (!path.ok || tooLong) return;
    setSaving(true);
    setProblem(null);
    const outcome = await props.save({
      relativePath: path.relativePath,
      format,
      ...(replacing === null ? {} : { replaceVersion: replacing.version }),
    });
    setSaving(false);
    if (outcome.kind === "exists") {
      setExisting({ path: path.relativePath, version: outcome.currentVersion });
    } else if (outcome.kind === "failed") setProblem(outcome.message);
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : close())}>
      <DialogPopup>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>Save reply as file</DialogTitle>
            <DialogDescription>
              The file is saved in this workspace's folder and opens beside the chat.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label id={`${id}-format`}>Format</Label>
                <ToggleGroup
                  aria-labelledby={`${id}-format`}
                  value={[format]}
                  onValueChange={(next) => {
                    const value = REPLY_FILE_FORMATS.find((entry) => entry.format === next[0]);
                    if (value) setFormat(value.format);
                  }}
                >
                  {REPLY_FILE_FORMATS.map((entry) => (
                    <Toggle
                      key={entry.format}
                      value={entry.format}
                      disabled={entry.format === "xlsx" && !hasTable}
                    >
                      {entry.label}
                    </Toggle>
                  ))}
                </ToggleGroup>
                <p className="text-xs text-muted-foreground">
                  {format === "xlsx"
                    ? "The reply's first table becomes a sheet. Its other text is left out."
                    : format === "pdf"
                      ? "The reply as pages of text. Characters outside Western European text print as a question mark."
                      : hasTable
                        ? "The reply as it was written."
                        : "The reply as it was written. Spreadsheet needs a reply with a table."}
                </p>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${id}-name`}>File name</Label>
                <Input
                  id={`${id}-name`}
                  value={name}
                  autoFocus
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${id}-folder`}>Folder in the workspace</Label>
                <Input
                  id={`${id}-folder`}
                  value={folder}
                  placeholder="Top of the workspace"
                  onChange={(event) => setFolder(event.target.value)}
                />
              </div>
              <p role="status" className="text-xs break-all text-muted-foreground">
                {path.ok ? `Saves to ${path.relativePath}` : path.problem}
              </p>
              {replacing !== null ? (
                <p role="alert" className="text-xs text-warning-foreground">
                  A file is already at {replacing.path}. Replace it, or change the name.
                </p>
              ) : null}
              {tooLong ? (
                <p role="alert" className="text-xs text-destructive">
                  This reply is too long to save as a file.
                </p>
              ) : null}
              {problem !== null ? (
                <p role="alert" className="text-xs text-destructive">
                  {problem}
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost-muted" onClick={close}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={replacing === null ? "default" : "destructive"}
              disabled={!path.ok || saving || tooLong}
            >
              {replacing === null ? "Save" : "Replace file"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
