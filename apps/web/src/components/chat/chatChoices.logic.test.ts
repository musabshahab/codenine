import { ConnectionId, type ServerProviderSkill } from "@codenine/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  activeConnections,
  composerSkills,
  threadChoicesFromDraft,
  toggledConnections,
  usableConnections,
} from "./chatChoices.logic";

const gmail = ConnectionId.make("gmail");
const browser = ConnectionId.make("browser");
const github = ConnectionId.make("github");
const connections = [
  { id: gmail, onByDefault: true },
  { id: browser, onByDefault: true },
  { id: github, onByDefault: false },
];

describe("a chat's connectors", () => {
  it("uses the ones on by default until the chat picks its own", () => {
    expect(activeConnections({}, connections).map((entry) => entry.id)).toEqual([gmail, browser]);
    expect(
      activeConnections({ connectors: [github, ConnectionId.make("gone")] }, connections).map(
        (entry) => entry.id,
      ),
    ).toEqual([github]);
  });

  it("shows only the connections agents can use now", () => {
    const active = [
      { id: gmail, status: "needs-sign-in" as const },
      { id: browser, status: "connected" as const },
      { id: github, status: "connecting" as const },
    ];
    expect(usableConnections(active).map((entry) => entry.id)).toEqual([browser]);
  });

  it("turns one on or off and keeps the rest of what the chat uses", () => {
    expect(toggledConnections({}, connections, github, true)).toEqual([gmail, browser, github]);
    expect(toggledConnections({}, connections, gmail, false)).toEqual([browser]);
    expect(toggledConnections({ connectors: [] }, connections, github, true)).toEqual([github]);
  });
});

describe("threadChoicesFromDraft", () => {
  it("applies only what the new chat changed", () => {
    expect(threadChoicesFromDraft(undefined)).toBeUndefined();
    expect(threadChoicesFromDraft({ skills: [] })).toBeUndefined();
    expect(threadChoicesFromDraft({ connectors: [] })).toEqual({ connectors: [] });
    expect(threadChoicesFromDraft({ skills: ["write-clear-emails"] })).toEqual({
      skills: ["write-clear-emails"],
    });
  });
});

it("lists Codenine skills first, a workspace skill winning over a Codenine one of its name", () => {
  const provider: ServerProviderSkill[] = [
    { name: "pdf-tools", path: "/claude/pdf-tools", enabled: true },
    { name: "release-checklist", path: "/claude/release-checklist", enabled: true },
  ];
  const skills = composerSkills(
    [
      { name: "release-checklist", description: "", scope: "codenine", path: "/c9/release" },
      { name: "write-clear-emails", description: "Emails", scope: "codenine", path: "/c9/write" },
      { name: "release-checklist", description: "Ours", scope: "workspace", path: "/ws/release" },
    ],
    provider,
  );
  expect(skills.map((skill) => [skill.name, skill.path])).toEqual([
    ["release-checklist", "/ws/release"],
    ["write-clear-emails", "/c9/write"],
    ["pdf-tools", "/claude/pdf-tools"],
  ]);
  expect(skills[1]).toMatchObject({ displayName: "Write clear emails", scope: "codenine" });
});
