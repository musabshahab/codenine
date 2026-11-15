import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { Accounts } from "../accounts/Accounts.ts";
import { AuditLog } from "../audit/AuditLog.ts";
import * as Licence from "../licence/LicenceService.ts";
import { layerTestServices } from "../testing/layerTestServices.ts";
import { signTestLicence, testClaims, testKeyPair } from "../testing/testLicence.ts";
import { WorkspaceManager } from "./WorkspaceManager.ts";
import * as WorkspaceRetention from "./WorkspaceRetention.ts";

/** Retention over a workspace manager that records what it was asked to remove. */
const withRetention = <A, E>(
  body: (removed: {
    readonly workspaces: ReadonlyArray<string>;
    readonly files: ReadonlyArray<string>;
  }) => Effect.Effect<A, E, Accounts | AuditLog | WorkspaceRetention.WorkspaceRetention>,
) =>
  Effect.gen(function* () {
    const keys = yield* testKeyPair;
    yield* TestClock.setTime(Date.parse("2026-12-10T12:00:00Z"));
    const workspaces: Array<string> = [];
    const files: Array<string> = [];
    const manager = WorkspaceManager.of({
      targetFor: Effect.fn("test.targetFor")(() => Effect.die("Not used here.")),
      forget: Effect.fn("test.forget")(() => Effect.void),
      isAsleep: Effect.fn("test.isAsleep")(() => Effect.succeed(true)),
      retire: Effect.fn("test.retire")((personId: string) =>
        Effect.sync(() => workspaces.push(personId) > 0),
      ),
      removeFiles: Effect.fn("test.removeFiles")((personId: string) =>
        Effect.sync(() => files.push(personId) > 0),
      ),
    });
    const licence = yield* signTestLicence(testClaims({ seats: 5 }), keys.privateKey);
    return yield* Effect.gen(function* () {
      yield* (yield* Licence.LicenceService).install(licence);
      return yield* body({ workspaces, files });
    }).pipe(
      Effect.provide(
        WorkspaceRetention.layer.pipe(
          Layer.provideMerge(Layer.succeed(WorkspaceManager, manager)),
          Layer.provideMerge(layerTestServices(keys.publicKey)),
        ),
      ),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

describe("WorkspaceRetention", () => {
  it.effect("stops a leaver's workspace at once and deletes its files after 30 days", () =>
    withRetention((removed) =>
      Effect.gen(function* () {
        const accounts = yield* Accounts;
        const retention = yield* WorkspaceRetention.WorkspaceRetention;
        const invite = (email: string) =>
          accounts
            .invite({ email, displayName: email, role: "member" })
            .pipe(Effect.map(({ person }) => person.id));
        const ada = yield* invite("ada@acme.test");
        const bea = yield* invite("bea@acme.test");

        yield* retention.deactivate(ada);
        yield* retention.deactivate(bea);
        expect(removed.workspaces).toEqual([ada, bea]);

        // Bea comes back in time, so her files stay.
        yield* TestClock.adjust("10 days");
        yield* accounts.reactivate(bea);
        yield* TestClock.adjust("19 days");
        yield* retention.sweep;
        expect(removed.files).toEqual([]);

        yield* TestClock.adjust("2 days");
        yield* retention.sweep;
        expect(removed.files).toEqual([ada]);
        const { entries } = yield* (yield* AuditLog).list(null);
        expect(entries[0]).toMatchObject({
          actor: { kind: "system" },
          action: "person.files-deleted",
          target: { id: ada, label: "ada@acme.test" },
          after: { retentionDays: 30 },
        });
      }),
    ),
  );
});
