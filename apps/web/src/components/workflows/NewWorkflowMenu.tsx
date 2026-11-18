import type { EnvironmentId } from "@codenine/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { useStartWorkflowChat } from "../chat/useStartWorkflowChat";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { setWorkflowEdit, setWorkflowSelection, workflowEditKey } from "./workflowEditStore";

const BLANK_KEY = workflowEditKey({ kind: "new", from: { kind: "blank" } });

/** The three ways to make a workflow: draw it, describe it to a lead, or keep a finished team. */
export function NewWorkflowMenu(props: {
  readonly environmentId: EnvironmentId;
  readonly disabled: boolean;
}) {
  const { environmentId } = props;
  const navigate = useNavigate();
  const [explaining, setExplaining] = useState(false);
  const startWorkflowChat = useStartWorkflowChat();
  const drawIt = () => {
    // A workflow drawn from the menu starts blank, not from an earlier unsaved one.
    setWorkflowEdit(environmentId, BLANK_KEY, null);
    setWorkflowSelection(environmentId, BLANK_KEY, null);
    void navigate({ to: "/workflows/new", search: { machine: environmentId } });
  };
  return (
    <>
      <Menu>
        <MenuTrigger disabled={props.disabled} render={<Button size="sm" />}>
          New workflow
          <ChevronDownIcon aria-hidden />
        </MenuTrigger>
        <MenuPopup align="end" className="w-80">
          <MenuItem onClick={drawIt}>
            <MenuChoice
              title="Draw it yourself"
              detail="Start from a trigger and a lead, then add your agents as steps."
            />
          </MenuItem>
          <MenuItem onClick={() => void startWorkflowChat(environmentId)}>
            <MenuChoice
              title="Describe it in a chat"
              detail="The lead draws it from what you write. You review it and save."
            />
          </MenuItem>
          <MenuItem onClick={() => setExplaining(true)}>
            <MenuChoice
              title="From a finished team"
              detail="Turn a team that did the job well into one that runs again."
            />
          </MenuItem>
        </MenuPopup>
      </Menu>
      <Dialog open={explaining} onOpenChange={setExplaining}>
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>From a finished team</DialogTitle>
            <DialogDescription>
              Open a task whose team did the job well. In its Task tab, choose Save as workflow: the
              lead turns the team into steps for the same agents, and your request into the goal it
              checks each run against.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setExplaining(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setExplaining(false);
                void navigate({ to: "/tasks" });
              }}
            >
              Open Tasks
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}

function MenuChoice(props: { readonly title: string; readonly detail: string }) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5 py-1">
      <span className="font-medium text-foreground">{props.title}</span>
      <span className="text-muted-foreground text-xs">{props.detail}</span>
    </span>
  );
}
