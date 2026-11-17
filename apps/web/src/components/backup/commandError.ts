import { squashAtomCommandFailure } from "@codenine/client-runtime/state/runtime";
import type * as Cause from "effect/Cause";

/** What a failed backup command shows; backup errors carry text written for the user. */
export function commandErrorMessage(
  result: { readonly cause: Cause.Cause<unknown> },
  fallback: string,
): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim() !== "" ? error.message : fallback;
}
