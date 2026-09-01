// The three places a model is allowed to act, and the fence around each.
//
// The scout is a real agent: it is handed one tool and a goal ("read this
// company's site and tell me what they sell"), and it decides which of the
// pages linked off the landing page are worth opening. That is a loop with
// judgement in it, which is what an agent is for.
//
// The judge and the writer are NOT agents and deliberately so. They are one
// structured call each. An agent is a loop with tools; giving a loop to
// "score this post against this rubric" buys nothing and costs a
// non-deterministic number of requests per item.
//
// All three run on lib/llm.mjs — fetch, a schema check, a tool loop, and no
// dependencies. The whole tool now runs on a bare Node install; the only thing
// a model seat needs that the rest does not is a key.
//
// THE HARD RULE, inherited from the local rebuild and worth restating: the
// model proposes and a human presses Save. There is no code path in here that
// writes project.md, icp.md or rule.md. `scoutSite` RETURNS markdown; the
// server hands it to a form; a person clicks. That is the cheapest possible way
// to make "the markdown wins" true rather than aspirational.

import { seat, chosen, ROLES } from "./models.mjs";
import { structured, toolLoop } from "./llm.mjs";
import { memoryContext } from "./memory.mjs";

/* ------------------------------------------------------------------ html */

/** Enough HTML-to-text to read a landing page. Not a parser — a reducer, so a
 *  model spends its context on sentences rather than on class attributes. */
export const htmlToText = (h) =>
  String(h ?? "")
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|tr|li|h\d|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, x) => String.fromCodePoint(parseInt(x, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&(quot|apos|lt|gt|amp|nbsp|mdash|ndash);/g, (_, e) =>
      ({ quot: '"', apos: "'", lt: "<", gt: ">", amp: "&", nbsp: " ", mdash: "—", ndash: "–" }[e]))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** An explorer that pulls a megabyte of HTML into its context has stopped
 *  exploring and started drowning. */
const PAGE_LIMIT = 30_000;

/* ------------------------------------------------------------------ scout */

/**
 * The one tool the scout gets. GET-only and no method parameter — adding one
 * would be the only way for this to write to somebody else's server, which is
 * why there is not one.
 */
const readUrlTool = (ctl, seen) => ({
  name: "read_url",
  description: "Fetch one public web page and return its text and the links on it. GET only.",
  parameters: {
    type: "object",
    required: ["url"],
    properties: { url: { type: "string", description: "Absolute http(s) URL" } },
  },
  run: async ({ url }) => {
    if (ctl?.signal?.aborted) return "cancelled";
    if (seen.size >= 12) return "page budget spent — write your answer from what you have read";
    let u;
    try { u = new URL(url); } catch { return `not a url: ${url}`; }
    if (!/^https?:$/.test(u.protocol)) return "only http and https";
    if (seen.has(u.href)) return "already read that one";
    seen.add(u.href);
    ctl?.log?.(`  reading ${u.href}`);
    try {
      const r = await fetch(u, {
        redirect: "follow",
        signal: AbortSignal.timeout(20_000),
        headers: { "user-agent": "messaging-quest/0.4 (+local; reads public pages)" },
      });
      if (!r.ok) return `${r.status} ${r.statusText}`;
      const body = await r.text();
      const text = htmlToText(body);
      // Give it the links too: the whole point of an agent here is that it
      // picks pricing and about pages off the landing page itself.
      const links = [...body.matchAll(/href="([^"#?]+)"/g)]
        .map((m) => { try { return new URL(m[1], u).href; } catch { return null; } })
        .filter((h) => h && h.startsWith(u.origin));
      const uniq = [...new Set(links)].slice(0, 40);
      return `URL: ${u.href}\n\n${text.slice(0, PAGE_LIMIT)}\n\n--- links on this page ---\n${uniq.join("\n")}`;
    } catch (e) {
      return `could not read it: ${e.message}`;
    }
  },
});

const SCOUT_BRIEF = `You are reading one company's own website so that a Reddit
outreach tool can tell, later and automatically, whether a stranger's post is
somebody that company should answer.

Start at the URL you are given. Read it. Then follow the links on it that would
tell you more — pricing, product, use cases, about, docs, customers. Read at
most a handful; you have a budget of twelve pages and you will be told when it
is spent.

What you are looking for, in order of importance:

1. The PROBLEM somebody has before they find this company. In their words, not
   the company's. The sentence a person types into a forum at 1am.
2. What the thing actually does. Concretely. Not the tagline.
3. Who it is for, and — harder and more valuable — who looks like a match and
   is NOT. Every fit rule leaks without this written down.
4. What a stranger can go and check. Named customers, public numbers, a free
   tier, a repo.

Do not guess. If the site does not say who it is not for, say that you could not
find it rather than inventing a plausible exclusion. A rule built on a guess is
a rule that quietly drops real people from a queue for months.

When you have read enough, write your findings as prose. Someone else will turn
them into files.`;

const PROPOSAL = {
  type: "object",
  required: ["name", "one_line", "problem", "project_md", "icp_md", "rule_md", "places", "unknown"],
  properties: {
    name: { type: "string", description: "What the company or product is called." },
    one_line: { type: "string", description: "What it does, in one sentence, in plain words." },
    problem: { type: "string", description: "The sentence somebody types when they have this problem." },
    project_md: { type: "string", description: "Full markdown for project.md. Headings and prose, no frontmatter." },
    icp_md: { type: "string", description: "Full markdown for icp.md, including who is NOT a match." },
    rule_md: {
      type: "string",
      description: "Full markdown for rule.md: a fit rule with an 'Answer YES when' list, a 'The near miss' " +
        "list, and a 'When you cannot tell' section that says to answer YES.",
    },
    places: { type: "array", items: { type: "string" }, description: "Subreddit names, no r/ prefix, where this problem is discussed. Best guess, at most six." },
    unknown: { type: "array", items: { type: "string" }, description: "What the site did not say, that a human should fill in." },
  },
};

/**
 * The scout run. Returns proposed markdown for three files; writes nothing.
 */
export async function scoutSite(dir, url, ctl = {}) {
  const cfg = seat(dir, "scout");
  ctl.log?.(`scout: ${cfg.model}`);
  ctl.progress?.(0, 3, "reading the site");

  const seen = new Set();
  const { text: prose, usage, exhausted } = await toolLoop(cfg, {
    messages: [
      { role: "system", content: SCOUT_BRIEF },
      { role: "user", content: `Read ${url} and report what you find.` },
    ],
    tools: [readUrlTool(ctl, seen)],
    maxSteps: 24,   // twelve pages plus room to think between them
    signal: ctl.signal,
    log: ctl.log,
  });
  if (exhausted) ctl.log?.("  step budget spent — writing the files from what was read");
  ctl.log?.(`  ${seen.size} page${seen.size === 1 ? "" : "s"} read, ${usage.completion_tokens} tokens written`);

  ctl.progress?.(2, 3, "writing the files");
  ctl.log?.("\nturning that into project.md, icp.md and rule.md");

  const { data } = await structured(cfg, [
    { role: "system", content: "Turn these findings into the three files. Keep the person's own words wherever you can. Never invent a fact the findings do not contain." },
    { role: "user", content: `Site: ${url}\n\nFindings:\n\n${prose}` },
  ], PROPOSAL, { name: "proposal", signal: ctl.signal, log: ctl.log });

  ctl.progress?.(3, 3, "done");
  return data;
}

/* ------------------------------------------------------------------ judge */

const VERDICTS = {
  type: "object",
  required: ["verdicts"],
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        required: ["n", "fit", "why"],
        properties: {
          n: { type: "number", description: "The item number you were given." },
          fit: { type: "boolean", description: "True if this person should be answered." },
          why: { type: "string", description: "One sentence. Quote their words where you can." },
        },
      },
    },
  },
};

/**
 * Score found posts against rule.md.
 *
 * Batched, and the batch size is load-bearing: the schema check refuses the
 * whole object, so ONE malformed element discards every verdict in the call.
 * At five a bad batch costs five re-reads; at a hundred it costs the whole
 * tick, which is the failure the local rebuild hit and wrote down.
 */
export async function judgeItems(dir, items, ruleText, ctl = {}) {
  const cfg = seat(dir, "judge");

  const about = memoryContext(dir);
  const system = [
    "You decide whether one forum post is somebody the operator should answer, using the rule below and nothing else.",
    "",
    "# The rule",
    ruleText,
    about ? `\n# What the operator sells\n\n${about}` : "",
    "",
    "Answer every item you are given, by its number. One sentence of why, quoting their words where you can.",
  ].join("\n");

  const out = [];
  // Five, not ten. A batch is one request that either lands whole or is lost
  // whole, and on a model that reasons, ten items of body text is enough
  // thinking to exhaust the output budget before the tool call is emitted —
  // which does not error, it truncates, and the verdicts simply never arrive.
  // Five also means the progress bar moves four times as often on a job that
  // takes minutes, which is most of what makes it feel like it is working.
  const BATCH = 5;
  // 700 characters is plenty to decide whether somebody has a problem. The
  // 1200 the store keeps is for the drafter, which needs their actual words.
  const BODY = 700;

  for (let i = 0; i < items.length; i += BATCH) {
    if (ctl.signal?.aborted) throw new Error("cancelled");
    const batch = items.slice(i, i + BATCH);
    const upto = Math.min(i + BATCH, items.length);
    ctl.progress?.(i, items.length, `judging ${i + 1}–${upto} of ${items.length}`);
    const body = batch
      .map((x) => `## ${x.n}\nr/${x.place ?? "?"} · u/${x.author ?? "?"}\n${x.title ?? ""}\n${(x.body ?? "").slice(0, BODY)}`)
      .join("\n\n");
    const began = Date.now();
    try {
      const { data } = await structured(cfg,
        [{ role: "system", content: system }, { role: "user", content: body }],
        VERDICTS,
        // Without the signal, Stop marks the job cancelled and the request
        // carries on underneath it — the button lies, and the next batch fires.
        { name: "verdicts", signal: ctl.signal, log: ctl.log });
      for (const v of data.verdicts ?? []) out.push(v);
      const fits = (data.verdicts ?? []).filter((v) => v.fit).length;
      ctl.log?.(`  ${i + 1}–${upto}: ${fits} fit  (${Math.round((Date.now() - began) / 1000)}s)`);
    } catch (e) {
      if (ctl.signal?.aborted) throw new Error("cancelled");
      // A failed batch is unjudged, which is its own state and is not a no.
      // Those items stay pending, exactly as they would if a human had not got
      // to them yet — so the loop carries on rather than losing the other 17.
      ctl.log?.(`  ${i + 1}–${upto}: failed after ${Math.round((Date.now() - began) / 1000)}s (${e.message}) — left unjudged`);
    }
  }
  ctl.progress?.(items.length, items.length, "done");
  return out;
}

/* ----------------------------------------------------------------- writer */

const OPTIONS = {
  type: "object",
  required: ["options"],
  properties: {
    options: {
      type: "array",
      description: "Up to three, differing by move. One is a correct answer if there is only one honest thing to say.",
      items: {
        type: "object",
        required: ["move", "text"],
        properties: {
          move: { type: "string", description: "What this option DOES: answers the literal question, answers what is behind it, or points at whoever already solved it." },
          text: { type: "string", description: "The reply itself, ready to post. No preamble, no sign-off, no subject line." },
        },
      },
    },
  },
};

/**
 * Draft the reply.
 *
 * The prompt is `buildSignalDraftPrompt()`, unchanged — it already assembled
 * the post, the measured voice, the community's risks and the three-moves
 * instruction, and already emitted a complete prompt. Until now it printed that
 * prompt for a human to paste somewhere. This sends it.
 */
export async function draftReply(dir, promptText, ctl = {}) {
  const cfg = seat(dir, "writer");
  ctl.log?.(`writer: ${cfg.model}`);
  const { data } = await structured(cfg, [{ role: "user", content: promptText }], OPTIONS,
    { name: "options", signal: ctl.signal, log: ctl.log });
  return data.options ?? [];
}

/** What each role is currently set to, for the UI to show without importing
 *  models.mjs a second time. */
export const roleSummary = (dir) =>
  Object.values(ROLES).map((r) => ({ ...r, model: chosen(dir)[r.key] }));
