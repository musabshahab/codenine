/** A skill as the session's instructions list it. */
export interface SkillListing {
  readonly name: string;
  readonly description: string;
}

// Codex truncates additionalContext entries over 4,000 bytes, so the list stays below it on both.
const SKILLS_INSTRUCTIONS_MAX_BYTES = 4_000;
const LISTED_DESCRIPTION_MAX_CHARS = 280;
const ATTACHED_FILES_SHOWN = 20;
const ATTACHED_INSTRUCTIONS_MAX_CHARS = 60_000;

const SKILLS_HEADER = `## Codenine skills

A skill holds the user's way of doing one kind of task. When a task fits one of these, call \`codenine_skill_read\` with its name before you start, then follow it. Read a skill once per conversation. A skill the user names with \`$name\` comes attached to their message.`;

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

const oneLine = (text: string) => text.replaceAll(/\s+/g, " ").trim();

function shorten(text: string, maxChars: number): string {
  const characters = Array.from(text);
  if (characters.length <= maxChars) return text;
  const cut = characters.slice(0, maxChars - 1).join("");
  const wordEnd = cut.lastIndexOf(" ");
  return `${wordEnd > maxChars / 2 ? cut.slice(0, wordEnd) : cut}…`;
}

const escapeAttribute = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

/** The session's list of skills, or "" when there are none. */
export function buildSkillsInstructions(skills: ReadonlyArray<SkillListing>): string {
  if (skills.length === 0) return "";
  const moreLine = (count: number) => `- ${count} more: list them with \`codenine_skill_list\`.`;
  const reserved = utf8Bytes(`\n${moreLine(skills.length)}`);
  const lines: Array<string> = [];
  let bytes = utf8Bytes(`${SKILLS_HEADER}\n`);
  for (const [index, skill] of skills.entries()) {
    const description = shorten(oneLine(skill.description), LISTED_DESCRIPTION_MAX_CHARS);
    const line = `- ${skill.name}: ${description || "(no description)"}`;
    const lineBytes = utf8Bytes(`\n${line}`);
    const last = index === skills.length - 1;
    if (bytes + lineBytes + (last ? 0 : reserved) > SKILLS_INSTRUCTIONS_MAX_BYTES) {
      lines.push(moreLine(skills.length - index));
      break;
    }
    lines.push(line);
    bytes += lineBytes;
  }
  return `${SKILLS_HEADER}\n\n${lines.join("\n")}`;
}

/** A skill the user named in their message, sent with it. */
export function attachedSkillContext(skill: {
  readonly name: string;
  readonly folder: string;
  readonly files: ReadonlyArray<string>;
  readonly instructions: string;
}): string {
  const shown = skill.files.slice(0, ATTACHED_FILES_SHOWN);
  const more = skill.files.length - shown.length;
  const files =
    shown.length === 0
      ? ""
      : `\nIts folder also holds ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}. Read or run them from the folder when the skill says to.`;
  const instructions = skill.instructions.trim();
  const cut = shorten(instructions, ATTACHED_INSTRUCTIONS_MAX_CHARS);
  const body =
    cut === instructions
      ? instructions
      : `${cut}\n\n[Cut short here. Read the rest in SKILL.md in the folder above.]`;
  return `<codenine_skill name="${escapeAttribute(skill.name)}" folder="${escapeAttribute(skill.folder)}">
The user named this skill in their message. Follow it for this request.${files}

${body}
</codenine_skill>`;
}

/** Skills the user keeps on for a chat, named each turn instead of sent in full. */
export function keptOnSkillsContext(names: ReadonlyArray<string>): string {
  return `<codenine_skills_on>The user keeps these skills on for this chat: ${names.join(", ")}. Read any you have not read in this conversation with \`codenine_skill_read\`, then follow them wherever they apply.</codenine_skills_on>`;
}
