// Reading Reddit the way a stranger reads it: logged out, keyless, one request
// a minute. That constraint is not a limitation of this tool, it IS the tool —
// the whole question Phase 0 answers is "what does somebody who is not you see?",
// and the only honest way to ask it is to not be you while asking.
//
// Every URL and every field below was measured, not read off a blog. The
// measurements are dated inline so a future reader can tell a fact from a guess.

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

/**
 * Measured 2026-08-28, anonymous, residential: every 200 comes back
 * `x-ratelimit-used: 1, remaining: 0.0, reset: ~60`, keyed on the address and
 * surviving a fresh cookie jar. So the gap is the platform's number, not a
 * politeness setting, and lowering it just buys 429s.
 *
 * **It is not a clean 60-second sliding gap, and this was measured the hard
 * way.** On the first live run, a request sent 61s after the previous one was
 * still refused, with `x-ratelimit-reset: 9` — so the window is longer than the
 * header's own round number suggests, or is aligned to something we cannot see.
 * Observed `reset` values across one run: 60, 44, 27, 9.
 *
 * Hence 65s rather than 61s, and hence the 429 path in `es.mjs` is the
 * authority rather than this constant: it waits out the number Reddit itself
 * reports. This value only decides how often that path has to be used.
 *
 * Explained later (2026-08-31): what was measured here is Reddit's 2026-06-11
 * RSS throttle — ~1 request/minute/IP, announced to moderators as an
 * anti-scraping change alongside the May 2026 removal of unauthenticated
 * .json. So this number is the platform's enforced ceiling, not a comfortable
 * distance below it: there is ZERO headroom above this gap, and RSS itself
 * was named as a surface under review. That is why reading is designed to
 * survive on more than one lane — see PLAN.md ("Reading survives by never
 * depending on one lane") and research/market-2026-08-31.md.
 */
export const ANON_GAP_MS = 65_000;

/** How long a caller must still wait, given when the last request went out.
 *  Pure, and exported, because the governor is a thing that breaks silently:
 *  get it wrong and every read still "works" while the address collects 429s. */
export const waitFor = (lastMs, nowMs = Date.now()) => Math.max(0, lastMs + ANON_GAP_MS - nowMs);

/** One page of a thread. A read that comes back with exactly this many entries
 *  hit the ceiling and is therefore INCOMPLETE — see `truncated` below, which is
 *  the difference between "your comment is not there" and "we did not look at
 *  all of it". */
const PAGE = 100;

/* ------------------------------------------------------------------ atom */

const tag = (x, t) => (x.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "i")) || [, ""])[1];

const decode = (s) =>
  String(s ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");

const stripTags = (s) =>
  String(s ?? "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|br|li|h\d)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** Reddit wraps the author's words in its own chrome — a thumbnail table
 *  sometimes before, a `submitted by /u/… [link] [comments]` footer always
 *  after. Only what sits between its SC_OFF/SC_ON markers is the person
 *  talking. A post with no markers is a link-only post, and an empty body is
 *  the truth about it rather than a parse failure. */
const body = (content) => {
  const raw = decode(content);
  const inner = raw.match(/<!--\s*SC_OFF\s*-->([\s\S]*?)<!--\s*SC_ON\s*-->/i);
  return stripTags(decode(inner ? inner[1] : raw));
};

/**
 * One Atom entry → one thing somebody said.
 *
 * Measured on a live feed 2026-08-28, and each of these has cost somebody a day
 * at some point in this project's history:
 *   - `<id>` is Reddit's fullname: `t3_` a post, `t1_` a comment, `t5_` a
 *     SUBREDDIT. t5 carries a founding date, which is what puts an unfiltered
 *     feed out of chronological order. Dropped.
 *   - `<link href>` is an ATTRIBUTE, not element text.
 *   - `<updated>`, never `<published>` — comment entries carry no `<published>`
 *     at all, so reading that field dates every comment `null`.
 *   - a comment's `<title>` is synthesised as "/u/someone on <thread>". It is
 *     not what the person said, and must never be shown as if it were.
 */
const entry = (block) => {
  const id = decode(tag(block, "id")).trim();
  if (!/^t[13]_/.test(id)) return null;
  return {
    id,
    kind: id.startsWith("t3_") ? "post" : "comment",
    url: (block.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || null,
    author: decode(tag(tag(block, "author"), "name")).trim().replace(/^\/u\//, "") || null,
    title: decode(tag(block, "title")).trim(),
    body: body(tag(block, "content")),
    at: decode(tag(block, "updated")).trim() || null,
  };
};

export const parseFeed = (xml) => {
  const blocks = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  return blocks.map(entry).filter(Boolean);
};

/* ----------------------------------------------------------------- fetch */

/**
 * Three outcomes, never two.
 *
 * A feed that could not be read is not a feed that said nothing, and collapsing
 * those two is the single failure this project keeps re-learning: a throttled
 * or blocked source reports `0 entries` and is indistinguishable from a quiet
 * one forever. So every read returns `{ok:false, error}` or `{ok:true, ...}`,
 * and "nothing there" is only ever expressible by the second.
 *
 * Status is checked BEFORE the body, because Reddit returns valid, parseable
 * Atom with zero entries for at least three things that are not "nothing new"
 * (measured: a 404 for a subreddit that does not exist ships 550 bytes of
 * well-formed Atom). Do not "simplify" this.
 */
export async function read(url) {
  let res, text;
  try {
    res = await fetch(url, {
      headers: { "user-agent": UA, accept: "*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(25_000),
    });
    text = await res.text();
  } catch (e) {
    return { ok: false, error: e.name === "TimeoutError" ? "timeout" : `network: ${e.message}` };
  }

  if (res.status === 429) return { ok: false, error: "rate_limited", retryAfter: Number(res.headers.get("x-ratelimit-reset")) || 60 };
  if (!res.ok) return { ok: false, error: `http_${res.status}` };

  // 200 with a page of HTML is Reddit's network-security block wearing a
  // feed's clothes. A body that is not Atom is an error outcome, never "empty".
  if (!/<(entry|feed)[\s>]/i.test(text)) return { ok: false, error: "200 but not a feed — block page or interstitial" };

  // A subreddit or user that does not exist is answered by a SILENT REDIRECT to
  // a search feed, status 200, perfectly well-formed. The only thing that
  // distinguishes it is the final URL, so it is compared rather than trusted.
  const redirected = res.url && stripQuery(res.url) !== stripQuery(url);

  const entries = parseFeed(text);
  return {
    ok: true,
    entries,
    /** A feed's <subtitle> is the subreddit's SHORT public description. It is
     *  not the rules — measured, see lib/rules.mjs — but it is the only room
     *  text a logged-out reader gets, so it travels with every read. */
    subtitle: decode(tag(text.split("<entry")[0], "subtitle")).trim() || null,
    redirected,
    finalUrl: res.url || url,
    /** The read hit the page ceiling, so what it did NOT contain proves nothing. */
    truncated: entries.length >= PAGE,
  };
}

const stripQuery = (u) => String(u).split("?")[0].replace(/\/$/, "");

/* ------------------------------------------------------------------ urls */

export const userFeed = (name) => `https://www.reddit.com/user/${encodeURIComponent(name)}.rss?limit=${PAGE}`;

/** A whole conversation in one GET: the post, its comments, and the
 *  subreddit's own description in `<subtitle>`. The expensive render path was
 *  assumed for a year and this was never probed. */
export const threadFeed = (permalink) => `${trimSlash(permalink)}/.rss?limit=${PAGE}`;

/** A comment's own permalink, which Reddit answers with a view FOCUSED on that
 *  comment rather than the whole thread. That is what makes it a second,
 *  different question from the thread read — see verdict.mjs. */
export const commentFeed = (permalink) => `${trimSlash(permalink)}/.rss?limit=${PAGE}`;

const trimSlash = (u) => String(u).replace(/\/+$/, "").replace(/\.rss$/, "");

/**
 * The thread a permalink belongs to: everything up to and including
 * `/comments/<post-id>`.
 *
 * Reddit serves a permalink with no slug perfectly well, and taking the prefix
 * is the only rule that survives BOTH shapes it hands out — which it does not
 * do consistently:
 *
 *   /r/<sub>/comments/<post>/<slug>/<comment>/     the feed's form
 *   /r/<sub>/comments/<post>/comment/<comment>/    the web UI's form
 *
 * Dropping the last segment works on the first and silently produces
 * `.../comments/<post>/comment` on the second — a URL that reads as a thread,
 * is not one, and would have been checked as though it were. Found on a real
 * permalink copied out of the browser, not in a test.
 */
export function threadOf(item) {
  const u = trimSlash(item.url || "");
  if (!u) return null;
  const parts = u.split("/");
  const at = parts.indexOf("comments");
  if (at === -1 || !parts[at + 1]) return item.kind === "post" ? u : null;
  return parts.slice(0, at + 2).join("/");
}

export const subredditOf = (url) => (String(url).match(/reddit\.com\/r\/([^/]+)/i) || [, null])[1];
