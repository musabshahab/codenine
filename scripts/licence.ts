#!/usr/bin/env node

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  LICENCE_ISSUER,
  LicenceClaims,
  LicenceEdition,
  LicenceFeature,
  licenceStanding,
  signLicence,
  verifyLicence,
} from "@codenine/shared/licence";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { Hex } from "effect/encoding";
import * as FileSystem from "effect/FileSystem";
import * as Jwk from "effect/jose/Jwk";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";

export class LicenceScriptError extends Schema.TaggedError<LicenceScriptError>()(
  "LicenceScriptError",
  { message: Schema.String },
) {}

const DAY_SECONDS = 86_400;
const decodeClaims = Schema.decodeUnknownEffect(LicenceClaims);
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

const dayStartSeconds = (date: string, flag: string) => {
  const ms = DATE.test(date) ? Date.parse(`${date}T00:00:00Z`) : Number.NaN;
  return Number.isNaN(ms)
    ? Effect.fail(new LicenceScriptError({ message: `--${flag} must be a date like 2027-11-30.` }))
    : Effect.succeed(ms / 1_000);
};

const parseList = <A extends string>(value: string, allowed: ReadonlyArray<A>, flag: string) => {
  const items = [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  ];
  const unknown = items.filter((item) => !(allowed as ReadonlyArray<string>).includes(item));
  return unknown.length > 0
    ? Effect.fail(
        new LicenceScriptError({
          message: `--${flag} accepts ${allowed.join(", ")}; got ${unknown.join(", ")}.`,
        }),
      )
    : Effect.succeed(items);
};

/** Builds licence claims. The licence covers both dates in full, in UTC. */
export const buildLicenceClaims = Effect.fn("licence.buildClaims")(function* (input: {
  readonly licenceId: string;
  readonly customer: string;
  readonly seats: number;
  readonly editions: string;
  readonly features: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly graceDays: number;
  readonly installationId?: string | undefined;
  readonly issuedAtMs: number;
}): Effect.fn.Return<LicenceClaims, LicenceScriptError> {
  const nbf = yield* dayStartSeconds(input.startsOn, "starts");
  const exp = (yield* dayStartSeconds(input.endsOn, "ends")) + DAY_SECONDS;
  if (exp <= nbf) {
    return yield* new LicenceScriptError({ message: "--ends must not be before --starts." });
  }
  const editions = yield* parseList(input.editions, LicenceEdition.literals, "editions");
  const features = yield* parseList(input.features, LicenceFeature.literals, "features");
  return yield* decodeClaims({
    iss: LICENCE_ISSUER,
    sub: input.licenceId,
    customer: input.customer,
    seats: input.seats,
    editions,
    features,
    iat: Math.floor(input.issuedAtMs / 1_000),
    nbf,
    exp,
    graceDays: input.graceDays,
    ...(input.installationId ? { installationId: input.installationId } : {}),
  }).pipe(
    Effect.mapError(
      (cause) => new LicenceScriptError({ message: `Invalid licence details: ${cause.message}` }),
    ),
  );
});

const keygenCommand = Command.make(
  "keygen",
  {
    keyId: Flag.String("key-id").pipe(
      Flag.withDescription("Name for this signing key, such as 2026-1."),
    ),
    outDir: Flag.String("out-dir").pipe(Flag.withDescription("Folder for the two key files.")),
  },
  Effect.fnUntraced(function* ({ keyId, outDir }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const privatePath = path.join(outDir, `${keyId}.private.pem`);
    const publicPath = path.join(outDir, `${keyId}.public.pem`);
    for (const target of [privatePath, publicPath]) {
      if (yield* fs.exists(target)) {
        return yield* new LicenceScriptError({ message: `${target} already exists.` });
      }
    }
    const pair = yield* Jwk.generateKeyPair({ algorithm: "EdDSA" });
    const privatePem = yield* Jwk.importPrivate(pair.privateKey, "EdDSA").pipe(
      Effect.flatMap((key) => Jwk.exportPkcs8(key, { format: "pem" })),
    );
    const publicPem = yield* Jwk.importPublic(pair.publicKey, "EdDSA").pipe(
      Effect.flatMap((key) => Jwk.exportSpki(key, { format: "pem" })),
    );
    yield* fs.makeDirectory(outDir, { recursive: true });
    yield* fs.writeFileString(privatePath, `${Redacted.value(privatePem)}\n`, { mode: 0o600 });
    yield* fs.writeFileString(publicPath, `${publicPem}\n`);
    yield* Console.log(`Private key: ${privatePath} (keep it in the vault; never commit it)`);
    yield* Console.log(`Public key:  ${publicPath} (built into control servers)`);
  }),
).pipe(Command.withDescription("Create a licence signing key pair."));

const issueCommand = Command.make(
  "issue",
  {
    privateKey: Flag.String("private-key").pipe(Flag.withDescription("Path to the private key.")),
    keyId: Flag.String("key-id").pipe(Flag.withDescription("Name of the signing key.")),
    customer: Flag.String("customer").pipe(Flag.withDescription("Customer's legal name.")),
    seats: Flag.Int("seats").pipe(Flag.withDescription("Named users allowed.")),
    editions: Flag.String("editions").pipe(
      Flag.withDescription(`Comma-separated: ${LicenceEdition.literals.join(", ")}.`),
    ),
    features: Flag.String("features").pipe(
      Flag.withDescription(`Comma-separated: ${LicenceFeature.literals.join(", ")}.`),
      Flag.withDefault(""),
    ),
    starts: Flag.String("starts").pipe(Flag.withDescription("First day, such as 2026-12-01.")),
    ends: Flag.String("ends").pipe(Flag.withDescription("Last day, such as 2027-11-30.")),
    graceDays: Flag.Int("grace-days").pipe(Flag.withDefault(30)),
    installationId: Flag.String("installation-id").pipe(
      Flag.withDescription("Tie the key to one installation."),
      Flag.optional,
    ),
    licenceId: Flag.String("licence-id").pipe(Flag.optional),
  },
  Effect.fnUntraced(function* (flags) {
    const fs = yield* FileSystem.FileSystem;
    const random = yield* SecureRandom.SecureRandom;
    const generatedId = `lic_${Hex.encode(yield* random.randomBytes(8))}`;
    const claims = yield* buildLicenceClaims({
      licenceId: Option.getOrElse(flags.licenceId, () => generatedId),
      customer: flags.customer,
      seats: flags.seats,
      editions: flags.editions,
      features: flags.features,
      startsOn: flags.starts,
      endsOn: flags.ends,
      graceDays: flags.graceDays,
      installationId: Option.getOrUndefined(flags.installationId),
      issuedAtMs: yield* Clock.currentTimeMillis,
    });
    const privateKey = yield* fs.readFileString(flags.privateKey);
    yield* Console.log(yield* signLicence({ privateKey, keyId: flags.keyId, claims }));
  }),
).pipe(Command.withDescription("Issue a licence key and print it."));

const inspectCommand = Command.make(
  "inspect",
  {
    licence: Argument.String("licence").pipe(
      Argument.withDescription("The licence key, or a path to a file holding it."),
    ),
    publicKey: Flag.String("public-key").pipe(Flag.withDescription("Path to the public key.")),
    keyId: Flag.String("key-id").pipe(Flag.withDescription("Name of the signing key.")),
  },
  Effect.fnUntraced(function* ({ licence, publicKey, keyId }) {
    const fs = yield* FileSystem.FileSystem;
    const token = (yield* fs.exists(licence)) ? yield* fs.readFileString(licence) : licence;
    const claims = yield* verifyLicence({
      token,
      trustedKeys: new Map([[keyId, yield* fs.readFileString(publicKey)]]),
    });
    const day = (seconds: number) =>
      DateTime.formatIsoDateUtc(DateTime.makeUnsafe(seconds * 1_000));
    const standing = licenceStanding(claims, yield* Clock.currentTimeMillis);
    yield* Console.log(
      [
        `Licence:   ${claims.sub}`,
        `Customer:  ${claims.customer}`,
        `Seats:     ${claims.seats}`,
        `Editions:  ${claims.editions.join(", ")}`,
        `Features:  ${claims.features.join(", ") || "none"}`,
        `Starts:    ${day(claims.nbf)}`,
        `Ends:      ${day(claims.exp - DAY_SECONDS)}`,
        `Grace:     ${claims.graceDays} days`,
        `Tied to:   ${claims.installationId ?? "any installation"}`,
        `Status:    ${standing.status}`,
      ].join("\n"),
    );
  }),
).pipe(Command.withDescription("Check a licence key's signature and show its details."));

export const licenceCommand = Command.make("licence").pipe(
  Command.withDescription("Create signing keys and issue Codenine business licence keys."),
  Command.withSubcommands([keygenCommand, issueCommand, inspectCommand]),
);

if (import.meta.main) {
  Command.run(licenceCommand, { version: "0.0.0" }).pipe(
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, NodeCrypto.layerSignature, NodeCrypto.layerSecureRandom),
    ),
    NodeRuntime.runMain,
  );
}
