import {
  MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
} from "@codenine/contracts/settings";
import { useState } from "react";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";

export function AutoSettleDaysInput({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (days: number) => void;
}) {
  // Every save starts a settlement sweep, so typing stays local until the field commits
  // (blur, Enter, or a step): typing 30 must never save 3 on the way.
  const [draft, setDraft] = useState<number | null>(value);
  const [draftSource, setDraftSource] = useState(value);
  if (draftSource !== value) {
    setDraftSource(value);
    setDraft(value);
  }

  return (
    <NumberField
      size="sm"
      className="w-full sm:w-32"
      min={MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
      max={MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
      step={1}
      value={draft}
      onValueChange={setDraft}
      onValueCommitted={(next) => {
        if (next === null) {
          setDraft(value);
          return;
        }
        const days = Math.min(
          MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
          Math.max(MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS, Math.round(next)),
        );
        setDraft(days);
        if (days !== value) onCommit(days);
      }}
    >
      <NumberFieldGroup>
        <NumberFieldDecrement aria-label="Fewer days" />
        <NumberFieldInput
          aria-label="Days of inactivity before marking done"
          // Base UI commits on blur but not on Enter; refocus so keyboard users stay put.
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            const input = event.currentTarget;
            input.blur();
            input.focus();
          }}
        />
        <NumberFieldIncrement aria-label="More days" />
      </NumberFieldGroup>
    </NumberField>
  );
}
