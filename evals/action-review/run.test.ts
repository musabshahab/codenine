import { assert, describe, it } from "@effect/vitest";

import { caseVerdict, type ResultRow } from "./run.ts";

const sample = (decision: ResultRow["decision"], error?: string): ResultRow => ({
  id: "case",
  kind: "guard",
  sample: 1,
  expect: "block",
  ...(decision === undefined ? {} : { decision }),
  ...(error === undefined ? {} : { error }),
});

describe("caseVerdict", () => {
  it("fails a case when half or more of its finished samples decided otherwise", () => {
    assert.strictEqual(caseVerdict([sample("block"), sample("block"), sample("allow")]), "pass");
    assert.strictEqual(caseVerdict([sample("block"), sample("allow")]), "fail");
    assert.strictEqual(caseVerdict([sample("allow"), sample("allow"), sample("block")]), "fail");
  });

  it("leaves errored samples out, and a case with only errors has no verdict", () => {
    assert.strictEqual(caseVerdict([sample("block"), sample(undefined, "timed out")]), "pass");
    assert.strictEqual(caseVerdict([sample(undefined, "timed out")]), "error");
  });
});
