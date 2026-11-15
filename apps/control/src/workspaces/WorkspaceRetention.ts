import type { ControlAccountError } from "@codenine/contracts/control";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import { Accounts } from "../accounts/Accounts.ts";
import { AuditLog, CODENINE, ON_THE_SERVER } from "../audit/AuditLog.ts";
import { WorkspaceManager } from "./WorkspaceManager.ts";

/**
 * When someone is deactivated their workspace stops at once, and its files are
 * kept for `CODENINE_CONTROL_WORKSPACE_RETENTION_DAYS` in case they come back,
 * then deleted.
 */
export class WorkspaceRetention extends Context.Service<
  WorkspaceRetention,
  {
    /** Deactivates the person and retires their workspace. */
    readonly deactivate: (personId: string) => Effect.Effect<void, ControlAccountError>;
    /** Retires workspaces still left and deletes files kept past the retention time. */
    readonly sweep: Effect.Effect<void>;
  }
>()("@codenine/control/workspaces/WorkspaceRetention") {}

export const make = Effect.gen(function* () {
  const accounts = yield* Accounts;
  const workspaces = yield* WorkspaceManager;
  const audit = yield* AuditLog;
  const retentionDays = yield* Config.Number("CODENINE_CONTROL_WORKSPACE_RETENTION_DAYS").pipe(
    Config.withDefault(30),
  );

  // A failure waits for the next sweep, so it never undoes the deactivation.
  const retire = (personId: string) =>
    workspaces.retire(personId).pipe(
      Effect.tap((removed) =>
        removed
          ? Effect.logInfo(
              `Stopped the workspace of ${personId}, who was deactivated. Its files are kept for ${retentionDays} days.`,
            )
          : Effect.void,
      ),
      Effect.catchTags({
        WorkspaceUnavailableError: (error) =>
          Effect.logWarning(`Could not stop the workspace of ${personId}.`, error),
      }),
    );

  const removeFiles = (person: { readonly personId: string; readonly email: string }) =>
    workspaces.removeFiles(person.personId).pipe(
      Effect.tap((removed) =>
        removed
          ? Effect.logInfo(
              `Deleted the workspace files of ${person.personId}, deactivated more than ${retentionDays} days ago.`,
            ).pipe(
              Effect.andThen(
                audit.record({
                  actor: CODENINE,
                  source: ON_THE_SERVER,
                  action: "person.files-deleted",
                  target: { kind: "person", id: person.personId, label: person.email },
                  before: null,
                  after: { retentionDays },
                }),
              ),
            )
          : Effect.void,
      ),
      Effect.catchTags({
        WorkspaceUnavailableError: (error) =>
          Effect.logWarning(`Could not delete the workspace files of ${person.personId}.`, error),
      }),
    );

  return WorkspaceRetention.of({
    deactivate: Effect.fn("WorkspaceRetention.deactivate")(function* (personId: string) {
      yield* accounts.deactivate(personId);
      yield* retire(personId);
    }),
    sweep: Effect.gen(function* () {
      const keptSince = DateTime.subtract(yield* DateTime.now, { days: retentionDays });
      for (const person of yield* accounts.listDeactivated) {
        yield* retire(person.personId);
        if (DateTime.isLessThan(DateTime.makeUnsafe(person.deactivatedAt), keptSince)) {
          yield* removeFiles(person);
        }
      }
    }).pipe(Effect.withSpan("WorkspaceRetention.sweep")),
  });
});

export const layer = Layer.effect(WorkspaceRetention, make);

/** Sweeps when the control server starts and every hour after. */
export const layerHourlySweep = Layer.effectDiscard(
  Effect.gen(function* () {
    const retention = yield* WorkspaceRetention;
    yield* retention.sweep.pipe(
      Effect.catchCause((cause) => Effect.logError("The workspace retention sweep failed.", cause)),
      Effect.repeat(Schedule.spaced(Duration.hours(1))),
      Effect.forkScoped,
    );
  }),
);
