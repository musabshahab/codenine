import { assert, it } from "@effect/vitest";
import { type OrchestrationV2TurnItem, RunId, ThreadId, TurnItemId } from "@codenine/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

const layerTest = TurnItemPositionStore.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

it.effect("reuses an item's position without attempting another allocation insert", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const input = {
      threadId: ThreadId.make("thread:position-reuse"),
      turnItemId: TurnItemId.make("item:streaming"),
      runId: null,
    };
    const first = yield* positions.allocate(input);
    assert.equal(first, 1);

    // BEFORE INSERT runs even when ON CONFLICT would discard the allocation.
    yield* sql`
      CREATE TEMP TRIGGER reject_redundant_position_insert
      BEFORE INSERT ON orchestration_v2_turn_item_positions
      WHEN EXISTS (
        SELECT 1 FROM orchestration_v2_turn_item_positions
        WHERE thread_id = NEW.thread_id AND turn_item_id = NEW.turn_item_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'Existing item positions must be reused');
      END
    `;

    const next = yield* positions.allocate({
      ...input,
      turnItemId: TurnItemId.make("item:next"),
    });
    assert.equal(next, first + 1);
    assert.equal(yield* positions.allocate(input), first);
    assert.equal(
      yield* positions.allocate({
        ...input,
        runId: RunId.make("run:moved"),
        runOrdinal: 2,
      }),
      first,
    );
    assert.equal(
      yield* positions.allocate({ ...input, threadId: ThreadId.make("thread:other") }),
      1,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("places a workflow result after the chat's newest run and keeps it there", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const threadId = ThreadId.make("thread:workflow-chat");
    const result = (id: string) =>
      ({
        id: TurnItemId.make(id),
        threadId,
        runId: null,
        type: "workflow_run",
        ordinal: 0,
      }) as unknown as OrchestrationV2TurnItem;
    const addRun = (ordinal: number) =>
      sql`
        INSERT INTO orchestration_v2_projection_runs
          (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
        VALUES (${`run:${ordinal}`}, ${threadId}, ${ordinal}, 'codex', 'completed', '', '{}')
      `;

    // With no runs it takes the runless band.
    assert.equal((yield* positions.normalize(result("result:before-runs"))).ordinal, 1);

    yield* addRun(1);
    yield* addRun(2);
    const reply = yield* positions.allocate({
      threadId,
      turnItemId: TurnItemId.make("item:reply"),
      runId: RunId.make("run:2"),
    });
    const card = (yield* positions.normalize(result("result:run-1"))).ordinal;
    assert.isAbove(card, reply);

    // A later run's items follow it, and an update leaves it where it is.
    yield* addRun(3);
    const next = yield* positions.allocate({
      threadId,
      turnItemId: TurnItemId.make("item:next"),
      runId: RunId.make("run:3"),
    });
    assert.isAbove(next, card);
    assert.equal((yield* positions.normalize(result("result:run-1"))).ordinal, card);
    // Other runless items still come first.
    const notice = yield* positions.allocate({
      threadId,
      turnItemId: TurnItemId.make("item:notice"),
      runId: null,
    });
    assert.isBelow(notice, reply);
  }).pipe(Effect.provide(layerTest)),
);
