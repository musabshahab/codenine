import type { ControlEffectiveProfile, ControlProfileSettings } from "@codenine/contracts/control";
import { describe, expect, it } from "@effect/vitest";

import { describeLayerChange, resolveProfile, summarizeChanges } from "./layering.ts";

const DEFAULTS = { cpus: 2, memoryGb: 4, sleepMinutes: 30 };
const BASE: ControlEffectiveProfile = {
  image: null,
  ...DEFAULTS,
  terminal: true,
  allowHosts: [],
  blockHosts: [],
};

/** Layers from the top: company, department, teams, then a person's exceptions. */
const LAYERING: ReadonlyArray<{
  readonly name: string;
  readonly layers: ReadonlyArray<ControlProfileSettings>;
  readonly expected: Partial<ControlEffectiveProfile>;
}> = [
  { name: "no layers: the installation's settings", layers: [], expected: {} },
  {
    name: "a lower layer changes what the layers above leave open",
    layers: [{ cpus: 4, memoryGb: 8 }, { memoryGb: 16 }, {}, { sleepMinutes: 120 }],
    expected: { cpus: 4, memoryGb: 16, sleepMinutes: 120 },
  },
  {
    name: "a locked setting keeps the value it had where it was locked",
    layers: [{ memoryGb: 8, lock: ["memoryGb"] }, { memoryGb: 64 }, { memoryGb: 128 }],
    expected: { memoryGb: 8 },
  },
  {
    name: "locking without a value keeps the installation's",
    layers: [{ lock: ["image", "cpus"] }, { image: "registry.acme.test/big:1", cpus: 16 }],
    expected: { image: null, cpus: 2 },
  },
  {
    name: "a department's lock binds its teams and exceptions, not the company above it",
    layers: [{ cpus: 8 }, { cpus: 1, lock: ["cpus"] }, { cpus: 4 }, { cpus: 8 }],
    expected: { cpus: 1 },
  },
  {
    name: "the company blocks the terminal and a department tries to allow it",
    layers: [{ terminal: "block" }, { terminal: "allow" }, { terminal: "allow" }],
    expected: { terminal: false },
  },
  {
    name: "a block anywhere below also wins",
    layers: [{ terminal: "allow" }, {}, { terminal: "block" }, { terminal: "allow" }],
    expected: { terminal: false },
  },
  {
    name: "the company blocks a host and a department tries to allow it, and its subdomains",
    layers: [
      { blockHosts: [".pastebin.com"] },
      { allowHosts: ["pastebin.com", "api.pastebin.com", "docs.acme.test"] },
    ],
    expected: { allowHosts: ["docs.acme.test"], blockHosts: [".pastebin.com"] },
  },
  {
    name: "allowed hosts add up, and a lower block removes one allowed above",
    layers: [
      { allowHosts: ["a.acme.test"] },
      { allowHosts: ["b.acme.test"] },
      { blockHosts: ["a.acme.test"] },
    ],
    expected: { allowHosts: ["b.acme.test"], blockHosts: ["a.acme.test"] },
  },
];

describe("resolveProfile", () => {
  it.each(LAYERING)("$name", ({ layers, expected }) => {
    expect(resolveProfile(layers, DEFAULTS)).toEqual({ ...BASE, ...expected });
  });
});

describe("summarizeChanges", () => {
  it("counts each person once per setting, across all their workspaces", () => {
    const blocked = { ...BASE, terminal: false };
    const bigger = { ...BASE, memoryGb: 8, allowHosts: ["docs.acme.test"] };
    expect(
      summarizeChanges([
        // Two workspaces, both losing the terminal.
        [
          { before: BASE, after: blocked },
          { before: BASE, after: blocked },
        ],
        [{ before: BASE, after: bigger }],
        [{ before: BASE, after: BASE }],
      ]),
    ).toEqual({
      people: 3,
      affected: 2,
      changes: [
        { setting: "memoryGb", people: 1, removed: ["4"], added: ["8"] },
        { setting: "terminal", people: 1, removed: ["allowed"], added: ["blocked"] },
        { setting: "allowHosts", people: 1, removed: [], added: ["docs.acme.test"] },
      ],
    });
  });
});

describe("describeLayerChange", () => {
  it("lists what a new version of a layer changes", () => {
    expect(
      describeLayerChange(
        { cpus: 2, allowHosts: ["a.acme.test"] },
        { cpus: 4, terminal: "block", allowHosts: ["a.acme.test"] },
      ),
    ).toBe("cpus: 2 → 4; terminal: unset → block");
  });
});
