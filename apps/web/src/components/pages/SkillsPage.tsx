import { SparklesIcon } from "lucide-react";

import { useEnvironmentProviders, useEnvironments } from "../../state/environments";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Badge } from "../ui/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { listProvidersOnMachines, skillsByProvider } from "./buildPages.logic";
import { WorkspacePage } from "./WorkspacePage";

/** The skills each agent provider has installed, which agents load when a task needs one. */
export function SkillsPage() {
  const { environments } = useEnvironments();
  const providersByEnvironment = useEnvironmentProviders();
  const groups = skillsByProvider(
    listProvidersOnMachines({ machines: environments, providersByEnvironment }),
  );
  const total = groups.reduce((count, group) => count + group.skills.length, 0);
  return (
    <WorkspacePage
      area="skills"
      title="Skills"
      subtitle={total === 0 ? null : `${total} installed`}
    >
      {groups.length === 0 ? (
        <Empty className="h-full">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SparklesIcon />
            </EmptyMedia>
            <EmptyTitle>No skills yet</EmptyTitle>
            <EmptyDescription>
              A skill is a set of instructions an agent loads when a task needs it, such as how to
              write a report or edit a video. Skills installed in Claude Code or Codex show here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-5 px-4 py-4">
          {groups.map((group) => (
            <section key={group.key} aria-label={group.name} className="flex flex-col gap-px">
              <h2 className="flex items-center gap-2 px-2 pb-1 text-xs font-medium text-muted-foreground">
                <ProviderInstanceIcon
                  driverKind={group.provider.driver}
                  displayName={group.name}
                  accentColor={group.provider.accentColor}
                  className="size-3.5"
                />
                {group.machineLabel ? `${group.name} on ${group.machineLabel}` : group.name} ·{" "}
                {group.skills.length}
              </h2>
              <ul className="flex flex-col gap-px">
                {group.skills.map((skill) => (
                  <li
                    key={skill.key}
                    className="flex min-h-9 flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-md px-2 py-1.5 text-sm"
                  >
                    <span className="shrink-0 font-medium text-foreground">{skill.name}</span>
                    {skill.description ? (
                      <span className="min-w-40 flex-1 truncate text-xs text-muted-foreground">
                        {skill.description}
                      </span>
                    ) : null}
                    {skill.enabled ? null : <Badge variant="secondary">Off</Badge>}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </WorkspacePage>
  );
}
