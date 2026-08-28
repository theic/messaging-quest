// Phase 1 — Return.
//
// "Membership is made of second and third replies, not first ones." Almost
// nobody goes back to their own comments, which is why coming back is worth a
// tool: a real back-and-forth is what Crowd Control and Contributor Quality
// Score actually reward, and it is the only version of warming that is not
// karma farming.
//
// So this answers one question — WHO IS WAITING FOR YOU — and deliberately does
// not write anything. The job here is reminding, not drafting.
//
// The mechanism is the second half of the read Phase 0 already does. A comment's
// own permalink is answered by Reddit with a view FOCUSED on that comment: the
// post, the comment, and its descendants, and nothing else. Measured
// 2026-08-28 — 5 entries and 13KB where the whole thread was 100 and 121KB.
// That is the entire reply tree for one request, which is why this costs the
// same as Phase 0 rather than double.
//
// The flat thread feed cannot do this: an Atom entry carries no parent, so a
// hundred comments in document order say nothing about who answered whom.

/** Reddit's tombstones, same as verdict.mjs — a reply whose text is gone is not
 *  somebody waiting for an answer. */
const GONE = /^\s*\[(removed|deleted)\]\s*$/i;

const newest = (rows) => rows.reduce((a, r) => (a && a > (r.at ?? "") ? a : (r.at ?? "")), "");

/**
 * What became of one thing you said, conversationally.
 *
 * @param item     your comment: {id, url}
 * @param focused  the focused read of that comment's own permalink
 * @param me       your username, lowercased by the caller's account
 */
export function conversation(item, focused, me) {
  if (!focused.ok) return { state: "error", why: focused.error };

  const subtree = focused.entries.filter((e) => e.id !== item.id && e.kind === "comment");
  const mineToo = subtree.filter((e) => (e.author ?? "").toLowerCase() === me);
  // Everything under your comment that somebody else said and that still has
  // words in it. A [removed] reply is not a person waiting.
  const theirs = subtree.filter((e) => (e.author ?? "").toLowerCase() !== me && !GONE.test(e.body));

  if (!theirs.length) return { state: "quiet", replies: 0, why: "nobody has answered it" };

  const lastTheirs = newest(theirs);
  const lastMine = newest(mineToo);

  // You have spoken since the last thing said to you, so the ball is not in
  // your court. Comparing TIMES rather than merely "did you reply at all" is
  // what makes this survive a long thread: answering once in March does not
  // settle something said yesterday.
  if (lastMine && lastMine >= lastTheirs) {
    return { state: "answered", replies: theirs.length, why: "you have replied since they last spoke", at: lastMine };
  }

  const latest = theirs.filter((e) => (e.at ?? "") === lastTheirs)[0] ?? theirs[theirs.length - 1];
  return {
    state: "waiting",
    replies: theirs.length,
    /** The newest thing said to you that you have not answered. The FIRST reply
     *  is what an outreach tool wants; the LAST one is what a conversation
     *  wants, because it is the thing still hanging. */
    latest: { author: latest.author, text: latest.body, at: latest.at, url: latest.url },
    since_you: Boolean(lastMine),
    at: lastTheirs,
  };
}

/** Oldest-waiting first: the one most likely to go cold is the one to answer,
 *  and a queue sorted newest-first quietly buries it. */
export const byUrgency = (rows) => rows.slice().sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
