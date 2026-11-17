import { useNavigate } from "@tanstack/react-router";
import { BotIcon, PaperclipIcon, PlugIcon, PlusIcon, SparklesIcon } from "lucide-react";
import { useRef, useState } from "react";

import { agentTitle, useAgents } from "../agents/useAgents";
import { CONNECTION_STATUS } from "../connectors/connectors.logic";
import { Button } from "../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { AddSkillDialog } from "./AddSkillDialog";
import { type ChatChoicesTarget, useChatChoices } from "./useChatChoices";
import { useCodenineSkills } from "./useComposerSkills";

/**
 * The composer's + menu: files, a skill to keep on, and the chat's connectors. In a chat with an
 * agent, the agent decides its connectors and skills.
 */
export function ComposerAddMenu(props: {
  readonly target: ChatChoicesTarget;
  /** Absent where this message cannot carry files. */
  readonly attach: {
    readonly add: (files: File[]) => Promise<boolean>;
    readonly focusComposer: () => void;
  } | null;
}) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pickingSkill, setPickingSkill] = useState(false);
  const choices = useChatChoices(props.target);
  const skills = useCodenineSkills(props.target.environmentId, props.target.projectId);
  const { agents } = useAgents(props.target.environmentId);
  const activeIds = new Set(choices.active.map((connection) => connection.id));
  const attach = props.attach;
  const agentName = choices.agent;
  const agentLabel =
    agentName === null
      ? null
      : agentTitle(
          agentName,
          agents.find((agent) => agent.name === agentName),
        );
  return (
    <>
      {attach === null ? null : (
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            // Inserting a chip refocuses the editor after the draft renders.
            void attach.add(files).then((inserted) => {
              if (!inserted) attach.focusComposer();
            });
          }}
        />
      )}
      <Menu>
        <MenuTrigger
          render={
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Add to this chat" />
          }
        >
          <PlusIcon />
        </MenuTrigger>
        <MenuPopup align="start" side="top" className="w-72">
          {attach === null ? null : (
            <MenuItem onClick={() => inputRef.current?.click()}>
              <PaperclipIcon />
              Add files or photos
            </MenuItem>
          )}
          {agentName === null ? (
            <MenuItem disabled={!choices.canChange} onClick={() => setPickingSkill(true)}>
              <SparklesIcon />
              Add a skill…
            </MenuItem>
          ) : null}
          <MenuSeparator />
          {agentName === null ? (
            <MenuGroup>
              <MenuGroupLabel>Connectors</MenuGroupLabel>
              {choices.connectionsError !== null && choices.connections.length === 0 ? (
                <p className="px-2 py-1 text-xs text-muted-foreground">
                  {choices.connectionsError}
                </p>
              ) : choices.connections.length === 0 ? (
                <p className="px-2 py-1 text-xs text-muted-foreground">None connected yet.</p>
              ) : (
                choices.connections.map((connection) => (
                  <MenuCheckboxItem
                    key={connection.id}
                    variant="switch"
                    checked={activeIds.has(connection.id)}
                    disabled={!choices.canChange}
                    onCheckedChange={(on) => void choices.toggleConnection(connection.id, on)}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate">{connection.name}</span>
                      {connection.status === "connected" ? null : (
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {CONNECTION_STATUS[connection.status].label}
                        </span>
                      )}
                    </span>
                  </MenuCheckboxItem>
                ))
              )}
            </MenuGroup>
          ) : (
            <MenuGroup>
              <MenuGroupLabel>Connectors and skills</MenuGroupLabel>
              <p className="px-2 py-1 text-xs text-muted-foreground">
                {`Set by the ${agentLabel} agent`}
              </p>
              <MenuItem
                onClick={() =>
                  void navigate({
                    to: "/agents/$name/edit",
                    params: { name: agentName },
                    search: { machine: props.target.environmentId },
                  })
                }
              >
                <BotIcon />
                Edit agent
              </MenuItem>
            </MenuGroup>
          )}
          <MenuItem
            onClick={() =>
              void navigate({
                to: "/connectors",
                search: { machine: props.target.environmentId },
              })
            }
          >
            <PlugIcon />
            Manage connectors
          </MenuItem>
        </MenuPopup>
      </Menu>
      <AddSkillDialog
        open={pickingSkill}
        skills={skills}
        keptOn={choices.skills}
        emptyMessage={
          skills.length === 0
            ? "No Codenine skills yet. Add some on the Skills page."
            : "Every skill is already on in this chat."
        }
        onOpenChange={setPickingSkill}
        onPick={(name) => void choices.addSkill(name)}
      />
    </>
  );
}
