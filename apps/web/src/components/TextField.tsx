import { useId } from "react";

import { Input } from "./ui/input";
import { Label } from "./ui/label";

/** A labelled one-line field with an optional hint and error, for dialogs and forms. */
export function TextField(props: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly secret?: boolean | undefined;
  readonly placeholder?: string | undefined;
  readonly hint?: string | undefined;
  readonly error?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly font?: "default" | "mono" | undefined;
}) {
  const id = useId();
  const describedBy = [props.hint ? `${id}-hint` : null, props.error ? `${id}-error` : null]
    .filter((part) => part !== null)
    .join(" ");
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{props.label}</Label>
      <Input
        id={id}
        type={props.secret ? "password" : "text"}
        font={props.font ?? "default"}
        autoComplete="off"
        spellCheck={false}
        value={props.value}
        placeholder={props.placeholder}
        disabled={props.disabled}
        aria-invalid={props.error !== undefined || undefined}
        aria-describedby={describedBy === "" ? undefined : describedBy}
        onChange={(event) => props.onChange(event.currentTarget.value)}
      />
      {props.hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {props.hint}
        </p>
      ) : null}
      {props.error === undefined ? null : (
        <p id={`${id}-error`} className="text-xs text-destructive-foreground">
          {props.error}
        </p>
      )}
    </div>
  );
}
