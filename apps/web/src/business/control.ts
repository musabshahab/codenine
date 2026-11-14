import { ControlApi, type ControlMe } from "@codenine/contracts/control";
import type { LicenceProblem } from "@codenine/contracts/licence";
import { layerRemoteHttpClient } from "@codenine/client-runtime/rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

// The control server serves this app, so it answers on this origin with its own cookie.
const makeControlClient = Effect.suspend(() =>
  HttpApiClient.make(ControlApi, { baseUrl: window.location.origin }),
);
export type ControlClient = Effect.Success<typeof makeControlClient>;

const layerControlHttp = Layer.merge(
  // Looked up per call, so tests can replace fetch.
  layerRemoteHttpClient((input, init) => globalThis.fetch(input, init)),
  Layer.succeed(FetchHttpClient.RequestInit, { credentials: "same-origin" }),
);

/** Calls the control server. Rejects with its typed error; see `controlErrorMessage`. */
export const callControl = <A, E>(call: (client: ControlClient) => Effect.Effect<A, E>) =>
  Effect.runPromise(makeControlClient.pipe(Effect.flatMap(call), Effect.provide(layerControlHttp)));

/** The signed-in person, or null when nobody is signed in. */
export const fetchControlMe = () =>
  callControl((client) =>
    client.me.me().pipe(
      Effect.map((me): ControlMe | null => me),
      Effect.catchTags({ ControlSignedOutError: () => Effect.succeed(null) }),
    ),
  );

const LICENCE_PROBLEMS: Record<LicenceProblem, string> = {
  malformed: "This is not a Codenine licence key.",
  "unknown-key": "This licence key was signed with a key this installation does not trust.",
  "invalid-signature": "This licence key has been altered or damaged.",
  "wrong-type": "This key is not a Codenine licence.",
  "invalid-claims": "This licence key is missing or has invalid details.",
  "wrong-installation": "This licence key belongs to a different installation.",
};

/** A sentence for people from whatever a control call rejected with. */
export function controlErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    if (error._tag === "ControlLicenceInstallError" && "problem" in error) {
      return (
        LICENCE_PROBLEMS[error.problem as LicenceProblem] ?? "This licence key cannot be used."
      );
    }
    if (
      (error._tag === "ControlAccountError" ||
        error._tag === "ControlSignInError" ||
        error._tag === "ControlSignedOutError" ||
        error._tag === "ControlForbiddenError") &&
      error instanceof Error
    ) {
      return error.message;
    }
  }
  return "The control server did not answer. Check your connection and try again.";
}

/** Licence end times are exclusive; people read the last day that is covered. */
export const lastCoveredDay = (iso: string) =>
  new Date(Date.parse(iso) - 86_400_000).toLocaleDateString(undefined, { timeZone: "UTC" });
