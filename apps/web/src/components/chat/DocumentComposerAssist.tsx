import { FileTextIcon, PlusIcon } from "lucide-react";

import { type ComposerThreadTarget, useComposerDraftHasUserContent } from "~/composerDraftStore";
import {
  documentContextLabel,
  documentSelectionKey,
  documentSuggestions,
  setDocumentContextDismissed,
  useDocumentContextDismissed,
  useDocumentSelection,
} from "~/documentContext";

import { Button } from "../ui/button";
import type { ChatComposerHandle } from "./ChatComposer";
import { ChoiceChip } from "./ComposerChoiceChips";

/**
 * Above the message box in document view: the chip naming the open file and its selection, which
 * the next message carries, and a few things to ask about that kind of file. A file attached to
 * the chat is already part of it, so it gets the suggestions and no chip.
 */
export function DocumentComposerAssist(props: {
  readonly threadKey: string;
  readonly target: ComposerThreadTarget;
  readonly cwd: string;
  /** Relative to the workspace folder, or an attachment's name. */
  readonly relativePath: string;
  readonly attached: boolean;
  readonly composerRef: { readonly current: ChatComposerHandle | null };
}) {
  const selection = useDocumentSelection(documentSelectionKey(props.cwd, props.relativePath));
  const dismissed = useDocumentContextDismissed(props.threadKey);
  const composerEmpty = !useComposerDraftHasUserContent(props.target);
  const label = documentContextLabel(props.relativePath, selection);
  const suggestions = composerEmpty ? documentSuggestions(props.relativePath, props.attached) : [];
  if (props.attached && suggestions.length === 0) return null;
  return (
    <div className="mb-2 flex flex-col gap-1.5" data-document-composer-assist>
      {props.attached ? null : dismissed ? (
        <div>
          <Button
            type="button"
            size="micro"
            variant="ghost-muted"
            onClick={() => setDocumentContextDismissed(props.threadKey, false)}
          >
            <PlusIcon />
            Add this file to the message
          </Button>
        </div>
      ) : (
        <ul aria-label="Sent with your message" className="flex min-w-0">
          <ChoiceChip
            icon={<FileTextIcon />}
            label={label}
            removeLabel={`Leave ${label} out of this message`}
            disabled={false}
            onRemove={() => setDocumentContextDismissed(props.threadKey, true)}
          />
        </ul>
      )}
      {suggestions.length > 0 ? (
        <ul aria-label="Suggestions" className="flex flex-wrap gap-1.5">
          {suggestions.map((suggestion) => (
            <li key={suggestion}>
              <Button
                type="button"
                size="xs-pill"
                variant="outline"
                onClick={() => {
                  props.composerRef.current?.insertTextAtEnd(suggestion);
                  props.composerRef.current?.focusAtEnd();
                }}
              >
                {suggestion}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
