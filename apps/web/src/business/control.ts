import {
  ControlApi,
  type ControlMe,
  type ControlMyDepartments,
  type ControlWorkspaceAccess,
  type ControlWorkspaceState,
} from "@codenine/contracts/control";
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

interface ControlStartup {
  readonly me: ControlMe;
  /** Null when the control server could not say. */
  readonly departments: ControlMyDepartments | null;
  /** Null when the control server could not say; the workspace still enforces it. */
  readonly access: ControlWorkspaceAccess | null;
  /** Null when the control server could not say; the first request starts it anyway. */
  readonly workspace: ControlWorkspaceState | null;
}

let startup: Promise<ControlStartup | null> | undefined;
let startupResult: ControlStartup | null = null;

/**
 * The signed-in person, what the licence allows and whether their workspace is
 * asleep, asked once per page load. Signing in and out reload the page, so the
 * answer cannot go stale that way.
 */
export const controlStartup = () =>
  (startup ??= Promise.all([
    fetchControlMe(),
    callControl((client) => client.me.access()).then(
      (access) => access,
      () => null,
    ),
    callControl((client) => client.me.workspace()).then(
      (workspace) => workspace,
      () => null,
    ),
    callControl((client) => client.me.departments()).then(
      (departments) => departments,
      () => null,
    ),
  ]).then(([me, access, workspace, departments]) => {
    startupResult = me === null ? null : { me, access, workspace, departments };
    return startupResult;
  }));

/**
 * Works in another department in this browser. Each department has its own
 * workspace, so the page loads again to open it.
 */
export const chooseDepartment = (departmentId: string) =>
  callControl((client) => client.me.chooseDepartment({ payload: { departmentId } })).then(() =>
    window.location.reload(),
  );

/** What `controlStartup` found; the app renders only after it resolves. */
export const currentControlStartup = () => startupResult;

/** A line under the start-up logo, until the app replaces the start-up screen. */
const showBootStatus = (text: string) => {
  const card = document.getElementById("boot-shell-card");
  if (card === null) return;
  const status = document.getElementById("boot-status") ?? document.createElement("p");
  status.id = "boot-status";
  status.setAttribute("role", "status");
  status.textContent = text;
  card.append(status);
};

let waking: Promise<void> | undefined;

/**
 * Starts the person's workspace when it was asleep, once per page load, and says
 * so on the start-up screen meanwhile. After a failure, the next try starts over.
 */
export const wakeWorkspaceIfAsleep = (found: ControlStartup) => {
  if (found.workspace?.asleep !== true) return Promise.resolve();
  if (waking === undefined) {
    showBootStatus("Starting your workspace…");
    waking = callControl((client) => client.me.wakeWorkspace()).then(
      () => undefined,
      (error: unknown) => {
        waking = undefined;
        throw new Error(controlErrorMessage(error), { cause: error });
      },
    );
  }
  return waking;
};

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
    if (error._tag === "ControlUnavailableError" && "reason" in error) {
      return error.reason === "workspace-unavailable"
        ? "Your workspace did not start. Try again in a moment, and if it keeps failing, ask your admin to check the control server's log."
        : "The control server cannot reach its database. Try again in a moment.";
    }
  }
  return "The control server did not answer. Check your connection and try again.";
}

/** Licence end times are exclusive; people read the last day that is covered. */
export const lastCoveredDay = (iso: string) =>
  new Date(Date.parse(iso) - 86_400_000).toLocaleDateString(undefined, { timeZone: "UTC" });
