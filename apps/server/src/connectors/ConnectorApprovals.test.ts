import {
  type ConnectorApprovalAnswer,
  DEFAULT_CONNECTOR_APPROVALS,
  type OrchestrationV2ConnectorApprovalStatus,
  ThreadId,
  TurnItemId,
} from "@codenine/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ConnectorApprovals from "./ConnectorApprovals.ts";

const threadId = ThreadId.make("thread:connector-approvals");
const turnItemId = TurnItemId.make("turn-item:connector-approval:1");

describe("toolRisk", () => {
  it.each([
    ["a pin wins over the annotations", { readOnlyHint: true }, "irreversible", "irreversible"],
    ["read-only annotations read", { readOnlyHint: true }, undefined, "read"],
    ["non-destructive annotations change", { destructiveHint: false }, undefined, "change"],
    [
      "destructive annotations are irreversible",
      { destructiveHint: true },
      undefined,
      "irreversible",
    ],
    ["no annotations count as irreversible", undefined, undefined, "irreversible"],
  ] as const)("%s", (_name, annotations, pin, expected) => {
    const tool = { name: "send", ...(annotations === undefined ? {} : { annotations }) };
    assert.strictEqual(
      ConnectorApprovals.toolRisk(tool, pin === undefined ? undefined : { send: pin }),
      expected,
    );
  });

  it("an agent's choice for the group decides in its chats; elsewhere the action's own choice wins", () => {
    const decide = (
      toolApprovals: Record<string, "auto" | "ask">,
      agentApprovals?: { readonly irreversible?: "auto" | "ask"; readonly read?: "auto" | "ask" },
    ) =>
      ConnectorApprovals.toolApproval({
        tool: "send",
        risk: "irreversible",
        approvals: DEFAULT_CONNECTOR_APPROVALS,
        toolApprovals,
        agentApprovals,
      });
    assert.deepStrictEqual(decide({}), { mode: "ask", byAgent: false });
    assert.deepStrictEqual(decide({ send: "auto" }), { mode: "auto", byAgent: false });
    assert.deepStrictEqual(decide({ other: "auto" }), { mode: "ask", byAgent: false });
    assert.deepStrictEqual(decide({}, { irreversible: "auto" }), { mode: "auto", byAgent: true });
    assert.deepStrictEqual(decide({ send: "auto" }, { read: "ask" }), {
      mode: "auto",
      byAgent: false,
    });
    assert.deepStrictEqual(decide({ send: "ask" }, { irreversible: "auto" }), {
      mode: "auto",
      byAgent: true,
    });
    assert.deepStrictEqual(decide({ send: "auto" }, { irreversible: "ask" }), {
      mode: "ask",
      byAgent: true,
    });
  });
});

const askWithRecorder = Effect.fn(function* (canRemember: boolean) {
  const approvals = yield* ConnectorApprovals.ConnectorApprovals;
  const recorded = yield* Ref.make<
    ReadonlyArray<readonly [OrchestrationV2ConnectorApprovalStatus, boolean]>
  >([]);
  const remembered = yield* Ref.make(0);
  const shown = yield* Deferred.make<void>();
  const waiting = yield* Deferred.make<void>();
  const runEnded = yield* Deferred.make<void>();
  const fiber = yield* approvals
    .ask({
      threadId,
      turnItemId,
      record: (status, remember) =>
        Ref.update(recorded, (current) => [...current, [status, remember] as const]).pipe(
          Effect.andThen(status === "pending" ? Deferred.succeed(shown, undefined) : Effect.void),
          Effect.asVoid,
        ),
      ...(canRemember ? { remember: Ref.update(remembered, (count) => count + 1) } : {}),
      ended: Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Deferred.await(runEnded))),
    })
    .pipe(Effect.forkChild);
  yield* Deferred.await(shown);
  yield* Deferred.await(waiting);
  const answer = (value: ConnectorApprovalAnswer) =>
    approvals.answer({ threadId, turnItemId, answer: value });
  return { fiber, answer, recorded, remembered, runEnded };
}, Effect.provide(ConnectorApprovals.layer));

describe("ConnectorApprovals.ask", () => {
  it.effect.each([
    ["allow", "allowed", true, false, 0],
    ["always", "allowed", true, true, 1],
    // An agent's settings decide its chats, so "always" there allows just this once.
    ["always", "allowed", false, false, 0],
    ["decline", "declined", true, false, 0],
  ] as const)(
    "%s closes the card as %s",
    ([answer, outcome, canRemember, remembered, rememberCalls]) =>
      Effect.gen(function* () {
        const harness = yield* askWithRecorder(canRemember);
        assert.strictEqual(yield* harness.answer(answer), "answered");
        assert.strictEqual(yield* Fiber.join(harness.fiber), outcome);
        assert.deepStrictEqual(yield* Ref.get(harness.recorded), [
          ["pending", false],
          [outcome, remembered],
        ]);
        assert.strictEqual(yield* Ref.get(harness.remembered), rememberCalls);
        // A second answer finds nothing waiting.
        assert.strictEqual(yield* harness.answer("allow"), "not-waiting");
      }),
  );

  it.effect("no answer within the wait cancels the card", () =>
    Effect.gen(function* () {
      const harness = yield* askWithRecorder(true);
      yield* TestClock.adjust("10 minutes");
      assert.strictEqual(yield* Fiber.join(harness.fiber), "cancelled");
      assert.deepStrictEqual(yield* Ref.get(harness.recorded), [
        ["pending", false],
        ["cancelled", false],
      ]);
      assert.strictEqual(yield* harness.answer("allow"), "not-waiting");
    }),
  );

  it.effect("the run ending cancels the card", () =>
    Effect.gen(function* () {
      const harness = yield* askWithRecorder(true);
      yield* Deferred.succeed(harness.runEnded, undefined);
      assert.strictEqual(yield* Fiber.join(harness.fiber), "cancelled");
      assert.deepStrictEqual((yield* Ref.get(harness.recorded)).at(-1), ["cancelled", false]);
    }),
  );

  it.effect("an aborted call cancels the card and nothing waits for an answer", () =>
    Effect.gen(function* () {
      const harness = yield* askWithRecorder(true);
      yield* Fiber.interrupt(harness.fiber);
      assert.deepStrictEqual(yield* Ref.get(harness.recorded), [
        ["pending", false],
        ["cancelled", false],
      ]);
      assert.strictEqual(yield* harness.answer("allow"), "not-waiting");
    }),
  );
});
