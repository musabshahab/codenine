import {
  type ControlAiAccount,
  ControlAiAccountKind,
  type ControlAiAccountSettings,
  aiAccountServes,
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
  openai: "OpenAI API",
  "azure-openai": "Azure OpenAI",
  "openai-compatible": "Gateway with OpenAI's API",
};

const AGENT_NAMES = { claude: "Claude", codex: "Codex" } as const;

const ADDRESSES: Record<ControlAiAccountKind, string> = {
  anthropic: "Address (leave empty for api.anthropic.com)",
  "anthropic-compatible": "Address, such as https://litellm.acme.internal",
  openai: "Address (leave empty for api.openai.com)",
  "azure-openai": "Address, such as https://acme.openai.azure.com/openai",
  "openai-compatible": "Address, such as https://litellm.acme.internal",
};

const DEFAULT_ADDRESSES: Partial<Record<ControlAiAccountKind, string>> = {
  anthropic: "api.anthropic.com",
  openai: "api.openai.com",
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
              {account.isDefault ? (
                <Badge variant="info">
                  Default for {AGENT_NAMES[aiAccountServes(account.kind)]}
                </Badge>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">
              {account.baseUrl ?? DEFAULT_ADDRESSES[account.kind]} · key ending {account.keyHint}
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
          No AI account is set up yet, so agents in workspaces cannot call Claude or Codex.
        </p>
      ) : null}

      {editing === null ? (
        <Button
          className="mt-3"
          onClick={() =>
            setEditing({
              id: null,
              draft: {
                ...EMPTY,
                isDefault: !accounts.some(({ kind }) => aiAccountServes(kind) === "claude"),
              },
            })
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
            onValueChange={(value) => {
              const kind = ControlAiAccountKind.literals.find((candidate) => candidate === value);
              if (kind === undefined) return;
              change({
                kind,
                isDefault: !accounts.some(
                  (account) =>
                    account.id !== editing.id &&
                    aiAccountServes(account.kind) === aiAccountServes(kind),
                ),
              });
            }}
            value={editing.draft.kind}
          >
            <SelectTrigger aria-label="Provider" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {ControlAiAccountKind.literals.map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {KIND_LABELS[kind]}, for {AGENT_NAMES[aiAccountServes(kind)]}
                </SelectItem>
              ))}
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
            placeholder={ADDRESSES[editing.draft.kind]}
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
            Use it for {AGENT_NAMES[aiAccountServes(editing.draft.kind)]}
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
