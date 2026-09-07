// The memory — five markdown files, and the rule that nothing writes them
// without a keystroke behind it.
//
// Markdown rather than a table, for the reason the predecessor's local rebuild
// found and wrote down: what you WRITE belongs in files you can open, and only
// what ACCUMULATES belongs in a store. `rule.md` decides every verdict in the
// product. If it lives in a database row, the honest answer to "why is this
// person in my queue" is a query. If it lives in a file, the answer is `cat`.
//
// These files are also the agent's filesystem. `lib/agents.mjs` mounts this
// directory at /workspace/, so the scout that proposes them and the judge that
// applies them are reading the same bytes you edit in the browser — not a copy
// marshalled through a prompt template that can drift from what is on disk.
//
// EDITABLE is a whitelist and not a convenience. The browser can write these
// five names and no others: an editor that can write anywhere is a shell, and
// this one is reachable from a page that renders text a stranger wrote.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";

/* ------------------------------------------------------------------- seeds */

/** The fit rule. Every verdict is stamped with a hash of this file, so when the
 *  queue changes you can tell whether it was your rule or the model that moved.
 *  Seeded generic on purpose — a seed that guessed your business would be a
 *  rubric you never read and never corrected. */
const RULE_SEED = `# Fit rule

A post is a fit **iff** the author is a person who has the problem and is
visibly working at it, and is **not** selling a solution to it or advising
somebody else about it.

## Answer YES when
- They describe the difficulty in their own words.
- They ask how to solve it.
- They show what it currently costs them.

## The near miss
- Pitching their own product or service.
- Answering somebody else's question rather than having the problem.
- A tactic write-up, case study or launch. A war story is not somebody stuck.
- Already solved it, reporting back in the past tense.
- **Advertising.** Somebody offering the thing, however softly, is not somebody
  who needs it. This clause leaks without being written down.
- **Job seekers.** "Looking for work" is a different need from the one you
  solve, and it reads as a fit to every judge that has not been told otherwise.

## When you cannot tell
Answer YES. A wrong yes costs one line in a queue you skim. A wrong no costs a
person nobody will ever know existed. Uncertainty is a yes, not a fallback.
`;

const PROJECT_SEED = `# What you sell

<!-- Paste your URL on /setup and this gets written for you. Or write it
     yourself — what you say always beats what was read. -->

## In one line

## What it actually does

## What somebody can check
`;

const ICP_SEED = `# Who it is for

<!-- Filled by /setup from your own site, then corrected by you. -->

## The person

## The sentence they type when they have the problem

## Who looks like a match and is not
`;

const ME_SEED = `# What you have actually done

Every first-person claim in a draft is checked against this file, and the ones
that are not supported here are put in front of you before you send anything.

The failure this exists for is a real one: a competitor posted *"at my last job
i used [product] for some basic bridge work during intake"* into a clinical
thread, under a real name. Nobody had ever had that job.

So write only what is true.

## What you have built

## What you have actually used

## What you have not done
`;

const PERSONA_SEED = `# Your specialist

<!-- Who the strategist is when it talks to you. Give it a name, give it
     manners, tell it what to nag you about. This file is read every time it
     speaks; edit it and the next conversation is with whoever you wrote.
     The seed below works as shipped, which is why an unedited persona does
     not count against your setup. -->

You are the operator's marketing specialist — a colleague, not a control
panel. You know their project from its own files, you keep track of who is
waiting for an answer, and you say what the next action is without being
asked.

Plain sentences. Concrete numbers. No marketing fluff, no exclamation-mark
enthusiasm. When you are unsure, say so. When something was refused, quote
the sentence that refused it — the refusals are the product, not an apology.
`;

const AGENTS_SEED = `# Your specialist's notebook

<!-- The sixth memory file, and the only one the model writes (PLAN.md,
     2026-09-03). The strategist keeps its standing instructions and what it
     has learned about this brand and this operator here, in the Deep Agents
     convention (AGENTS.md), and reads it into its prompt every turn. You may
     read and correct it; the five files above stay yours alone. -->
`;

/* ---------------------------------------------------------------- the files */

export const MEMORY = [
  {
    file: "rule.md",
    title: "The fit rule",
    what: "Decides who reaches your queue. Every verdict is stamped with a hash of this file.",
    seed: RULE_SEED,
  },
  {
    file: "project.md",
    title: "What you sell",
    what: "Read off your own site, then corrected by you. The drafter writes from this.",
    seed: PROJECT_SEED,
  },
  {
    file: "icp.md",
    title: "Who it is for",
    what: "The person, and the sentence they type when they have the problem.",
    seed: ICP_SEED,
  },
  {
    file: "me.md",
    title: "What you have actually done",
    what: "Claims about your own experience are checked against this before a draft is saved.",
    seed: ME_SEED,
  },
  {
    file: "persona.md",
    title: "Your specialist",
    what: "Who the strategist is when it talks to you. Yours to rewrite; the seed works as shipped.",
    seed: PERSONA_SEED,
    /** Usable unedited — so it neither counts against setup progress nor
     *  enters the judge's and writer's context. It is about how the
     *  STRATEGIST speaks, not about the operator's project, and a judge told
     *  "you are a colleague named X" starts judging like a colleague named X. */
    optional: true,
  },
  {
    file: "AGENTS.md",
    title: "Your specialist's notebook",
    what: "What the strategist learned about this brand and this operator, in its own words — the one file the model writes. Yours to read and correct.",
    seed: AGENTS_SEED,
    /** The model's, not the operator's: out of the setup count, out of the
     *  judge's and writer's context, into the strategist's prompt only. */
    optional: true,
  },
];

const EDITABLE = MEMORY.map((m) => m.file);

const meta = (file) => MEMORY.find((m) => m.file === file) ?? null;

/** Reject anything that is not one of the five, by exact basename. `join` on an
 *  attacker-supplied name is how a whitelist becomes a directory traversal. */
export const allowed = (file) => EDITABLE.includes(basename(String(file ?? "")));

/* ------------------------------------------------------------------ access */

/**
 * A file is "filled" when somebody has actually said something in it.
 *
 * Not a byte count: every seed is already several hundred bytes of scaffolding,
 * so length alone reports an untouched `me.md` as done. What counts is prose
 * that is not the seed and not an HTML comment — the seeds are headings and
 * instructions, and a heading nobody wrote under is still an empty answer.
 */
export function filled(body, seed) {
  const strip = (s) =>
    String(s ?? "")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n")
      .replace(/\s+/g, " ")
      .trim();
  const mine = strip(body);
  if (!mine) return false;
  return mine !== strip(seed);
}

export function readOne(dir, file) {
  if (!allowed(file)) return null;
  const m = meta(basename(file));
  const path = join(dir, m.file);
  const exists = existsSync(path);
  const body = exists ? readFileSync(path, "utf8") : m.seed;
  return { ...m, body, exists, filled: filled(body, m.seed), bytes: Buffer.byteLength(body) };
}

export const readMemory = (dir) => MEMORY.map((m) => readOne(dir, m.file));

/** Write one file. Returns the new state so a caller never has to re-read. */
export function writeMemory(dir, file, body) {
  if (!allowed(file)) throw new Error(`${file} is not one of the memory files`);
  const name = basename(file);
  // Normalise the newline a browser textarea submits, so a file edited in the
  // UI and the same file edited in an editor hash identically. `rule.md`'s hash
  // is on every verdict, and CRLF alone would silently invalidate all of them.
  writeFileSync(join(dir, name), String(body ?? "").replace(/\r\n/g, "\n"));
  return readOne(dir, name);
}

/** Write any of the four that are not there yet. Called by `init` and by the
 *  server on boot, so an older `.mq/` grows the new files on first run. */
export function seedMissing(dir) {
  const made = [];
  for (const m of MEMORY) {
    const path = join(dir, m.file);
    if (existsSync(path)) continue;
    writeFileSync(path, m.seed);
    made.push(m.file);
  }
  return made;
}

/**
 * What the agents are told about you, as one block.
 *
 * Only the filled files go in. Handing a model the untouched seed of `me.md`
 * teaches it that your experience section is a list of headings, and it will
 * write drafts to match — an empty section has to be absent, not blank.
 */
export function memoryContext(dir) {
  return readMemory(dir)
    .filter((m) => m.filled && m.file !== "rule.md" && !m.optional)
    .map((m) => `# ${m.title} (${m.file})\n\n${m.body.trim()}`)
    .join("\n\n---\n\n");
}

/** How much of the setup is actually answered — the number the /setup progress
 *  bar and the "you are not set up yet" banners both read. Optional files are
 *  in the list (the editor shows them) and out of the count (an unedited
 *  persona is a working persona, not a gap). */
export function memoryProgress(dir) {
  const all = readMemory(dir);
  const counted = all.filter((m) => !m.optional);
  return { done: counted.filter((m) => m.filled).length, total: counted.length, files: all };
}
