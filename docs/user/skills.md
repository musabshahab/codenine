# Skills

A skill is know-how an agent follows for a kind of task, such as how you write emails or the steps
before a release. Skills in Codenine work with every model. Each one is a standard skill folder, so
other tools that read skills can use it too.

## Your skills

Open **Skills** under **Build** in the sidebar. **Your skills** lists your Codenine skills and the
skills of the workspace chosen at the top of the page.

**New skill** asks for a name, **Use it when…**, the instructions, and where to keep it. Agents read
**Use it when…** to decide whether the skill fits, so name the task, not the content.

**Keep it** decides who gets the skill:

- **For all my workspaces** saves it in the `skills` folder of your Codenine folder.
- **Only in this workspace** saves it with the workspace's files, in `.agents/skills`, so people
  who share the workspace get it too. A workspace skill wins over a Codenine skill of the same name.

A skill's folder can also hold examples, templates or scripts; agents open them only when they need
them. **Open folder** on the skill's page opens it.

## Skills from Claude Code and Codex

**Found in Claude Code and Codex** lists skills those providers keep in their own folders. They
work only with the provider they came from. **Add to Codenine** copies one into your Codenine folder
so every model can use it; the original stays where it is. **Import** copies a skill from any folder
on the computer Codenine runs on.

## The library

**Library** lists skills that come with Codenine. **Add** copies one into your skills, where you can
change it. **Write a skill** turns how you like something done into a new skill: choose **Write it
with the Write a skill skill** on **New skill** to start a chat with it.

## Use a skill in a chat

Type `$` or `/` in the message box. Codenine skills come first, and a provider skill with the same
name is left out. To keep a skill on for the whole chat, choose **+** then **Add a skill…** next to
the message box. It shows above the message box until you remove it.
