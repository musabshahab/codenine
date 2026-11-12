import { FolderIcon, MessageCircleIcon } from "lucide-react";

import type { SidebarMode } from "../../uiStateStore";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

/** Switches the sidebar between threads in projects and chats without a project. */
export function SidebarModeSwitch(props: {
  mode: SidebarMode;
  onModeChange: (mode: SidebarMode) => void;
}) {
  return (
    <ToggleGroup
      aria-label="Show in sidebar"
      variant="segmented"
      value={[props.mode]}
      onValueChange={(next) => {
        const value = next[0];
        if (value === "projects" || value === "chats") props.onModeChange(value);
      }}
      className="w-full"
    >
      <Toggle value="projects" className="flex-1">
        <FolderIcon aria-hidden />
        Projects
      </Toggle>
      <Toggle value="chats" className="flex-1">
        <MessageCircleIcon aria-hidden />
        Chats
      </Toggle>
    </ToggleGroup>
  );
}
