import { MessageSquareIcon, UsersIcon } from "lucide-react";

import {
  type ComposerThreadTarget,
  useComposerDraftHasUserContent,
  useComposerDraftStore,
  useComposerTeamRequested,
  useComposerWorkflowRequested,
} from "~/composerDraftStore";
import { cn } from "~/lib/utils";
import type { ChatComposerHandle } from "./ChatComposer";
import { draftHeroExamples } from "./composerTeam.logic";

/** The quiet line under the composer while Team or Workflow is on. */
export function ComposerRequestNote(props: {
  target: ComposerThreadTarget;
  teamOffered: boolean;
  workflowOffered: boolean;
  className?: string;
}) {
  const team = useComposerTeamRequested(props.target) && props.teamOffered;
  const workflow = useComposerWorkflowRequested(props.target) && props.workflowOffered;
  if (!team && !workflow) return null;
  return (
    <p className={cn("text-center text-muted-foreground text-xs", props.className)}>
      {team
        ? "The lead agent will plan a team and show it to you. Nothing runs until you approve it."
        : "The lead agent will draft a workflow for you to review. Nothing is saved until you save it."}
    </p>
  );
}

/** Starting points under an empty new chat. A pick fills the composer; it never sends. */
export function DraftHeroExamples(props: {
  target: ComposerThreadTarget;
  hasProject: boolean;
  teamOffered: boolean;
  composerRef: { readonly current: ChatComposerHandle | null };
}) {
  const composerEmpty = !useComposerDraftHasUserContent(props.target);
  const workflowRequested = useComposerWorkflowRequested(props.target);
  const setTeamRequested = useComposerDraftStore((store) => store.setTeamRequested);
  const examples = draftHeroExamples({
    hasProject: props.hasProject,
    composerEmpty,
    teamAvailable: props.teamOffered,
    workflowRequested,
  });
  if (examples.length === 0) return null;
  return (
    <section aria-label="Examples" className="grid gap-2 sm:grid-cols-3">
      {examples.map((example) => (
        <button
          key={example.prompt}
          type="button"
          className="flex cursor-pointer flex-col gap-1 rounded-xl border border-border/70 bg-card/60 px-3 py-2.5 text-start outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={() => {
            const filled = props.composerRef.current?.insertTextAtEnd(example.prompt) === true;
            if (filled && example.team) setTeamRequested(props.target, true);
          }}
        >
          <span
            className={cn(
              "flex items-center gap-1 font-medium text-2xs uppercase tracking-wide",
              example.team ? "text-primary" : "text-muted-foreground",
            )}
          >
            {example.team ? (
              <UsersIcon aria-hidden="true" className="size-3" />
            ) : (
              <MessageSquareIcon aria-hidden="true" className="size-3" />
            )}
            {example.team ? "Team" : "Chat"}
          </span>
          <span className="text-foreground text-sm">{example.prompt}</span>
        </button>
      ))}
    </section>
  );
}
