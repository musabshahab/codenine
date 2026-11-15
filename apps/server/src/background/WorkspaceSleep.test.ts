import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as WorkspaceSleep from "./WorkspaceSleep.ts";

const setup = Effect.fn(function* (options: { readonly agentsBusy: boolean }) {
  const stopped = yield* Deferred.make<void>();
  const agentsBusy = yield* Ref.make(options.agentsBusy);
  const sleep = yield* WorkspaceSleep.make({
    after: Duration.minutes(30),
    agentsBusy: Ref.get(agentsBusy),
    stop: Deferred.succeed(stopped, undefined).pipe(Effect.asVoid),
  });
  /** Opens a connection; the effect it returns closes it. */
  const connect = Effect.gen(function* () {
    const opened = yield* Deferred.make<void>();
    const close = yield* Deferred.make<void>();
    const connection = yield* sleep
      .whileConnected(
        Deferred.succeed(opened, undefined).pipe(Effect.andThen(Deferred.await(close))),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(opened);
    return Deferred.succeed(close, undefined).pipe(Effect.andThen(Fiber.join(connection)));
  });
  return { isStopped: Deferred.isDone(stopped), agentsBusy, connect };
});

describe("WorkspaceSleep", () => {
  it.effect(
    "sleeps once nobody has been connected for the sleep time, from the last to leave",
    () =>
      Effect.gen(function* () {
        const { isStopped, connect } = yield* setup({ agentsBusy: false });
        yield* TestClock.adjust("29 minutes");
        const closeFirst = yield* connect;
        const closeSecond = yield* connect;
        yield* closeFirst;
        yield* TestClock.adjust("2 hours");
        expect(yield* isStopped).toBe(false);

        yield* closeSecond;
        yield* TestClock.adjust("29 minutes");
        expect(yield* isStopped).toBe(false);
        yield* TestClock.adjust("1 minute");
        expect(yield* isStopped).toBe(true);
      }),
  );

  it.effect("stays up while agents have work, and sleeps soon after they finish", () =>
    Effect.gen(function* () {
      const { isStopped, agentsBusy } = yield* setup({ agentsBusy: true });
      yield* TestClock.adjust("3 hours");
      expect(yield* isStopped).toBe(false);

      yield* Ref.set(agentsBusy, false);
      yield* TestClock.adjust(WorkspaceSleep.WORK_CHECK_INTERVAL);
      expect(yield* isStopped).toBe(true);
    }),
  );
});
