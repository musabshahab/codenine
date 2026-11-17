import type { ChatAttachment } from "@codenine/contracts";
import { assistantCitationsToPlainText } from "@codenine/shared/assistantCitations";
import { replaceComposerContextReferences } from "@codenine/shared/composerContextReferences";
import { SKILL_MENTION_PATTERN } from "@codenine/shared/composerInlineTokens";
import { truncate } from "@codenine/shared/String";

import { collectComposerAgentMentions } from "../composerAgentMentions.ts";
import { collectComposerModelMentions } from "../composerModelMentions.ts";

export interface ThreadTitleSeedInput {
  readonly text: string;
  readonly attachments: ReadonlyArray<Pick<ChatAttachment, "type" | "name">>;
  readonly fallbackLabels?: ReadonlyArray<string | null | undefined>;
}

function normalizeTitleSeed(value: string): string {
  return assistantCitationsToPlainText(value).trim().replace(/\s+/gu, " ");
}

// The agent a message hands the chat to says who does the task, not the task.
function withoutAgentMentions(value: string): string {
  let result = "";
  let cursor = 0;
  for (const mention of collectComposerAgentMentions(value)) {
    result += value.slice(cursor, mention.start);
    cursor = mention.end;
  }
  return result + value.slice(cursor);
}

function modelMentionsAsSlugs(value: string): string {
  let result = "";
  let cursor = 0;
  for (const mention of collectComposerModelMentions(value)) {
    result += value.slice(cursor, mention.start) + mention.model;
    cursor = mention.end;
  }
  return result + value.slice(cursor);
}

export function threadTitleTextFromPrompt(value: string): string {
  const imageIds = new Set<string>();
  const prose = replaceComposerContextReferences(value, (reference) => {
    if (reference.kind === "image") {
      imageIds.add(reference.contextId);
      return "";
    }
    return reference.label;
  });
  // A skill names how to do the task, not the task.
  const withoutSkills = prose.replace(SKILL_MENTION_PATTERN, "$1");
  return (
    normalizeTitleSeed(modelMentionsAsSlugs(withoutAgentMentions(withoutSkills))) ||
    (imageIds.size > 0 ? (imageIds.size === 1 ? "Attached image" : "Attached images") : "")
  );
}

export function deriveThreadTitleSeed(input: ThreadTitleSeedInput): string {
  const text = threadTitleTextFromPrompt(input.text);
  if (text.length > 0) {
    return truncate(text);
  }

  const images = input.attachments.filter((attachment) => attachment.type === "image");
  if (images.length > 0) {
    return images.length === 1 ? "Attached image" : "Attached images";
  }

  const attachmentName = normalizeTitleSeed(input.attachments[0]?.name ?? "");
  if (attachmentName.length > 0) {
    return truncate(`File: ${attachmentName}`);
  }

  for (const label of input.fallbackLabels ?? []) {
    const normalized = normalizeTitleSeed(label ?? "");
    if (normalized.length > 0) {
      return truncate(normalized);
    }
  }

  return "New chat";
}
