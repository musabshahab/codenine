import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/**
 * SCIM 2.0 (RFC 7643 and 7644) as Microsoft Entra ID and Okta speak it: their
 * requests read into changes, and the resources answered with. Users are
 * people and groups are departments.
 */

export const SCIM_CONTENT_TYPE = "application/scim+json";
const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
/** The most resources one list answers with. */
export const MAX_COUNT = 200;

export class ScimError extends Schema.TaggedError<ScimError>()("ScimError", {
  status: Schema.Number,
  scimType: Schema.optionalKey(Schema.String),
  detail: Schema.String,
}) {}

const invalid = (detail: string, scimType = "invalidValue") =>
  Result.fail(new ScimError({ status: 400, scimType, detail }));

/** A user as the identity provider sends it whole, on creation or replacement. */
export interface UserFields {
  readonly userName: string;
  readonly externalId: string | null;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly givenName: string | null;
  readonly familyName: string | null;
  readonly active: boolean;
}

/** What a patch changes; absent means unchanged. */
export interface UserChange {
  readonly userName?: string;
  readonly externalId?: string | null;
  readonly email?: string;
  readonly displayName?: string;
  readonly givenName?: string | null;
  readonly familyName?: string | null;
  readonly active?: boolean;
}

export interface GroupFields {
  readonly displayName: string;
  readonly externalId: string | null;
  readonly members: ReadonlyArray<string>;
}

/** Applied in order to the members a group has. */
export type MemberStep =
  | { readonly add: ReadonlyArray<string> }
  | { readonly remove: ReadonlyArray<string> }
  | { readonly replace: ReadonlyArray<string> };

export interface GroupChange {
  readonly displayName?: string;
  readonly externalId?: string | null;
  readonly members: ReadonlyArray<MemberStep>;
}

export const applyMemberSteps = (
  members: ReadonlyArray<string>,
  steps: ReadonlyArray<MemberStep>,
): ReadonlyArray<string> => {
  let current = new Set(members);
  for (const step of steps) {
    if ("replace" in step) current = new Set(step.replace);
    else if ("add" in step) for (const id of step.add) current.add(id);
    else for (const id of step.remove) current.delete(id);
  }
  return [...current];
};

/** One `attribute eq "value"` comparison, the only filter Entra ID and Okta send. */
export interface ScimFilter {
  /** Lowercase, as attribute names are case-insensitive. */
  readonly attribute: string;
  readonly value: string;
}

type Json = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const attribute = (object: Json, name: string): unknown => {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(object)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
};

const text = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

/** Entra ID sends booleans as "True" and "False" unless told otherwise. */
const flag = (value: unknown) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && /^(?:true|false)$/iu.test(value.trim())) {
    return value.trim().toLowerCase() === "true";
  }
  return null;
};

const looksLikeEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);

/** The primary address, else the work one, else the first. */
const emailOf = (value: unknown) => {
  if (!Array.isArray(value)) return null;
  const entries = value.filter(isObject);
  const chosen =
    entries.find((entry) => flag(attribute(entry, "primary")) === true) ??
    entries.find((entry) => text(attribute(entry, "type"))?.toLowerCase() === "work") ??
    entries[0];
  return chosen === undefined ? null : text(attribute(chosen, "value"));
};

const joinNames = (givenName: string | null, familyName: string | null) =>
  [givenName, familyName].filter((part) => part !== null).join(" ") || null;

export const userFieldsFromResource = (body: unknown): Result.Result<UserFields, ScimError> => {
  if (!isObject(body)) return invalid("Send a User resource.", "invalidSyntax");
  const userName = text(attribute(body, "userName"));
  if (userName === null) return invalid("A user needs a userName.");
  const name = attribute(body, "name");
  const givenName = isObject(name) ? text(attribute(name, "givenName")) : null;
  const familyName = isObject(name) ? text(attribute(name, "familyName")) : null;
  const formatted = isObject(name) ? text(attribute(name, "formatted")) : null;
  const active = attribute(body, "active");
  return Result.succeed({
    userName,
    externalId: text(attribute(body, "externalId")),
    email: emailOf(attribute(body, "emails")) ?? (looksLikeEmail(userName) ? userName : null),
    displayName:
      text(attribute(body, "displayName")) ?? formatted ?? joinNames(givenName, familyName),
    givenName,
    familyName,
    active: active === undefined ? true : (flag(active) ?? true),
  });
};

/** Strips the core schema's URN, which a path may start with. */
const pathOf = (path: string, schema: string) => {
  const lower = path.trim().toLowerCase();
  const prefix = `${schema.toLowerCase()}:`;
  return lower.startsWith(prefix) ? lower.slice(prefix.length) : lower;
};

const operationsOf = (body: unknown) => {
  const operations = isObject(body) ? attribute(body, "Operations") : undefined;
  if (!Array.isArray(operations) || !operations.every(isObject)) {
    return invalid("Send a PatchOp with Operations.", "invalidSyntax");
  }
  const parsed: Array<{ op: "add" | "replace" | "remove"; path: string | null; value: unknown }> =
    [];
  for (const operation of operations) {
    const op = text(attribute(operation, "op"))?.toLowerCase();
    if (op !== "add" && op !== "replace" && op !== "remove") {
      return invalid(
        `Unknown patch operation ${String(attribute(operation, "op"))}.`,
        "invalidSyntax",
      );
    }
    parsed.push({
      op,
      path: text(attribute(operation, "path")),
      value: attribute(operation, "value"),
    });
  }
  return Result.succeed(parsed);
};

/** Each attribute an operation sets: its path, or with none, each key of its value. */
const pairsOf = (path: string | null, value: unknown) => {
  if (path !== null) return [[path, value] as const];
  return isObject(value) ? Object.entries(value) : null;
};

export const userChangeFromPatch = (body: unknown): Result.Result<UserChange, ScimError> => {
  const operations = operationsOf(body);
  if (Result.isFailure(operations)) return Result.fail(operations.failure);
  const change: { -readonly [K in keyof UserChange]: UserChange[K] } = {};
  const apply = (op: "add" | "replace" | "remove", rawPath: string, value: unknown) => {
    const path = pathOf(rawPath, USER_SCHEMA);
    const removing = op === "remove";
    if (path === "active") {
      if (removing) return null;
      const active = flag(value);
      if (active === null) return `active must be true or false.`;
      change.active = active;
    } else if (path === "username") {
      const userName = text(value);
      if (removing || userName === null) return removing ? null : "userName cannot be empty.";
      change.userName = userName;
    } else if (path === "externalid") {
      change.externalId = removing ? null : text(value);
    } else if (path === "displayname") {
      const displayName = text(value);
      if (!removing && displayName !== null) change.displayName = displayName;
    } else if (path === "name.givenname") {
      change.givenName = removing ? null : text(value);
    } else if (path === "name.familyname") {
      change.familyName = removing ? null : text(value);
    } else if (path === "name" && isObject(value)) {
      const givenName = attribute(value, "givenName");
      const familyName = attribute(value, "familyName");
      if (givenName !== undefined) change.givenName = text(givenName);
      if (familyName !== undefined) change.familyName = text(familyName);
    } else if (path === "emails" || path.startsWith("emails[") || path.startsWith("emails.")) {
      // An address cannot be removed: every person keeps one.
      const email = Array.isArray(value)
        ? emailOf(value)
        : isObject(value)
          ? text(attribute(value, "value"))
          : text(value);
      if (!removing && email !== null) change.email = email;
    }
    // Anything else, such as titles, addresses or the enterprise extension, is not kept.
    return null;
  };
  for (const { op, path, value } of operations.success) {
    const pairs = pairsOf(path, value);
    if (pairs === null) {
      return invalid("A patch without a path needs an object value.", "invalidSyntax");
    }
    for (const [key, item] of pairs) {
      const problem = apply(op, key, item);
      if (problem !== null) return invalid(problem);
    }
  }
  return Result.succeed(change);
};

const memberIds = (value: unknown) =>
  (Array.isArray(value) ? value : [value]).filter(isObject).flatMap((member) => {
    const id = text(attribute(member, "value"));
    return id === null ? [] : [id];
  });

export const groupFieldsFromResource = (body: unknown): Result.Result<GroupFields, ScimError> => {
  if (!isObject(body)) return invalid("Send a Group resource.", "invalidSyntax");
  const displayName = text(attribute(body, "displayName"));
  if (displayName === null) return invalid("A group needs a displayName.");
  return Result.succeed({
    displayName,
    externalId: text(attribute(body, "externalId")),
    members: memberIds(attribute(body, "members") ?? []),
  });
};

/** `members[value eq "id"]`, how Okta names one member to remove. */
const MEMBER_PATH = /^members\[\s*value\s+eq\s+"((?:[^"\\]|\\.)*)"\s*\]$/iu;

export const groupChangeFromPatch = (body: unknown): Result.Result<GroupChange, ScimError> => {
  const operations = operationsOf(body);
  if (Result.isFailure(operations)) return Result.fail(operations.failure);
  let displayName: string | undefined;
  let externalId: string | null | undefined;
  const members: Array<MemberStep> = [];
  const apply = (op: "add" | "replace" | "remove", rawPath: string, value: unknown) => {
    const path = pathOf(rawPath, GROUP_SCHEMA);
    if (path === "displayname") {
      const name = text(value);
      if (op === "remove" || name === null) return "displayName cannot be empty.";
      displayName = name;
    } else if (path === "externalid") {
      externalId = op === "remove" ? null : text(value);
    } else if (path === "members") {
      const ids = memberIds(value ?? []);
      if (op === "add") members.push({ add: ids });
      else if (op === "replace") members.push({ replace: ids });
      else members.push(value === undefined ? { replace: [] } : { remove: ids });
    } else {
      const one = MEMBER_PATH.exec(rawPath.trim());
      if (one?.[1] !== undefined && op === "remove") {
        members.push({ remove: [one[1].replaceAll(/\\(.)/gu, "$1")] });
      } else if (one !== null) {
        return "Only removal can name one member.";
      }
    }
    return null;
  };
  for (const { op, path, value } of operations.success) {
    const pairs = pairsOf(path, value);
    if (pairs === null) {
      return invalid("A patch without a path needs an object value.", "invalidSyntax");
    }
    for (const [key, item] of pairs) {
      const problem = apply(op, key, item);
      if (problem !== null) return invalid(problem);
    }
  }
  return Result.succeed({
    ...(displayName === undefined ? {} : { displayName }),
    ...(externalId === undefined ? {} : { externalId }),
    members,
  });
};

const FILTER = /^\s*([a-z][\w.]*)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/iu;

export const parseFilter = (
  filter: string | undefined,
  supported: ReadonlyArray<string>,
): Result.Result<ScimFilter | null, ScimError> => {
  if (filter === undefined || filter.trim() === "") return Result.succeed(null);
  const match = FILTER.exec(filter);
  const attributeName = match?.[1]?.toLowerCase();
  if (match?.[2] === undefined || attributeName === undefined) {
    return invalid(`Only one attribute eq "value" comparison is supported.`, "invalidFilter");
  }
  if (!supported.includes(attributeName)) {
    return invalid(`Filtering by ${match[1]} is not supported.`, "invalidFilter");
  }
  return Result.succeed({
    attribute: attributeName,
    value: match[2].replaceAll(/\\(.)/gu, "$1"),
  });
};

/** `startIndex` from 1 and `count` up to `MAX_COUNT`, as RFC 7644 pages lists. */
export const pageOf = (query: { readonly startIndex?: string; readonly count?: string }) => {
  const startIndex = Math.max(1, Math.trunc(Number(query.startIndex ?? 1)) || 1);
  const asked = Math.trunc(Number(query.count ?? MAX_COUNT));
  const count = Number.isNaN(asked) ? MAX_COUNT : Math.min(MAX_COUNT, Math.max(0, asked));
  return { startIndex, count };
};

export interface ScimUser {
  readonly id: string;
  readonly userName: string;
  readonly externalId: string | null;
  readonly email: string;
  readonly displayName: string;
  readonly givenName: string | null;
  readonly familyName: string | null;
  readonly active: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ScimGroup {
  readonly id: string;
  readonly displayName: string;
  readonly externalId: string | null;
  readonly members: ReadonlyArray<{ readonly id: string; readonly displayName: string }>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const userResource = (user: ScimUser, base: string) => ({
  schemas: [USER_SCHEMA],
  id: user.id,
  ...(user.externalId === null ? {} : { externalId: user.externalId }),
  userName: user.userName,
  name: {
    ...(user.givenName === null ? {} : { givenName: user.givenName }),
    ...(user.familyName === null ? {} : { familyName: user.familyName }),
    formatted: joinNames(user.givenName, user.familyName) ?? user.displayName,
  },
  displayName: user.displayName,
  emails: [{ value: user.email, type: "work", primary: true }],
  active: user.active,
  meta: {
    resourceType: "User",
    created: user.createdAt,
    lastModified: user.updatedAt,
    location: `${base}/Users/${user.id}`,
  },
});

export const groupResource = (group: ScimGroup, base: string, withMembers = true) => ({
  schemas: [GROUP_SCHEMA],
  id: group.id,
  ...(group.externalId === null ? {} : { externalId: group.externalId }),
  displayName: group.displayName,
  ...(withMembers
    ? {
        members: group.members.map((member) => ({
          value: member.id,
          display: member.displayName,
          $ref: `${base}/Users/${member.id}`,
        })),
      }
    : {}),
  meta: {
    resourceType: "Group",
    created: group.createdAt,
    lastModified: group.updatedAt,
    location: `${base}/Groups/${group.id}`,
  },
});

export const listResponse = (
  resources: ReadonlyArray<unknown>,
  totalResults: number,
  startIndex: number,
) => ({
  schemas: [LIST_SCHEMA],
  totalResults,
  startIndex,
  itemsPerPage: resources.length,
  Resources: resources,
});

export const errorBody = (error: ScimError) => ({
  schemas: [ERROR_SCHEMA],
  status: String(error.status),
  ...(error.scimType === undefined ? {} : { scimType: error.scimType }),
  detail: error.detail,
});

export const serviceProviderConfig = (base: string) => ({
  schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
  patch: { supported: true },
  bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
  filter: { supported: true, maxResults: MAX_COUNT },
  changePassword: { supported: false },
  sort: { supported: false },
  etag: { supported: false },
  authenticationSchemes: [
    {
      type: "oauthbearertoken",
      name: "Bearer token",
      description: "The provisioning token an owner creates under Account.",
      primary: true,
    },
  ],
  meta: { resourceType: "ServiceProviderConfig", location: `${base}/ServiceProviderConfig` },
});

export const resourceTypes = (base: string) => [
  {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
    id: "User",
    name: "User",
    endpoint: "/Users",
    schema: USER_SCHEMA,
    meta: { resourceType: "ResourceType", location: `${base}/ResourceTypes/User` },
  },
  {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
    id: "Group",
    name: "Group",
    endpoint: "/Groups",
    schema: GROUP_SCHEMA,
    meta: { resourceType: "ResourceType", location: `${base}/ResourceTypes/Group` },
  },
];

const stringAttribute = (name: string, required = false, uniqueness = "none") => ({
  name,
  type: "string",
  multiValued: false,
  required,
  caseExact: false,
  mutability: "readWrite",
  returned: "default",
  uniqueness,
});

/** The attributes kept; others are accepted and left out. */
export const schemaDefinitions = [
  {
    id: USER_SCHEMA,
    name: "User",
    attributes: [
      stringAttribute("userName", true, "server"),
      {
        name: "name",
        type: "complex",
        multiValued: false,
        required: false,
        mutability: "readWrite",
        returned: "default",
        subAttributes: [stringAttribute("givenName"), stringAttribute("familyName")],
      },
      stringAttribute("displayName"),
      {
        name: "emails",
        type: "complex",
        multiValued: true,
        required: false,
        mutability: "readWrite",
        returned: "default",
        subAttributes: [stringAttribute("value"), stringAttribute("type")],
      },
      {
        name: "active",
        type: "boolean",
        multiValued: false,
        required: false,
        mutability: "readWrite",
        returned: "default",
      },
    ],
  },
  {
    id: GROUP_SCHEMA,
    name: "Group",
    attributes: [
      stringAttribute("displayName", true, "server"),
      {
        name: "members",
        type: "complex",
        multiValued: true,
        required: false,
        mutability: "readWrite",
        returned: "default",
        subAttributes: [stringAttribute("value"), stringAttribute("display")],
      },
    ],
  },
].map((schema) => ({
  schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"],
  ...schema,
  meta: { resourceType: "Schema" },
}));
