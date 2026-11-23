# Images

Codenine can make and edit images for you and save them in your workspace. The images are made by
an outside provider that you choose and pay: Codenine has no image model of its own, and it
contacts no provider until you have added a key for one.

## Add a provider

Open **Settings → Accounts → Media**. It lists the providers and says which have a key:

- **fal** uses the key of the fal connector. Open **Connectors** under **Build**, add **fal**, and
  paste an API key from fal.ai/dashboard/keys.
- **OpenRouter** uses the key of an OpenRouter account. Add one under **Settings → Accounts**.

Both keys are stored on the computer that runs Codenine and are sent only to their provider.

**Default model** starts as the cheapest model of the providers you have set up. Pick another if
you want better pictures and accept the price shown beside it.

## What it costs, and the limits

Each image is billed by the provider to your account with them. Codenine shows an estimated price
for each model and keeps two limits, in US dollars:

- **Monthly limit** is the most this computer spends on images in a calendar month, for you and
  your agents together. It starts at $5. Set it to 0 to turn images off.
- **Limit for one request** is the most a single request may cost: the number of images times the
  model's estimated price. It starts at $0.50.

A request that would pass either limit is refused before any provider is called, and the message
says which limit it was. **This month** shows what has been spent. Where a provider reports what it
charged, that amount is counted; otherwise the estimate is. Your provider's own bill is the final
word, so set a spending cap with the provider too if it offers one.

## Agents

An agent may make images only when **Make images** is on for it, under **On this computer** in the
agent's settings. New agents in a Create workspace start with it on; in other workspaces it starts
off. A chat without an agent can make images in any workspace once a provider has a key.

An agent's images count against the same limits. In a chat that asks before each file change, or in
plan mode, an agent does not make images: it tells you what it would make instead.

Results are saved in the workspace's `media` folder, under a name taken from the prompt, and never
replace a file that is already there. An edit saves a new file and leaves the original as it is.
In a folder without Git, the new files appear under **Versions** like any other change, and an
agent's images are listed with the turn's changed files so you can discard them.

The fal connector also gives agents fal's own tools, which can run any fal model, video included.
Those calls ask first by default and are not counted against the limits above.
