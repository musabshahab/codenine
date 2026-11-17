import type { FetchLike } from "@modelcontextprotocol/client";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { CodenineToolSet } from "./catalog.ts";
import type { UpstreamTool } from "./ConnectorStore.ts";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Google's Gmail MCP server writes drafts but cannot send them. */
export const GMAIL_SEND_DRAFT: UpstreamTool = {
  name: "send_draft",
  title: "Send draft",
  description:
    "Sends one of the user's Gmail drafts. The user sees its recipients, subject and text and decides whether it goes. Write the draft first with create_draft.",
  inputSchema: {
    type: "object",
    properties: {
      draftId: { type: "string", description: "The draft's ID, from create_draft or list_drafts." },
    },
    required: ["draftId"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
};

export const codenineTools = (set: CodenineToolSet | undefined): ReadonlyArray<UpstreamTool> =>
  set === "gmail" ? [GMAIL_SEND_DRAFT] : [];

/** Why a request Codenine makes itself failed, in plain words. */
export class CodenineToolError extends Schema.TaggedError<CodenineToolError>()(
  "CodenineToolError",
  {
    reason: Schema.Literals(["unauthorized", "not-found", "invalid", "unreachable"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unauthorized":
        return "Gmail turned down the saved sign-in.";
      case "not-found":
        return "Gmail has no draft with that ID.";
      case "invalid":
        return "Give the draft's ID as draftId.";
      case "unreachable":
        return "Codenine could not reach Gmail.";
    }
  }
}

const Header = Schema.Struct({ name: Schema.String, value: Schema.String });
interface DraftPart {
  readonly mimeType?: string | undefined;
  readonly headers?: ReadonlyArray<typeof Header.Type> | undefined;
  readonly body?: { readonly data?: string | undefined } | undefined;
  readonly parts?: ReadonlyArray<DraftPart> | undefined;
}
const DraftPart: Schema.Codec<DraftPart> = Schema.Struct({
  mimeType: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Array(Header)),
  body: Schema.optional(Schema.Struct({ data: Schema.optional(Schema.String) })),
  parts: Schema.optional(Schema.Array(Schema.suspend((): Schema.Codec<DraftPart> => DraftPart))),
});
const Draft = Schema.Struct({
  message: Schema.Struct({
    snippet: Schema.optional(Schema.String),
    payload: Schema.optional(DraftPart),
  }),
});
const decodeDraft = Schema.decodeUnknownEffect(Draft);
const SentMessage = Schema.Struct({ id: Schema.String, threadId: Schema.optional(Schema.String) });
const decodeSentMessage = Schema.decodeUnknownEffect(SentMessage);
const encodeSendRequest = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Struct({ id: Schema.String })),
);

export interface DraftSummary {
  readonly to: string;
  readonly cc: string | undefined;
  readonly subject: string;
  readonly text: string;
}

const draftIdOf = (args: Readonly<Record<string, unknown>>) => {
  const draftId = args["draftId"];
  return typeof draftId === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(draftId)
    ? Effect.succeed(draftId)
    : Effect.fail(new CodenineToolError({ reason: "invalid" }));
};

const request = Effect.fn("codenineTools.gmailRequest")(function* (
  fetchFn: FetchLike,
  token: string,
  url: string,
  init?: { readonly method: "POST"; readonly body: string },
) {
  const response = yield* Effect.tryPromise({
    try: () =>
      fetchFn(url, {
        method: init?.method ?? "GET",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(init === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(init === undefined ? {} : { body: init.body }),
      }),
    catch: (cause) => new CodenineToolError({ reason: "unreachable", cause }),
  });
  if (response.status === 401 || response.status === 403) {
    return yield* new CodenineToolError({ reason: "unauthorized" });
  }
  if (response.status === 404 || response.status === 400) {
    return yield* new CodenineToolError({ reason: "not-found" });
  }
  if (!response.ok) {
    return yield* new CodenineToolError({ reason: "unreachable", cause: response.status });
  }
  return yield* Effect.tryPromise({
    try: () => response.json() as Promise<unknown>,
    catch: (cause) => new CodenineToolError({ reason: "unreachable", cause }),
  });
});

const decodeBase64Url = (data: string) => Buffer.from(data, "base64url").toString("utf8");

const findText = (part: DraftPart): string | undefined => {
  if (part.mimeType === "text/plain" && part.body?.data !== undefined) {
    return decodeBase64Url(part.body.data);
  }
  for (const child of part.parts ?? []) {
    const text = findText(child);
    if (text !== undefined) return text;
  }
  return undefined;
};

/** What the approval card shows before a draft is sent. */
export const describeDraft = Effect.fn("codenineTools.describeDraft")(function* (
  fetchFn: FetchLike,
  token: string,
  args: Readonly<Record<string, unknown>>,
) {
  const draftId = yield* draftIdOf(args);
  const draft = yield* request(fetchFn, token, `${GMAIL_API}/drafts/${draftId}?format=full`).pipe(
    Effect.flatMap((body) =>
      decodeDraft(body).pipe(
        Effect.mapError((cause) => new CodenineToolError({ reason: "unreachable", cause })),
      ),
    ),
  );
  const payload = draft.message.payload;
  const header = (name: string) =>
    payload?.headers?.find((candidate) => candidate.name.toLowerCase() === name)?.value;
  const text =
    (payload === undefined ? undefined : findText(payload)) ?? draft.message.snippet ?? "";
  return {
    to: header("to") ?? "",
    cc: header("cc"),
    subject: header("subject") ?? "",
    text: text.trim(),
  } satisfies DraftSummary;
});

export const sendDraft = Effect.fn("codenineTools.sendDraft")(function* (
  fetchFn: FetchLike,
  token: string,
  args: Readonly<Record<string, unknown>>,
) {
  const draftId = yield* draftIdOf(args);
  const body = yield* encodeSendRequest({ id: draftId }).pipe(
    Effect.mapError((cause) => new CodenineToolError({ reason: "invalid", cause })),
  );
  const sent = yield* request(fetchFn, token, `${GMAIL_API}/drafts/send`, {
    method: "POST",
    body,
  }).pipe(
    Effect.flatMap((body) =>
      decodeSentMessage(body).pipe(
        Effect.mapError((cause) => new CodenineToolError({ reason: "unreachable", cause })),
      ),
    ),
  );
  return sent;
});

const IdTokenClaims = Schema.Struct({ email: Schema.String });
const decodeIdTokenClaims = Schema.decodeUnknownOption(Schema.fromJsonString(IdTokenClaims));

/** The email in an id token straight from Google's token endpoint; it is only shown, never trusted. */
export const idTokenEmail = (idToken: string | undefined): string | null => {
  const payload = idToken?.split(".")[1];
  if (payload === undefined) return null;
  return Option.getOrNull(
    Option.map(decodeIdTokenClaims(decodeBase64Url(payload)), (claims) => claims.email),
  );
};

const GitHubUser = Schema.Struct({ login: Schema.String });
const decodeGitHubUser = Schema.decodeUnknownOption(GitHubUser);

export const gitHubLogin = Effect.fn("codenineTools.gitHubLogin")(function* (
  fetchFn: FetchLike,
  token: string,
) {
  const response = yield* Effect.tryPromise({
    try: () =>
      fetchFn("https://api.github.com/user", {
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
      }),
    catch: (cause) => new CodenineToolError({ reason: "unreachable", cause }),
  });
  if (!response.ok) return null;
  const body = yield* Effect.tryPromise({
    try: () => response.json() as Promise<unknown>,
    catch: (cause) => new CodenineToolError({ reason: "unreachable", cause }),
  });
  return Option.getOrNull(Option.map(decodeGitHubUser(body), (user) => user.login));
});
