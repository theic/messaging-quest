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

import { seat } from "./models.mjs";
import { structured, toolLoop } from "./llm.mjs";
import { memoryContext } from "./memory.mjs";
import { STYLES } from "./writing.mjs";

/* ------------------------------------------------------------------ html */

/** An explorer that pulls a megabyte of HTML into its context has stopped
 *  exploring and started drowning. */
const PAGE_LIMIT = 30_000;

/* ------------------------------------------------------------------ scout */

/**
 * The one tool the scout gets: a page, read in the operator's own browser
 * (lib/browse.mjs) — the only reading mechanism there is, from 0.6.0. The
 * tab is leased once for the run and turns pages; the lane paces it. There
 * is no fetch here and no method parameter: the extension reads, it never
 * submits, and a page a person can open is the whole reach.
 */
const LINKS = { items: "a[href]", limit: 200, fields: { href: "href", text: "text" } };
const hostOf = (u) => String(u).toLowerCase().replace(/^www\./, "");
/**
 * `site` is the host the run was given, and the tool stays on it: the
 * scout reads one company's own pages, not the web. Measured 2026-09-06,
 * the first fresh-user run on the free plan: refused on the site (the
 * extension had no grant for it yet), the model went to example.com and a
 * Google search and proposed three files from those. `stats` counts what
 * actually opened so the run can refuse to propose from nothing.
 */
const readUrlTool = (ctl, seen, browse, site, stats) => ({
  name: "read_url",
  description: `Open one page of ${site} in the operator's browser and return its text and the links on it. Reads only; only that site.`,
  parameters: {
    type: "object",
    required: ["url"],
    properties: { url: { type: "string", description: `Absolute http(s) URL on ${site}` } },
  },
  run: async ({ url }) => {
    if (ctl?.signal?.aborted) return "cancelled";
    if (seen.size >= 12) return "page budget spent — write your answer from what you have read";
    let u;
    try { u = new URL(url); } catch { return `not a url: ${url}`; }
    if (!/^https?:$/.test(u.protocol)) return "only http and https";
    if (hostOf(u.host) !== site) return `only pages on ${site} — this is the company's own site, not a search or another site. If ${site} cannot be read, stop and say so.`;
    if (seen.has(u.href)) return "already read that one";
    seen.add(u.href);
    ctl?.log?.(`  reading ${u.href}`);
    const opened = await browse.open(u.href);
    if (opened.error) { stats.failed++; stats.lastError = opened.error; return `could not open it: ${opened.error}. If every page of ${site} is refused, stop and say the site could not be read.`; }
    const page = await browse.text(PAGE_LIMIT);
    if (page.error) { stats.failed++; stats.lastError = page.error; return `could not read it: ${page.error}`; }
    stats.ok++;
    // Give it the links too: the whole point of an agent here is that it
    // picks pricing and about pages off the landing page itself.
    const got = await browse.extract(LINKS);
    const links = (got.rows ?? [])
      .map((r) => { try { return new URL(String(r.href ?? ""), u).href.split("#")[0]; } catch { return null; } })
      .filter((h) => h && h.startsWith(u.origin));
    const uniq = [...new Set(links)].slice(0, 40);
    return `URL: ${page.url ?? u.href}\n\n${page.text}\n\n--- links on this page ---\n${uniq.join("\n")}`;
  },
});

const SCOUT_BRIEF = `You are reading one company's own website so that a
marketing tool can tell, later and automatically, whether a stranger's post is
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
    places: { type: "array", items: { type: "string" }, description: "Community names, without a platform prefix, where this problem is discussed. Best guess, at most six." },
    unknown: { type: "array", items: { type: "string" }, description: "What the site did not say, that a human should fill in." },
  },
};

/**
 * The scout run. Returns proposed markdown for three files; writes nothing.
 */
export async function scoutSite(dir, url, ctl = {}, { browse } = {}) {
  if (!browse) throw new Error("the site is read in your own browser — the scout needs the browser lane (run it from the dashboard)");
  const cfg = seat(dir, "scout");
  ctl.log?.(`scout: ${cfg.model}`);
  ctl.progress?.(0, 3, "reading the site");

  const seen = new Set();
  const stats = { ok: 0, failed: 0, lastError: null };
  let site;
  try { site = hostOf(new URL(url).host); } catch { throw new Error(`not a site address: ${url}`); }
  let prose, usage, exhausted;
  try {
    ({ text: prose, usage, exhausted } = await toolLoop(cfg, {
      messages: [
        { role: "system", content: SCOUT_BRIEF },
        { role: "user", content: `Read ${url} and report what you find. Stay on ${site}: its own pages are the only source.` },
      ],
      tools: [readUrlTool(ctl, seen, browse, site, stats)],
      maxSteps: 24,   // twelve pages plus room to think between them
      signal: ctl.signal,
      log: ctl.log,
    }));
  } finally {
    await browse.close();
  }
  if (exhausted) ctl.log?.("  step budget spent — writing the files from what was read");
  ctl.log?.(`  ${stats.ok} page${stats.ok === 1 ? "" : "s"} read, ${usage.completion_tokens} tokens written`);
  // Nothing of the site opened: there is nothing honest to propose, and a
  // proposal written from nothing is worse than an error that says why.
  if (!stats.ok) throw new Error(`could not read ${site} — ${stats.lastError ?? "no page opened"}. ${/allow|grant/i.test(stats.lastError ?? "") ? "Press Allow on the panel's card for the site, then try again." : "Check the address, then try again."}`);

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
    "A post that already had many comments when found is crowded: everybody's bots got there first, and one more reply is noise. The rule still decides fit; when crowding tips a borderline case, say so in the why.",
  ].join("\n");

  const out = [];
  // Why each failed batch failed, carried on the result: a run where every
  // batch failed used to finish "ok" with nothing written, and the reason
  // lived only in a log nobody kept. The server turns this into the job's
  // error, so the strip says "400: …" instead of nothing.
  out.failed = [];
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
    // The room and the author as the platform's people write them; a
    // campaign's own fit clause, when the finding came in under one
    // (lib/campaigns.mjs judgeLine) — one line, and rule.md still decides.
    const body = batch
      .map((x) => `## ${x.n}\n${x.room ?? x.place ?? "?"} · ${x.author ?? "?"}${x.crowd != null ? ` · ${x.crowd} comment${x.crowd === 1 ? "" : "s"} already when found` : ""}\n${x.campaign ? `${x.campaign}\n` : ""}${x.title ?? ""}\n${(x.body ?? "").slice(0, BODY)}`)
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
      out.failed.push(e.message);
    }
  }
  ctl.progress?.(items.length, items.length, "done");
  return out;
}

/* ----------------------------------------------------------------- writer */

const STYLE_IDS = STYLES.map((s) => s.id);
const DRAFTS = {
  type: "object",
  required: ["drafts"],
  properties: {
    no_fit: {
      type: "string",
      description: "Only when there is nothing honest to say without naming what the operator sells: one plain sentence on why. Leave drafts empty then.",
    },
    drafts: {
      type: "array",
      description: `Exactly three, one per style, in this order: ${STYLE_IDS.join(", ")}. Empty only when no_fit is filled in.`,
      items: {
        type: "object",
        required: ["style", "text"],
        properties: {
          // Not an enum on purpose: the validator refuses the WHOLE answer on
          // one bad value, and a model that labels a fourth draft "story"
          // would lose the three good ones. An unknown style is dropped and
          // a missing one asked for (perStyle, below) — one draft lost, not
          // the round.
          style: { type: "string", description: `One of: ${STYLE_IDS.join(", ")}. ${STYLES.map((s) => `${s.id}: ${s.what}`).join(" ")}` },
          text: { type: "string", description: "The reply itself, ready to post. No preamble, no sign-off, no subject line." },
        },
      },
    },
  },
};

const SYSTEM = "You are the writer. Everything you need is in the next message. Answer only by calling the drafts function — the three replies go in its arguments, one per style, and nothing goes outside it. A line break is a real newline character (\\n) inside the JSON string — never a pipe, never the letter n.";

/**
 * A free model's newlines, measured 2026-09-06 (MiniMax M2.7 free, the
 * first fresh-user round): every line break arrived as a bare "n" —
 * "first step.nAsk if they need" — the backslash lost somewhere between
 * the model and the tool call. A text with no newline at all and two or
 * more of that seam is that fault, not prose; the seam is put back. Never
 * applied to a text that already has a newline, and never to a person's
 * own words (this runs on the writer's output only).
 */
// The seam has been seen as "n", as "|n" and as a bare "|" (three rounds,
// same model, same afternoon), with or without spaces around it.
const SEAM = /([.!?,;:a-z0-9)]) *(?:\| *n?|n)(?=[A-Z])/g;
export const mendNewlines = (text) => {
  const s = String(text ?? "");
  if (/\n/.test(s)) return s;
  const hits = s.match(SEAM);
  return hits && hits.length >= 2 ? s.replace(SEAM, "$1\n") : s;
};

/** One per style, in the canonical order, first answer per style kept;
 *  blanks dropped. What is missing is the caller's to ask for again. */
const perStyle = (rows) => {
  const by = new Map();
  for (const d of Array.isArray(rows) ? rows : []) {
    const k = String(d?.style ?? "").toLowerCase();
    const text = mendNewlines(String(d?.text ?? "").trim());
    if (STYLE_IDS.includes(k) && text && !by.has(k)) by.set(k, { style: k, text });
  }
  return STYLE_IDS.filter((k) => by.has(k)).map((k) => by.get(k));
};

/**
 * Draft the three replies (0.8.0 — three, always).
 *
 * The prompt is what `mq draft <id>` prints — the post, the measured voice,
 * the community's risks, the campaign, and the three styles by name
 * (lib/writing.mjs draftsBlock). This sends it and holds the answer to the
 * shape: one draft per style. A model that sends two is asked once more for
 * the one it left out, with the two it wrote in front of it, so a round on
 * the card is three tabs and not a lottery.
 *
 * Returns `{drafts, no_fit}`: an empty list with a reason is the writer
 * saying the honest reply would have to name the product, which on a first
 * message it may not — a real answer, and not a failure to draft.
 */
export async function draftReply(dir, promptText, ctl = {}) {
  const cfg = seat(dir, "writer");
  ctl.log?.(`writer: ${cfg.model}`);
  // The system line exists because of one measurement (2026-09-01): handed
  // the material as a bare user message, Kimi K3 wrote the three replies as
  // prose and had to be asked again — 128s and two calls for one draft. Told
  // where the answer goes, it goes there.
  const { data } = await structured(cfg, [
    { role: "system", content: SYSTEM },
    { role: "user", content: promptText },
  ], DRAFTS, { name: "drafts", signal: ctl.signal, log: ctl.log });
  let drafts = perStyle(data.drafts);
  // A writer that fills no_fit AND drafts has misread the field; the drafts
  // are the answer and the reason is noise.
  if (!drafts.length) return { drafts: [], no_fit: data.no_fit ?? null };

  const missing = STYLE_IDS.filter((k) => !drafts.some((d) => d.style === k));
  if (missing.length) {
    ctl.log?.(`  ${drafts.length} of 3 came back — asking for the ${missing.join(" and ")} draft${missing.length === 1 ? "" : "s"}`);
    try {
      const { data: more } = await structured(cfg, [
        { role: "system", content: SYSTEM },
        { role: "user", content: promptText },
        { role: "assistant", content: `Written so far:\n\n${drafts.map((d) => `--- ${d.style} ---\n${d.text}`).join("\n\n")}` },
        { role: "user", content: `Now write the ${missing.join(" and ")} draft${missing.length === 1 ? "" : "s"} — the same person, the same rules, a different move: ${missing.map((k) => `${k} — ${STYLES.find((s) => s.id === k).what}`).join(" ")} Call the drafts function with only ${missing.length === 1 ? "that one" : "those"}.` },
      ], DRAFTS, { name: "drafts", signal: ctl.signal, log: ctl.log });
      drafts = perStyle([...drafts, ...(more.drafts ?? [])]);
    } catch (e) {
      if (ctl.signal?.aborted) throw new Error("cancelled");
      ctl.log?.(`  the second ask failed (${e.message}) — keeping the ${drafts.length}`);
    }
  }
  return { drafts, no_fit: null };
}
