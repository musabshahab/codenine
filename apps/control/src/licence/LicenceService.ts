import type {
  ControlLicenceOverview,
  ControlLicenceSummary,
  ControlWorkspaceAccess,
} from "@codenine/contracts/control";
import type { LicenceClaims } from "@codenine/contracts/licence";
import {
  LicenceError,
  licenceAllowsWork,
  licenceStanding,
  verifyLicence,
} from "@codenine/shared/licence";
import { count, desc, inArray } from "drizzle-orm";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Signature from "effect/crypto/Signature";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

import { ControlDb } from "../db.ts";
import { Installation } from "../installation/Installation.ts";
import { controlLicences, controlPeople } from "../persistence/schema.ts";

/**
 * Public keys this build trusts to sign licence keys, by key ID. Make a pair
 * with `node scripts/licence.ts keygen` and add only the public key here; the
 * private key stays in our vault.
 */
const BUILT_IN_LICENCE_KEYS: ReadonlyMap<string, string> = new Map();

export class LicenceTrust extends Context.Service<LicenceTrust, ReadonlyMap<string, string>>()(
  "@codenine/control/licence/LicenceService/LicenceTrust",
) {
  static readonly layer = Layer.succeed(LicenceTrust, BUILT_IN_LICENCE_KEYS);
}

export interface LicenceInstallResult {
  readonly licenceId: string;
  readonly overview: ControlLicenceOverview;
}

export class LicenceService extends Context.Service<
  LicenceService,
  {
    /** Verifies and stores a key. It applies when it is the best working key installed. */
    readonly install: (token: string) => Effect.Effect<LicenceInstallResult, LicenceError>;
    readonly overview: Effect.Effect<ControlLicenceOverview>;
  }
>()("@codenine/control/licence/LicenceService") {}

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

interface CheckedLicence {
  readonly id: string;
  readonly installedAt: string;
  readonly result: Result.Result<LicenceClaims, LicenceError>;
}

/**
 * The working key that runs longest applies, so a renewal installed early
 * takes over only when it starts. With no working key, the trusted key that
 * runs longest is shown. Ties go to the most recently installed key.
 */
const choose = (
  checked: ReadonlyArray<CheckedLicence>,
  nowMs: number,
  seatsUsed: number,
): ControlLicenceSummary => {
  const usable = checked.flatMap((entry) =>
    Result.isSuccess(entry.result)
      ? [
          {
            ...entry,
            claims: entry.result.success,
            standing: licenceStanding(entry.result.success, nowMs),
          },
        ]
      : [],
  );
  const working = usable.filter((entry) => licenceAllowsWork(entry.standing.status));
  const chosen = (working.length > 0 ? working : usable).reduce<
    (typeof usable)[number] | undefined
  >(
    (best, entry) =>
      best === undefined ||
      entry.claims.exp > best.claims.exp ||
      (entry.claims.exp === best.claims.exp && entry.installedAt > best.installedAt)
        ? entry
        : best,
    undefined,
  );
  if (chosen !== undefined) {
    return {
      _tag: "installed",
      licenceId: chosen.claims.sub,
      customer: chosen.claims.customer,
      seats: chosen.claims.seats,
      seatsUsed,
      editions: chosen.claims.editions,
      features: chosen.claims.features,
      status: chosen.standing.status,
      startsAt: iso(chosen.claims.nbf * 1_000),
      expiresAt: iso(chosen.standing.expiresAtMs),
      graceEndsAt: iso(chosen.standing.graceEndsAtMs),
      installedAt: chosen.installedAt,
    };
  }
  const latest = checked[0];
  if (latest !== undefined && Result.isFailure(latest.result)) {
    return { _tag: "unusable", licenceId: latest.id, problem: latest.result.failure.reason };
  }
  return { _tag: "missing" };
};

export const make = Effect.gen(function* () {
  const db = yield* ControlDb;
  const trustedKeys = yield* LicenceTrust;
  const installation = yield* Installation;
  const signature = yield* Signature.Signature;

  const verify = (token: string) =>
    verifyLicence({ token, trustedKeys, installationId: installation.id }).pipe(
      Effect.provideService(Signature.Signature, signature),
    );

  const seatsUsed = db
    .select({ count: count() })
    .from(controlPeople)
    .where(inArray(controlPeople.status, ["invited", "active"]))
    .pipe(Effect.map(([row]) => row?.count ?? 0));

  const overview = Effect.gen(function* () {
    const rows = yield* db
      .select()
      .from(controlLicences)
      .orderBy(desc(controlLicences.installedAt));
    const checked = yield* Effect.forEach(rows, (row) =>
      verify(row.token).pipe(
        Effect.result,
        Effect.map((result) => ({ id: row.id, installedAt: row.installedAt, result })),
      ),
    );
    const licence = choose(checked, yield* Clock.currentTimeMillis, yield* seatsUsed);
    return { installationId: installation.id, licence };
  }).pipe(Effect.orDie, Effect.withSpan("LicenceService.overview"));

  const install = Effect.fn("LicenceService.install")(function* (token: string) {
    const trimmed = token.trim();
    const claims = yield* verify(trimmed);
    const installedAt = DateTime.formatIso(yield* DateTime.now);
    yield* db
      .insert(controlLicences)
      .values({ id: claims.sub, token: trimmed, installedAt })
      .onConflictDoUpdate({ target: controlLicences.id, set: { token: trimmed, installedAt } })
      .pipe(Effect.orDie);
    return { licenceId: claims.sub, overview: yield* overview };
  });

  return LicenceService.of({ install, overview });
});

export const layer = Layer.effect(LicenceService, make);

/** End times are exclusive, so the last day a licence or its grace covers is the day before. */
/** Workspaces are read-only unless the licence in use allows work. */
export const workspaceAccess = (licence: ControlLicenceSummary): ControlWorkspaceAccess => {
  switch (licence._tag) {
    case "missing":
      return { canWork: false, reason: "no-licence" };
    case "unusable":
      return { canWork: false, reason: "licence-unusable" };
    case "installed":
      return licenceAllowsWork(licence.status)
        ? { canWork: true, reason: null }
        : {
            canWork: false,
            reason: licence.status === "not-yet-valid" ? "licence-not-started" : "licence-ended",
          };
  }
};

export const lastDay = (iso: string) =>
  DateTime.formatIsoDateUtc(DateTime.makeUnsafe(iso).pipe(DateTime.subtract({ days: 1 })));

/** Logs where the licence stands, for admins reading the server log. */
export const logLicenceStanding = Effect.fn("LicenceService.logStanding")(function* () {
  const { licence } = yield* (yield* LicenceService).overview;
  switch (licence._tag) {
    case "missing":
      return yield* Effect.logWarning(
        "No licence key is installed, so Codenine is read-only. Install one with `codenine-control licence install`.",
      );
    case "unusable":
      return yield* Effect.logError(
        `Licence ${licence.licenceId} cannot be used (${licence.problem}), so Codenine is read-only. Install a valid key.`,
      );
    case "installed":
      break;
  }
  if (licence.seatsUsed > licence.seats) {
    yield* Effect.logWarning(
      `${licence.seatsUsed} people hold seats but licence ${licence.licenceId} allows ${licence.seats}. Deactivate people or install a key with more seats.`,
    );
  }
  switch (licence.status) {
    case "not-yet-valid":
      return yield* Effect.logWarning(
        `Licence ${licence.licenceId} starts on ${licence.startsAt.slice(0, 10)}; Codenine is read-only until then.`,
      );
    case "active":
      return yield* Effect.logInfo(
        `Licence ${licence.licenceId} for ${licence.customer} runs through ${lastDay(licence.expiresAt)}.`,
      );
    case "expiring":
      return yield* Effect.logWarning(
        `Licence ${licence.licenceId} runs through ${lastDay(licence.expiresAt)}. Install the renewal before then.`,
      );
    case "grace":
      return yield* Effect.logWarning(
        `Licence ${licence.licenceId} has ended. Codenine keeps working through ${lastDay(licence.graceEndsAt)}; install the renewal.`,
      );
    case "expired":
      return yield* Effect.logError(
        `Licence ${licence.licenceId} has expired, so Codenine is read-only. Install a new key.`,
      );
  }
});

/** Checks the licence at start-up and then once a day. */
export const layerDailyCheck = Layer.effectDiscard(
  logLicenceStanding().pipe(
    Effect.catchCause((cause) => Effect.logError("The licence check failed.", cause)),
    Effect.repeat(Schedule.spaced(Duration.days(1))),
    Effect.forkScoped,
  ),
);
