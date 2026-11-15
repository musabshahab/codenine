import type { MailMessage } from "./Mailer.ts";

interface LinkMail {
  readonly to: string;
  readonly displayName: string;
  /** The installation's address, so people can tell which Codenine wrote. */
  readonly origin: string;
  readonly link: string;
  /** How long the link works, such as "7 days". */
  readonly validFor: string;
}

const lines = (...parts: ReadonlyArray<string>) => parts.join("\n");

export const invitationMail = (mail: LinkMail): MailMessage => ({
  to: mail.to,
  subject: "You are invited to Codenine",
  text: lines(
    `Hello ${mail.displayName},`,
    "",
    `You have been invited to Codenine at ${mail.origin}.`,
    "",
    `Open this link to choose a password and set up your sign-in. It works once and expires in ${mail.validFor}:`,
    "",
    mail.link,
    "",
    "If you were not expecting this, you can ignore this email.",
  ),
});

export const resetMail = (mail: LinkMail): MailMessage => ({
  to: mail.to,
  subject: "Set up your Codenine sign-in again",
  text: lines(
    `Hello ${mail.displayName},`,
    "",
    `An admin reset your sign-in to Codenine at ${mail.origin}, so your old password and authenticator no longer work.`,
    "",
    `Open this link to set up new ones. It works once and expires in ${mail.validFor}:`,
    "",
    mail.link,
  ),
});

export const passwordResetMail = (mail: LinkMail): MailMessage => ({
  to: mail.to,
  subject: "Choose a new Codenine password",
  text: lines(
    `Hello ${mail.displayName},`,
    "",
    `Someone asked to reset the password for ${mail.to} on Codenine at ${mail.origin}.`,
    "",
    `If it was you, open this link within ${mail.validFor} to choose a new password. You will also need your passkey, authenticator app or a recovery code:`,
    "",
    mail.link,
    "",
    "If it was not you, ignore this email. Your password has not changed.",
  ),
});

export const workspaceOpenedMail = (mail: {
  readonly to: string;
  readonly displayName: string;
  readonly origin: string;
  /** Who opened it, by their email. */
  readonly by: string;
  readonly reason: string;
  /** When their look ends, in UTC. */
  readonly until: string;
}): MailMessage => ({
  to: mail.to,
  subject: "An owner opened your Codenine workspace",
  text: lines(
    `Hello ${mail.displayName},`,
    "",
    `${mail.by} opened your workspace on Codenine at ${mail.origin} to look at it, without changing anything, until ${mail.until} UTC.`,
    "",
    `The reason they gave: ${mail.reason}`,
    "",
    "This is in the audit log. If you have questions, ask them or another owner.",
  ),
});

/** A warning about AI spend: a budget nearly or wholly used, or an hour far above usual. */
export const budgetAlertMail = (mail: {
  readonly to: string;
  readonly displayName: string;
  readonly origin: string;
  readonly subject: string;
  /** What happened, in one or two sentences. */
  readonly what: string;
  /** What the reader can do about it. */
  readonly next: string;
}): MailMessage => ({
  to: mail.to,
  subject: mail.subject,
  text: lines(
    `Hello ${mail.displayName},`,
    "",
    mail.what,
    "",
    mail.next,
    "",
    `Codenine at ${mail.origin}`,
  ),
});
