import * as Layer from "effect/Layer";

import * as Accounts from "../accounts/Accounts.ts";
import { SecretBox } from "../accounts/SecretBox.ts";
import * as Sessions from "../accounts/Sessions.ts";
import { ControlPublicUrl } from "../config.ts";
import { Installation } from "../installation/Installation.ts";
import * as Licence from "../licence/LicenceService.ts";
import { layerControlTestDb } from "./ControlTestDb.ts";
import { TEST_KEY_ID } from "./testLicence.ts";

export const TEST_PUBLIC_URL = "https://codenine.acme.test";

/** Every control service on a fresh PGlite database, trusting one test licence key. */
export const layerTestServices = (licencePublicKey: string) =>
  Accounts.layer.pipe(
    Layer.provideMerge(Sessions.layer),
    Layer.provideMerge(Licence.layer),
    Layer.provideMerge(Installation.layer),
    Layer.provide(Layer.succeed(Licence.LicenceTrust, new Map([[TEST_KEY_ID, licencePublicKey]]))),
    Layer.provide(Layer.effect(SecretBox, SecretBox.make(new Uint8Array(32).fill(7)))),
    Layer.provideMerge(layerControlTestDb),
    Layer.provideMerge(Layer.effect(ControlPublicUrl, ControlPublicUrl.make(TEST_PUBLIC_URL))),
  );
