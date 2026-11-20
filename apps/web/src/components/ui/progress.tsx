import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

/** A bar for work that reports how far it is. A value is required: an indeterminate bar animates. */
function Progress({
  className,
  ...props
}: Omit<ComponentProps<"progress">, "value" | "children"> & { readonly value: number }) {
  return (
    <progress
      data-slot="progress"
      className={cn(
        "h-2 w-full appearance-none overflow-hidden rounded-full bg-muted [&::-moz-progress-bar]:rounded-full [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-primary",
        className,
      )}
      {...props}
    />
  );
}

export { Progress };
