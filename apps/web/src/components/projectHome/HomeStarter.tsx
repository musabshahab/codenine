import type { WorkspacePreset } from "@codenine/shared/workspacePreset";
import { ArrowRightIcon, MessageSquareIcon, UsersIcon } from "lucide-react";
import { useId, useState } from "react";

import { cn } from "~/lib/utils";

import { Button } from "../ui/button";

/**
 * Where a chat in the workspace starts. It is not a composer: the text is handed to a new
 * chat's own composer, where the model, files and Send are, and nothing is sent from here.
 */
export function HomeStarter(props: {
  readonly startScreen: Pick<WorkspacePreset["startScreen"], "headline" | "examples">;
  readonly onStart: (prompt: string, team: boolean) => void;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const start = () => props.onStart(text.trim(), false);
  return (
    <section aria-labelledby={`${id}-headline`} className="flex flex-col gap-3">
      <form
        className="flex flex-col rounded-2xl border border-border bg-card shadow-xs/5 transition-shadow focus-within:border-ring focus-within:ring-1 focus-within:ring-inset focus-within:ring-ring"
        onSubmit={(event) => {
          event.preventDefault();
          start();
        }}
      >
        <label
          id={`${id}-headline`}
          htmlFor={`${id}-prompt`}
          className="px-4 pt-4 font-semibold text-foreground text-lg tracking-tight"
        >
          {props.startScreen.headline}
        </label>
        <textarea
          id={`${id}-prompt`}
          className="field-sizing-content max-h-64 min-h-14 w-full resize-none bg-transparent px-4 py-2 text-base text-foreground outline-none placeholder:text-muted-foreground/72 sm:text-sm"
          rows={2}
          value={text}
          placeholder="Describe it in a sentence or two"
          aria-describedby={`${id}-hint`}
          onChange={(event) => setText(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            start();
          }}
        />
        <div className="flex items-center gap-3 px-3 pb-3">
          <p id={`${id}-hint`} className="min-w-0 flex-1 ps-1 text-muted-foreground text-xs">
            Opens a new chat with this text, ready to send. You can add files there.
          </p>
          <Button type="submit" size="sm">
            Start chat
            <ArrowRightIcon />
          </Button>
        </div>
      </form>
      <ul
        aria-label="Examples"
        className="grid gap-2 max-sm:-mx-4 max-sm:flex max-sm:snap-x max-sm:scroll-px-4 max-sm:overflow-x-auto max-sm:px-4 max-sm:[scrollbar-width:none] sm:grid-cols-3"
      >
        {props.startScreen.examples.map((example) => (
          <li key={example.prompt} className="flex max-sm:w-64 max-sm:shrink-0 max-sm:snap-start">
            <button
              type="button"
              className="flex flex-1 cursor-pointer flex-col gap-1 rounded-xl border border-border/70 bg-card/60 px-3 py-2.5 text-start outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              onClick={() => props.onStart(example.prompt, example.team)}
            >
              <span
                className={cn(
                  "flex items-center gap-1 font-medium text-2xs uppercase tracking-wide",
                  example.team ? "text-primary" : "text-muted-foreground",
                )}
              >
                {example.team ? (
                  <UsersIcon aria-hidden className="size-3" />
                ) : (
                  <MessageSquareIcon aria-hidden className="size-3" />
                )}
                {example.team ? "Team" : "Chat"}
              </span>
              <span className="text-foreground text-sm">{example.prompt}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
