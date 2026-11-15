import type {
  ControlAiAccount,
  ControlAiAccountKind,
  ControlAiAccountSettings,
} from "@codenine/contracts/control";
import React, { useState } from "react";

import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { type ControlCall, SectionTitle } from "./adminParts";

const KIND_LABELS: Record<ControlAiAccountKind, string> = {
  anthropic: "Claude API",
  "anthropic-compatible": "Gateway with Anthropic's API",
};

interface Draft {
  readonly kind: ControlAiAccountKind;
  readonly name: string;
  readonly baseUrl: string;
  /** Empty keeps the saved one. */
  readonly apiKey: string;
  readonly priceAdjustment: string;
  readonly isDefault: boolean;
}

const EMPTY: Draft = {
  kind: "anthropic",
  name: "",
  baseUrl: "",
  apiKey: "",
  priceAdjustment: "0",
  isDefault: true,
};

const draftOf = (account: ControlAiAccount): Draft => ({
  kind: account.kind,
  name: account.name,
  baseUrl: account.baseUrl ?? "",
  apiKey: "",
  priceAdjustment: String(account.priceAdjustment),
  isDefault: account.isDefault,
});

/** The settings a draft makes, or what is wrong with it. */
const settingsOf = (draft: Draft): ControlAiAccountSettings | string => {
  const adjustment = Number(draft.priceAdjustment.trim() || "0");
  if (!Number.isInteger(adjustment) || adjustment < -100 || adjustment > 100) {
    return "Give the price adjustment as a whole percentage between -100 and 100.";
  }
  return {
    name: draft.name.trim(),
    kind: draft.kind,
    baseUrl: draft.baseUrl.trim() || null,
    priceAdjustment: adjustment,
    isDefault: draft.isDefault,
    ...(draft.apiKey.trim() === "" ? {} : { apiKey: draft.apiKey.trim() }),
  };
};

/** Owners' and admins' company AI accounts, which workspaces call AI through. */
export function AiAccountsSection({
  accounts,
  onAction,
}: {
  readonly accounts: ReadonlyArray<ControlAiAccount>;
  readonly onAction: (change: ControlCall) => Promise<boolean>;
}) {
  /** Null while no form is open; an ID while one account is edited. */
  const [editing, setEditing] = useState<{ readonly id: string | null; draft: Draft } | null>(null);
  const [problem, setProblem] = useState("");

  const save = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (editing === null) return;
    const settings = settingsOf(editing.draft);
    if (typeof settings === "string") {
      setProblem(settings);
      return;
    }
    setProblem("");
    const id = editing.id;
    const saved = await onAction((client) =>
      id === null
        ? client.admin.createAiAccount({ payload: settings })
        : client.admin.updateAiAccount({ params: { accountId: id }, payload: settings }),
    );
    if (saved) setEditing(null);
  };

  const change = (next: Partial<Draft>) =>
    setEditing((current) =>
      current === null ? current : { ...current, draft: { ...current.draft, ...next } },
    );

  return (
    <section>
      <SectionTitle>AI accounts</SectionTitle>
      <p className="mt-2 text-sm text-muted-foreground">
        Workspaces call AI through Codenine&apos;s gateway with these accounts, so keys never reach
        a workspace. Each call is recorded with who made it, the model, its tokens and cost, never
        what was said.
      </p>

      <ul className="mt-3 divide-y divide-border/70">
        {accounts.map((account) => (
          <li className="space-y-2 py-3" key={account.id}>
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium">{account.name}</p>
              <Badge variant="secondary">{KIND_LABELS[account.kind]}</Badge>
              {account.isDefault ? <Badge variant="info">Default for Claude</Badge> : null}
            </div>
            <p className="text-xs text-muted-foreground">
              {account.baseUrl ?? "api.anthropic.com"} · key ending {account.keyHint}
              {account.priceAdjustment === 0
                ? ""
                : ` · prices ${account.priceAdjustment > 0 ? "+" : ""}${account.priceAdjustment}%`}
            </p>
            <div className="flex gap-2">
              <Button
                onClick={() => setEditing({ id: account.id, draft: draftOf(account) })}
                size="xs"
                variant="outline"
              >
                Edit
              </Button>
              <Button
                onClick={() =>
                  void onAction((client) =>
                    client.admin.deleteAiAccount({ params: { accountId: account.id } }),
                  )
                }
                size="xs"
                variant="ghost"
              >
                Remove
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {accounts.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          No AI account is set up yet, so agents in workspaces cannot call Claude.
        </p>
      ) : null}

      {editing === null ? (
        <Button
          className="mt-3"
          onClick={() =>
            setEditing({ id: null, draft: { ...EMPTY, isDefault: accounts.length === 0 } })
          }
          size="sm"
          variant="outline"
        >
          Add an AI account
        </Button>
      ) : (
        <form className="mt-4 space-y-2" onSubmit={(event) => void save(event)}>
          <p className="text-sm font-medium">
            {editing.id === null ? "Add an AI account" : `Change ${editing.draft.name}`}
          </p>
          <Select
            onValueChange={(value) =>
              change({ kind: value === "anthropic-compatible" ? value : "anthropic" })
            }
            value={editing.draft.kind}
          >
            <SelectTrigger aria-label="Provider" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="anthropic">{KIND_LABELS.anthropic}</SelectItem>
              <SelectItem value="anthropic-compatible">
                {KIND_LABELS["anthropic-compatible"]}, such as LiteLLM
              </SelectItem>
            </SelectPopup>
          </Select>
          <Input
            aria-label="Name"
            onChange={(event) => change({ name: event.currentTarget.value })}
            placeholder="Name, such as Engineering's Claude account"
            size="sm"
            value={editing.draft.name}
          />
          <Input
            aria-label="Address"
            onChange={(event) => change({ baseUrl: event.currentTarget.value })}
            placeholder={
              editing.draft.kind === "anthropic"
                ? "Address (leave empty for api.anthropic.com)"
                : "Address, such as https://litellm.acme.internal"
            }
            size="sm"
            value={editing.draft.baseUrl}
          />
          <Input
            aria-label="API key"
            autoComplete="off"
            onChange={(event) => change({ apiKey: event.currentTarget.value })}
            placeholder={editing.id === null ? "API key" : "API key (leave empty to keep it)"}
            size="sm"
            type="password"
            value={editing.draft.apiKey}
          />
          <Input
            aria-label="Price adjustment"
            inputMode="numeric"
            onChange={(event) => change({ priceAdjustment: event.currentTarget.value })}
            placeholder="Price adjustment in %, such as -15 for a negotiated discount"
            size="sm"
            value={editing.draft.priceAdjustment}
          />
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={editing.draft.isDefault}
              onCheckedChange={(checked) => change({ isDefault: checked === true })}
            />
            Use it for Claude
          </label>
          {problem ? (
            <Alert variant="error">
              <AlertDescription>{problem}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex gap-2">
            <Button size="sm" type="submit">
              Save
            </Button>
            <Button onClick={() => setEditing(null)} size="sm" variant="ghost">
              Cancel
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
