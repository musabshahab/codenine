import { useState } from "react";

import { cn } from "../../lib/utils";
import { InlineButton } from "../ui/button";

const LONG_RESULT_CHARS = 280;
const LONG_RESULT_LINES = 4;

/** A team task's result, clamped to three lines when long; `failed` reads as an error. */
export function TeamResultText(props: { text: string; failed?: boolean }) {
  const { text } = props;
  const [expanded, setExpanded] = useState(false);
  const long = text.length > LONG_RESULT_CHARS || text.split("\n").length > LONG_RESULT_LINES;
  return (
    <div className="flex flex-col items-start gap-0.5">
      <p
        className={cn(
          "whitespace-pre-wrap break-words",
          props.failed ? "text-error-foreground" : "text-muted-foreground",
          long && !expanded && "line-clamp-3",
        )}
      >
        {text}
      </p>
      {long ? (
        <InlineButton tone="muted" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : "Show more"}
        </InlineButton>
      ) : null}
    </div>
  );
}
