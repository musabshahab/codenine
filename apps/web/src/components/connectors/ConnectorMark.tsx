import { cn } from "~/lib/utils";

/** A tile with a name's first letter in place of a logo; connectors are neutral, agents tinted. */
export function ConnectorMark({
  name,
  size = "default",
  tone = "neutral",
}: {
  readonly name: string;
  readonly size?: "sm" | "default" | "lg";
  readonly tone?: "neutral" | "agent";
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center font-semibold",
        tone === "neutral" ? "bg-muted text-muted-foreground" : "bg-primary/10 text-foreground",
        size === "sm" && "size-4.5 rounded-sm text-3xs",
        size === "default" && "size-9 rounded-lg text-sm",
        size === "lg" && "size-12 rounded-xl text-xl",
      )}
    >
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}
