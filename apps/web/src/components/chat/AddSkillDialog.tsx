import { useAtomValue } from "@effect/atom-react";
import { type SkillName, type SkillSummary, skillTitle } from "@codenine/contracts";
import { SparklesIcon } from "lucide-react";
import { useState } from "react";

import { primaryServerKeybindingsAtom } from "~/state/server";
import type { CommandPaletteActionItem, CommandPaletteGroup } from "../CommandPalette.logic";
import { CommandPaletteContent } from "../CommandPaletteContent";
import { CommandPaletteResults } from "../CommandPaletteResults";
import { CommandDialog, CommandDialogPopup } from "../ui/command";

function matches(skill: SkillSummary, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return (
    needle === "" ||
    skill.name.includes(needle) ||
    skillTitle(skill.name).toLowerCase().includes(needle) ||
    skill.description.toLowerCase().includes(needle)
  );
}

/** Picks a Codenine or workspace skill to keep on for the chat. */
export function AddSkillDialog(props: {
  readonly open: boolean;
  readonly skills: ReadonlyArray<SkillSummary>;
  /** Skills the chat keeps on already; they are left out. */
  readonly keptOn: ReadonlyArray<SkillName>;
  readonly emptyMessage: string;
  /** What choosing a skill does, in the footer. */
  readonly actionLabel?: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPick: (name: SkillName) => void;
}) {
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const kept = new Set(props.keptOn);
  const item = (skill: SkillSummary): CommandPaletteActionItem => ({
    kind: "action",
    value: `skill:${skill.scope}:${skill.name}`,
    searchTerms: [skill.name, skillTitle(skill.name), skill.description],
    title: skillTitle(skill.name),
    description: skill.description,
    icon: <SparklesIcon className="size-4 text-muted-foreground" />,
    run: async () => props.onPick(skill.name),
  });
  const available = props.skills.filter((skill) => !kept.has(skill.name) && matches(skill, query));
  const groups: CommandPaletteGroup[] = [
    {
      value: "workspace",
      label: "This workspace",
      items: available.filter((skill) => skill.scope === "workspace").map(item),
    },
    {
      value: "codenine",
      label: "Codenine",
      items: available.filter((skill) => skill.scope === "codenine").map(item),
    },
  ].filter((group) => group.items.length > 0);

  return (
    <CommandDialog open={props.open} onOpenChange={props.onOpenChange}>
      {props.open ? (
        <CommandDialogPopup
          aria-label="Add a skill"
          className="overflow-hidden"
          onBackdropPointerDown={() => props.onOpenChange(false)}
        >
          <CommandPaletteContent
            aria-label="Add a skill"
            autoHighlight="always"
            escapeLabel="Close"
            footerActionLabel={props.actionLabel ?? "Keep it on in this chat"}
            inputProps={{ placeholder: "Search skills…" }}
            mode="none"
            onItemHighlighted={(value) => setHighlighted(typeof value === "string" ? value : null)}
            onValueChange={(value) => {
              setHighlighted(null);
              setQuery(value);
            }}
            panelSize="list"
            value={query}
          >
            <CommandPaletteResults
              groups={groups}
              highlightedItemValue={highlighted}
              isActionsOnly={false}
              keybindings={keybindings}
              onExecuteItem={(picked) => {
                if (picked.kind !== "action") return;
                props.onOpenChange(false);
                void picked.run();
              }}
              emptyStateMessage={query.trim() === "" ? props.emptyMessage : "No skill matches."}
            />
          </CommandPaletteContent>
        </CommandDialogPopup>
      ) : null}
    </CommandDialog>
  );
}
