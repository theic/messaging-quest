// Reddit's pages, read the way a person reads them: in a real tab of the
// operator's own Chrome, rendered, and then asked for the rows on it.
//
// This file replaced feed.mjs on 2026-09-04, when the anonymous RSS transport
// (one request a minute, a throttle under review, a 403 on every .json path)
// and the background fetch lane were retired for one mechanism: the human
// browser (lib/browse.mjs, the operator's rule). Nothing here fetches. What it
// holds instead is what a PAGE looks like — which elements carry a post, a
// comment, an author, a date — as declarative specs the extension's read_dom
// executes in the page's isolated world. The engine never sees a DOM; the
// extension never runs platform code. The seam is a selector and a field map.
//
// Two seats, same specs:
//   * the operator's session — finding reads (searches, listings, a post's
//     body). What a signed-in person sees.
//   * the STRANGER's — sync/check/back, in an Incognito tab the extension
//     opens only once the operator allowed it there. Reddit shows an author
//     their own shadow-removed comment as if nothing happened, so what
//     became of a comment is only measurable logged out.
//
// Every shape below carries the date it was read off the live site. A shape
// Reddit changes is a read that comes back empty — and an empty read is an
// error here (`rows: 0` on a page that plainly has posts), never "nothing
// new": three outcomes, always.

const ROOT = "https://www.reddit.com";

/* ------------------------------------------------------------------ urls */

export const userPage = (name) => `${ROOT}/user/${encodeURIComponent(name)}/comments/`;
export const threadPage = (permalink) => `${trimSlash(permalink)}/`;
/** A comment's own permalink, which Reddit answers with a view FOCUSED on
 *  that comment and its replies rather than the whole thread. That is what
 *  makes it a second, different question from the thread read — see
 *  lib/verdict.mjs and lib/conversation.mjs. */
export const commentPage = (permalink) => `${trimSlash(permalink)}/`;

const trimSlash = (u) => String(u).replace(/\/+$/, "").replace(/\.rss$/, "");

/**
 * The thread a permalink belongs to: everything up to and including
 * `/comments/<post-id>`. Reddit serves a permalink with no slug perfectly
 * well, and taking the prefix is the only rule that survives BOTH shapes it
 * hands out (`…/comments/<post>/<slug>/<comment>/` and
 * `…/comments/<post>/comment/<comment>/`).
 */
export function threadOf(item) {
  const u = trimSlash(item.url || "");
  if (!u) return null;
  const parts = u.split("/");
  const at = parts.indexOf("comments");
  if (at === -1 || !parts[at + 1]) return item.kind === "post" ? u : null;
  return parts.slice(0, at + 2).join("/");
}

export const subredditOf = (url) => (String(url).match(/reddit\.com\/r\/([^/?#]+)/i) || [, null])[1];

/** The page a legacy feed URL stands for: `/search/.rss?q=…&limit=100`
 *  → `/search/?q=…`, `/new/.rss` → `/new/`. A URL that is already a page
 *  comes back unchanged. */
export const pageOf = (url) => String(url ?? "")
  .replace(/\/\.rss(?=\?|$)/i, "/")
  .replace(/([?&])limit=\d+(&|$)/i, "$1")
  .replace(/[?&]$/, "");
export const postIdOf = (url) => { const m = /\/comments\/([a-z0-9]+)/i.exec(String(url ?? "")); return m ? `t3_${m[1]}` : null; };

/**
 * What a permalink names — {id, kind} — or null when it is not one of
 * Reddit's. `.../comments/<post>/<slug>/<comment>/` and the web UI's
 * `.../comments/<post>/comment/<comment>/` both name a comment; a trailing
 * segment that is neither the post id nor the slug is the comment id.
 * Getting this wrong checks the wrong thing and reports confidently about it.
 */
export function itemOf(url) {
  const u = String(url ?? "").split("?")[0].replace(/\/+$/, "");
  if (!/^https?:\/\/(www\.|old\.)?reddit\.com\/r\/[^/]+\/comments\//i.test(u)) return null;
  const parts = u.split("/");
  const at = parts.indexOf("comments");
  const post = parts[at + 1];
  if (!post) return null;
  const tail = parts[parts.length - 1];
  const isComment = tail !== post && at + 2 < parts.length - 1;
  return isComment ? { id: `t1_${tail}`, kind: "comment" } : { id: `t3_${post}`, kind: "post" };
}

/** What kind of page a URL is, so one read knows which spec to ask for. */
export function kindOf(url) {
  const u = String(url ?? "");
  if (/\/user\/[^/]+\/comments\/?/i.test(u)) return "profile";
  if (/\/comments\/[a-z0-9]+\/[^/]+\/(?:comment\/)?[a-z0-9]+\/?(\?|$)/i.test(u)) return "comment";
  if (/\/comments\/[a-z0-9]+/i.test(u)) return "thread";
  if (/\/search\/?\?/i.test(u)) return "search";
  return "listing";
}

/* ----------------------------------------------------------------- specs */

/**
 * read_dom specs. `items` is a selector (querySelectorAll, through shadow
 * roots); each field is `attr:<name>` (an attribute on the item),
 * `text:<selector>` (the trimmed text of the first matching descendant),
 * `href:<selector>` (its href, absolute), `text` (the item's own text),
 * `attr:<name>@<selector>` (an attribute on a descendant); `a|b` takes
 * the first that answers.
 *
 * MEASURED on www.reddit.com 2026-09-04, signed in, through the lane
 * (scratch inspector; the numbers are a Thursday evening's):
 *   /r/<sub>/new/        28 <shreddit-post> on the first screen, attributes
 *                        id (t3_…), post-title, author, permalink,
 *                        created-timestamp, comment-count, score, post-type,
 *                        subreddit-prefixed-name; a text post's body slotted
 *                        in as [slot=text-body], a link post's null.
 *   /r/<sub>/search/?q=  7 <div data-testid="search-post-unit"> for the
 *                        phrase: a title link a[data-testid=post-title] to
 *                        /comments/, a <time datetime>, NO author, NO body —
 *                        so a search read is followed by a read of each new
 *                        post's own page.
 *   /r/<sub>/comments/…  the post as <shreddit-post> with the full body;
 *                        comments as <shreddit-comment> (thingid, author,
 *                        depth, permalink, postid, score; body in
 *                        [slot=comment]; <time datetime> inside), 94 of a
 *                        296-comment thread rendered on the first screen —
 *                        <shreddit-comment-tree totalcomments> says how many
 *                        there are. Comments load a beat after the post.
 *   /user/<name>/comments/  <shreddit-profile-comment>, one per comment:
 *                        comment-id (t1_…), href (the comment's permalink,
 *                        with ?context=3), the body in div.md, a <time
 *                        datetime>; the author is the profile's.
 *   the room's blurb     <shreddit-subreddit-header description="…">.
 * A page Chrome is not drawing renders the header and nothing else — the
 * extension fronts the tab before every read for that reason.
 */
export const SPECS = {
  listing: {
    items: "shreddit-post",
    limit: 100,
    fields: { id: "attr:id", title: "attr:post-title", author: "attr:author", permalink: "attr:permalink", at: "attr:created-timestamp", comments: "attr:comment-count", score: "attr:score", type: "attr:post-type", body: "text:[slot=text-body]", sub: "attr:subreddit-prefixed-name" },
  },
  search: {
    items: "[data-testid='search-post-unit']",
    limit: 100,
    fields: { href: "href:a[data-testid='post-title']|href:a[href*='/comments/']", title: "text:a[data-testid='post-title']|text:a[href*='/comments/']", at: "attr:datetime@time|attr:ts@faceplate-timeago", author: "text:a[href^='/user/']" },
  },
  post: {
    items: "shreddit-post",
    limit: 1,
    fields: { id: "attr:id", title: "attr:post-title", author: "attr:author", permalink: "attr:permalink", at: "attr:created-timestamp", comments: "attr:comment-count", score: "attr:score", type: "attr:post-type", body: "text:[slot=text-body]", sub: "attr:subreddit-prefixed-name" },
  },
  comments: {
    items: "shreddit-comment",
    limit: 400,
    fields: { id: "attr:thingid", author: "attr:author", depth: "attr:depth", permalink: "attr:permalink", postid: "attr:postid", at: "attr:datetime@time|attr:ts@faceplate-timeago", body: "text:[slot=comment]", score: "attr:score" },
  },
  /** A profile's comments page. The author is the profile's own name, read
   *  off the page's bold link when it is there and off the account when not. */
  profile: {
    items: "shreddit-profile-comment",
    limit: 100,
    fields: { id: "attr:comment-id", permalink: "attr:href|href:a[href*='/comment/']", body: "text:div.md|text:p", at: "attr:datetime@time|attr:ts@faceplate-timeago", author: "text:a.font-bold|text:a[href^='/user/']" },
  },
  /** How many comments the thread has, whatever number of them rendered. */
  tree: { items: "shreddit-comment-tree", limit: 1, fields: { total: "attr:totalcomments" } },
  /** The subreddit's own short description — the free check for a blunt
   *  "no self-promotion" (lib/rules.mjs). */
  about: {
    items: "shreddit-subreddit-header",
    limit: 1,
    fields: { description: "attr:description", text: "text" },
  },
  /** The page's own signals that this is not the page asked for. */
  wall: {
    items: "shreddit-blocking-modal, [data-testid='login-modal'], form[action*='login'], h1",
    limit: 3,
    fields: { tag: "tag", text: "text" },
  },
};

/* --------------------------------------------------------------- entries */

const abs = (u) => { const s = String(u ?? "").trim(); if (!s) return null; try { return new URL(s, ROOT).href.split("?")[0]; } catch { return null; } };
const clean = (s) => String(s ?? "").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
const isoOf = (s) => { const d = Date.parse(String(s ?? "")); return Number.isFinite(d) ? new Date(d).toISOString() : null; };

/** Rows off a listing or a post page → the store's entries. A post's body
 *  on a listing is Reddit's preview (the first lines); the full text comes
 *  from the post page. */
export function postEntries(rows) {
  const out = [];
  for (const r of rows ?? []) {
    const id = /^t3_[a-z0-9]+$/i.test(String(r.id ?? "")) ? String(r.id) : postIdOf(r.permalink);
    const url = abs(r.permalink);
    if (!id || !url) continue;
    out.push({
      id, kind: "post", url,
      author: r.author ? String(r.author).replace(/^u\//, "").trim() || null : null,
      title: clean(r.title ?? ""),
      body: clean(r.body ?? ""),
      at: isoOf(r.at),
      comments: Number(r.comments) || 0, score: Number(r.score) || 0, type: r.type ?? null,
    });
  }
  return out;
}

/** Rows off a search page: a title and a link, no author, no body — enough
 *  to know WHICH posts are new; the post page fills the rest. */
export function searchEntries(rows) {
  const out = [];
  for (const r of rows ?? []) {
    const url = abs(r.href);
    const id = postIdOf(url);
    if (!id) continue;
    if (out.some((e) => e.id === id)) continue;
    out.push({ id, kind: "post", url, author: r.author ? String(r.author).replace(/^u\//, "").trim() || null : null, title: clean(r.title ?? ""), body: "", at: isoOf(r.at), preview: true });
  }
  return out;
}

/** Rows off a thread or profile page → comment entries. */
export function commentEntries(rows) {
  const out = [];
  for (const r of rows ?? []) {
    const id = /^t1_[a-z0-9]+$/i.test(String(r.id ?? "")) ? String(r.id) : null;
    if (!id) continue;
    out.push({
      id, kind: "comment", url: abs(r.permalink),
      author: r.author ? String(r.author).replace(/^u\//, "").trim() || null : null,
      title: "", body: clean(r.body ?? ""), at: isoOf(r.at), depth: Number(r.depth) || 0, postid: r.postid ?? null,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ read */

/**
 * Three outcomes, never two: `{ok:false, error}` or `{ok:true, entries, …}`.
 * A page that could not be read is not a page that said nothing, and
 * collapsing those two is the single failure this project keeps
 * re-learning. So: the tab must reach the URL asked for (a subreddit that
 * does not exist is a silent redirect to a search page — only the final URL
 * gives it away); a wall (login, block, "you've been blocked") is an error
 * with its words; and a page whose rows come back empty while its text
 * plainly lists posts is an error too ("the page shape changed").
 */
export async function readPage(rawUrl, browse, opts = {}) {
  // A source watched before 0.6.0 carries the feed's URL; the page it
  // stands for is what a person opens. Normalised here, once, so the
  // stored row need not be rewritten and nothing above the skill knows
  // Reddit ever had feeds.
  const url = pageOf(rawUrl);
  const kind = opts.kind ?? kindOf(url);
  const opened = browse.lease ? await browse.goto(url) : await browse.open(url);
  if (opened.error) return { ok: false, error: opened.error };
  const here = await browse.where();
  const finalUrl = here.url ?? opened.url ?? url;
  const redirected = stripQuery(finalUrl) !== stripQuery(url) && !sameThread(finalUrl, url);
  const walls = await browse.extract(SPECS.wall);
  const wall = (walls.rows ?? []).find((w) => /log in|sign up to continue|you've been blocked|blocked|verify you are human|something went wrong|private community|quarantined/i.test(String(w.text ?? "")) && !/^h1$/i.test(String(w.tag ?? "")) );
  if (wall) return { ok: false, error: `a wall: “${String(wall.text).replace(/\s+/g, " ").slice(0, 80)}” — deal with it in the tab and read again`, finalUrl };

  const spec = kind === "search" ? SPECS.search : kind === "listing" ? SPECS.listing : kind === "profile" ? SPECS.profile : kind === "post" ? SPECS.post : null;
  if (kind === "thread" || kind === "comment") {
    const post = await browse.extract(SPECS.post);
    let comments = await browse.extract(SPECS.comments);
    if (post.error || comments.error) return { ok: false, error: post.error ?? comments.error, finalUrl };
    const [p] = postEntries(post.rows);
    // The comments load a beat after the post (measured: a 1-comment thread
    // read 0 comments on the first pass). One more look, a person's pause
    // later, before "no comments" is believed.
    if ((Number(post.rows?.[0]?.comments) || 0) > 0 && !(comments.rows ?? []).length) {
      await browse.scroll(2);
      comments = await browse.extract(SPECS.comments);
      if (comments.error) return { ok: false, error: comments.error, finalUrl };
    }
    const cs = commentEntries(comments.rows);
    const tree = await browse.extract(SPECS.tree);
    const total = Number(tree.rows?.[0]?.total) || Number(post.rows?.[0]?.comments) || cs.length;
    return { ok: true, entries: [...(p ? [p] : []), ...cs], redirected, finalUrl, truncated: total > cs.length, total, subtitle: null };
  }
  const got = await browse.extract(spec);
  if (got.error) return { ok: false, error: got.error, finalUrl };
  const entries = kind === "search" ? searchEntries(got.rows) : kind === "profile" ? commentEntries(got.rows) : postEntries(got.rows);
  if (kind === "profile" && !entries.length) {
    // A profile that does not render at all is the loudest finding the
    // listener has (bin/mq.mjs notFound): Reddit says so in words on the page.
    const text = await browse.text(3000);
    if (/nobody on reddit goes by that name|page not found|this account has been suspended|user has deleted their account/i.test(text.text ?? "")) return { ok: false, error: "http_404", finalUrl };
  }
  if (!entries.length && got.total === 0) {
    // Nothing matched the spec. Either the page is genuinely empty (a search
    // with no results says so in words) or the shape changed; ask the text.
    const text = await browse.text(4000);
    const empty = /no results|nothing here|hmm\.\.\.|doesn.t have any|no posts yet|has no comments|be the first/i.test(text.text ?? "");
    if (!empty && /comments\/|r\//.test(text.text ?? "")) return { ok: false, error: "the page shape changed — the rows this skill knows (skills/reddit/pages.mjs) did not match a page that plainly has posts. Measure the new shape and update the spec.", finalUrl };
  }
  const about = kind === "listing" || kind === "search" ? await browse.extract(SPECS.about) : { rows: [] };
  const subtitle = clean(about.rows?.[0]?.description ?? "") || null;
  return { ok: true, entries, redirected, finalUrl, truncated: entries.length >= (kind === "search" ? 25 : 25), subtitle };
}

const stripQuery = (u) => String(u ?? "").split("?")[0].replace(/\/$/, "").replace(/^https?:\/\/(www\.|old\.)?/i, "").toLowerCase();
const sameThread = (a, b) => { const pa = postIdOf(a), pb = postIdOf(b); return Boolean(pa && pa === pb); };

/** How many posts a finding read may open for their bodies, per page read.
 *  A person opens the ones that look like them, not the whole page. */
export const BODIES_PER_READ = 8;
