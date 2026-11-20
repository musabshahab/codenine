import type { AgentName } from "@codenine/contracts";
import { BotOffIcon, CheckIcon } from "lucide-react";
import { memo } from "react";

import { ConnectorMark } from "../connectors/ConnectorMark";
import { ComboboxItem } from "../ui/combobox";
import { modelPickerAgentKey } from "./modelPickerKeys";

export interface ModelPickerAgent {
  readonly name: AgentName;
  readonly title: string;
  /** "Use it for…" and its model, such as "Reads and drafts email · Sonnet 5.5". */
  readonly detail: string;
  /** Why it can't be picked, such as an account that is turned off; the row shows it. */
  readonly disabledReason: string | null;
}

/** The Agents tab of a chat's model picker: who the chat talks to, or No agent. */
export interface ModelPickerAgents {
  readonly items: ReadonlyArray<ModelPickerAgent>;
  readonly selected: AgentName | null;
  /** The selected agent's title, also while the list loads or after the agent is gone. */
  readonly selectedTitle: string | null;
  /** False when the chat could not move to the agent's model; a toast or dialog says why. */
  readonly onPick: (name: AgentName | null) => boolean;
}

export const ModelPickerAgentRow = memo(function ModelPickerAgentRow(props: {
  readonly index: number;
  /** Null for No agent. */
  readonly agent: ModelPickerAgent | null;
  readonly isSelected: boolean;
}) {
  const { agent } = props;
  return (
    <ComboboxItem
      hideIndicator
      selectedFill={false}
      index={props.index}
      value={modelPickerAgentKey(agent?.name ?? null)}
      disabled={agent?.disabledReason != null}
      className="w-full !min-w-0 max-w-full"
    >
      {agent === null ? (
        <BotOffIcon aria-hidden="true" />
      ) : (
        <ConnectorMark name={agent.title} size="sm" tone="agent" />
      )}
      <span className="flex min-w-0 flex-1 flex-col text-left">
        <span className="truncate text-sm leading-snug">
          {agent === null ? "No agent" : agent.title}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {agent === null ? "Just the model" : (agent.disabledReason ?? agent.detail)}
        </span>
      </span>
      {props.isSelected ? <CheckIcon className="size-3.5 shrink-0" aria-hidden="true" /> : null}
    </ComboboxItem>
  );
});
