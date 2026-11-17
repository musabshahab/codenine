import { isAtomCommandInterrupted } from "@codenine/client-runtime/state/runtime";
import type {
  ConnectorApprovalAnswer,
  EnvironmentId,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2TurnItem,
} from "@codenine/contracts";
import { CheckIcon, MinusIcon, PlugIcon } from "lucide-react";
import { useId, useRef, useState } from "react";

import { commandErrorMessage } from "../../lib/commandError";
import { connectorsEnvironment } from "../../state/connectors";
import { useAtomCommand } from "../../state/use-atom-command";
import { approvalChoiceLabels, approvalOutcomeLabel } from "../connectors/connectors.logic";
import { Button } from "../ui/button";
import { WorkLogRow } from "./WorkLog";

export type ConnectorApprovalItem = Extract<
  OrchestrationV2TurnItem,
  { readonly type: "connector_approval" }
>;

/** A connector action that asks first, such as sending an email, with what it would do. */
export function ConnectorApprovalCard(props: {
  readonly environmentId: EnvironmentId;
  readonly item: ConnectorApprovalItem;
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
  readonly canAnswer: boolean;
}) {
  const { item } = props;
  const outcome = approvalOutcomeLabel(item);
  if (outcome !== null || props.visibility !== "local") {
    const Icon =
      item.approvalStatus === "allowed" ? CheckIcon : outcome === null ? PlugIcon : MinusIcon;
    return (
      <WorkLogRow
        data-v2-item-type={item.type}
        icon={<Icon className="size-3.5 text-icon-muted" aria-hidden />}
        label={
          <>
            {item.connectorName} · {item.action} ·{" "}
            {outcome ?? "Waiting for an answer in the original chat"}
          </>
        }
      />
    );
  }
  return <PendingConnectorApproval {...props} />;
}

function PendingConnectorApproval(props: {
  readonly environmentId: EnvironmentId;
  readonly item: ConnectorApprovalItem;
  readonly canAnswer: boolean;
}) {
  const { item } = props;
  const titleId = useId();
  const answer = useAtomCommand(connectorsEnvironment.answerApproval, { reportFailure: false });
  const [answering, setAnswering] = useState<ConnectorApprovalAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Two clicks can land before a render.
  const inFlight = useRef(false);
  const labels = approvalChoiceLabels(item.action);

  const send = async (choice: ConnectorApprovalAnswer) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setAnswering(choice);
    setError(null);
    const result = await answer({
      environmentId: props.environmentId,
      input: { threadId: item.threadId, turnItemId: item.id, answer: choice },
    });
    inFlight.current = false;
    setAnswering(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setError(commandErrorMessage(result, "Could not answer. Try again."));
    }
  };

  return (
    <section
      aria-labelledby={titleId}
      data-v2-item-type={item.type}
      className="flex min-w-0 flex-col rounded-xl border border-primary/30 bg-primary/4"
    >
      <div className="flex min-w-0 flex-col gap-2.5 p-4">
        <h3 id={titleId} className="text-sm font-semibold text-foreground">
          {item.connectorName} wants to {item.action}
        </h3>
        {item.details.length > 0 ? (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
            {item.details.map((detail) => (
              <div key={`${detail.label}:${detail.value}`} className="contents">
                <dt className="text-muted-foreground">{detail.label}</dt>
                <dd className="wrap-anywhere text-foreground">{detail.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {item.preview?.trim() ? (
          <p className="max-h-60 overflow-y-auto rounded-lg bg-background px-3 py-2.5 text-sm whitespace-pre-wrap wrap-anywhere text-muted-foreground">
            {item.preview}
          </p>
        ) : null}
        {error === null ? null : (
          <p role="alert" className="text-xs text-destructive-foreground">
            {error}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-primary/20 px-4 py-3">
        <Button
          size="sm"
          disabled={!props.canAnswer || answering !== null}
          onClick={() => void send("allow")}
        >
          {labels.allow}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!props.canAnswer || answering !== null}
          onClick={() => void send("always")}
        >
          {labels.always}
        </Button>
        <Button
          size="sm"
          variant="ghost-muted"
          disabled={!props.canAnswer || answering !== null}
          onClick={() => void send("decline")}
        >
          {labels.decline}
        </Button>
        {props.canAnswer ? null : (
          <span className="text-xs text-muted-foreground">
            This connection cannot answer for this chat.
          </span>
        )}
      </div>
    </section>
  );
}
