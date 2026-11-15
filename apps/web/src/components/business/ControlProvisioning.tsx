import type { ControlProvisioning } from "@codenine/contracts/control";
import { useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { SectionTitle } from "./adminParts";

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** SCIM provisioning for owners: the address and token an identity provider uses. */
export function ProvisioningSection({
  provisioning,
  onCreateToken,
  onRevokeToken,
}: {
  readonly provisioning: ControlProvisioning;
  /** Resolves to the new token, or null when it failed. */
  readonly onCreateToken: () => Promise<string | null>;
  readonly onRevokeToken: () => Promise<boolean>;
}) {
  const [newToken, setNewToken] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const url = useCopyToClipboard();
  const token = useCopyToClipboard();
  const current = provisioning.token;

  const create = async () => {
    setIsBusy(true);
    setNewToken(await onCreateToken());
    setIsBusy(false);
  };
  const revoke = async () => {
    setIsBusy(true);
    if (await onRevokeToken()) setNewToken(null);
    setIsBusy(false);
  };

  return (
    <section>
      <SectionTitle>Provisioning</SectionTitle>
      <p className="mt-2 text-sm text-muted-foreground">
        Microsoft Entra ID, Okta or another identity provider can add people, move them between
        departments and remove them over SCIM. The groups it pushes are departments.
      </p>
      <dl className="mt-3 grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Address</dt>
        <dd className="flex min-w-0 flex-wrap items-center gap-2">
          <code className="font-mono text-xs break-all">{provisioning.url}</code>
          <Button onClick={() => url.copyToClipboard(provisioning.url)} size="xs" variant="outline">
            {url.isCopied ? "Copied" : "Copy"}
          </Button>
        </dd>
        <dt className="text-muted-foreground">Token</dt>
        <dd>
          {current === null
            ? "None yet"
            : `Created ${when(current.createdAt)} by ${current.createdBy}, ${
                current.lastUsedAt === null
                  ? "not used yet"
                  : `last used ${when(current.lastUsedAt)}`
              }`}
        </dd>
      </dl>

      {newToken === null ? null : (
        <Alert className="mt-4" variant="info">
          <AlertDescription>
            <p>
              Paste this token into your identity provider now. It is not shown again, and it
              replaces any token there was.
            </p>
            <p className="mt-2 font-mono text-xs break-all">{newToken}</p>
            <div className="mt-2 flex gap-2">
              <Button onClick={() => token.copyToClipboard(newToken)} size="xs" variant="outline">
                {token.isCopied ? "Copied" : "Copy token"}
              </Button>
              <Button onClick={() => setNewToken(null)} size="xs" variant="ghost">
                Done
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <Button disabled={isBusy} onClick={() => void create()} size="sm" variant="outline">
          {current === null ? "Create token" : "Replace token"}
        </Button>
        {current === null ? null : (
          <Button disabled={isBusy} onClick={() => void revoke()} size="sm" variant="ghost">
            Revoke token
          </Button>
        )}
      </div>
    </section>
  );
}
