// Where to look on Reddit, and where this platform refuses to look.
//
// "Precision is a subtraction problem." The failure mode of every product in
// this category is showing you more, so nearly everything here is a rule about
// what NOT to read.
//
// The shapes, measured over a real corpus of 57 sources and 5,268 reads (on
// the feeds, 2026-08; the pages carry the same posts, so the ratios hold):
//
//   scoped subreddit search  restrict_sr=1     42.2% fit   2.4 reads per lead
//   subreddit submissions    /new/             29.3% fit   3.4 reads per lead
//   site-wide search                           10.0% fit  10.0 reads per lead
//   comments firehose        /comments/         4.2% fit  23.5 reads per lead
//
// The firehose was 76% of everything ever read on Reddit and sat in the 4.2%
// row. Controlled nine ways — same subreddits, same period — submissions beat
// comments nine times out of nine, from 3x to 13x. So it is not deprioritised
// here, it is refused: a shape that costs 23.5 page-turns a lead would keep a
// person's browser turning pages all day for a handful of people.
//
// From 0.6.0 every URL here is the PAGE a person opens, not a feed: reads
// happen in the operator's own rendered Chrome (lib/browse.mjs) and nowhere
// else. These numbers are Reddit's, which is why this file lives in the
// reddit skill rather than in lib/: another platform gets its own
// measurements or it gets no shapes at all. The 10% floor those measurements
// justified is the one part that generalises, and it lives in lib/probe.mjs.

const ROOT = "https://www.reddit.com";

/** A scoped search: the phrase finds the problem, the subreddit guarantees the
 *  person is the kind who has it. `restrict_sr=1` is the whole trick, and
 *  leaving it off silently widens the search to the entire site; `type=posts`
 *  keeps it to submissions (a post was measured 3.9× likelier to be somebody
 *  with the problem than a comment on somebody else's). */
export const scoped = (place, q, window = "week") =>
  `${ROOT}/r/${place}/search/?q=${encodeURIComponent(q)}&type=posts&restrict_sr=1&sort=new&t=${window}`;

/** A subreddit's own new submissions. No phrase, so it is reach rather than
 *  precision — worth it in a room where the problem is the reason people post. */
export const submissions = (place) => `${ROOT}/r/${place}/new/`;

export const SHAPES = { scoped, submissions };

/** Where a person reads a room's rules — Reddit does not show them to a
 *  logged-out reader, so a human looks once and records the answer. */
export const rulesUrl = (place) => `${ROOT}/r/${place}/about/rules`;

/** Reddit's own convention for parody communities — the class a competitor's
 *  picker put at the top of its list at 100/100. Free to check. */
export const isParody = (place) => /jerk$/i.test(String(place ?? ""));

/**
 * The refusals, applied to a source before it can ever be watched.
 *
 * Returned as a reason string, or null when there is nothing wrong. A refusal
 * is not a low score — the tool writes no source at all, and says why.
 */
export function refuse(src) {
  const url = String(src?.url ?? "");
  if (src?.kind === "comments")
    return "the undirected comment firehose: 4,074 reads for 173 leads in the corpus, 23.5 reads each. Read submissions and scoped searches instead.";
  if (/\/r\/[^/]+\/comments\/?(\?|$|\.rss)/.test(url))
    return "that URL is a subreddit's comment firehose. Same measurement, same answer.";
  if (/\/search\/?\?/.test(url) && !/restrict_sr=1/.test(url))
    return "a search without restrict_sr=1 silently widens to the whole site — 10% fit against 42% scoped.";
  if (/reddit\.com\/search\/?\?/.test(url))
    return "a site-wide search: 10% fit, the floor exactly. Scope it to a room.";
  return null;
}
