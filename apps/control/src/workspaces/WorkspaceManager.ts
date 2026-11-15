import * as Cache from "effect/Cache";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** Where the control server reaches one person's workspace server. */
export interface WorkspaceTarget {
  readonly url: string;
  /** The audience of the tokens it accepts; no other workspace accepts them. */
  readonly workspaceId: string;
}

export class WorkspaceUnavailableError extends Schema.TaggedError<WorkspaceUnavailableError>()(
  "WorkspaceUnavailableError",
  { cause: Schema.optionalKey(Schema.Defect()) },
) {
  override get message(): string {
    return "The workspace server is not answering.";
  }
}

/** Finds each person's workspace server, starting it when it is not running. */
export class WorkspaceManager extends Context.Service<
  WorkspaceManager,
  {
    readonly targetFor: (
      personId: string,
    ) => Effect.Effect<WorkspaceTarget, WorkspaceUnavailableError>;
    /** Drops what is known about a workspace that stopped answering, so the next request checks. */
    readonly forget: (personId: string) => Effect.Effect<void>;
    /** Whether the person's workspace is stopped or not made yet, so their next request starts it. */
    readonly isAsleep: (personId: string) => Effect.Effect<boolean, WorkspaceUnavailableError>;
    /** Stops and removes the person's workspace, keeping their files; true when there was one. */
    readonly retire: (personId: string) => Effect.Effect<boolean, WorkspaceUnavailableError>;
    /** Deletes the files of a retired workspace; true when there were some. */
    readonly removeFiles: (personId: string) => Effect.Effect<boolean, WorkspaceUnavailableError>;
  }
>()("@codenine/control/workspaces/WorkspaceManager") {
  /** Everyone reaches one workspace server at `CODENINE_CONTROL_WORKSPACE_URL`. */
  static readonly shared = (target: WorkspaceTarget) =>
    WorkspaceManager.of({
      targetFor: Effect.fn("WorkspaceManager.targetFor")(() => Effect.succeed(target)),
      forget: Effect.fn("WorkspaceManager.forget")(() => Effect.void),
      isAsleep: Effect.fn("WorkspaceManager.isAsleep")(() => Effect.succeed(false)),
      // People share it, so leaving removes nothing.
      retire: Effect.fn("WorkspaceManager.retire")(() => Effect.succeed(false)),
      removeFiles: Effect.fn("WorkspaceManager.removeFiles")(() => Effect.succeed(false)),
    });

  /** No workspace is set up: people can sign in, and every forwarded request fails. */
  static readonly none = WorkspaceManager.of({
    targetFor: Effect.fn("WorkspaceManager.targetFor")(() =>
      Effect.fail(new WorkspaceUnavailableError({ cause: "No workspace is set up." })),
    ),
    forget: Effect.fn("WorkspaceManager.forget")(() => Effect.void),
    isAsleep: Effect.fn("WorkspaceManager.isAsleep")(() => Effect.succeed(false)),
    retire: Effect.fn("WorkspaceManager.retire")(() => Effect.succeed(false)),
    removeFiles: Effect.fn("WorkspaceManager.removeFiles")(() => Effect.succeed(false)),
  });

  /** The shared workspace server, when `CODENINE_CONTROL_WORKSPACE_URL` names one. */
  static readonly sharedFromConfig = Effect.gen(function* () {
    const url = yield* Config.option(Config.String("CODENINE_CONTROL_WORKSPACE_URL"));
    const workspaceId = yield* Config.String("CODENINE_CONTROL_WORKSPACE_ID").pipe(
      Config.withDefault("workspace"),
    );
    return Option.map(url, (value) =>
      WorkspaceManager.shared({ url: value.replace(/\/+$/u, ""), workspaceId }),
    );
  });
}

/** For tests and the shared mode: a fixed manager as a layer. */
export const layerShared = (target: WorkspaceTarget) =>
  Layer.succeed(WorkspaceManager, WorkspaceManager.shared(target));

/**
 * Where each person's workspace answers, found by `start`. Concurrent requests share one start
 * and a failed start is tried again next time.
 */
export const cachedTargets = Effect.fn("WorkspaceManager.cachedTargets")(function* (
  start: (personId: string) => Effect.Effect<WorkspaceTarget, WorkspaceUnavailableError>,
) {
  const targets = yield* Cache.makeWith(start, {
    capacity: 10_000,
    timeToLive: (exit) => (Exit.isFailure(exit) ? Duration.zero : Duration.infinity),
  });
  return {
    targetFor: (personId: string) => Cache.get(targets, personId),
    /** Drops a known target; a start under way finds the workspace afresh, so it stays. */
    forget: Effect.fnUntraced(function* (personId: string) {
      const known = yield* Cache.getSuccess(targets, personId);
      if (Option.isSome(known)) {
        yield* Cache.invalidateWhen(targets, personId, (target) => target === known.value);
      }
    }),
    /** Drops whatever is known, for a workspace that was just removed. */
    drop: (personId: string) => Cache.invalidate(targets, personId),
  };
});
