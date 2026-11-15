import * as Layer from "effect/Layer";

import * as Accounts from "../accounts/Accounts.ts";
import { PasswordHashCost } from "../accounts/passwords.ts";
import { SecretBox } from "../accounts/SecretBox.ts";
import * as Sessions from "../accounts/Sessions.ts";
import * as AuditLog from "../audit/AuditLog.ts";
import * as Departments from "../departments/Departments.ts";
import * as Profiles from "../profiles/Profiles.ts";
import { WebAuthn } from "../accounts/WebAuthn.ts";
import { ControlPublicUrl } from "../config.ts";
import { Installation } from "../installation/Installation.ts";
import * as Licence from "../licence/LicenceService.ts";
import { Mailer } from "../mail/Mailer.ts";
import { layerControlTestDb } from "./ControlTestDb.ts";
import { TEST_KEY_ID } from "./testLicence.ts";

export const TEST_PUBLIC_URL = "https://codenine.acme.test";

/**
 * Every control service on a fresh PGlite database, trusting one test licence
 * key. Mail is off unless a test passes its own mailer.
 */
export const layerTestServices = (
  licencePublicKey: string,
  mailer: Layer.Layer<Mailer> = Layer.succeed(Mailer, Mailer.off),
) =>
  Profiles.layer.pipe(
    Layer.provideMerge(Accounts.layer),
    Layer.provideMerge(WebAuthn.layer),
    Layer.provideMerge(mailer),
    // The real cost makes tests that sign in many times slow; the rules do not change.
    Layer.provideMerge(Layer.succeed(PasswordHashCost, { memory: 64, passes: 1, parallelism: 1 })),
    Layer.provideMerge(Sessions.layer),
    Layer.provideMerge(AuditLog.layer),
    Layer.provideMerge(Departments.layer),
    Layer.provideMerge(Licence.layer),
    Layer.provideMerge(Installation.layer),
    Layer.provide(Layer.succeed(Licence.LicenceTrust, new Map([[TEST_KEY_ID, licencePublicKey]]))),
    Layer.provideMerge(Layer.effect(SecretBox, SecretBox.make(new Uint8Array(32).fill(7)))),
    Layer.provideMerge(layerControlTestDb),
    Layer.provideMerge(Layer.effect(ControlPublicUrl, ControlPublicUrl.make(TEST_PUBLIC_URL))),
  );
