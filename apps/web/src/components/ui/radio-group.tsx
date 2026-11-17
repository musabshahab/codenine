import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { type ReactNode, useId } from "react";

import { cn } from "~/lib/utils";

function RadioGroup({ className, ...props }: RadioGroupPrimitive.Props) {
  return (
    <RadioGroupPrimitive
      className={cn("flex flex-col gap-3", className)}
      data-slot="radio-group"
      {...props}
    />
  );
}

function Radio({ className, ...props }: RadioPrimitive.Root.Props) {
  return (
    <RadioPrimitive.Root
      className={cn(
        "relative inline-flex size-4.5 shrink-0 items-center justify-center rounded-full border border-input bg-background not-dark:bg-clip-padding shadow-xs/5 outline-none transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-full not-data-disabled:not-data-checked:not-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring aria-invalid:border-destructive/36 focus-visible:aria-invalid:border-destructive/64 focus-visible:aria-invalid:outline-destructive/48 data-disabled:opacity-64 sm:size-4 dark:not-data-checked:bg-input/32 dark:focus-visible:aria-invalid:outline-destructive/24 dark:not-data-disabled:not-data-checked:not-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/6%)] [[data-disabled],[data-checked],[aria-invalid]]:shadow-none",
        className,
      )}
      data-slot="radio"
      {...props}
    >
      <RadioPrimitive.Indicator
        className="-inset-px absolute flex size-4.5 items-center justify-center rounded-full before:size-2 before:rounded-full before:bg-primary-foreground data-unchecked:hidden data-checked:bg-primary sm:size-4 sm:before:size-1.5 in-[[data-slot=radio]:focus-visible]:inset-shadow-[0_0_0_3px_var(--background)] in-[[data-slot=radio]:focus-visible]:outline-2 in-[[data-slot=radio]:focus-visible]:outline-solid in-[[data-slot=radio]:focus-visible]:-outline-offset-2 in-[[data-slot=radio]:focus-visible]:outline-inherit"
        data-slot="radio-indicator"
      />
    </RadioPrimitive.Root>
  );
}

/** A bordered choice in a RadioGroup; the selected card opens below for its own fields. */
function RadioCard({
  value,
  title,
  description,
  selected,
  disabled = false,
  children,
}: {
  readonly value: string;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly selected: boolean;
  readonly disabled?: boolean;
  readonly children?: ReactNode;
}) {
  const id = useId();
  return (
    <div
      data-slot="radio-card"
      className={cn(
        "rounded-lg border transition-colors",
        selected ? "border-primary/48 bg-primary/4" : "border-border",
      )}
    >
      <label
        className={cn(
          "flex items-start gap-3 px-3 py-2.5",
          disabled ? "cursor-not-allowed opacity-64" : "cursor-pointer",
        )}
      >
        <span className="flex h-5 items-center">
          <Radio
            value={value}
            disabled={disabled}
            aria-labelledby={`${id}-title`}
            aria-describedby={description === undefined ? undefined : `${id}-description`}
          />
        </span>
        <span className="flex min-w-0 flex-col">
          <span id={`${id}-title`} className="font-medium text-foreground text-sm">
            {title}
          </span>
          {description === undefined ? null : (
            <span id={`${id}-description`} className="text-muted-foreground text-xs">
              {description}
            </span>
          )}
        </span>
      </label>
      {selected && children !== undefined ? (
        <div className="flex flex-col gap-2 ps-10 pe-3 pb-3">{children}</div>
      ) : null}
    </div>
  );
}

export { RadioGroup, Radio, Radio as RadioGroupItem, RadioCard };
