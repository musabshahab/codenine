import { cn } from "~/lib/utils";

/** A neutral tile with the connector's first letter, in place of a logo. */
export function ConnectorMark({
  name,
  size = "default",
}: {
  readonly name: string;
  readonly size?: "sm" | "default" | "lg";
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center bg-muted font-semibold text-muted-foreground",
        size === "sm" && "size-4.5 rounded-sm text-3xs",
        size === "default" && "size-9 rounded-lg text-sm",
        size === "lg" && "size-12 rounded-xl text-xl",
      )}
    >
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}
