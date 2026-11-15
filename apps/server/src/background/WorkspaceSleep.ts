import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ProjectionStoreV2 from "../orchestration-v2/ProjectionStore.ts";

/**
 * Keeps a managed workspace up while someone has it open. Once nobody has, and
 * no agent has had work, for its sleep time, it stops; its control server
 * starts it again on the person's next visit.
 */
export class WorkspaceSleep extends Context.Service<
  WorkspaceSleep,
  {
    /** Runs one client connection; the workspace stays up until it ends. */
    readonly whileConnected: <A, E, R>(
      connection: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>()("codenine/background/WorkspaceSleep") {}

/** How often a quiet workspace looks again for agents that are still working. */
export const WORK_CHECK_INTERVAL = Duration.minutes(1);

export const make = Effect.fn("WorkspaceSleep.make")(function* (options: {
  readonly after: Duration.Duration;
  readonly agentsBusy: Effect.Effect<boolean>;
  readonly stop: Effect.Effect<void>;
}) {
  const sleepWhenQuiet = Effect.sleep(options.after).pipe(
    Effect.andThen(
      options.agentsBusy.pipe(
        Effect.repeat({ schedule: Schedule.spaced(WORK_CHECK_INTERVAL), until: (busy) => !busy }),
      ),
    ),
    Effect.andThen(options.stop),
  );
  const wait = yield* FiberHandle.make<void>();
  const lock = yield* Semaphore.make(1);
  let connections = 0;
  yield* FiberHandle.run(wait, sleepWhenQuiet);
  // Under the lock, a connection has cancelled the wait before it runs, and only the last to close starts it over.
  return WorkspaceSleep.of({
    // Untraced: the socket's request span already covers the connection.
    whileConnected: Effect.fnUntraced(function* <A, E, R>(connection: Effect.Effect<A, E, R>) {
      return yield* Effect.acquireUseRelease(
        lock.withPermit(
          Effect.suspend(() => {
            connections += 1;
            return FiberHandle.clear(wait);
          }),
        ),
        () => connection,
        () =>
          lock.withPermit(
            Effect.suspend(() => {
              connections -= 1;
              return connections === 0
                ? FiberHandle.run(wait, sleepWhenQuiet).pipe(Effect.asVoid)
                : Effect.void;
            }),
          ),
      );
    }),
  });
});

const alwaysUp = WorkspaceSleep.of({
  whileConnected: Effect.fnUntraced(function* <A, E, R>(connection: Effect.Effect<A, E, R>) {
    return yield* connection;
  }),
});

export const layer = Layer.effect(
  WorkspaceSleep,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const after = config.managed?.sleepAfter;
    if (after === undefined) {
      return alwaysUp;
    }
    const projections = yield* ProjectionStoreV2.ProjectionStoreV2;
    return yield* make({
      after,
      // The same rule that keeps a thread listed as live: runs, requests, background work, watches.
      agentsBusy: projections.listActiveShellIndex().pipe(
        Effect.map((threads) => threads.some((thread) => thread.mayBeLive)),
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not check for agent work, so the workspace stays up.", {
            cause,
          }).pipe(Effect.as(true)),
        ),
      ),
      stop: Effect.logInfo(
        `Nobody has had this workspace open for ${Duration.format(after)} and no agent is working, so it is going to sleep.`,
      ).pipe(
        // Stop as a SIGTERM would, so the server's shutdown path runs.
        Effect.andThen(Effect.sync(() => void process.emit("SIGTERM"))),
      ),
    });
  }),
);
