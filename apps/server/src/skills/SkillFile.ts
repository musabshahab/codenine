import { SkillName } from "@codenine/contracts";
import * as Schema from "effect/Schema";
import { Document, isMap, parseDocument } from "yaml";

export const SKILL_FILE = "SKILL.md";
const SKILL_NAME_MAX_LENGTH = 64;
// Marks a skill added from Codenine's library, under the open format's free-form `metadata`.
const LIBRARY_METADATA_KEY = "codenine-library";

const FRONTMATTER_PATTERN = /^﻿?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

export const isSkillName = Schema.is(SkillName);

export interface SkillFile {
  readonly name: string | undefined;
  readonly description: string | undefined;
  readonly fromLibrary: string | undefined;
  /** SKILL.md without its frontmatter. */
  readonly instructions: string;
}

export const splitFrontmatter = (contents: string) => {
  const match = FRONTMATTER_PATTERN.exec(contents);
  return match === null
    ? { yaml: undefined, body: contents }
    : { yaml: match[1] ?? "", body: contents.slice(match[0].length) };
};

/** Quotes `key: value: more` scalars, which agents accept and strict YAML rejects. */
const quoteColonScalars = (yaml: string) =>
  yaml.replace(/^([\w-]+:[ \t]*)([^\r\n]*)/gm, (line, prefix: string, value: string) => {
    const scalar = value.split(/[ \t]+#/)[0] ?? "";
    if (!/:[ \t]/.test(scalar) || /^(?:["'[\]{}|>&*!#%@`]|[-?:](?:[ \t]|$))/.test(scalar)) {
      return line;
    }
    return `${prefix}${JSON.stringify(scalar)}${value.slice(scalar.length)}`;
  });

export const parseFrontmatterMap = (yaml: string) => {
  for (const source of [yaml, quoteColonScalars(yaml)]) {
    const document = parseDocument(source);
    if (document.errors.length === 0 && (document.contents === null || isMap(document.contents))) {
      return document;
    }
  }
  return undefined;
};

export const instructionsOf = (body: string) => body.replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd();

/** Reads what it can: a skill with broken frontmatter still has its instructions. */
export function parseSkillFile(contents: string): SkillFile {
  const { yaml, body } = splitFrontmatter(contents);
  const document = yaml === undefined ? undefined : parseFrontmatterMap(yaml);
  const text = (value: unknown) =>
    typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  const metadata = document?.get("metadata");
  return {
    name: text(document?.get("name")),
    description: text(document?.get("description")),
    fromLibrary: isMap(metadata) ? text(metadata.get(LIBRARY_METADATA_KEY)) : undefined,
    instructions: instructionsOf(body),
  };
}

/** Writes SKILL.md, keeping every other frontmatter key of `existing`. */
export function renderSkillFile(input: {
  readonly existing?: string | undefined;
  readonly name: string;
  readonly description?: string | undefined;
  readonly instructions: string;
  readonly fromLibrary?: string | undefined;
}): string {
  const previous = input.existing === undefined ? undefined : splitFrontmatter(input.existing).yaml;
  const document =
    (previous === undefined ? undefined : parseFrontmatterMap(previous)) ?? new Document({});
  document.set("name", input.name);
  if (input.description !== undefined) document.set("description", input.description);
  if (input.fromLibrary !== undefined) {
    const metadata = document.get("metadata");
    if (isMap(metadata)) metadata.set(LIBRARY_METADATA_KEY, input.fromLibrary);
    else document.set("metadata", { [LIBRARY_METADATA_KEY]: input.fromLibrary });
  }
  const instructions = input.instructions.trim();
  // An unbounded line width keeps each value on one line for agents that read frontmatter by line.
  return `---\n${document.toString({ lineWidth: 0 })}---\n${instructions === "" ? "" : `\n${instructions}\n`}`;
}

/** A valid skill name from any label, such as a plugin skill's `plugin:review`. */
export function slugifySkillName(label: string): string {
  const slug = label
    .normalize("NFKD")
    .replaceAll(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, SKILL_NAME_MAX_LENGTH)
    .replace(/-+$/, "");
  return slug === "" ? "skill" : slug;
}
