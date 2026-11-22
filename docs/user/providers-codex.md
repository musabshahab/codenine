# Codex

Use your ChatGPT plan or an existing Codex CLI login to code in Codenine.

## Connect with ChatGPT

Connect during onboarding or in **Settings → Accounts**. For a remote machine,
select that environment first. Codenine handles Codex installation; sign in on
OpenAI and allow sharing of your ChatGPT plan.

Manage shared usage and credits in ChatGPT through **Manage usage** in Codenine.
If a request uses a feature that ChatGPT sharing does not support, use another
provider for that request.

Fast and Ultrafast speeds are unavailable with this connection. To use the speed
options your account supports, [sign in with the Codex CLI](#sign-in-with-the-codex-cli).

When reconnecting, choose the same account in Codenine and on OpenAI's sign-in
page. Disconnecting stops running chats but keeps their history and lets you
reconnect later.

If remote sign-in cannot return automatically, paste the full URL from the final
localhost page into the sign-in panel, even if that page could not load.

## Sign in with the Codex CLI

The Codex command line login gives you every speed your plan includes, such as Fast. In
**Settings → Accounts**, choose **Add account**, pick Codex, then **Sign in with Codex CLI**. Name
the account and finish `codex login` in the panel that opens. On a remote machine, the panel signs
in with a code you enter in your browser. [Provider setup](./install.md#providers) covers installing
Codex and custom configuration.

This login is separate from a ChatGPT connection. Signing in one way does not change the other.

## Use multiple accounts

Add each account in **Settings → Accounts** with **Add account**, then pick it in a chat's model
picker or set it as a workspace's default.

- **Continue with ChatGPT** connects another ChatGPT account. ChatGPT accounts share chat history,
  so a chat can move between them.
- **Sign in with Codex CLI** adds another command line login. Codenine keeps each login in its own
  folder in your Codenine folder (`~/.codenine/accounts/codex`) and shares Codex's chat history
  between them, so a chat can move between these accounts too. If Codex is already signed in on the
  machine, the first account uses that login where it is.

Each command line account needs its own `auth.json` file. If Codex keeps logins in an OS credential
store, configure file storage for this setup. See
[OpenAI's credential storage guide](https://learn.chatgpt.com/docs/auth#credential-storage).

To end a login, choose **Sign out** on the account. Removing an account keeps its login and chat
history on the machine, so adding it again picks them up.

### Configure an account by hand

**Configure manually** lets you choose the folders. Accounts that share a **CODEX_HOME path** and
each have their own **Shadow home path** share Codex sessions and configuration while keeping their
own login and available models. Codenine prepares the shared state in the shadow directory; do not
populate it by copying your whole Codex home. To sign an account in from your own terminal, point
`CODEX_HOME` at its shadow home:

```bash
CODEX_HOME=~/.codenine/accounts/codex/personal codex login
```

Use a completely separate **CODEX_HOME path**, with no shadow home, when you want separate Codex
sessions and configuration.

## Switch accounts in a chat

Choose the other account from the chat's model picker. An account that shares the chat's history
continues the same chat. For an account with its own history, such as a command line account in a
chat that started on ChatGPT, Codenine asks how to go on:

- **Branch this chat** copies the conversation into a new chat on the other account. The history
  goes with your next message, so it counts toward that account's usage.
- **New chat** starts an empty chat on the other account in the same workspace.

The original chat stays on its account either way.

If two accounts show the same unexpected account or models, check their reported accounts, refresh
provider status, and confirm each command line account has its own shadow folder and login. A
shadow-home conflict usually means the folder contains a copied Codex setup. Use a fresh folder and
sign in again.

## Answer questions while Codex works

Codex can ask a question and keep working. Answer it in the chat's question
panel. The answer becomes a new message: it reaches the active turn, or starts
another turn if Codex has finished. Unanswered questions survive reconnects.
If you do not want to answer, dismiss the question from its panel. Dismissing
closes it without sending anything to Codex. This requires a Codex version that
supports async questions.

## Approve app access

Codex tools can request access to another app. Respond to the named app's request
in the chat. Some tools offer access for one request,
the current session, or permanently. See [Permission modes](./permission-modes.md)
for command and file approvals.

## Codex says I hit a usage limit

When Codex stops on a usage limit, the chat names the window that ran out and
when it resets, when Codex reports them. Send the message again after the reset. On a workspace plan the
message also says whether your workspace owner needs to add credits or raise the
spend limit to continue sooner.

## Send feedback to OpenAI

In an existing Codex chat, send `/feedback` with an optional description, for
example `/feedback The agent stopped before finishing the tests`. This uploads
the conversation and Codex logs to OpenAI. The returned thread ID can be shared
with OpenAI support.
