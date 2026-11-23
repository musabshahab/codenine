/** A skill that ships with Codenine. Adding one copies it into the Codenine skills folder. */
export interface LibrarySkillSource {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
}

const writeClearEmails: LibrarySkillSource = {
  name: "write-clear-emails",
  description:
    "Drafts and rewrites emails so the reader knows within two lines why they got it and what is asked of them: a subject that states the point, the ask or answer first, short paragraphs, and a clear next step. Use when the user wants an email, reply, follow-up, or announcement written, shortened, or made clearer.",
  instructions: `# Write clear emails

The reader is busy. Within two lines they should know why you wrote and what you need from them.

## Before you write
- Work out the one thing this email must achieve: a decision, an answer, an action, or awareness. If there are several, order them by importance or suggest separate emails.
- Know the reader: their role, what they already know, and how formal the relationship is. If the user gave an earlier thread, match its tone and do not repeat what it settled.
- If a fact the email depends on is missing (a date, an amount, a name, who decides), ask the user. Use a marked placeholder such as [DATE] only when the user wants a draft now.

## Structure
1. Subject: the point or the ask, specific enough to find later. "Approve Q3 hiring plan by Friday" beats "Hiring". In a reply, keep the thread's subject.
2. Opening: the ask or the answer first, then one line of why if the reader needs it.
3. Body: only what the reader needs to act. One idea per paragraph, two to four sentences each. Use a short list for options, steps, or several questions, and number the questions so replies can refer to them.
4. Close: the next step, who owns it, and when. "If you approve by Friday, I'll send the offers on Monday." Then a sign-off that fits the relationship.

## Style
- Plain words, active voice, specific nouns and numbers. Cut throat-clearing such as "I hope this finds you well" and "I just wanted to reach out".
- One request per sentence, each with what you need and by when.
- Bold at most one key fact or deadline.
- Bad news: say it plainly and early, give the reason in one sentence, then say what happens next.
- As short as it can be while complete: under 150 words for most emails.

## Rewriting a draft
- Keep the user's voice, facts, and intent. Change structure and wording, not substance.
- Move the ask to the top, cut repetition, split long paragraphs, and turn buried questions into a numbered list.
- Point out anything likely to read as unclear or curt, or to start a long back-and-forth.

## Output
The subject line, then the body, ready to paste. Then, briefly, any assumption you made or placeholder you left. If the user asked for options, give at most three, each with one line on how it differs, such as more formal or shorter.

Never send an email yourself unless the user explicitly asks you to send that email.`,
};

const triageAnInbox: LibrarySkillSource = {
  name: "triage-an-inbox",
  description:
    "Sorts a batch of emails or messages into reply needed, action needed, read later, and archive, with a reason and a suggested next step for each, so the user sees what needs them today. Use when the user asks to go through, triage, prioritise, or clean up an inbox, a list of messages, notifications, or support tickets.",
  instructions: `# Triage an inbox

Goal: in one minute the user sees what needs them today, what can wait, and what they can drop. Every message ends up in exactly one group.

## Gather
- Work from the messages the user gave you or the ones you can read with your tools. Do not send, delete, archive, label, or mark anything until the user approves; propose first.
- For each message note the sender, subject, date, whether it asks something of the user or is for information, any deadline, and the thread it belongs to.

## Sort into four groups
1. Reply needed: someone waits on the user, such as a question, an approval, or a meeting request. Order by deadline, then by how blocked the sender is.
2. Action needed: something to do that is not a reply, such as paying, signing, reviewing a document, or booking. Note the deadline.
3. Read later: useful, but nothing is asked, such as updates, reports, and newsletters the user reads.
4. Archive: automated notices that need nothing, duplicates, resolved threads, and promotions.

Rules of thumb:
- A person writing to the user directly outranks a mailing list or a bot.
- A deadline within two working days goes to the top of its group.
- When a later message resolves an earlier one in the same thread, keep only the latest and say so.
- Security alerts, failed payments, and legal or HR messages never go to Archive without the user's say.
- When you cannot tell whether something needs the user, put it in Reply needed or Action needed with your question, not in Archive.

## Report
Open with two lines: the count in each group, and the one or two things that matter most today.
Then one section per group, one line per message:
- Sender, "Subject": what is needed and by when. Next step: what you suggest.

For Reply needed, add the key point of the answer when it is obvious, and offer to draft full replies for the messages the user picks.

## Acting on it
Apply only the actions the user approves, then report exactly what you changed. Never send a reply without the user's go-ahead on that reply.`,
};

const reviewCode: LibrarySkillSource = {
  name: "review-code",
  description:
    "Reviews a code change for correctness bugs first, then security, data loss, performance, and missing tests, and reports confirmed findings ranked by severity with file and line references and concrete fixes. Use when the user asks for a code review, a review of a diff, branch, commit, or pull request, or a second look before merging.",
  instructions: `# Review code

A good review finds the problems that would hurt users or the next developer, explains each so the author can act on it, and stays quiet about taste.

## Scope
- Review the change, not the whole codebase: the diff, branch, commit, or pull request the user named. If they named none, review the uncommitted changes (\`git diff\` and \`git diff --staged\`), or the current branch against its base (\`git diff $(git merge-base HEAD origin/main)\`), and say which you reviewed.
- Read enough around the change to judge it: callers of changed functions, the data they receive, and the tests that cover them.
- Read the project's own rules first if it has any (CONTRIBUTING, AGENTS.md, style guides, lint config), and review against them.

## What to look for, in this order
1. Correctness: wrong logic, off-by-one errors, unhandled null and error paths, edge cases (empty, one, many, huge, concurrent), wrong assumptions about inputs, and behaviour that no longer matches its name or docs.
2. Security: injection (SQL, shell, HTML), missing authentication or permission checks, secrets in code or logs, path traversal, unsafe deserialisation, trusting client input.
3. Data: migrations that lose or corrupt data, missing transactions, irreversible changes with no way back.
4. Performance where it matters: work inside loops that belongs outside, N+1 queries, unbounded memory or result sets, blocking calls on hot paths.
5. Tests: changed behaviour with no test that fails without the change, and tests that cannot fail.
6. Maintainability: duplicated logic, misleading names, dead code, and error messages a user could not act on. Only what will cost real time later.

Skip formatting and personal style that a formatter or linter handles, or that the codebase already does differently.

## Confirm before you report
Trace each suspected bug through the actual code path. Run the tests or a small reproduction when you can. Drop findings you cannot support, or mark them clearly as questions.

## Report
Open with a short verdict: is it safe to merge, and what must change first.
Then the findings, most severe first. For each:
- Severity: blocker, should fix, or nit.
- Where: file and line.
- What is wrong and why it matters, with the input or sequence that triggers it.
- A concrete fix, as a short code suggestion when that is clearest.

Close with what you checked and what you did not, such as "did not run the integration tests". Keep praise to one specific line, or none.

Do not change the code unless the user asks you to apply the fixes.`,
};

const writeReleaseNotes: LibrarySkillSource = {
  name: "write-release-notes",
  description:
    "Turns merged changes, commits, pull requests, or a changelog into release notes users can act on: highlights, breaking changes with upgrade steps, and what is new, improved, and fixed. Use when the user asks for release notes, a changelog entry, a version announcement, or a summary of what shipped between two versions.",
  instructions: `# Write release notes

Release notes answer the reader's questions: what can I do now that I could not before, what changed under me, and do I need to do anything?

## Collect the changes
- Find the range: the two versions or tags the user named, or the last tag to now (\`git describe --tags --abbrev=0\`, then \`git log <tag>..HEAD --oneline\`, or the pull requests merged in that range).
- Read each pull request's title and description, not only commit messages.
- Leave out internal-only changes (CI, refactors, test-only changes, dependency bumps with no visible effect) unless the readers are the project's own developers.
- Breaking changes, deprecations, migrations, new settings, and security fixes always make the notes.

## Group and order
1. Breaking changes and upgrade steps, first whenever there are any: what breaks, who is affected, and the exact steps or settings to change.
2. Highlights: one to three changes most readers will care about, each with a sentence on why it matters.
3. New, Improved, Fixed: one line per change.
4. Security: fixed vulnerabilities with their severity and the affected versions.

## Write each line
- Lead with the effect, not the implementation: "Exports now include attachments", not "Refactor exporter to stream blobs".
- Present tense and plain words, no internal code names. Name the screen, command, or setting the reader touches.
- One line per user-visible change, even when several pull requests made it.
- Link the pull request or issue and credit outside contributors when the project does.

## Before you finish
- Never invent a version number, date, or link. Ask, or leave a placeholder such as [VERSION].
- Match the project's earlier release notes or CHANGELOG: its headings, heading levels, and tone.
- Give the notes ready to paste, then list what you left out and why, so the user can put it back.`,
};

const summariseAMeeting: LibrarySkillSource = {
  name: "summarise-a-meeting",
  description:
    "Turns a meeting transcript or rough notes into a short summary that leads with decisions, action items with owners and due dates, and open questions. Use when the user shares meeting notes, a transcript, or a recording's text and asks for a summary, minutes, a recap, a follow-up email, or the action items.",
  instructions: `# Summarise a meeting

People read a meeting summary to learn what was decided and what they have to do. Lead with those.

## Read the source
- Work from the transcript or notes the user gave. Note the attendees, the date, and the meeting's purpose when stated.
- Separate decisions from discussion. A decision is something the group agreed to do or not do. "We should probably..." with no agreement is discussion or an open question.
- Capture every commitment: who does what, by when. When no owner or date was said, write "no owner" or "no date" instead of guessing.
- Keep numbers, dates, names, and quotes exact. Where the source is unclear (crosstalk, [inaudible]), say so instead of filling the gap.

## Format
**Meeting:** purpose, date, attendees

**Summary:** two or three sentences on what the meeting was for and where it landed.

**Decisions**
- One line each, stated as the decision ("Launch moves to 12 March"), with the reason if one was given.

**Action items**
- [ ] Owner: action (due date)

**Open questions**
- What is unresolved, and who is expected to answer it.

**Notes**, only when the user wants detail: short bullets per topic, in the order discussed.

## Style
- Neutral and factual; no judgement on who was right.
- Short bullets, not paragraphs. Use people's names, not "someone".
- Leave out small talk, repetition, and tangents that reached no outcome.
- For a follow-up email, keep to the decisions and action items, and use the write-clear-emails skill if it is available.

## Check before you finish
Every action item has an owner or is marked as missing one, and every decision is in the source.`,
};

const researchWithSources: LibrarySkillSource = {
  name: "research-with-sources",
  description:
    "Researches a question across several sources and writes an answer in which every factual claim cites a source the user can open, with conflicting evidence and uncertainty stated plainly. Use when the user asks to research, investigate, fact-check, compare options, or find out what is known about a topic, especially when they want sources.",
  instructions: `# Research with sources

The answer is only as good as its sources. Every factual claim gets a citation the user can open, and anything you could not verify is labelled as such.

## Plan
- Restate the question in one sentence and list the sub-questions that answer it. If the question is ambiguous (which market, period, or definition), ask, or state the reading you chose.
- Decide what counts as a good source here. Primary sources (official documentation, standards, papers, filings, data sets, the original announcement) beat secondary ones (news, blog posts), which beat forums and AI-written summaries.

## Search and read
- Use the search and web tools you have. Try several phrasings, including the terms an expert would use.
- Open and read each source; never cite a search snippet. Note who published it and when.
- For each sub-question, find at least two independent sources or one authoritative primary source. For fast-moving topics, prefer recent sources and say how recent.
- When sources disagree, record both sides and why they might differ: date, method, or incentive.
- Keep notes as you go: claim, source title, publisher, date, URL, and the exact figure or quote.

## Write
- Open with a direct answer in two to four sentences, saying how confident you are and why.
- Then the detail, organised by sub-question. Put a citation after each claim, as [1] or [2], and list the numbered sources at the end: title, publisher, date, URL.
- Quote figures exactly, with units and dates. Do not combine numbers from incompatible sources.
- Keep what the sources state apart from your own inference ("This suggests...").
- Say plainly what you could not find or verify, and what would settle it.

## Never
- Invent a source, URL, quote, or statistic. If a page would not load, say so.
- Present one source's claim as consensus.
- Cite a source for something it does not say. Check each citation against your notes before you finish.`,
};

const planAProject: LibrarySkillSource = {
  name: "plan-a-project",
  description:
    "Turns a goal into a written project plan: the outcome and how to measure it, scope, milestones, ordered tasks with owners, estimates, and dependencies, the main risks, and the next actions. Use when the user asks to plan a project, launch, migration, event, or piece of work, or to turn a vague goal into concrete steps.",
  instructions: `# Plan a project

A plan is useful when someone can start work tomorrow from it and anyone can tell whether it is on track.

## Understand the goal
- Write the outcome in one sentence that says what will be true when the project is done and how you will know, such as "Customers in the EU can pay by bank transfer, and 5% of payments use it within a month."
- Find the constraints: deadline, budget, people, fixed dependencies, and what must not break.
- When an unknown would change the plan, ask the user a few targeted questions first. Otherwise state your assumptions at the top.

## Scope
- In scope: what the project delivers.
- Out of scope: what it deliberately does not do, so nobody assumes it.
- Smallest version: the least that reaches the outcome. Plan it first and list extras separately.

## Break it down
- Milestones: three to six checkpoints, each a result someone could demonstrate ("first payment through the sandbox"), not an activity.
- Tasks: concrete actions of a few days at most, each starting with a verb, grouped under milestones. Mark which tasks depend on others and which can run in parallel.
- Estimates: a range such as 2–4 days, with what drives the uncertainty. Leave room for review, testing, and handover; first estimates usually run low.
- Owners: one per task, or "unassigned" when the user has not said.
- Put the riskiest, least certain work early, so you learn soonest.

## Risks
The few biggest: what could go wrong, how likely and how bad it is, and what you will do now to reduce it or to notice early.

## Tracking
How progress is reported, how often, and to whom; and the points where the plan is revisited, with what would make you cut scope or move the date.

## Output
A plan the user can paste into a document or tracker:
1. Outcome, constraints, assumptions
2. Scope: in, out, smallest version
3. Milestones with target dates
4. Tasks: task, owner, estimate, depends on
5. Risks and how you will handle them
6. The next three actions for this week

Size the plan to the work: a two-week task needs no risk register, a migration across teams does.`,
};

const workWithDocuments: LibrarySkillSource = {
  name: "work-with-documents",
  description:
    "Reads and changes office documents in the workspace the way the user can review: spreadsheets (.xlsx, .csv), PDFs (form fields, highlights and notes) and slide decks (.pptx). Use when the user asks to update a spreadsheet, fill in or mark up a PDF, edit slides or speaker notes, or pull figures out of any of these files.",
  instructions: `# Work with documents

The user opens these files in Codenine and reviews what you changed, so change them with Codenine's document tools. They keep everything you do not touch, and each change can be discarded or restored.

## Read first
- Spreadsheet: \`codenine_spreadsheet_read\`. Read the sheet list, then the block you need. Rows and columns count from 0.
- PDF: \`codenine_pdf_read\`. It returns page text and the form's fields with their names and values.
- Deck: \`codenine_deck_read\`. It returns each slide's shapes with their ids, its notes, and the deck's layouts.
- Quote figures exactly as the file has them, and say which sheet, page or slide they came from.

## Change
- Spreadsheet: \`codenine_spreadsheet_edit\`. Write a formula where the user would expect one (a total is \`=SUM(...)\`, not a typed number). Match the formats of the cells around your change.
- PDF: \`codenine_pdf_edit\`. Fill fields by name. To mark a passage, quote its text from the page as you read it.
- Deck: \`codenine_deck_edit\`. Replace text in the existing shapes, and add slides from the deck's own layouts so they match its design. Keep a slide to what fits: split long text over two slides.
- Send the \`version\` from your read as \`expectedVersion\`. If the file changed since, read it again before you retry.
- After a change, say what you changed and where, in a few lines.

## Never
- Unzip a .xlsx or .pptx, edit its XML, or rebuild the file with a script. That drops formats, charts, themes and formulas, and the user cannot review it.
- Sign a PDF, or draw anything that stands for a signature. Only the user signs: tell them the file is ready and that Sign is in the PDF's tab.
- Guess a value for a form field or a cell. Ask, or leave it empty and say so.
- Send a document to an outside service to convert or read it.`,
};

const writeASkill: LibrarySkillSource = {
  name: "write-a-skill",
  description:
    "Helps the user turn how they like a kind of task done into a new skill: asks the right questions, drafts a SKILL.md in the open skill format, and saves it in the Codenine skills folder so every agent can use it. Use when the user wants to create, write, or save a skill, teach agents their way of doing something, or turn instructions they keep repeating into a reusable skill.",
  instructions: `# Write a skill

A skill is a folder with a SKILL.md file that tells an agent how to do one kind of task the user's way. Codenine lists every skill to its agents by name and description, and an agent reads the full instructions when a task fits. Your job: learn how the user wants the task done, write it down so another agent can follow it without asking, and save it.

## 1. Interview the user
Ask a few focused questions at a time and build on the answers. Stop when you could do the task their way without asking again. Cover:
- The task: what kind of work it is for and what it produces. Ask for one or two real examples of output they liked, or disliked and why.
- When it applies: which requests should use it, and which similar ones should not.
- Their way: the steps they always follow, the tools and sources they use, their standards for tone, format, length, and naming, and the mistakes to avoid.
- Inputs: what the agent will usually be given, and what it should ask for when something is missing.
- Done: how they judge the result, and any checks they run before calling it finished.
If they already have a prompt, notes, or a document they keep reusing, start from it and ask only about the gaps.

## 2. Name and describe it
- name: lower case letters, digits, and single hyphens, at most 64 characters, naming the task, such as \`write-weekly-update\` or \`review-sql-migrations\`. The folder has the same name. Check that the name is free with \`codenine_skill_list\`.
- description: at most 1024 characters, written in the third person: what the skill does and when to use it, with the words a user would really say when asking. It is all an agent sees when deciding whether to read the skill, so be specific: "Drafts the weekly team update from merged pull requests and closed tickets in the team's format. Use when the user asks for a weekly update, status report, or team summary." Not "Helps with updates."

## 3. Write SKILL.md
Start the file with frontmatter, then the instructions:

    ---
    name: write-weekly-update
    description: Drafts the weekly team update ... Use when ...
    ---

    # Write the weekly update

    The goal, and what good looks like, in one or two sentences.

    ## Steps
    1. ...

    ## Format
    ...

    ## Check before you finish
    - ...

- Write to a capable agent, in the imperative: "List the merged pull requests", not "You might want to". Give the reason when a rule is not obvious, so the agent can handle cases nobody foresaw.
- Be concrete. Exact formats, templates, thresholds, and a short example of good output beat adjectives.
- Keep SKILL.md under 500 lines, ideally far fewer. Move long material into files the skill names by relative path, with when to use each: \`references/\` for detailed guides and examples, \`scripts/\` for code the agent should run instead of rewriting, \`assets/\` for templates.
- Leave out secrets, personal data, and anything only true today.

## 4. Save it
Save it in the Codenine skills folder, which holds this skill's own folder: if this skill's folder is \`/home/user/.codenine/skills/write-a-skill\`, write \`/home/user/.codenine/skills/<name>/SKILL.md\`, plus any \`references/\`, \`scripts/\`, or \`assets/\` files. When the user wants the skill for one workspace only, save it in that workspace's \`.agents/skills/<name>/\` instead; a workspace skill wins over a Codenine skill of the same name.
Never overwrite an existing skill without the user's go-ahead. If you cannot write to the folder, give the user the files and where to put them.

## 5. Check it
Show the user the SKILL.md. Then read it as if you knew nothing else: could an agent do the task the user's way from this alone? Fix the gaps, and offer to try it on a real request. Tell the user how to use it: name it in a message as \`$<name>\`, or keep it on for a chat. It also appears on Codenine's Skills page, where they can edit it.`,
};

export const SKILL_LIBRARY: ReadonlyArray<LibrarySkillSource> = [
  writeClearEmails,
  triageAnInbox,
  reviewCode,
  writeReleaseNotes,
  summariseAMeeting,
  researchWithSources,
  planAProject,
  workWithDocuments,
  writeASkill,
];
