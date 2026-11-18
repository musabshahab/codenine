import type { AgentModel, EnvironmentId } from "@codenine/contracts";
import { useId, useState } from "react";

import { AgentModelDialog } from "../agents/AgentModelDialog";
import { AGENT_EFFORT_LABELS, AGENT_EFFORTS } from "../agents/agents.logic";
import { describeAgentModel, useAgentModelCatalog } from "../agents/useAgents";
import { Button, InlineButton } from "../ui/button";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

/**
 * A model with its effort for the lead or a step. A step without one runs on its agent's model,
 * which `fallback` names, and can go back to it.
 */
export function ModelField(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly value: AgentModel | null;
  /** What runs without a value, such as the step agent's own model. */
  readonly fallback: { readonly label: string; readonly model: AgentModel | null } | null;
  /** Who the model is for, in the picker's title. */
  readonly subject: string;
  readonly needsTools: boolean;
  readonly disabled: boolean;
  readonly onChange: (model: AgentModel | null) => void;
}) {
  const labelId = useId();
  const effortId = useId();
  const catalog = useAgentModelCatalog(props.environmentId);
  const [picking, setPicking] = useState(false);
  const { value, fallback } = props;
  const shown = value ?? fallback?.model ?? null;
  const described = shown === null ? null : describeAgentModel(catalog, shown);
  const detail =
    value === null
      ? (fallback?.label ?? `Choose the model ${props.subject} runs on.`)
      : (described?.account ?? "Its account is off or gone");
  return (
    <div className="flex flex-col gap-1.5">
      <span id={labelId} className="font-medium text-foreground text-sm">
        {props.label}
      </span>
      <div
        role="group"
        aria-labelledby={labelId}
        className="flex items-center gap-3 rounded-lg border border-border px-3 py-2"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-foreground text-sm">
            {described?.name ?? "No model yet"}
          </span>
          <span className="truncate text-muted-foreground text-xs">{detail}</span>
        </span>
        <Button
          size="xs"
          variant="outline"
          disabled={props.disabled}
          onClick={() => setPicking(true)}
        >
          {value === null ? "Choose" : "Change"}
        </Button>
      </div>
      {value === null ? null : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <ToggleGroup
            aria-labelledby={effortId}
            value={[value.effort]}
            disabled={props.disabled}
            onValueChange={(next) => {
              const effort = AGENT_EFFORTS.find((level) => level === next[0]);
              if (effort !== undefined) props.onChange({ ...value, effort });
            }}
          >
            {AGENT_EFFORTS.map((level) => (
              <Toggle key={level} value={level}>
                {AGENT_EFFORT_LABELS[level]}
              </Toggle>
            ))}
          </ToggleGroup>
          <span id={effortId} className="sr-only">
            Effort
          </span>
          {fallback === null ? null : (
            <InlineButton
              tone="muted"
              disabled={props.disabled}
              onClick={() => props.onChange(null)}
            >
              Use the agent's own model
            </InlineButton>
          )}
        </div>
      )}
      {picking ? (
        <AgentModelDialog
          environmentId={props.environmentId}
          agentTitle={props.subject}
          needsTools={props.needsTools}
          value={shown === null ? null : { instanceId: shown.instanceId, model: shown.model }}
          onPick={(choice) => {
            props.onChange({ ...choice, effort: value?.effort ?? shown?.effort ?? "medium" });
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </div>
  );
}
