// Optional model rewrite of one briefing block. The model sees figure tokens, never numbers,
// and its answer is rejected unless every number still comes from a token, so a rewrite can
// change wording but cannot invent or alter a figure.

const TOKEN = /\[\[([a-z0-9_.]+)\]\]/g;

export function aiConfig(env = process.env) {
  const model = env.WBR_AI_MODEL;
  if (!model) return null;
  return {
    model,
    url: env.WBR_AI_URL ?? "https://openrouter.ai/api/v1/chat/completions",
    key: env.OPENROUTER_API_KEY ?? null,
  };
}

/** Why a proposed rewrite is unsafe, or null when every number in it is a known figure. */
export function rejectRewrite(proposed, figures) {
  if (!proposed.trim()) return "The rewrite was empty.";
  for (const match of proposed.matchAll(TOKEN)) {
    if (!figures[match[1]]) return `The rewrite used an unknown figure [[${match[1]}]].`;
  }
  const typed = proposed.replace(TOKEN, "").match(/\d/);
  if (typed) return "The rewrite typed a number instead of using a figure.";
  return null;
}

export async function rewriteBlock({ text, instruction, figures, config, fetchImpl = fetch }) {
  const catalogue = Object.values(figures)
    .filter((figure) => figure.provenance || figure.key.startsWith("week"))
    .map((figure) => `[[${figure.key}]] = ${figure.label}`)
    .join("\n");
  const body = {
    model: config.model,
    max_tokens: 600,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          "You edit one paragraph of a weekly business review. Figures appear as tokens like [[otd.current]]. " +
          "Keep tokens exactly as written and never write a digit: refer to numbers only through tokens from the list. " +
          "Reply with the rewritten paragraph only.",
      },
      {
        role: "user",
        content: `Available figures:\n${catalogue}\n\nInstruction: ${instruction}\n\nParagraph:\n${text}`,
      },
    ],
  };
  const response = await fetchImpl(config.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.key ? { authorization: `Bearer ${config.key}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`The model service answered ${response.status}.`);
  const json = await response.json();
  const proposed = String(json.choices?.[0]?.message?.content ?? "").trim();
  const problem = rejectRewrite(proposed, figures);
  if (problem) throw new Error(`${problem} The paragraph was left unchanged.`);
  return proposed;
}
