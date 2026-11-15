import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";

import {
  applyMemberSteps,
  groupChangeFromPatch,
  pageOf,
  parseFilter,
  userChangeFromPatch,
  userFieldsFromResource,
} from "./scim.ts";

const patch = (...Operations: ReadonlyArray<Record<string, unknown>>) => ({
  schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
  Operations,
});

const ok = <A, E>(result: Result.Result<A, E>) => Result.getOrThrow(result);
const refused = <A, E>(result: Result.Result<A, E>) => Result.isFailure(result);

describe("scim", () => {
  it.each([
    [
      "Entra ID turning someone off, with its boolean as a string",
      patch({ op: "Replace", path: "active", value: "False" }),
      { active: false },
    ],
    [
      "Okta turning someone off, with no path",
      patch({ op: "replace", value: { active: false } }),
      {
        active: false,
      },
    ],
    [
      "Entra ID's profile update, with filtered and dotted paths",
      patch(
        { op: "Add", path: "displayName", value: "Ada L" },
        { op: "Replace", path: 'emails[type eq "work"].value', value: "ada@acme.test" },
        { op: "Replace", path: "name.givenName", value: "Ada" },
        { op: "Remove", path: "name.familyName" },
        { op: "Add", path: "title", value: "Engineer" },
      ),
      { displayName: "Ada L", email: "ada@acme.test", givenName: "Ada", familyName: null },
    ],
    [
      "dotted keys in a value with no path, and the core schema's URN",
      patch({
        op: "Replace",
        value: {
          "name.familyName": "Lovelace",
          "urn:ietf:params:scim:schemas:core:2.0:User:userName": "ada@acme.onmicrosoft.com",
          externalId: "e-1",
        },
      }),
      { familyName: "Lovelace", userName: "ada@acme.onmicrosoft.com", externalId: "e-1" },
    ],
  ])("reads %s", (_, body, change) => {
    expect(ok(userChangeFromPatch(body))).toEqual(change);
  });

  it.each([
    ["an unknown operation", patch({ op: "move", path: "active", value: false })],
    ["active that is not a boolean", patch({ op: "replace", path: "active", value: "maybe" })],
    ["no Operations", { schemas: [] }],
    ["a value-only operation without an object", patch({ op: "replace", value: true })],
  ])("refuses a user patch with %s", (_, body) => {
    expect(refused(userChangeFromPatch(body))).toBe(true);
  });

  it("reads a whole user, taking the email from userName when none is sent", () => {
    expect(
      ok(
        userFieldsFromResource({
          userName: "bea@acme.test",
          name: { givenName: "Bea", familyName: "Smith" },
          active: "True",
        }),
      ),
    ).toEqual({
      userName: "bea@acme.test",
      externalId: null,
      email: "bea@acme.test",
      displayName: "Bea Smith",
      givenName: "Bea",
      familyName: "Smith",
      active: true,
    });
    expect(
      ok(
        userFieldsFromResource({
          userName: "bea",
          emails: [
            { value: "home@example.com", type: "home" },
            { value: "bea@acme.test", type: "work", primary: true },
          ],
        }),
      ).email,
    ).toBe("bea@acme.test");
    expect(refused(userFieldsFromResource({ displayName: "No user name" }))).toBe(true);
  });

  it.each([
    [
      "Entra ID adding and removing members",
      patch(
        { op: "Add", path: "members", value: [{ value: "per_b" }, { value: "per_c" }] },
        { op: "Remove", path: "members", value: [{ value: "per_a" }] },
      ),
      ["per_b", "per_c"],
    ],
    [
      "Okta removing one member by a filter",
      patch({ op: "remove", path: 'members[value eq "per_a"]' }),
      [],
    ],
    [
      "a replace of every member, then one more",
      patch(
        { op: "replace", path: "members", value: [{ value: "per_c" }] },
        { op: "add", path: "members", value: [{ value: "per_d" }] },
      ),
      ["per_c", "per_d"],
    ],
    ["a removal of every member", patch({ op: "remove", path: "members" }), []],
  ])("applies %s in order", (_, body, members) => {
    expect(applyMemberSteps(["per_a"], ok(groupChangeFromPatch(body)).members)).toEqual(members);
  });

  it("reads a group rename both ways, and refuses an empty name", () => {
    expect(
      ok(groupChangeFromPatch(patch({ op: "Replace", path: "displayName", value: "Studio" }))),
    ).toEqual({ displayName: "Studio", members: [] });
    expect(
      ok(
        groupChangeFromPatch(
          patch({ op: "replace", value: { id: "dep_1", displayName: "Studio" } }),
        ),
      ),
    ).toEqual({ displayName: "Studio", members: [] });
    expect(
      refused(groupChangeFromPatch(patch({ op: "replace", path: "displayName", value: " " }))),
    ).toBe(true);
  });

  it("reads one eq filter on a supported attribute, and pages from 1", () => {
    expect(ok(parseFilter('userName eq "a\\"b@acme.test"', ["username"]))).toEqual({
      attribute: "username",
      value: 'a"b@acme.test',
    });
    expect(ok(parseFilter(undefined, ["username"]))).toBeNull();
    expect(refused(parseFilter('userName sw "a"', ["username"]))).toBe(true);
    expect(refused(parseFilter('title eq "a"', ["username"]))).toBe(true);
    expect(pageOf({})).toEqual({ startIndex: 1, count: 200 });
    expect(pageOf({ startIndex: "0", count: "1000" })).toEqual({ startIndex: 1, count: 200 });
    expect(pageOf({ startIndex: "3", count: "-1" })).toEqual({ startIndex: 3, count: 0 });
  });
});
