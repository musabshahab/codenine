import { useAtomValue } from "@effect/atom-react";
import { codenineDocsUrl, type EnvironmentId, type ProviderDriverKind } from "@codenine/contracts";
import { isOpenRouterProvider } from "@codenine/shared/openRouter";
import { InfoIcon } from "lucide-react";

import { serverEnvironment } from "../../state/server";
import { Alert, AlertDescription } from "../ui/alert";

const MULTIPLE_ACCOUNTS_FAQ_URL = codenineDocsUrl(
  "user/faq.md#can-i-use-more-than-one-account-for-a-provider",
);

const PROVIDER_NAMES = new Map<string, string>([
  ["codex", "Codex"],
  ["claudeAgent", "Claude"],
]);

/** Shown while adding a Claude or Codex account when the environment already has one signed in. */
export function MultipleAccountsNote({
  environmentId,
  driver,
}: {
  readonly environmentId: EnvironmentId;
  readonly driver: ProviderDriverKind;
}) {
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const providerName = PROVIDER_NAMES.get(driver);
  const hasSignedInAccount =
    providerName !== undefined &&
    providers?.some(
      (provider) =>
        provider.driver === driver &&
        // An OpenRouter key is not a Claude account.
        !isOpenRouterProvider(provider) &&
        provider.auth.status === "authenticated",
    );
  if (!hasSignedInAccount) return null;
  return (
    <Alert variant="info" role="note">
      <InfoIcon aria-hidden />
      <AlertDescription>
        <p>
          One {providerName} account per purpose, such as work and personal, works well. Codenine
          never switches accounts on its own.{" "}
          <a
            href={MULTIPLE_ACCOUNTS_FAQ_URL}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-foreground"
          >
            More info
          </a>
        </p>
      </AlertDescription>
    </Alert>
  );
}
