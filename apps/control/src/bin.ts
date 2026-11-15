#!/usr/bin/env node

import { ControlAccountError, type ControlLicenceOverview } from "@codenine/contracts/control";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { Argument, Command, Flag } from "effect/cli";

import { Accounts } from "./accounts/Accounts.ts";
import * as AccountsModule from "./accounts/Accounts.ts";
import { SecretBox } from "./accounts/SecretBox.ts";
import * as Sessions from "./accounts/Sessions.ts";
import { WebAuthn } from "./accounts/WebAuthn.ts";
import { ControlPublicUrl, enrolmentLink } from "./config.ts";
import * as Db from "./db.ts";
import * as ControlHttp from "./http/ControlHttp.ts";
import { Installation } from "./installation/Installation.ts";
import * as Licence from "./licence/LicenceService.ts";
import { Mailer } from "./mail/Mailer.ts";
import * as WorkspaceProxy from "./workspaces/WorkspaceProxy.ts";
import * as WorkspaceTokensModule from "./workspaces/WorkspaceTokens.ts";

const layerControl = Licence.layer.pipe(
  Layer.provideMerge(Installation.layer),
  Layer.provide(Licence.LicenceTrust.layer),
  Layer.provideMerge(Db.layer),
);

const layerAccounts = AccountsModule.layer.pipe(
  Layer.provideMerge(WebAuthn.layer),
  Layer.provideMerge(Mailer.layer),
  Layer.provideMerge(Sessions.layer),
  Layer.provideMerge(SecretBox.layer),
  Layer.provideMerge(layerControl),
  Layer.provideMerge(ControlPublicUrl.layer),
);

const ServeConfig = Config.all({
  host: Config.String("CODENINE_CONTROL_HOST").pipe(Config.withDefault("127.0.0.1")),
  port: Config.Port("CODENINE_CONTROL_PORT").pipe(Config.withDefault(3780)),
});

const formatOverview = ({ installationId, licence }: ControlLicenceOverview) => {
  const lines = [`Installation: ${installationId}`];
  switch (licence._tag) {
    case "missing":
      lines.push("Licence:      none installed, so Codenine is read-only");
      break;
    case "unusable":
      lines.push(`Licence:      ${licence.licenceId} cannot be used (${licence.problem})`);
      break;
    case "installed":
      lines.push(
        `Licence:      ${licence.licenceId} (${licence.status})`,
        `Customer:     ${licence.customer}`,
        `Seats:        ${licence.seatsUsed} of ${licence.seats} in use`,
        `Editions:     ${licence.editions.join(", ")}`,
        `Features:     ${licence.features.join(", ") || "none"}`,
        `Runs:         ${licence.startsAt.slice(0, 10)} to ${Licence.lastDay(licence.expiresAt)}, then grace to ${Licence.lastDay(licence.graceEndsAt)}`,
      );
      break;
  }
  return lines.join("\n");
};

const serveCommand = Command.make("serve", {}, () =>
  Effect.gen(function* () {
    const { host, port } = yield* ServeConfig;
    return yield* Layer.launch(
      Layer.mergeAll(
        ControlHttp.layerServer(
          { host, port },
          Layer.mergeAll(WorkspaceProxy.layerForwarding, ControlHttp.layerWebApp),
        ),
        Licence.layerDailyCheck,
      ).pipe(
        Layer.provide(WorkspaceTokensModule.layer),
        Layer.provide(Layer.mergeAll(FetchHttpClient.layer, NodeSocket.layerWebSocketConstructor)),
        Layer.provideMerge(layerAccounts),
      ),
    );
  }),
).pipe(Command.withDescription("Run the control server."));

const installCommand = Command.make(
  "install",
  {
    licence: Argument.String("licence").pipe(
      Argument.withDescription("A path to the licence key file, or the key itself."),
    ),
  },
  Effect.fnUntraced(function* ({ licence }) {
    const fs = yield* FileSystem.FileSystem;
    const token = (yield* fs.exists(licence)) ? yield* fs.readFileString(licence) : licence;
    const result = yield* (yield* Licence.LicenceService).install(token);
    const inUse =
      result.overview.licence._tag === "installed" &&
      result.overview.licence.licenceId === result.licenceId;
    yield* Console.log(
      inUse
        ? `Installed licence ${result.licenceId}. It is now in use.\n`
        : `Installed licence ${result.licenceId}. It is not in use yet: the longest-running working licence applies.\n`,
    );
    yield* Console.log(formatOverview(result.overview));
  }, Effect.provide(layerControl)),
).pipe(Command.withDescription("Install a licence key."));

const showCommand = Command.make("show", {}, () =>
  Licence.LicenceService.pipe(
    Effect.flatMap((licence) => licence.overview),
    Effect.flatMap((overview) => Console.log(formatOverview(overview))),
    Effect.provide(layerControl),
  ),
).pipe(Command.withDescription("Show the licence in use and this installation's ID."));

const inviteOwnerCommand = Command.make(
  "invite-owner",
  {
    email: Flag.String("email").pipe(Flag.withDescription("The owner's email address.")),
    name: Flag.String("name").pipe(Flag.withDescription("The owner's name."), Flag.withDefault("")),
  },
  Effect.fnUntraced(function* ({ email, name }) {
    const { person, token, emailed } = yield* (yield* Accounts).inviteOwner({
      email,
      displayName: name,
    });
    yield* Console.log(
      [
        `${person.displayName} <${person.email}> is invited as the owner.`,
        emailed
          ? "We emailed them this link. It works once and expires in 7 days:"
          : "Send them this link. It works once and expires in 7 days:",
        "",
        `  ${enrolmentLink((yield* ControlPublicUrl).origin, token)}`,
      ].join("\n"),
    );
  }, Effect.provide(layerAccounts)),
).pipe(Command.withDescription("Invite the first owner. Refused once an owner can sign in."));

const resetCommand = Command.make(
  "reset",
  { email: Flag.String("email").pipe(Flag.withDescription("The person's email address.")) },
  Effect.fnUntraced(function* ({ email }) {
    const accounts = yield* Accounts;
    const person = (yield* accounts.listPeople).find(
      (candidate) => candidate.email.toLowerCase() === email.trim().toLowerCase(),
    );
    if (person === undefined) {
      return yield* new ControlAccountError({ reason: "not-found" });
    }
    const { token, emailed } = yield* accounts.issueReset(person.id);
    yield* Console.log(
      [
        `${person.displayName}'s password, authenticator and passkeys are removed, and they are signed out everywhere.`,
        `${emailed ? "We emailed them this link" : "Send them this link"} to set new ones. It works once and expires in ${person.status === "invited" ? "7 days" : "24 hours"}:`,
        "",
        `  ${enrolmentLink((yield* ControlPublicUrl).origin, token)}`,
      ].join("\n"),
    );
  }, Effect.provide(layerAccounts)),
).pipe(
  Command.withDescription(
    "Remove someone's password, authenticator and passkeys, and print a link to set new ones.",
  ),
);

const workspaceKeyCommand = Command.make("key", {}, () =>
  Effect.gen(function* () {
    const { verifier } = yield* WorkspaceTokensModule.WorkspaceTokens;
    yield* Console.log(
      [
        "Set these on each workspace server so it accepts people this control server signs in:",
        "",
        `CODENINE_MANAGED_ISSUER=${verifier.issuer}`,
        `CODENINE_MANAGED_KEY_ID=${verifier.keyId}`,
        `CODENINE_MANAGED_PUBLIC_KEY="${verifier.publicKey.trim().replaceAll("\n", "\\n")}"`,
      ].join("\n"),
    );
  }).pipe(
    Effect.provide(
      WorkspaceTokensModule.layer.pipe(Layer.provide(SecretBox.layer), Layer.provide(layerControl)),
    ),
  ),
).pipe(
  Command.withDescription("Print what a workspace server needs to trust this control server."),
);

const controlCommand = Command.make("codenine-control").pipe(
  Command.withDescription("The Codenine control server for business installations."),
  Command.withSubcommands([
    serveCommand,
    Command.make("licence").pipe(
      Command.withDescription("Install and inspect licence keys."),
      Command.withSubcommands([installCommand, showCommand]),
    ),
    Command.make("workspace").pipe(
      Command.withDescription("Connect workspace servers to this control server."),
      Command.withSubcommands([workspaceKeyCommand]),
    ),
    Command.make("people").pipe(
      Command.withDescription("Invite the first owner and recover locked-out people."),
      Command.withSubcommands([inviteOwnerCommand, resetCommand]),
    ),
  ]),
);

Command.run(controlCommand, { version: "0.0.0" }).pipe(
  Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  NodeRuntime.runMain,
);
