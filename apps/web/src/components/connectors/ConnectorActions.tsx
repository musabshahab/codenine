import { isAtomCommandInterrupted } from "@codenine/client-runtime/state/runtime";
import type {
  ConnectionSnapshot,
  ConnectorApprovalMode,
  ConnectorRisk,
  ConnectorTool,
  EnvironmentId,
} from "@codenine/contracts";
import { ChevronDownIcon } from "lucide-react";

import { commandErrorMessage } from "../../lib/commandError";
import { connectorsEnvironment } from "../../state/connectors";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuTrigger,
} from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { APPROVAL_MODE_LABELS, groupToolsByRisk } from "./connectors.logic";

const MODES = ["auto", "ask"] as const satisfies ReadonlyArray<ConnectorApprovalMode>;
const SAME_AS_GROUP = "group";
const TOOL_CHOICES = [SAME_AS_GROUP, ...MODES] as const;

/** "What it can do": a connector's actions by reach, and which of them ask first. */
export function ConnectorActions({
  environmentId,
  connection,
  canManage,
}: {
  readonly environmentId: EnvironmentId;
  readonly connection: Pick<ConnectionSnapshot, "id" | "name" | "status" | "approvals">;
  readonly canManage: boolean;
}) {
  const tools = useEnvironmentQuery(
    connection.status === "connected"
      ? connectorsEnvironment.tools({ environmentId, input: { connectionId: connection.id } })
      : null,
  );
  const update = useAtomCommand(connectorsEnvironment.update, { reportFailure: false });

  const save = async (change: {
    readonly approvals?: Partial<Record<ConnectorRisk, ConnectorApprovalMode>>;
    readonly toolApprovals?: Record<string, ConnectorApprovalMode | null>;
  }) => {
    const result = await update({
      environmentId,
      input: { connectionId: connection.id, ...change },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: "Could not change what it can do",
        description: commandErrorMessage(result, "Try again."),
      });
    }
  };

  const groups = groupToolsByRisk(tools.data?.tools ?? []);
  const fromCodenine = (tools.data?.tools ?? []).filter((tool) => tool.providedByCodenine);
  return (
    <section aria-labelledby="connector-actions" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id="connector-actions" className="text-base font-semibold text-foreground">
          What it can do
        </h2>
        <p className="text-sm text-muted-foreground">
          Choose which actions run on their own and which ask you first.
        </p>
      </div>
      {connection.status !== "connected" ? (
        <p className="text-sm text-muted-foreground">
          {connection.name} lists its actions once it is connected.
        </p>
      ) : tools.data === null ? (
        <p className="text-sm text-muted-foreground">
          {tools.error ?? `Asking ${connection.name} what it can do…`}
        </p>
      ) : groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">{connection.name} reports no actions.</p>
      ) : (
        <div className="divide-y divide-border rounded-xl border border-border bg-card">
          {groups.map((group) => (
            <div key={group.risk} className="flex flex-col gap-2.5 px-4 py-3.5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="flex min-w-48 flex-1 flex-col gap-0.5">
                  <span className="text-sm font-medium text-foreground">{group.title}</span>
                  <span className="text-xs text-muted-foreground">{group.hint}</span>
                </span>
                <Select
                  value={connection.approvals[group.risk]}
                  disabled={!canManage}
                  onValueChange={(mode) => {
                    if (mode === "auto" || mode === "ask") {
                      void save({ approvals: { [group.risk]: mode } });
                    }
                  }}
                >
                  <SelectTrigger
                    size="sm"
                    className="w-auto"
                    aria-label={`When an agent uses ${group.title.toLowerCase()} actions`}
                  >
                    <SelectValue>
                      {(mode: ConnectorApprovalMode) => APPROVAL_MODE_LABELS[mode]}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {MODES.map((mode) => (
                      <SelectItem hideIndicator key={mode} value={mode}>
                        {APPROVAL_MODE_LABELS[mode]}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {group.tools.map((tool) => (
                  <ToolChoice
                    key={tool.name}
                    tool={tool}
                    groupMode={connection.approvals[group.risk]}
                    disabled={!canManage}
                    onChange={(mode) => void save({ toolApprovals: { [tool.name]: mode } })}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Codenine sorts actions from what {connection.name} reports about each one; change a single
        action from its menu.
        {fromCodenine.length > 0
          ? ` ${fromCodenine.map((tool) => tool.title ?? tool.name).join(", ")} ${fromCodenine.length === 1 ? "comes" : "come"} from Codenine, with the same sign-in.`
          : null}
      </p>
    </section>
  );
}

function ToolChoice({
  tool,
  groupMode,
  disabled,
  onChange,
}: {
  readonly tool: ConnectorTool;
  readonly groupMode: ConnectorApprovalMode;
  readonly disabled: boolean;
  readonly onChange: (mode: ConnectorApprovalMode | null) => void;
}) {
  const label = tool.title?.trim() || tool.name;
  return (
    <Menu>
      <MenuTrigger
        disabled={disabled}
        render={
          <Button
            variant="outline"
            size="xs"
            aria-label={`${label}: ${tool.overridden ? APPROVAL_MODE_LABELS[tool.approval] : `same as the group, ${APPROVAL_MODE_LABELS[groupMode].toLowerCase()}`}`}
          />
        }
      >
        <span className="font-mono">{tool.name}</span>
        {tool.providedByCodenine ? <Badge variant="info">Codenine</Badge> : null}
        {tool.overridden ? (
          <Badge variant={tool.approval === "ask" ? "warning" : "secondary"}>
            {tool.approval === "ask" ? "Asks" : "Automatic"}
          </Badge>
        ) : null}
        <ChevronDownIcon aria-hidden />
      </MenuTrigger>
      <MenuPopup align="start" className="w-72">
        <MenuGroupLabel>{tool.description.trim() || label}</MenuGroupLabel>
        <MenuRadioGroup
          value={tool.overridden ? tool.approval : SAME_AS_GROUP}
          onValueChange={(value) => onChange(value === "auto" || value === "ask" ? value : null)}
        >
          {TOOL_CHOICES.map((value) => (
            <MenuRadioItem key={value} value={value} closeOnClick>
              <span className="flex items-center gap-3">
                <span className="min-w-0 flex-1">
                  {value === SAME_AS_GROUP
                    ? `Same as the group (${APPROVAL_MODE_LABELS[groupMode].toLowerCase()})`
                    : APPROVAL_MODE_LABELS[value]}
                </span>
                <MenuRadioItemIndicator />
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
