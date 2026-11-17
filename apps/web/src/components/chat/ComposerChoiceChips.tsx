import { skillTitle } from "@codenine/contracts";
import { PlugIcon, SparklesIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { type ChatChoicesTarget, useChatChoices } from "./useChatChoices";

/** The chat's connectors and kept-on skills above the message box, each one removable. */
export function ComposerChoiceChips(props: { readonly target: ChatChoicesTarget }) {
  const choices = useChatChoices(props.target);
  if (choices.active.length === 0 && choices.skills.length === 0) return null;
  return (
    <ul aria-label="Used in this chat" className="mb-2.5 flex flex-wrap gap-1.5">
      {choices.active.map((connection) => (
        <Chip
          key={connection.id}
          icon={<PlugIcon />}
          label={connection.name}
          removeLabel={`Turn off ${connection.name} for this chat`}
          disabled={!choices.canChange}
          onRemove={() => void choices.toggleConnection(connection.id, false)}
        />
      ))}
      {choices.skills.map((name) => (
        <Chip
          key={name}
          skill
          icon={<SparklesIcon />}
          label={`Skill: ${skillTitle(name)}`}
          removeLabel={`Stop keeping ${skillTitle(name)} on in this chat`}
          disabled={!choices.canChange}
          onRemove={() => void choices.removeSkill(name)}
        />
      ))}
    </ul>
  );
}

function Chip(props: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly removeLabel: string;
  readonly disabled: boolean;
  readonly skill?: boolean;
  readonly onRemove: () => void;
}) {
  return (
    <li
      className={cn(
        "flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-md ps-2 pe-0.5 text-xs [&>svg]:size-3.5 [&>svg]:shrink-0",
        props.skill ? "bg-primary/10 text-foreground" : "bg-muted text-foreground",
      )}
    >
      {props.icon}
      <span className="min-w-0 truncate">{props.label}</span>
      <Button
        type="button"
        variant="ghost-muted"
        size="icon-micro"
        aria-label={props.removeLabel}
        disabled={props.disabled}
        onClick={props.onRemove}
      >
        <XIcon />
      </Button>
    </li>
  );
}
