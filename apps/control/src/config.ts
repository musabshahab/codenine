import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Where people reach this installation, from `CODENINE_CONTROL_PUBLIC_URL`.
 * Links point here, cookies are `Secure` when it is HTTPS, and requests that
 * change anything must come from this origin.
 */
export class ControlPublicUrl extends Context.Service<
  ControlPublicUrl,
  { readonly origin: string; readonly secure: boolean }
>()("@codenine/control/config/ControlPublicUrl") {
  static readonly make = (raw: string) => {
    const url = URL.parse(raw.trim());
    if (
      url === null ||
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.pathname !== "/"
    ) {
      return Effect.die(
        "CODENINE_CONTROL_PUBLIC_URL must be an origin such as https://codenine.example.com, with no path.",
      );
    }
    return Effect.succeed(
      ControlPublicUrl.of({ origin: url.origin, secure: url.protocol === "https:" }),
    );
  };

  static readonly layer = Layer.effect(
    ControlPublicUrl,
    Config.String("CODENINE_CONTROL_PUBLIC_URL").pipe(
      Config.withDefault("http://127.0.0.1:3780"),
      Effect.flatMap(ControlPublicUrl.make),
    ),
  );
}

/** The token rides in the fragment, which browsers never send to a server. */
export const enrolmentLink = (origin: string, token: string) => `${origin}/admin/enrol#${token}`;
