// Phase 2 — Find. Where to look, and where this tool refuses to look.
//
// "Precision is a subtraction problem." The failure mode of every product in
// this category is showing you more, so nearly everything here is a rule about
// what NOT to read.
//
// The shapes, measured over a real corpus of 57 live sources and 5,268 reads:
//
//   scoped subreddit search  restrict_sr=1     42.2% fit   2.4 reads per lead
//   subreddit submissions    /new/.rss         29.3% fit   3.4 reads per lead
//   site-wide search                           10.0% fit  10.0 reads per lead
//   comments firehose        /comments/.rss     4.2% fit  23.5 reads per lead
//
// The firehose was 76% of everything ever read on Reddit and sat in the 4.2%
// row. Controlled nine ways — same subreddits, same period — submissions beat
// comments nine times out of nine, from 3x to 13x. So it is not deprioritised
// here, it is refused: at one anonymous request a minute, a shape that costs
// 23.5 reads a lead would eat the entire daily budget for a handful of people.

/** A scoped search: the phrase finds the problem, the subreddit guarantees the
 *  person is the kind who has it. `restrict_sr=1` is the whole trick, and
 *  leaving it off silently widens the search to the entire site. */
export const scoped = (place, q, window = "week") =>
  `https://www.reddit.com/r/${place}/search/.rss?q=${encodeURIComponent(q)}&restrict_sr=1&sort=new&t=${window}&limit=100`;

/** A subreddit's own new submissions. No phrase, so it is reach rather than
 *  precision — worth it in a room where the problem is the reason people post. */
export const submissions = (place) => `https://www.reddit.com/r/${place}/new/.rss?limit=100`;

export const SHAPES = { scoped, submissions };

/**
 * The refusals, applied to a source before it can ever be watched.
 *
 * Returned as a reason string, or null when there is nothing wrong. A refusal
 * is not a low score — the tool writes no source at all, and says why.
 */
export function refuse(src) {
  if (src.kind === "comments")
    return "the undirected comment firehose: 4,074 reads for 173 leads in the corpus, 23.5 reads each. Read submissions and scoped searches instead.";
  if (/\/comments\/\.rss/.test(src.url || ""))
    return "that URL is a subreddit's comment firehose. Same measurement, same answer.";
  if (/\/search\/\.rss/.test(src.url || "") && !/restrict_sr=1/.test(src.url || ""))
    return "a search without restrict_sr=1 silently widens to the whole site — 10% fit against 42% scoped.";
  return null;
}

/* --------------------------------------------------- the rules of the room */

/**
 * Phrases a subreddit uses when it does not want what this tool helps you do.
 *
 * This is the refusal nobody else ships. A competitor was observed scoring
 * r/slp an "Excellent Match" at 80/100 while rendering that subreddit's own
 * rule — "No recruiters ever. Seriously. Never. Don't self-…" — on the same
 * card. Displaying the rule that prohibits your use case and recommending it
 * anyway is the exact behaviour this tool exists to not have.
 *
 * Deliberately literal. These are phrases communities actually write, not a
 * model's opinion about tone, so a refusal can always be traced to the sentence
 * that caused it and argued with.
 */
const BANS = [
  /\bno\s+(self[- ]?)?promo(tion|ting)?\b/i,
  /\bno\s+advertis(ing|ements?)\b/i,
  /\bno\s+solicit(ing|ation)\b/i,
  /\bno\s+recruit(ers?|ing|ment)\b/i,
  /\bno\s+(spam|shilling)\b/i,
  /\bno\s+market(ing|ers)\b/i,
  /\bdo\s+not\s+(self[- ]?promote|advertise|solicit)\b/i,
  /\bself[- ]?promotion\s+is\s+(not\s+allowed|banned|prohibited|forbidden)\b/i,
  /\bno\s+surveys?\b/i,
  /\bno\s+market\s+research\b/i,
];

/**
 * Read a room's own description for a rule against being sold to.
 *
 * Returns the matched sentence, so the refusal can be quoted back rather than
 * asserted. A match is reported VERBATIM for the same reason every other number
 * in this repo carries its measurement: an unquotable refusal is one nobody can
 * check.
 */
export function bansPromotion(text) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return null;
  for (const re of BANS) {
    const m = clean.match(re);
    if (!m) continue;
    // Give back the sentence it sits in, not the two words that matched.
    const at = m.index ?? 0;
    const start = Math.max(0, clean.lastIndexOf(".", at) + 1);
    const end = clean.indexOf(".", at + m[0].length);
    return clean.slice(start, end === -1 ? Math.min(clean.length, at + 160) : end + 1).trim();
  }
  return null;
}

/* ---------------------------------------------------------------- the floor */

/** Below this, a source is not worth a minute a read. Set from the measured
 *  spread: site-wide search sat at 10% and was the shape that wasted most of
 *  the corpus, so 10% is the line between "narrow" and "a firehose with a
 *  phrase on it". */
export const FLOOR = 0.10;

/** What a probe concluded. Deliberately a decision and a number, not a score:
 *  the competitor's 0–100 relevance score produced eleven distinct values over
 *  981 rows with a floor that never once fired. */
export function verdictOf({ read, fit }) {
  if (!read) return { commit: false, why: "nothing came back to judge" };
  const rate = fit / read;
  return {
    commit: rate >= FLOOR,
    rate,
    why: rate >= FLOOR
      ? `${fit} of ${read} fit (${pct(rate)}) — clears the ${pct(FLOOR)} floor`
      : `${fit} of ${read} fit (${pct(rate)}) — under the ${pct(FLOOR)} floor, so no source is written`,
  };
}

export const pct = (r) => `${Math.round(r * 100)}%`;
