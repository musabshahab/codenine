import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

/** A titled block of the workspace home page. */
export function HomeSection(props: {
  readonly title: string;
  /** Shown muted beside the title, such as a count. */
  readonly note?: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <section aria-label={props.title} className={cn("flex flex-col gap-2", props.className)}>
      <div className="flex min-h-7 items-center gap-2">
        <h3 className="font-medium text-foreground text-sm">{props.title}</h3>
        {props.note ? (
          <span className="text-muted-foreground text-xs tabular-nums">{props.note}</span>
        ) : null}
        {props.actions ? (
          <div className="ms-auto flex items-center gap-2 text-xs">{props.actions}</div>
        ) : null}
      </div>
      {props.children}
    </section>
  );
}

/** What a section shows in place of its list: what belongs here and how to get it. */
export function HomeEmpty(props: { readonly className?: string; readonly children: ReactNode }) {
  return (
    <p
      className={cn(
        "flex items-center rounded-xl border border-border border-dashed px-4 py-3 text-muted-foreground text-sm",
        props.className,
      )}
    >
      <span>{props.children}</span>
    </p>
  );
}

/** A bordered block in the side column. */
export function HomeCard(props: {
  readonly title: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section
      aria-label={props.title}
      className="flex flex-col gap-1 rounded-xl border border-border bg-card p-3"
    >
      <div className="flex min-h-6 items-center gap-2 px-1">
        <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          {props.title}
        </h3>
        {props.action ? <div className="ms-auto flex text-xs">{props.action}</div> : null}
      </div>
      {props.children}
    </section>
  );
}
