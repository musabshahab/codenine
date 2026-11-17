import {
  AgentName,
  ContextHandoffId,
  MessageId,
  ProviderInstanceId,
  type OrchestrationV2ThreadProjection,
} from "@codenine/contracts";
import { describe, expect, it } from "vite-plus/test";

import { agentSwitchSince, modelSwitchSince } from "./modelSwitch.ts";

const instanceId = ProviderInstanceId.make("codex");
const selection = (model: string) => ({ instanceId, model });
const run = (
  message: string,
  ordinal: number,
  model: string,
  status: OrchestrationV2ThreadProjection["runs"][number]["status"] = "completed",
) =>
  ({
    ordinal,
    status,
    completedAt: null,
    contextHandoffId: null,
    userMessageId: MessageId.make(message),
    modelSelection: selection(model),
  }) as OrchestrationV2ThreadProjection["runs"][number];
const shown = (...messages: ReadonlyArray<string>) =>
  messages.map((message) => ({
    type: "user_message",
    messageId: MessageId.make(message),
    inputIntent: "turn_start",
    status: "completed",
    text: message,
    attachments: [],
  })) as unknown as OrchestrationV2ThreadProjection["turnItems"];

describe("modelSwitchSince", () => {
  it("measures from the latest run whose message is in the timeline", () => {
    // B failed before it started; its message shows "a -> b", so the next one must show "b -> a".
    expect(
      modelSwitchSince(
        {
          runs: [
            run("first", 1, "a"),
            run("failed", 2, "b", "failed"),
            run("queued", 3, "c", "queued"),
            run("undone", 4, "d", "rolled_back"),
          ],
          turnItems: shown("first", "failed", "queued", "undone"),
        },
        selection("a"),
      ),
    ).toEqual({ modelSwitch: { from: selection("b"), to: selection("a") } });
  });

  it("skips messages clients hide", () => {
    const [first, pending, compact, answer] = shown(
      "first",
      "pending",
      "/compact",
      "async-answer:question",
    );
    expect(
      modelSwitchSince(
        {
          runs: [
            run("first", 1, "a"),
            run("pending", 2, "b", "cancelled"),
            run("/compact", 3, "c"),
            run("async-answer:question", 4, "d"),
          ],
          turnItems: [
            first!,
            { ...pending!, inputIntent: "queued_turn", status: "pending" },
            compact!,
            answer!,
          ] as OrchestrationV2ThreadProjection["turnItems"],
        },
        selection("c"),
      ),
    ).toEqual({ modelSwitch: { from: selection("a"), to: selection("c") } });
  });

  it("counts a wake whose handoff row shows the swap", () => {
    const wake = {
      ...run("wake", 2, "other"),
      contextHandoffId: ContextHandoffId.make("handoff"),
    };
    expect(
      modelSwitchSince(
        { runs: [run("first", 1, "a"), wake], turnItems: shown("first") },
        selection("other"),
      ),
    ).toEqual({});
  });

  it("records nothing for a first run or an unchanged selection", () => {
    expect(modelSwitchSince({ runs: [], turnItems: [] }, selection("a"))).toEqual({});
    // A fork's first message compares with the run it forked from.
    expect(modelSwitchSince({ runs: [], turnItems: [] }, selection("a"), selection("b"))).toEqual({
      modelSwitch: { from: selection("b"), to: selection("a") },
    });
    expect(
      modelSwitchSince({ runs: [run("first", 1, "a")], turnItems: shown("first") }, selection("a")),
    ).toEqual({});
  });
});

describe("agentSwitchSince", () => {
  const gmail = AgentName.make("gmail");
  const calendar = AgentName.make("calendar");
  const sentTo = (message: string, agent?: AgentName) => ({
    ...shown(message)[0]!,
    ...(agent === undefined ? {} : { agent }),
  });
  const since = (
    agent: AgentName | undefined,
    runs: OrchestrationV2ThreadProjection["runs"],
    turnItems: ReadonlyArray<ReturnType<typeof sentTo>>,
  ) =>
    agentSwitchSince({
      thread: (agent === undefined ? {} : { agent }) as OrchestrationV2ThreadProjection["thread"],
      runs,
      turnItems: turnItems as unknown as OrchestrationV2ThreadProjection["turnItems"],
    });

  it("records the chat's agent and the hand-off from the latest message the timeline shows", () => {
    expect(
      since(
        calendar,
        [run("first", 1, "a"), run("undone", 2, "a", "rolled_back")],
        [sentTo("first", gmail), sentTo("undone", calendar)],
      ),
    ).toEqual({ agent: calendar, agentSwitch: { from: gmail, to: calendar } });
    expect(since(undefined, [run("first", 1, "a")], [sentTo("first", gmail)])).toEqual({
      agentSwitch: { from: gmail, to: null },
    });
    expect(since(gmail, [run("first", 1, "a")], [sentTo("first")])).toEqual({
      agent: gmail,
      agentSwitch: { from: null, to: gmail },
    });
  });

  it("records no hand-off for a first message or the same agent", () => {
    expect(since(gmail, [], [])).toEqual({ agent: gmail });
    expect(since(gmail, [run("first", 1, "a")], [sentTo("first", gmail)])).toEqual({
      agent: gmail,
    });
    expect(since(undefined, [run("first", 1, "a")], [sentTo("first")])).toEqual({});
  });
});
