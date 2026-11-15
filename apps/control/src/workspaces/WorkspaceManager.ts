import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
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
  }
>()("@codenine/control/workspaces/WorkspaceManager") {
  /** Everyone reaches one workspace server at `CODENINE_CONTROL_WORKSPACE_URL`. */
  static readonly shared = (target: WorkspaceTarget) =>
    WorkspaceManager.of({
      targetFor: Effect.fn("WorkspaceManager.targetFor")(() => Effect.succeed(target)),
      forget: Effect.fn("WorkspaceManager.forget")(() => Effect.void),
      isAsleep: Effect.fn("WorkspaceManager.isAsleep")(() => Effect.succeed(false)),
    });

  /** No workspace is set up: people can sign in, and every forwarded request fails. */
  static readonly none = WorkspaceManager.of({
    targetFor: Effect.fn("WorkspaceManager.targetFor")(() =>
      Effect.fail(new WorkspaceUnavailableError({ cause: "No workspace is set up." })),
    ),
    forget: Effect.fn("WorkspaceManager.forget")(() => Effect.void),
    isAsleep: Effect.fn("WorkspaceManager.isAsleep")(() => Effect.succeed(false)),
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
