import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted } from "@codenine/client-runtime/state/runtime";
import type { EnvironmentId, WorkflowInput } from "@codenine/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { commandErrorMessage } from "../../lib/commandError";
import { savedWorkflowsEnvironment } from "../../state/savedWorkflows";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { TextField } from "../TextField";
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
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Runs a saved workflow now and opens the run. A workflow with inputs asks for this run's values
 * first, starting from the workflow's own.
 */
export function RunWorkflowButton(props: {
  readonly environmentId: EnvironmentId;
  readonly workflow: { readonly name: string; readonly title: string };
  /** The workflow's inputs when known; they are read before running when not. */
  readonly inputs: ReadonlyArray<WorkflowInput> | null;
  /** Why it cannot run now; null when it can. */
  readonly disabledReason: string | null;
  readonly variant?: "secondary" | "outline" | undefined;
}) {
  const { environmentId, workflow } = props;
  const navigate = useNavigate();
  const permitted = useAtomValue(savedWorkflowsEnvironment.run.permissionAtom(environmentId));
  const read = useAtomQueryRunner(savedWorkflowsEnvironment.read, { reportFailure: false });
  const run = useAtomCommand(savedWorkflowsEnvironment.run, { reportFailure: false });
  const [asking, setAsking] = useState<ReadonlyArray<WorkflowInput> | null>(null);
  const [busy, setBusy] = useState(false);

  const failed = (result: Parameters<typeof commandErrorMessage>[0]) =>
    toastManager.add({
      type: "error",
      title: `Could not run ${workflow.title}`,
      description: commandErrorMessage(result, "Try again."),
    });

  const start = async (inputs?: ReadonlyArray<WorkflowInput>) => {
    setBusy(true);
    const result = await run({
      environmentId,
      input: { name: workflow.name, ...(inputs === undefined ? {} : { inputs: [...inputs] }) },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) failed(result);
      return;
    }
    setAsking(null);
    void navigate({
      to: "/workflows/$name/runs/$run",
      params: { name: workflow.name, run: String(result.value.run) },
      search: { machine: environmentId },
    });
  };

  const click = async () => {
    let inputs = props.inputs;
    if (inputs === null) {
      setBusy(true);
      const detail = await read({ environmentId, input: { name: workflow.name } });
      setBusy(false);
      if (detail._tag === "Failure") {
        if (!isAtomCommandInterrupted(detail)) failed(detail);
        return;
      }
      inputs = detail.value.inputs;
    }
    if (inputs.length > 0) setAsking(inputs);
    else await start();
  };

  const reason = permitted
    ? props.disabledReason
    : "This connection can see workflows but cannot start runs.";
  const button = (
    <Button
      size="sm"
      variant={props.variant ?? "secondary"}
      disabled={reason !== null || busy}
      onClick={() => void click()}
    >
      {busy && asking === null ? "Starting…" : "Run now"}
    </Button>
  );
  return (
    <>
      {reason === null ? (
        button
      ) : (
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" />}>{button}</TooltipTrigger>
          <TooltipPopup>{reason}</TooltipPopup>
        </Tooltip>
      )}
      {asking === null ? null : (
        <RunInputsDialog
          title={workflow.title}
          inputs={asking}
          busy={busy}
          onRun={(inputs) => void start(inputs)}
          onClose={() => setAsking(null)}
        />
      )}
    </>
  );
}

function RunInputsDialog(props: {
  readonly title: string;
  readonly inputs: ReadonlyArray<WorkflowInput>;
  readonly busy: boolean;
  readonly onRun: (inputs: ReadonlyArray<WorkflowInput>) => void;
  readonly onClose: () => void;
}) {
  const [values, setValues] = useState(props.inputs);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <form
          noValidate
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            props.onRun(values);
          }}
        >
          <DialogHeader>
            <DialogTitle>Run {props.title}</DialogTitle>
            <DialogDescription>
              What this run starts with. Changes here are for this run only.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {values.map((input, index) => (
              <TextField
                key={input.name}
                label={input.name}
                value={input.value}
                disabled={props.busy}
                onChange={(value) =>
                  setValues((current) =>
                    current.map((entry, at) => (at === index ? { ...entry, value } : entry)),
                  )
                }
              />
            ))}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" size="sm" disabled={props.busy} onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={props.busy}>
              {props.busy ? "Starting…" : "Run now"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
