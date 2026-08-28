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

/* ------------------------------------------------------------ made-up links */

/** The drafter has no search. Any URL it did not lift from the thread in hand
 *  is invented, and it is a checkable false statement under your own name. */
export function inventedLinks(text, thread) {
  const present = new Set((String(thread ?? "").match(/https?:\/\/[^\s)>\]"']+/g) || []).map(trim));
  return [...new Set((String(text ?? "").match(/https?:\/\/[^\s)>\]"']+/g) || []).map(trim))].filter((u) => !present.has(u));
}
const trim = (u) => u.replace(/[.,;:]+$/, "");
