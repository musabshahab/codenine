import type {
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  TeamPlan,
  ThreadId,
} from "@codenine/contracts";
import {
  type ActionReviewPromptInput,
  type ActionReviewTeam,
  type ReviewedAction,
  reviewedActionJson,
} from "@codenine/provider-core/server/textGenerationPrompts";
import { resolveProjectSettings } from "@codenine/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as Agents from "../agents/Agents.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";

const REVIEW_TIMEOUT = Duration.seconds(60);
const BLOCKS_IN_A_ROW = 3;
const BLOCKS_IN_TOTAL = 20;
const USER_MESSAGES_KEPT = 12;
const USER_MESSAGE_HEAD_CHARS = 1_500;
const USER_MESSAGE_TAIL_CHARS = 500;
const REASON_CHARS = 300;

export type ReviewDecision =
  | { readonly type: "allow" }
  | { readonly type: "block"; readonly reason: string }
  | { readonly type: "ask"; readonly reason: string };

export class ActionReviewer extends Context.Service<
  ActionReviewer,
  {
    /**
     * Auto's answer to an action that would ask the user. It never fails: a review that fails or
     * takes too long asks the user, and so does a block once there have been too many.
     */
    readonly decide: (input: {
      readonly threadId: ThreadId;
      readonly action: ReviewedAction;
    }) => Effect.Effect<ReviewDecision>;
  }
>()("codenine/approvals/ActionReviewer") {}

// A long paste usually holds the request at its start or its end.
const shorten = (text: string) =>
  text.length <= USER_MESSAGE_HEAD_CHARS + USER_MESSAGE_TAIL_CHARS
    ? text
    : `${text.slice(0, USER_MESSAGE_HEAD_CHARS)}\n[…]\n${text.slice(-USER_MESSAGE_TAIL_CHARS)}`;

const teamOf = (
  thread: Pick<OrchestrationV2AppThread, "team" | "teamTask">,
  leadPlan: TeamPlan | null | undefined,
): ActionReviewTeam | undefined => {
  const ref = thread.teamTask;
  if (ref === undefined) {
    // A plain team's lead wrote its own plan; a workflow run's goal is the user's.
    const own = thread.team;
    return own?.run === undefined ? undefined : { workflow: true, goal: own.goal };
  }
  const task =
    leadPlan?.id === ref.planId
      ? leadPlan.tasks.find((candidate) => candidate.id === ref.taskId)
      : undefined;
  if (leadPlan == null || task === undefined) return undefined;
  // From the plan rather than the thread's first message, which also holds earlier tasks' results.
  return {
    workflow: leadPlan.run !== undefined,
    goal: leadPlan.goal,
    task: {
      title: task.title,
      brief: task.brief,
      ...(task.doneWhen === undefined ? {} : { doneWhen: task.doneWhen }),
    },
  };
};

/**
 * What the reviewer reads: what the user wrote or approved. Never tool results, the agent's own
 * messages, or messages other agents sent, any of which can carry someone else's instructions.
 */
export const reviewContext = (input: {
  readonly thread: Pick<OrchestrationV2AppThread, "team" | "teamTask">;
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
  readonly agentInstructions: string | undefined;
  /** The plan of the lead whose task the thread runs. */
  readonly leadPlan: TeamPlan | null | undefined;
}): Omit<ActionReviewPromptInput, "action"> => {
  const team = teamOf(input.thread, input.leadPlan);
  return {
    userMessages: input.messages
      .filter((message) => message.role === "user" && message.createdBy === "user")
      .map((message) => message.text.trim())
      .filter((text) => text.length > 0)
      .slice(-USER_MESSAGES_KEPT)
      .map(shorten),
    ...(input.agentInstructions?.trim() ? { agentInstructions: input.agentInstructions } : {}),
    ...(team === undefined ? {} : { team }),
  };
};

const ALLOW: ReviewDecision = { type: "allow" };
const block = (reason: string): ReviewDecision => ({ type: "block", reason });
const ask = (reason: string): ReviewDecision => ({ type: "ask", reason });

/** One sentence without its closing period, so it reads inside the messages built around it. */
const sentence = (reason: string) => {
  const text = reason
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!\s]+$/, "");
  if (text.length === 0) return "it does not clearly fit what the user asked";
  return text.length <= REASON_CHARS ? text : `${text.slice(0, REASON_CHARS - 1).trimEnd()}…`;
};

interface BlockCount {
  readonly inARow: number;
  readonly total: number;
}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const agents = yield* Agents.Agents;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  // Per chat, where a team or workflow task counts toward its lead so the whole team stops together.
  const blocks = yield* Ref.make<ReadonlyMap<ThreadId, BlockCount>>(new Map());

  const review = Effect.fn("ActionReviewer.review")(function* (
    threadId: ThreadId,
    action: ReviewedAction,
  ) {
    const { thread, messages } = yield* threads.getThreadRecords(threadId, ["messages"], {
      messageRoles: ["user"],
    });
    const agent = thread.agent === undefined ? Option.none() : yield* agents.find(thread.agent);
    const leadPlan =
      thread.teamTask === undefined
        ? undefined
        : (yield* threads.getThreadRecords(thread.teamTask.rootThreadId, [])).thread.team;
    const settings = resolveProjectSettings(
      yield* serverSettings.getSettings,
      thread.projectId,
    ).settings;
    const reviewed = yield* textGeneration.reviewAction({
      // The project could hold a CLAUDE.md or AGENTS.md that a tricked agent wrote.
      cwd: yield* fileSystem.makeTempDirectoryScoped({ prefix: "codenine-review-" }),
      ...reviewContext({
        thread,
        messages,
        agentInstructions: Option.getOrUndefined(agent)?.instructions,
        leadPlan,
      }),
      action,
      modelSelection: settings.textGenerationModelSelection,
    });
    return { scope: thread.teamTask?.rootThreadId ?? thread.id, reviewed };
  }, Effect.scoped);

  const decide: ActionReviewer["Service"]["decide"] = Effect.fn("ActionReviewer.decide")(
    function* (input) {
      if (reviewedActionJson(input.action) === undefined) {
        return ask("This action is too large for Auto to review, so it asks you.");
      }
      const outcome = yield* review(input.threadId, input.action).pipe(
        Effect.timeoutOption(REVIEW_TIMEOUT),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("Auto could not review an action", {
                threadId: input.threadId,
                cause,
              }).pipe(Effect.as(undefined)),
        ),
      );
      if (outcome === undefined) return ask("Auto could not review this action, so it asks you.");
      if (Option.isNone(outcome)) return ask("Auto's review took too long, so it asks you.");
      const { scope, reviewed } = outcome.value;
      const reason = sentence(reviewed.reason);
      yield* Effect.annotateCurrentSpan({ "review.decision": reviewed.decision });
      if (reviewed.decision === "allow") {
        yield* Ref.update(blocks, (current) => {
          const count = current.get(scope);
          return count === undefined || count.inARow === 0
            ? current
            : new Map(current).set(scope, { ...count, inARow: 0 });
        });
        return ALLOW;
      }
      const count = yield* Ref.modify(blocks, (current) => {
        const previous = current.get(scope);
        const next = { inARow: (previous?.inARow ?? 0) + 1, total: (previous?.total ?? 0) + 1 };
        return [next, new Map(current).set(scope, next)] as const;
      });
      if (count.inARow >= BLOCKS_IN_A_ROW) {
        return ask(
          `Auto blocked ${count.inARow} actions in a row, so it asks you about this one: ${reason}.`,
        );
      }
      if (count.total >= BLOCKS_IN_TOTAL) {
        return ask(
          `Auto has blocked ${count.total} actions so far, so it asks you about this one: ${reason}.`,
        );
      }
      return block(reason);
    },
  );

  return ActionReviewer.of({ decide });
});

export const layer = Layer.effect(ActionReviewer, make);
