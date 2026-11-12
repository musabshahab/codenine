import { useEffect, useId, useState } from "react";
import { create } from "zustand";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

interface FolderNameRequest {
  readonly title: string;
  readonly action: string;
  readonly initial: string;
  readonly resolve: (name: string | null) => void;
}

const useRequest = create<{ request: FolderNameRequest | null }>(() => ({ request: null }));

/** Asks for a chat folder's name; resolves null when cancelled. */
export function requestFolderName(input: {
  readonly title: string;
  readonly action: string;
  readonly initial?: string;
}): Promise<string | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) =>
    useRequest.setState({ request: { ...input, initial: input.initial ?? "", resolve } }),
  );
}

function finish(name: string | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(name);
}

export function FolderNameDialogHost() {
  const request = useRequest((state) => state.request);
  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- resolves a pending folder name request with null when the dialog host unmounts
  useEffect(() => () => finish(null), []);
  return request ? <FolderNameDialog request={request} /> : null;
}

function FolderNameDialog({ request }: { request: FolderNameRequest }) {
  const id = useId();
  const [name, setName] = useState(request.initial);
  const trimmed = name.trim();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed.length > 0) finish(trimmed);
          }}
        >
          <DialogHeader>
            <DialogTitle>{request.title}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <Label className="flex min-w-0 flex-col items-stretch" htmlFor={`${id}-name`}>
              Name
              <Input
                nativeInput
                id={`${id}-name`}
                autoFocus
                maxLength={64}
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
              />
            </Label>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => finish(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={trimmed.length === 0}>
              {request.action}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
