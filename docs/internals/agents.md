# Agents

An agent is a specialist the user sets up once: its instructions, model, skills, connectors and
what it may do on the computer. A chat that talks to one (the thread's `agent`) takes its
instructions, skills and connectors from it; its model is only where the chat starts, so a turn
never reads it. The code lives in [`apps/server/src/agents/`](../../apps/server/src/agents/).

## One file per agent, read on the safe side

Each agent is `agents/<name>/AGENT.md` in the Codenine folder, so backups carry it and every
workspace sees it. The folder name is the agent's id and chats refer to it, so a rename leaves
those chats pointing at nothing; editing the title never needs one.

Parsing gives an agent less, never more: an ability that is missing or not `true` is off, and an
unreadable connector, skill or model is dropped. A file with no frontmatter map is left out of the
list, and a chat that names an agent the server cannot read refuses its next turn with a message
instead of running as a plain chat with the chat's own, possibly wider, reach. Forks keep the
chat's agent, subagents start without one, and a team task's thread starts with its member's agent.

## How a chat's agent reaches the provider

[`RuntimePolicy`](../../apps/server/src/orchestration-v2/RuntimePolicy.ts) puts the agent's
instructions and abilities on every runtime policy it resolves, so each turn and each session load
carries the same agent. An agent it cannot read gets no abilities.

- **Instructions** go in the session, not each message: Claude's system prompt append, and Codex
  `additionalContext` entries `codenine_agent_NNN` of at most 4,000 bytes each. Codex keeps what
  it sent in the conversation and resends an entry only when it changes, so an entry that goes away
  is overwritten, emptied or with a note that the chat has no agent now, rather than left out.
- **Connectors**: an agent chat reaches the agent's connections, not its own list and not the ones
  on by default, and still only connected ones. Both the session manager and the gateway ask
  [`Agents.chatConnectors`](../../apps/server/src/agents/Agents.ts). Where the agent chose for a
  group, that choice decides whether an action asks, over the connection's choice for the single
  action too, so an agent set to ask always asks, or in Auto goes to the
  [reviewer](./connectors.md#autos-reviewer-answers-first) first. Its card's "Always allow"
  therefore sets the agent's own choice for that group to allow on that connector, since a choice on
  the connection would not count in its chats. A group the agent leaves alone follows the
  connection.
- **Skills**: the agent's skills are the chat's kept-on skills; `$name` still attaches any skill.
- **Abilities** narrow the chat's runtime mode and never widen it. A chat the agent started or
  steered would run with its own settings, so in an agent's chat Codenine's MCP tools refuse except
  the ones that act on that chat alone, such as reading skills
  ([`McpHttpServer`](../../apps/server/src/mcp/McpHttpServer.ts)). The check reads the calling chat
  on every call, because a provider keeps its MCP session when the chat's agent changes.

Agents never call other agents. An agent tricked by what it reads, such as an email or a page,
could otherwise have an agent with wider abilities act for it. Agents work together only in a team,
which a chat without an agent proposes and the user approves, or in a workflow. So no tool, such as
`delegate_task`, may start an agent from an agent's chat.

| Ability        | Claude Code                                             | Codex                                                |
| -------------- | ------------------------------------------------------- | ---------------------------------------------------- |
| Read files     | `Read`, `Glob`, `Grep`, `LSP` off                       | Not on its own: Codex reads files through its shell  |
| Edit files     | `Edit`, `Write`, `NotebookEdit`, the worktree tools off | Read-only sandbox; only the user can approve a write |
| Run commands   | `Bash`, `PowerShell`, `Monitor` off                     | `features.shell_tool = false`                        |
| Search the web | `WebSearch`, `WebFetch` off                             | `web_search = "disabled"`                            |

With commands on, an agent can read files through them whatever the other switches say, and reach
the network where the chat's mode lets it; on Claude it can also change files with edits off.
Codex's read-only sandbox keeps the network the chat's mode gave it; in Full access a write is
refused, in the other modes it waits for the user, never for Auto's reviewer. A provider lists what
it can turn off in its snapshot's `agentAbilities`.

## When the agent changes mid-chat

The next message applies it; one the user sends into a running turn restarts that turn, as a
model change that cannot wait does. Claude's query key includes the disallowed tools and the
instructions, so it reopens the query with resume. Codex applies the sandbox and instructions on
every turn, but its shell and web search switches only when it loads a thread, so the session
manager's load key includes the abilities and it unloads the thread before resuming it, as it does
for new connections. While the thread still runs background work, Codex keeps the loaded switches.

Each user message records the agent it went to, and the "Handed to" line compares it with the
agent of the latest message the timeline shows, the way model switches do
([`modelSwitch.ts`](../../apps/server/src/orchestration-v2/modelSwitch.ts)). Choosing an agent after
`@` moves the chat at once, through the picker's path, because the send reads the model the
composer rendered with; its `agent:<name>` token only records the hand-off in the text.

## What a model can do

`ServerProviderModel.info` is fixed for Claude's and Codex's own models. For an OpenRouter account
the Claude driver reads OpenRouter's public model list, without the user's key, once a day and only
when such an account exists; a failure leaves the values unknown and is retried on the next check.
