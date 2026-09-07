// The two hard refusals on a draft, and one inherited from the store.
//
// §07: "Two hard refusals: no first-person claim your history does not
// support, and nothing repeating a phrase you have already used."
//
// Both are plain string arithmetic. Neither asks a model whether a draft is
// good — that judgement is the human's, and a model grading its own output is
// the shape that produced the sentence a competitor posted into a clinical
// thread under a real name.

/* ------------------------------------------------------ repeated phrasing */

/**
 * The AI smell is SHAPE, not vocabulary.
 *
 * The measurement that settles it, from the predecessor's own corpus: 29 drafts
 * shared a 26-word identical run, and 24.6% of all pairs shared a run of eight
 * words or more — while the mail-merge check reported them clean, because it
 * subtracted the template's vocabulary before comparing. It fired on 0 of 406
 * pairs. A duplicate detector that never fires is worse than none, because it
 * is also a reassurance.
 *
 * So this compares RUNS of consecutive words, and subtracts nothing.
 *
 * Re-run against the surviving drafts on disk, 2026-08-28 — 16 of the original
 * 29, the rest being in the Supabase table §13 deletes:
 *
 *   pairs sharing >= 8 words   25 of 120   20.8%   (24.6% over all 29)
 *   longest shared run         19 words              (26 over all 29)
 *   containing an em dash      8 of 16     50%      (13 of 29, 45%)
 *
 * The same finding at the same proportions, and the run it names is real:
 * "you sell in one sentence i can share three recent threads where people are
 * actively looking for exactly that". The check this replaces fired on 0 of
 * 406 pairs. This one fires on 25 of 120.
 */
const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);

/** Longest run of identical consecutive words shared by two texts. */
export function longestSharedRun(a, b) {
  const x = norm(a), y = norm(b);
  if (!x.length || !y.length) return { length: 0, phrase: "" };
  // Rolling one row of the classic table: these are single messages, and a
  // full matrix buys nothing but memory.
  let prev = new Array(y.length + 1).fill(0);
  let best = 0, endsAt = 0;
  for (let i = 1; i <= x.length; i++) {
    const cur = new Array(y.length + 1).fill(0);
    for (let j = 1; j <= y.length; j++) {
      if (x[i - 1] !== y[j - 1]) continue;
      cur[j] = prev[j - 1] + 1;
      if (cur[j] > best) { best = cur[j]; endsAt = i; }
    }
    prev = cur;
  }
  return { length: best, phrase: x.slice(endsAt - best, endsAt).join(" ") };
}

/** §10's threshold, and §02's governor signal: Reddit names "the same or
 *  similar comments across communities" as reportable spam. Eight consecutive
 *  words is the line the corpus was measured against. */
export const RUN_LIMIT = 8;

/**
 * Worst repetition between a draft and everything already sent.
 * Returns null when nothing reaches the limit.
 */
export function repeats(text, priors) {
  let worst = { length: 0, phrase: "", against: null };
  for (const p of priors) {
    const run = longestSharedRun(text, p.text ?? p);
    if (run.length > worst.length) worst = { ...run, against: p.id ?? null };
  }
  return worst.length >= RUN_LIMIT ? worst : null;
}

/* ------------------------------------------------- claims about yourself */

/**
 * First-person claims about experience, surfaced for a human to check.
 *
 * The failure this exists for, observed verbatim in a competitor's own output,
 * posted into a clinical thread about a patient with aphasia: "at my last job i
 * used vocavela for some basic bridge work during intake". The operator has
 * never been a speech therapist. That is a false statement of fact published
 * under a real name, and it is a harder version of the invented-permalink
 * failure the store already guards.
 *
 * Deliberately NOT a model call and deliberately NOT an auto-reject. A model
 * cannot know what you have done, and a regex certainly cannot — so this finds
 * the sentences that ASSERT experience and puts them in front of you next to
 * what you actually wrote about yourself. Every one is either true or it is the
 * thing that ends the account.
 */
const CLAIM = new RegExp(
  [
    /\bi (?:used|tried|built|ran|shipped|worked|managed|led|founded|sold|switched|migrated|implemented|deployed)\b/,
    /\b(?:at|in) my (?:last |previous |old |current )?(?:job|company|team|role|startup|agency|shop)\b/,
    /\bwhen i (?:was|worked|ran|did|had)\b/,
    /\bwe (?:used|tried|built|ran|shipped|switched|migrated)\b/,
    /\bi(?:'ve| have) (?:been|used|built|run|shipped|worked|done|spent)\b/,
    /\bmy (?:client|clients|customer|customers|team|company|startup)\b/,
    /\bin my experience\b/,
    /\bi'?m an? \w+/,
  ].map((r) => r.source).join("|"),
  "gi",
);

export function claims(text) {
  const out = [];
  // The sentence, not the fragment: "I used" proves nothing on its own, and a
  // person checking a claim needs the claim.
  for (const s of String(text ?? "").split(/(?<=[.!?])\s+|\n+/)) {
    const t = s.trim();
    if (!t) continue;
    CLAIM.lastIndex = 0;
    const m = t.match(CLAIM);
    if (m) out.push({ sentence: t.slice(0, 240), matched: [...new Set(m.map((x) => x.toLowerCase()))] });
  }
  return out;
}

/* --------------------------------------------------------- what is theirs */

/**
 * "i built doctick" — in a reply to the person who built DocTick. Seen on
 * 2026-09-07 from a free writer under a disclosed campaign with me.md still
 * the seed: told it may name what the operator built, and handed nothing of
 * theirs to name, it named the only product in front of it, which was the
 * stranger's. The claims guard flags that as a history claim like any other;
 * this one says WHOSE. A name the draft claims as built, made or founded that
 * appears in the person's own post and nowhere in me.md is theirs, not
 * yours — and posting it under your name is the one lie in this whole
 * pipeline that the person you are replying to can see at a glance.
 *
 * A flag, never a rejection, like the rest: the names are returned, the
 * human decides. Words that are not a name ("a", "the", "something", "a
 * small tool") never match.
 */
const MINE_VERBS = /\bi (?:built|made|created|founded|launched|run|wrote|shipped|develop(?:ed)?)\s+(?:a\s+|an\s+|the\s+|this\s+|my\s+)?([a-z][\w.-]{2,})/gi;
const NOT_A_NAME = new Set(["something", "small", "simple", "little", "tool", "thing", "one", "some", "it", "this", "that", "my", "our", "same", "similar", "few", "couple", "lot", "site", "app", "bot", "script", "version", "product", "service", "company", "startup", "business", "agency", "team", "system", "workflow", "process", "pipeline", "solution", "feature", "plugin", "extension", "quick", "tiny", "free", "new", "own"]);
export function theirs(text, thread, mine = "") {
  const post = String(thread ?? "");
  const me = String(mine ?? "").toLowerCase();
  if (!post.trim()) return [];
  const out = [];
  for (const m of String(text ?? "").matchAll(MINE_VERBS)) {
    const name = m[1].toLowerCase().replace(/[.,;:!?]+$/, "");
    if (NOT_A_NAME.has(name) || name.length < 3 || me.includes(name) || out.includes(name)) continue;
    if (namedInPost(post, name)) out.push(name);
  }
  return out;
}

/** A word in their post is a NAME — not just a word they also used — when
 *  they wrote it with a capital or a digit in it (DocTick, v2), or claimed
 *  it themselves ("I built X", "my X"). "nothing" in "we launched and
 *  nothing" is a word, and "i built nothing" is not their product. */
function namedInPost(post, name) {
  const re = new RegExp(`(?:\\b(built|made|created|launched|founded|shipped|my|our)\\s+(?:a\\s+|an\\s+|the\\s+)?)?(${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?![\\w-])`, "gi");
  for (const m of post.matchAll(re)) if (m[1] || /[A-Z\d]/.test(m[2]) || /[.-]/.test(name)) return true;
  return false;
}

/* ----------------------------------------------------------------- the tells */

/**
 * Phrases nobody types to one person. The model is handed the list in the
 * prompt (lib/writing.mjs AI_TELLS); this is the half that does not trust it
 * to have listened. Plain regexes over the finished draft — and, like the
 * other two refusals, a flag and never a rejection: the phrase is named, the
 * human decides.
 *
 * PHRASES only, deliberately. "delve" in a sentence about digging is a word;
 * "hope this helps" is a template. A vocabulary filter would be the same
 * one-person's-taste-shipped-as-fact mistake lib/voice.mjs was built to
 * delete — so "that said" and "reach out to them", which real people write,
 * are not here, and their template forms ("that being said", "feel free to
 * reach out") are.
 */
const TELLS = [
  ["great question", /\b(great|good|excellent|love this) question\b/i],
  ["hope this helps", /\bhope (this|that|it) helps\b/i],
  ["good luck", /\b(good|best of) luck\b/i],
  ["you've got this", /\byou'?ve got this\b/i],
  ["my two cents", /\bmy (two|2) cents\b/i],
  ["for what it's worth", /\bfor what it'?s worth\b/i],
  ["in my humble opinion", /\bin my humble opinion\b/i],
  ["I've been there", /\b(i'?ve been there|been there,? done that|i feel you|i totally get it)\b/i],
  ["at the end of the day", /\bat the end of the day\b/i],
  ["the reality is", /\bthe reality is\b/i],
  ["here's the thing", /\bhere'?s the thing\b/i],
  ["that being said", /\bthat (being|having been) said\b/i],
  ["it's worth noting", /\bit'?s worth (noting|mentioning)\b/i],
  ["it's important to note", /\bit'?s important to (note|remember|understand)\b/i],
  ["as someone who (opener)", /^\s*as someone who\b/i],
  ["game changer", /\bgame[- ]chang(er|ing)\b/i],
  ["in today's world", /\bin today'?s (fast-paced |digital |modern )?(world|landscape|market|economy)\b/i],
  ["not only … but also", /\bnot only\b[^.!?\n]{0,80}\bbut also\b/i],
  ["happy to help", /\bhappy to help\b/i],
  ["feel free to", /\bfeel free to\b/i],
  ["let me know if you have any questions", /\blet me know if you have any questions\b/i],
  ["I hope this finds you well", /\bi hope this (message |email )?finds you\b/i],
  ["best regards", /\b(best|kind|warm) regards\b/i],
  ["pro tip", /\bpro[- ]tip\b/i],
  ["TL;DR", /\btl;?dr\b/i],
];

/**
 * Which tells a draft carries, by name. `voice` is the merged fingerprint and
 * is consulted for exactly one thing: the em dash is the most reliable machine
 * signature in a forum reply, so it counts — unless this person has been seen
 * typing one, in which case it is theirs.
 */
export function tells(text, voice = null) {
  const s = String(text ?? "");
  const out = [];
  for (const [name, re] of TELLS) if (re.test(s)) out.push(name);
  if (/—/.test(s) && voice?.dashes?.value !== "yes") out.push("em dash");
  return out;
}

/* ------------------------------------------------------------ made-up links */

/** The drafter has no search. Any URL it did not lift from the thread in hand
 *  is invented, and it is a checkable false statement under your own name. */
export function inventedLinks(text, thread) {
  const present = new Set((String(thread ?? "").match(/https?:\/\/[^\s)>\]"']+/g) || []).map(trim));
  return [...new Set((String(text ?? "").match(/https?:\/\/[^\s)>\]"']+/g) || []).map(trim))].filter((u) => !present.has(u));
}
const trim = (u) => u.replace(/[.,;:]+$/, "");
