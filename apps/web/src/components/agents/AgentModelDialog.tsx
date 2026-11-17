import type { EnvironmentId, ProviderInstanceId } from "@codenine/contracts";
import { CheckIcon, SearchIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { agentModelGroups, modelInfoLine } from "./agents.logic";
import { agentModelAccounts, useAgentModelCatalog } from "./useAgents";

export interface AgentModelChoiceValue {
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
}

/** Picks an agent's model from the accounts turned on, with what each model can do. */
export function AgentModelDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly agentTitle: string;
  /** The agent has connectors, so its model must use tools. */
  readonly needsTools: boolean;
  readonly value: AgentModelChoiceValue | null;
  readonly onPick: (choice: AgentModelChoiceValue) => void;
  readonly onClose: () => void;
}) {
  const catalog = useAgentModelCatalog(props.environmentId);
  const [query, setQuery] = useState("");
  const [choice, setChoice] = useState(props.value);
  const accounts = agentModelAccounts(catalog);
  const groups = agentModelGroups(accounts, { query, needsTools: props.needsTools });
  // A search can hide the chosen model; it stays chosen.
  const chosen = agentModelGroups(accounts, { query: "", needsTools: props.needsTools })
    .flatMap((group) => group.models)
    .find((model) => model.instanceId === choice?.instanceId && model.slug === choice.model);
  const usable = chosen !== undefined && chosen.disabledReason === null ? chosen : null;
  const subject = props.agentTitle === "" ? "this agent" : props.agentTitle;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Choose a model for {subject}</DialogTitle>
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon aria-hidden />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              aria-label="Search models"
              placeholder="Search models"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </InputGroup>
          {props.needsTools ? (
            <DialogDescription>
              {`${props.agentTitle === "" ? "This agent" : props.agentTitle} uses a connector, so it needs a model that can use tools.`}
            </DialogDescription>
          ) : null}
        </DialogHeader>
        <DialogPanel>
          {groups.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {query.trim() === ""
                ? "No account is turned on. Add one or turn one on in Settings, Accounts."
                : "No model matches."}
            </p>
          ) : (
            groups.map((group) => (
              <section
                key={group.instanceId}
                aria-label={group.name}
                className="flex flex-col gap-0.5"
              >
                <h3 className="px-3 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  {group.name}
                </h3>
                {group.models.map((model) => {
                  const selected =
                    model.instanceId === choice?.instanceId && model.slug === choice.model;
                  const detail = model.disabledReason ?? modelInfoLine(model.info);
                  return (
                    <button
                      key={model.slug}
                      type="button"
                      aria-pressed={selected}
                      disabled={model.disabledReason !== null}
                      onClick={() => setChoice({ instanceId: model.instanceId, model: model.slug })}
                      onDoubleClick={() => {
                        if (model.disabledReason !== null) return;
                        props.onPick({ instanceId: model.instanceId, model: model.slug });
                      }}
                      className={cn(
                        "flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-64 disabled:hover:bg-transparent",
                        selected && "bg-accent",
                      )}
                    >
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="text-sm font-medium text-foreground">{model.name}</span>
                        {detail === "" ? null : (
                          <span className="text-xs text-muted-foreground">{detail}</span>
                        )}
                      </span>
                      {selected ? <CheckIcon aria-hidden className="size-4 shrink-0" /> : null}
                    </button>
                  );
                })}
              </section>
            ))
          )}
        </DialogPanel>
        <DialogFooter className="sm:items-center sm:justify-between">
          <span className="text-xs text-muted-foreground">
            Plans count against your subscription. Pay-per-use prices come from the account.
          </span>
          <span className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button variant="outline" size="sm" onClick={props.onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={usable === null}
              onClick={() => {
                if (usable === null) return;
                props.onPick({ instanceId: usable.instanceId, model: usable.slug });
              }}
            >
              {usable === null ? "Use this model" : `Use ${usable.name}`}
            </Button>
          </span>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
