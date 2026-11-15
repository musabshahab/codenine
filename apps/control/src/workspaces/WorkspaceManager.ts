import * as Cache from "effect/Cache";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** One person's workspace in one of their departments, or outside any department. */
export interface WorkspaceKey {
  readonly personId: string;
  readonly departmentId: string | null;
}

/**
 * The workspace's ID, which its tokens are for: the person's ID, and the
 * department's after a dot. Neither kind of ID has dots of its own.
 */
export const workspaceIdOf = (key: WorkspaceKey) =>
  key.departmentId === null ? key.personId : `${key.personId}.${key.departmentId}`;

const keyOf = (workspaceId: string): WorkspaceKey => {
  const [personId = workspaceId, departmentId] = workspaceId.split(".");
  return { personId, departmentId: departmentId ?? null };
};

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

/** Finds each workspace server, starting it when it is not running. */
export class WorkspaceManager extends Context.Service<
  WorkspaceManager,
  {
    readonly targetFor: (
      key: WorkspaceKey,
    ) => Effect.Effect<WorkspaceTarget, WorkspaceUnavailableError>;
    /** Drops what is known about a workspace that stopped answering, so the next request checks. */
    readonly forget: (key: WorkspaceKey) => Effect.Effect<void>;
    /** Gives those workspaces already made the network their profiles now set. */
    readonly applyNetwork: (
      keys: ReadonlyArray<WorkspaceKey>,
    ) => Effect.Effect<void, WorkspaceUnavailableError>;
    /** Whether the workspace is stopped or not made yet, so the next request starts it. */
    readonly isAsleep: (key: WorkspaceKey) => Effect.Effect<boolean, WorkspaceUnavailableError>;
    /** Stops and removes one workspace, keeping its files; true when there was one. */
    readonly retire: (key: WorkspaceKey) => Effect.Effect<boolean, WorkspaceUnavailableError>;
    /** Stops and removes all of a person's workspaces, keeping their files. */
    readonly retireAll: (personId: string) => Effect.Effect<boolean, WorkspaceUnavailableError>;
    /** Deletes the files of all of a person's workspaces; true when there were some. */
    readonly removeFiles: (personId: string) => Effect.Effect<boolean, WorkspaceUnavailableError>;
  }
>()("@codenine/control/workspaces/WorkspaceManager") {
  /** Everyone reaches one workspace server at `CODENINE_CONTROL_WORKSPACE_URL`. */
  static readonly shared = (target: WorkspaceTarget) =>
    WorkspaceManager.of({
      targetFor: Effect.fn("WorkspaceManager.targetFor")(() => Effect.succeed(target)),
      forget: Effect.fn("WorkspaceManager.forget")(() => Effect.void),
      // It reaches out however its own server allows.
      applyNetwork: Effect.fn("WorkspaceManager.applyNetwork")(() => Effect.void),
      isAsleep: Effect.fn("WorkspaceManager.isAsleep")(() => Effect.succeed(false)),
      // People share it, so leaving removes nothing.
      retire: Effect.fn("WorkspaceManager.retire")(() => Effect.succeed(false)),
      retireAll: Effect.fn("WorkspaceManager.retireAll")(() => Effect.succeed(false)),
      removeFiles: Effect.fn("WorkspaceManager.removeFiles")(() => Effect.succeed(false)),
    });

  /** No workspace is set up: people can sign in, and every forwarded request fails. */
  static readonly none = WorkspaceManager.of({
    targetFor: Effect.fn("WorkspaceManager.targetFor")(() =>
      Effect.fail(new WorkspaceUnavailableError({ cause: "No workspace is set up." })),
    ),
    forget: Effect.fn("WorkspaceManager.forget")(() => Effect.void),
    applyNetwork: Effect.fn("WorkspaceManager.applyNetwork")(() => Effect.void),
    isAsleep: Effect.fn("WorkspaceManager.isAsleep")(() => Effect.succeed(false)),
    retire: Effect.fn("WorkspaceManager.retire")(() => Effect.succeed(false)),
    retireAll: Effect.fn("WorkspaceManager.retireAll")(() => Effect.succeed(false)),
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
 * Where each workspace answers, found by `start`. Concurrent requests share one start and a
 * failed start is tried again next time.
 */
export const cachedTargets = Effect.fn("WorkspaceManager.cachedTargets")(function* (
  start: (key: WorkspaceKey) => Effect.Effect<WorkspaceTarget, WorkspaceUnavailableError>,
) {
  const targets = yield* Cache.makeWith((workspaceId: string) => start(keyOf(workspaceId)), {
    capacity: 10_000,
    timeToLive: (exit) => (Exit.isFailure(exit) ? Duration.zero : Duration.infinity),
  });
  return {
    targetFor: (key: WorkspaceKey) => Cache.get(targets, workspaceIdOf(key)),
    /** Drops a known target; a start under way finds the workspace afresh, so it stays. */
    forget: Effect.fnUntraced(function* (key: WorkspaceKey) {
      const workspaceId = workspaceIdOf(key);
      const known = yield* Cache.getSuccess(targets, workspaceId);
      if (Option.isSome(known)) {
        yield* Cache.invalidateWhen(targets, workspaceId, (target) => target === known.value);
      }
    }),
    /** Drops whatever is known, for a workspace that was just removed. */
    drop: (workspaceId: string) => Cache.invalidate(targets, workspaceId),
  };
});
