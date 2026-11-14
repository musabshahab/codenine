import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as OpenApi from "effect/http-api/OpenApi";

import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { LicenceEdition, LicenceFeature, LicenceProblem, LicenceStatus } from "./licence.ts";

export const ControlLicenceSummary = Schema.TaggedUnion({
  missing: {},
  unusable: { licenceId: TrimmedNonEmptyString, problem: LicenceProblem },
  installed: {
    licenceId: TrimmedNonEmptyString,
    customer: TrimmedNonEmptyString,
    seats: PositiveInt,
    seatsUsed: NonNegativeInt,
    editions: Schema.NonEmptyArray(LicenceEdition),
    features: Schema.Array(LicenceFeature),
    status: LicenceStatus,
    startsAt: IsoDateTime,
    /** The licence covers time before this instant; grace follows it. */
    expiresAt: IsoDateTime,
    graceEndsAt: IsoDateTime,
    installedAt: IsoDateTime,
  },
});
export type ControlLicenceSummary = typeof ControlLicenceSummary.Type;

export const ControlLicenceOverview = Schema.Struct({
  /** Licence keys can be tied to this ID. */
  installationId: TrimmedNonEmptyString,
  licence: ControlLicenceSummary,
});
export type ControlLicenceOverview = typeof ControlLicenceOverview.Type;

export class ControlUnavailableError extends Schema.TaggedError<ControlUnavailableError>()(
  "ControlUnavailableError",
  { reason: Schema.Literals(["database-unavailable"]) },
  { httpApiStatus: 503 },
) {}

export const ControlHealthResponse = Schema.Struct({
  ok: Schema.Literal(true),
  service: Schema.Literal("control"),
});
export type ControlHealthResponse = typeof ControlHealthResponse.Type;

/**
 * Everything the control server answers itself lives under `/control`, so
 * `/api` and `/ws` stay free to forward to a workspace server.
 */
const ControlHealthGroup = HttpApiGroup.make("health").add(
  HttpApiEndpoint.get("health", "/control/health", {
    success: ControlHealthResponse,
    error: ControlUnavailableError,
  }).annotate(OpenApi.Summary, "Check the control server and its database"),
);

export const ControlApi = HttpApi.make("ControlApi")
  .add(ControlHealthGroup)
  .annotate(OpenApi.Title, "Codenine Control API");
export type ControlApi = typeof ControlApi;
