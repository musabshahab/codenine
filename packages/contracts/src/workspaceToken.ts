import * as Schema from "effect/Schema";

import { AuthGrantScope } from "./auth.ts";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const WORKSPACE_TOKEN_TYPE = "codenine-workspace+jwt";

/**
 * What a control server vouches for when it forwards a person's request to a
 * managed workspace server. Times are Unix seconds; tokens live for minutes.
 */
export const WorkspaceTokenClaims = Schema.Struct({
  /** The control server's installation ID. */
  iss: TrimmedNonEmptyString,
  /** The workspace the token is for. */
  aud: TrimmedNonEmptyString,
  /** The person's ID on the control server. */
  sub: TrimmedNonEmptyString,
  /** The control server session, the same across the tokens it mints. */
  sid: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  scopes: Schema.Array(AuthGrantScope),
  iat: NonNegativeInt,
  exp: NonNegativeInt,
  jti: TrimmedNonEmptyString,
});
export type WorkspaceTokenClaims = typeof WorkspaceTokenClaims.Type;

export const WorkspaceTokenProblem = Schema.Literals([
  "malformed",
  "unknown-key",
  "invalid-signature",
  "wrong-type",
  "invalid-claims",
  "wrong-issuer",
  "wrong-audience",
  "expired",
]);
export type WorkspaceTokenProblem = typeof WorkspaceTokenProblem.Type;
