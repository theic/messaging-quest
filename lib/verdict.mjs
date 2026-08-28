// What became of the thing you said.
//
// The split this file exists to keep: the reader reports OBSERVATIONS — the id
// was in the stranger's copy of the thread or it was not, the body read
// `[removed]` or it did not — and this file turns observations into a state.
// Nothing here fetches anything, so every state is reproducible from what is on
// disk, and a rule change re-runs against stored evidence instead of against
// Reddit.
//
// The competitors' failure mode is decoration: a 0–100 relevance score with
// eleven distinct values over 981 rows and a floor that never once fired. So
// this returns a word, and every word is falsifiable.

/** Reddit's tombstones. The author's own deletion and a removal by somebody
 *  else are DIFFERENT EVENTS and the feed distinguishes them, so we do too. */
const REMOVED = /^\s*\[removed\]\s*$/i;
const DELETED = /^\s*\[deleted\]\s*$/i;

export const STATES = {
  visible: "a stranger sees it, in the thread, in your words",
  removed: "present but the text is gone — somebody took it down",
  deleted: "present but the text is gone — you took it down",
  unlisted: "reachable at its own link, absent from the thread a stranger reads",
  filtered: "not in the thread a stranger reads, at all",
  gone: "the thread itself is unreachable",
  inconclusive: "we did not see enough of the thread to say",
  error: "the read failed — this is not a finding about your comment",
};

/**
 * @param item     what you said: {id, kind, url}
 * @param thread   the stranger's read of the whole conversation, from reddit.read()
 * @param focused  optional second read of the item's OWN permalink, which Reddit
 *                 answers with a view centred on that comment. Only fetched when
 *                 the thread read left the question open, because anonymously it
 *                 costs another whole minute.
 */
export function classify(item, thread, focused = null) {
  if (!thread.ok) {
    // A read that broke says nothing about your comment, and letting it look
    // like a finding is how a tool starts lying reassuringly.
    return { state: "error", why: thread.error, confident: false };
  }

  // A permalink that redirects is Reddit saying "no such thing here" in the
  // voice of a successful request.
  if (thread.redirected) return { state: "gone", why: "the permalink redirected — the thread is not there", confident: true };
  if (thread.entries.length === 0) return { state: "gone", why: "the thread read came back empty", confident: true };

  const mine = thread.entries.find((e) => e.id === item.id);
  if (mine) return bodyState(mine, "in the thread a stranger reads");

  // Absent. What that means depends entirely on whether we saw the whole thread.
  if (!thread.truncated) {
    return {
      state: "filtered",
      why: `absent from a complete read of the thread (${thread.entries.length} entries, all of it)`,
      confident: true,
    };
  }

  // The thread was longer than one page, so absence from it proves nothing yet.
  if (!focused) {
    return {
      state: "inconclusive",
      why: `the thread is longer than the ${thread.entries.length} entries we read — absence is not evidence`,
      confident: false,
    };
  }
  if (!focused.ok) return { state: "error", why: focused.error, confident: false };

  const direct = focused.entries.find((e) => e.id === item.id);
  if (!direct) {
    return {
      state: "filtered",
      why: "Reddit's own view of this comment does not contain it",
      confident: true,
    };
  }
  const b = bodyState(direct, "at its own link");
  // It renders when linked to directly but did not turn up in the thread page we
  // read. That is the shape people mean by "shadow", and it is also what a long
  // thread looks like, so it is named separately and never dressed up as proof.
  return b.state === "visible"
    ? { state: "unlisted", why: "renders at its own link; the thread was too long to confirm it is listed", confident: false }
    : b;
}

const bodyState = (e, where) => {
  if (REMOVED.test(e.body)) {
    return {
      state: "removed",
      // Reddit's Atom does not say WHO removed it. The web UI distinguishes a
      // moderator from an admin; the feed does not carry the field, and
      // inventing the difference here would be the exact move this project
      // exists to refuse.
      why: `${where}, but the body is [removed] — the feed does not say whether that was a moderator or Reddit`,
      confident: true,
    };
  }
  if (DELETED.test(e.body)) return { state: "deleted", why: `${where}, body [deleted] — that is your own deletion`, confident: true };
  return { state: "visible", why: where, confident: true };
};

/** Absence from one read is a bad day; absence from every read there has ever
 *  been is the finding. History is what this tool has that a private window
 *  does not. */
export function history(checks) {
  if (!checks.length) return { state: "unchecked", ever_visible: false, checks: 0 };
  const seen = checks.map((c) => c.state);
  return {
    state: checks[checks.length - 1].state,
    ever_visible: seen.includes("visible"),
    /** Never once rendered to a stranger, across every look we took. */
    never_visible: checks.length > 0 && !seen.includes("visible") && !seen.includes("unlisted") && seen.some((s) => s === "filtered" || s === "removed"),
    changed_at: transition(checks),
    checks: checks.length,
  };
}

/** When it stopped being visible — the moment worth showing, and the one a
 *  by-hand private-window check can never recover. */
const transition = (checks) => {
  for (let i = 1; i < checks.length; i++) {
    if (checks[i].state !== checks[i - 1].state) return { at: checks[i].at, from: checks[i - 1].state, to: checks[i].state };
  }
  return null;
};
