import type { ScopedThreadRef } from "@codenine/contracts";
import {
  ExternalLinkIcon,
  GlobeIcon,
  LibraryIcon,
  PaperclipIcon,
  PlugIcon,
  SearchIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { useTheme } from "~/hooks/useTheme";
import { useRightPanelStore } from "~/rightPanelStore";
import { useQuietThreadVisibleTurnItems } from "~/state/entities";
import type { ChatFileAttachment } from "~/types";

import { PierreEntryIcon } from "../chat/PierreEntryIcon";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { ScrollArea } from "../ui/scroll-area";
import { chatSourcesCount, deriveChatSources, type SourceTurnItem } from "./chatSources.logic";

const ROW_CLASS =
  "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

function Section(props: {
  readonly title: string;
  readonly count: number;
  readonly children: ReactNode;
}) {
  if (props.count === 0) return null;
  return (
    <section aria-label={props.title} className="flex flex-col gap-0.5">
      <h3 className="px-2 pt-2 pb-1 text-2xs font-medium text-muted-foreground">
        {props.title} <span className="tabular-nums">{props.count}</span>
      </h3>
      <ul>{props.children}</ul>
    </section>
  );
}

/** What this chat read or cited, each with a way to open it. */
export default function SourcesPanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly workspaceRoot: string | undefined;
  readonly onOpenFile: (relativePath: string) => void;
}) {
  const { threadRef, workspaceRoot } = props;
  const { resolvedTheme } = useTheme();
  const items = useQuietThreadVisibleTurnItems(threadRef);
  const sources = deriveChatSources(
    items.map((row) => row.item as unknown as SourceTurnItem),
    workspaceRoot,
  );

  if (chatSourcesCount(sources) === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <LibraryIcon />
          </EmptyMedia>
          <EmptyTitle>No sources yet</EmptyTitle>
          <EmptyDescription>
            Files the agent reads, files you attach, web pages it opens and connectors it uses in
            this chat are listed here, so you can check where an answer came from.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <section aria-label="Sources" className="flex min-h-0 flex-1 flex-col text-sm">
      <ScrollArea scrollFade className="min-h-0 flex-1">
        <div className="flex flex-col gap-1 p-2">
          <Section title="Files read" count={sources.files.length}>
            {sources.files.map((file) => (
              <li key={file.path}>
                {file.inWorkspace ? (
                  <button
                    type="button"
                    className={ROW_CLASS}
                    onClick={() => props.onOpenFile(file.path)}
                  >
                    <PierreEntryIcon
                      pathValue={file.path}
                      kind="file"
                      theme={resolvedTheme}
                      className="size-3.5"
                    />
                    <span className="truncate">{file.path}</span>
                  </button>
                ) : (
                  <div className={ROW_CLASS}>
                    <PierreEntryIcon
                      pathValue={file.path}
                      kind="file"
                      theme={resolvedTheme}
                      className="size-3.5"
                    />
                    <span className="flex min-w-0 flex-1 flex-col text-muted-foreground">
                      <span className="truncate">{file.path}</span>
                      <span className="truncate text-2xs">Outside the workspace</span>
                    </span>
                  </div>
                )}
              </li>
            ))}
          </Section>
          <Section title="Attached" count={sources.attachments.length}>
            {sources.attachments.map((attachment) => (
              <li key={attachment.id}>
                <button
                  type="button"
                  className={ROW_CLASS}
                  onClick={() =>
                    useRightPanelStore
                      .getState()
                      .openAttachment(threadRef, attachment as unknown as ChatFileAttachment)
                  }
                >
                  <PaperclipIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{attachment.name}</span>
                </button>
              </li>
            ))}
          </Section>
          <Section title="Web" count={sources.pages.length + sources.searches.length}>
            {sources.pages.map((page) => (
              <li key={page.url}>
                <a className={ROW_CLASS} href={page.url} target="_blank" rel="noreferrer">
                  <GlobeIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{page.title ?? page.url}</span>
                    {page.title !== null ? (
                      <span className="truncate text-2xs text-muted-foreground">{page.url}</span>
                    ) : null}
                  </span>
                  <ExternalLinkIcon className="size-3 shrink-0 text-muted-foreground" />
                </a>
              </li>
            ))}
            {sources.searches.map((query) => (
              <li key={query}>
                <div className={ROW_CLASS}>
                  <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate text-muted-foreground">Searched for "{query}"</span>
                </div>
              </li>
            ))}
          </Section>
          <Section title="Connectors" count={sources.connectors.length}>
            {sources.connectors.map((connector) => (
              <li key={connector.name}>
                <div className={ROW_CLASS}>
                  <PlugIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{connector.name}</span>
                    <span className="truncate text-2xs text-muted-foreground">
                      {connector.tools.join(", ")}
                    </span>
                  </span>
                </div>
              </li>
            ))}
          </Section>
        </div>
      </ScrollArea>
    </section>
  );
}
