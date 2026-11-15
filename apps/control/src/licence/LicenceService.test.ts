import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { LicenceClaims } from "@codenine/contracts/licence";
import type { LicenceSigningError } from "@codenine/shared/licence";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { ControlDb } from "../db.ts";
import { Installation } from "../installation/Installation.ts";
import { controlPeople } from "../persistence/schema.ts";
import { layerControlTestDb } from "../testing/ControlTestDb.ts";
import {
  DEC_1_2026,
  signTestLicence,
  TEST_KEY_ID,
  testClaims,
  testKeyPair,
} from "../testing/testLicence.ts";
import * as Licence from "./LicenceService.ts";

const DAY = 86_400;
const DEC_1 = DEC_1_2026;
const at = (date: string) => TestClock.setTime(Date.parse(`${date}T12:00:00Z`));
const claims = testClaims;

const withControl = <A, E, R>(
  body: (keys: {
    readonly sign: (
      claims: LicenceClaims,
      privateKey?: string,
    ) => Effect.Effect<string, LicenceSigningError>;
    readonly otherPrivateKey: string;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const ours = yield* testKeyPair;
    const theirs = yield* testKeyPair;
    const sign = (licence: LicenceClaims, privateKey = ours.privateKey) =>
      signTestLicence(licence, privateKey);
    return yield* body({ sign, otherPrivateKey: theirs.privateKey }).pipe(
      Effect.provide(
        Licence.layer.pipe(
          Layer.provideMerge(Installation.layer),
          Layer.provide(
            Layer.succeed(Licence.LicenceTrust, new Map([[TEST_KEY_ID, ours.publicKey]])),
          ),
          Layer.provideMerge(layerControlTestDb),
        ),
      ),
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, NodeCrypto.layerSignature, NodeCrypto.layerSecureRandom),
    ),
  );

const person = (id: string, status: "invited" | "active" | "deactivated") => ({
  id,
  email: `${id}@acme.test`,
  displayName: id,
  role: "member" as const,
  status,
  createdAt: "2026-12-01T00:00:00.000Z",
  updatedAt: "2026-12-01T00:00:00.000Z",
});

describe("LicenceService", () => {
  it.effect("installs a key and counts invited and active people as seats", () =>
    withControl(({ sign }) =>
      Effect.gen(function* () {
        yield* at("2026-12-10");
        const licence = yield* Licence.LicenceService;
        expect((yield* licence.overview).licence).toEqual({ _tag: "missing" });
        expect(Licence.workspaceAccess((yield* licence.overview).licence)).toEqual({
          canWork: false,
          reason: "no-licence",
        });

        const db = yield* ControlDb;
        yield* db
          .insert(controlPeople)
          .values([
            person("ada", "active"),
            person("bea", "invited"),
            person("cy", "deactivated"),
            person("dee", "active"),
          ]);

        const installed = yield* licence.install(`  ${yield* sign(claims())}\n`);
        expect(installed.licenceId).toBe("lic_first");
        expect(installed.overview.installationId).toBe((yield* Installation).id);
        expect(installed.overview.licence).toEqual({
          _tag: "installed",
          licenceId: "lic_first",
          customer: "Acme Ltd",
          seats: 3,
          seatsUsed: 3,
          editions: ["coding"],
          features: [],
          status: "active",
          startsAt: "2026-12-01T00:00:00.000Z",
          expiresAt: "2027-12-01T00:00:00.000Z",
          graceEndsAt: "2027-12-31T00:00:00.000Z",
          installedAt: "2026-12-10T12:00:00.000Z",
        });

        yield* db.insert(controlPeople).values(person("eve", "invited"));
        expect(yield* licence.overview).toMatchObject({ licence: { seats: 3, seatsUsed: 4 } });
      }),
    ),
  );

  it.effect("refuses keys it cannot trust and keeps none of them", () =>
    withControl(({ sign, otherPrivateKey }) =>
      Effect.gen(function* () {
        yield* at("2026-12-10");
        const licence = yield* Licence.LicenceService;
        const reasonFor = (token: string) =>
          licence.install(token).pipe(
            Effect.flip,
            Effect.map((error) => error.reason),
          );

        expect(yield* reasonFor(yield* sign(claims(), otherPrivateKey))).toBe("invalid-signature");
        const [header, , signature] = (yield* sign(claims())).split(".");
        const moreSeats = Buffer.from(JSON.stringify(claims({ seats: 500 }))).toString("base64url");
        expect(yield* reasonFor(`${header}.${moreSeats}.${signature}`)).toBe("invalid-signature");
        expect(yield* reasonFor(yield* sign(claims({ installationId: "inst_elsewhere" })))).toBe(
          "wrong-installation",
        );
        expect((yield* licence.overview).licence).toEqual({ _tag: "missing" });

        const tiedHere = claims({ installationId: (yield* Installation).id });
        expect((yield* licence.install(yield* sign(tiedHere))).overview.licence).toMatchObject({
          _tag: "installed",
          status: "active",
        });
      }),
    ),
  );

  it.effect("keeps the working key until a renewal installed early starts", () =>
    withControl(({ sign }) =>
      Effect.gen(function* () {
        const licence = yield* Licence.LicenceService;
        const appliedLicence = licence.overview.pipe(
          Effect.map(({ licence: applied }) =>
            applied._tag === "installed" ? [applied.licenceId, applied.status] : [applied._tag],
          ),
        );
        yield* at("2027-11-20");
        yield* licence.install(yield* sign(claims()));
        expect(yield* appliedLicence).toEqual(["lic_first", "expiring"]);

        const renewal = claims({
          sub: "lic_renewal",
          nbf: DEC_1 + 365 * DAY,
          exp: DEC_1 + 730 * DAY,
        });
        yield* licence.install(yield* sign(renewal));
        const expiredLongAgo = claims({
          sub: "lic_old",
          nbf: DEC_1 - 730 * DAY,
          exp: DEC_1 - 365 * DAY,
        });
        yield* licence.install(yield* sign(expiredLongAgo));
        expect(yield* appliedLicence).toEqual(["lic_first", "expiring"]);

        yield* at("2027-12-01");
        expect(yield* appliedLicence).toEqual(["lic_renewal", "active"]);
        expect(Licence.workspaceAccess((yield* licence.overview).licence).canWork).toBe(true);

        yield* at("2029-12-31");
        expect(yield* appliedLicence).toEqual(["lic_renewal", "expired"]);
        expect(Licence.workspaceAccess((yield* licence.overview).licence)).toEqual({
          canWork: false,
          reason: "licence-ended",
        });
      }),
    ),
  );

  it.effect("reports a stored key this build no longer trusts as unusable", () =>
    withControl(({ sign }) =>
      Effect.gen(function* () {
        yield* at("2026-12-10");
        yield* (yield* Licence.LicenceService).install(yield* sign(claims()));
        const rebuilt = yield* Licence.make.pipe(
          Effect.provideService(Licence.LicenceTrust, new Map()),
        );
        expect((yield* rebuilt.overview).licence).toEqual({
          _tag: "unusable",
          licenceId: "lic_first",
          problem: "unknown-key",
        });
        expect(Licence.workspaceAccess((yield* rebuilt.overview).licence)).toEqual({
          canWork: false,
          reason: "licence-unusable",
        });
      }),
    ),
  );
});
