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
chat's agent; subagents and team task threads start without one.

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
  [`Agents.chatConnectors`](../../apps/server/src/agents/Agents.ts). For an action, the
  connection's own choice for that action (what "Always allow" sets) wins, then the agent's choice
  for its group, then the connection's.
- **Skills**: the agent's skills are the chat's kept-on skills; `$name` still attaches any skill.
- **Abilities** narrow the chat's runtime mode and never widen it. Codenine's MCP tools and
  connector tools stay on, so an agent can still start other chats and subagents, which run with
  their own settings.

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

The next message applies it. Claude's query key includes the disallowed tools and the
instructions, so it reopens the query with resume. Codex applies the sandbox and instructions on
every turn, but its shell and web search switches only when it loads a thread, so the session
manager's load key includes the abilities and it unloads the thread before resuming it, as it does
for new connections. While the thread still runs background work, Codex keeps the loaded switches.

## What a model can do

`ServerProviderModel.info` is fixed for Claude's and Codex's own models. For an OpenRouter account
the Claude driver reads OpenRouter's public model list, without the user's key, once a day and only
when such an account exists; a failure leaves the values unknown and is retried on the next check.
