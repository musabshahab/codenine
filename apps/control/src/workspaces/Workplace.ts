import { type ControlMyDepartments, ControlDepartmentError } from "@codenine/contracts/control";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { Accounts } from "../accounts/Accounts.ts";
import { Sessions, type Viewing } from "../accounts/Sessions.ts";
import { Departments } from "../departments/Departments.ts";
import type { WorkspaceKey } from "./WorkspaceManager.ts";

/** A signed-in browser: whose it is, and the department chosen in it. */
export interface WorkplaceSession {
  readonly sessionId: string;
  readonly personId: string;
  readonly departmentId: string | null;
  /** Someone else's workspace an owner opened in this session. */
  readonly viewing: Viewing | null;
}

/**
 * Which of a person's workspaces a browser works in: the department chosen in
 * that session while they are still in it, otherwise the one they joined
 * first, and outside departments only when they are in none.
 */
export class Workplace extends Context.Service<
  Workplace,
  {
    readonly keyFor: (session: WorkplaceSession) => Effect.Effect<WorkspaceKey>;
    readonly departmentsOf: (session: WorkplaceSession) => Effect.Effect<ControlMyDepartments>;
    /** The browser's connections reconnect to that department's workspace. */
    readonly choose: (
      session: WorkplaceSession,
      departmentId: string,
    ) => Effect.Effect<ControlMyDepartments, ControlDepartmentError>;
  }
>()("@codenine/control/workspaces/Workplace") {}

export const make = Effect.gen(function* () {
  const departments = yield* Departments;
  const sessions = yield* Sessions;
  const accounts = yield* Accounts;

  const departmentsOf = Effect.fn("Workplace.departmentsOf")(function* (session: WorkplaceSession) {
    const named = yield* departments.named(session.personId);
    const chosen = named.find(({ id }) => id === session.departmentId) ?? named[0];
    const viewing = session.viewing;
    return {
      departments: named,
      current: chosen?.id ?? null,
      viewing:
        viewing === null
          ? null
          : {
              personId: viewing.personId,
              displayName: yield* accounts.findPerson(viewing.personId).pipe(
                Effect.map((person) => person.displayName),
                Effect.orElseSucceed(() => viewing.personId),
              ),
              departmentName:
                viewing.departmentId === null
                  ? null
                  : yield* departments.find(viewing.departmentId).pipe(
                      Effect.map((department) => department.name),
                      Effect.orElseSucceed(() => viewing.departmentId),
                    ),
              until: viewing.until,
            },
    };
  });

  return Workplace.of({
    keyFor: Effect.fn("Workplace.keyFor")(function* (session: WorkplaceSession) {
      if (session.viewing !== null) {
        return { personId: session.viewing.personId, departmentId: session.viewing.departmentId };
      }
      return {
        personId: session.personId,
        departmentId: yield* departments.pick(session.personId, session.departmentId),
      };
    }),
    departmentsOf,
    choose: Effect.fn("Workplace.choose")(function* (
      session: WorkplaceSession,
      departmentId: string,
    ) {
      if (!(yield* departments.ofPerson(session.personId)).includes(departmentId)) {
        return yield* new ControlDepartmentError({ reason: "not-found" });
      }
      yield* sessions.chooseDepartment({
        personId: session.personId,
        sessionId: session.sessionId,
        departmentId,
      });
      return yield* departmentsOf({ ...session, departmentId });
    }),
  });
});

export const layer = Layer.effect(Workplace, make);
