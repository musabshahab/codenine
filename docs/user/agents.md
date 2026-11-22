# Agents

An agent is a specialist you set up once for a kind of task, such as your email or code review:
its instructions, the model it runs on, and the [skills](./skills.md) and
[connectors](./connectors.md) it may use. Agents work with any of your accounts, so you can move one
to another model at any time. Each agent is a standard agent file in your Codenine folder, so
backups include it.

## Make an agent

Open **Agents** under **Build** in the sidebar and choose **New agent**. Give it a name, say what
to use it for, and write its instructions. Chats and lead agents read **Use it for…** to decide
when the agent fits, so name the task. The agent's file is named after it, such as
`code-reviewer`.

**Model** and **Effort** choose what it runs on. **Change** lists the models of your accounts that
are turned on, with what each can do and, for pay-per-use accounts, what it costs. An agent with
connectors needs a model that can use tools. Effort is Low, Medium, High or Max; Codenine matches it
to each model's own levels, and a model without levels runs at its default.

**On this computer** decides what the agent may do besides its connectors: read files, edit files,
run commands, and search the web. A new agent starts with all of them off. Turn on only what the job
needs; an email agent needs none of them. An agent works within these limits on its own: it cannot
start, read or message other chats, and it never calls another agent. To have agents work together,
ask for a team from a chat without an agent.

**Save and start chat** saves the agent and opens a chat with it. **Duplicate**, in an agent's
menu on the Agents page, makes a copy to change.

When an agent's account is turned off, or the account no longer offers its model, its card says so.
Choose another model to use the agent again.

## Ask first or run on their own

A connector sorts its actions into **Read**, **Change** and **Can't be undone**, and each group
runs **Automatic** or **Ask every time**. An agent shows the connector's own choice for each group.
Change one, and that choice applies to this agent only; the connector and other chats keep theirs.
In the agent's chats it also wins over a choice made for a single action, so an agent set to ask
always asks. To stop it asking, choose **Always allow for this agent** on its card (**Always send
without asking** when it sends); that changes the agent's own choice in its settings. A group you
leave alone follows the connector, even after you change the connector later.

What an agent reads, such as an email or a web page, could carry instructions meant to trick it.
Choose **Automatic** for **Can't be undone** only when you trust what the agent reads.

## In a team

In a [team](./thread-sidebar.md#run-a-team), the lead gives a part of the job to one of your agents
when one fits, and otherwise makes a member just for that team, which is gone when the team is.
Before you approve, you can give any part to one of your agents instead, or keep a member the lead
made by saving it as an agent.

## Chat with an agent

**Start chat** on an agent's card opens a new chat with it, in the workspace you opened Agents from,
or in Personal. In any chat, open the model picker next to the message box and choose the agent
under **Agents**, or use **Chat with** in the command palette.

The model button then reads the agent's name and model, and the chat's header shows the agent. The
agent decides the chat's connectors and skills, so the **+** menu says they are set by the agent and
links to it. **No agent** goes back to the chat's own connectors and skills and keeps the model.

Picking another model in an agent's chat changes the model for that chat only. The agent keeps its
own model, and new chats with it start on that one.

You can also hand a chat to an agent while you write: type `@`, choose the agent at the top of the
list, and finish your message. The chat moves to the agent as soon as you choose it, the message
shows the agent's chip, and a line in the chat marks the hand-off. Choose **No agent** after `@` to
hand the chat back. When the agent runs on a different model, that model reads the conversation so
far with your next message, as it does after any model change.
