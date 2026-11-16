import { PlugIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";

import { useEnvironmentProviders, useEnvironments } from "../../state/environments";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import {
  type ConnectionState,
  listProvidersOnMachines,
  providerConnection,
} from "./buildPages.logic";
import { WorkspacePage } from "./WorkspacePage";

const STATE_BADGE = {
  connected: { label: "Connected", variant: "success" },
  "signed-out": { label: "Not signed in", variant: "warning" },
  attention: { label: "Needs attention", variant: "error" },
  off: { label: "Off", variant: "secondary" },
  missing: { label: "Not installed", variant: "secondary" },
} as const satisfies Record<
  ConnectionState,
  { label: string; variant: "success" | "warning" | "error" | "secondary" }
>;

/** What agents connect to: the AI providers that run them, and the apps they work with. */
export function ConnectorsPage() {
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const providersByEnvironment = useEnvironmentProviders();
  const providers = listProvidersOnMachines({ machines: environments, providersByEnvironment });
  return (
    <WorkspacePage area="connectors" title="Connectors">
      <div className="flex flex-col gap-5 px-4 py-4">
        <section aria-label="AI models" className="flex flex-col gap-px">
          <h2 className="px-2 pb-1 text-xs font-medium text-muted-foreground">AI models</h2>
          {providers.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <PlugIcon />
                </EmptyMedia>
                <EmptyTitle>No AI provider connected</EmptyTitle>
                <EmptyDescription>
                  Agents run on Claude Code or Codex. Set one up in Settings.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul className="flex flex-col gap-px">
              {providers.map((entry) => {
                const connection = providerConnection(entry.provider);
                const badge = STATE_BADGE[connection.state];
                return (
                  <li
                    key={entry.key}
                    className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-2 py-1.5 text-sm"
                  >
                    <ProviderInstanceIcon
                      driverKind={entry.provider.driver}
                      displayName={entry.name}
                      accentColor={entry.provider.accentColor}
                      className="size-4"
                    />
                    <span className="min-w-32 flex-1 truncate text-foreground">
                      {entry.machineLabel ? `${entry.name} on ${entry.machineLabel}` : entry.name}
                    </span>
                    {connection.account ? (
                      <span className="truncate text-xs text-muted-foreground">
                        {connection.account}
                      </span>
                    ) : null}
                    <Badge variant={badge.variant}>{badge.label}</Badge>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="px-2 pt-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void navigate({ to: "/settings/providers" })}
            >
              Manage AI providers
            </Button>
          </div>
        </section>
        <section aria-label="Apps" className="flex flex-col gap-px">
          <h2 className="px-2 pb-1 text-xs font-medium text-muted-foreground">Apps</h2>
          <ul className="flex flex-col gap-px">
            <li className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-2 py-1.5 text-sm">
              <PullRequestGlyph.pullRequest
                aria-hidden
                className="size-4 shrink-0 text-muted-foreground"
              />
              <span className="min-w-32 flex-1 truncate text-foreground">GitHub</span>
              <span className="truncate text-xs text-muted-foreground">
                Repositories and pull requests
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void navigate({ to: "/settings/source-control" })}
              >
                Set up
              </Button>
            </li>
          </ul>
        </section>
      </div>
    </WorkspacePage>
  );
}
