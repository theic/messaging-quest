// Where to look on Reddit, and where this platform refuses to look.
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
//
// These numbers are Reddit's, which is why this file lives in the reddit skill
// rather than in lib/: another platform gets its own measurements or it gets
// no shapes at all. The 10% floor those measurements justified is the one part
// that generalises, and it lives in lib/probe.mjs.

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
