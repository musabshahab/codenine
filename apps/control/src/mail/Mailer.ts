import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { createTransport } from "nodemailer";

export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export class MailDeliveryError extends Schema.TaggedError<MailDeliveryError>()(
  "MailDeliveryError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The mail server did not accept the message.";
  }
}

/**
 * Sends set-up and password links through the company's own mail server,
 * named by `CODENINE_CONTROL_SMTP_URL`. Without one, admins pass links on by hand.
 */
export class Mailer extends Context.Service<
  Mailer,
  {
    readonly enabled: boolean;
    readonly send: (message: MailMessage) => Effect.Effect<void, MailDeliveryError>;
  }
>()("@codenine/control/mail/Mailer") {
  static readonly off = Mailer.of({
    enabled: false,
    send: Effect.fn("Mailer.send")(function* () {
      return yield* Effect.die("No mail server is configured.");
    }),
  });

  static readonly layer = Layer.effect(
    Mailer,
    Effect.gen(function* () {
      const url = yield* Config.option(Config.Redacted("CODENINE_CONTROL_SMTP_URL"));
      if (Option.isNone(url)) {
        return Mailer.off;
      }
      const from = yield* Config.String("CODENINE_CONTROL_MAIL_FROM");
      const transport = createTransport(Redacted.value(url.value));
      return Mailer.of({
        enabled: true,
        send: Effect.fn("Mailer.send")(function* (message: MailMessage) {
          yield* Effect.tryPromise({
            try: () => transport.sendMail({ from, ...message }),
            catch: (cause) => new MailDeliveryError({ cause }),
          });
        }),
      });
    }),
  );
}
