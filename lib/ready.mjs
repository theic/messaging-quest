// Phase 4 — the gate. Where you stand in a room, and what this refuses to
// promise you.
//
// §07: "Readiness per room and your promotion mix, both shown, neither preachy,
// and you can always post anyway."
//
// ## The thing this must never do
//
// The 1:5 self-promotion ratio is folklore. Reddit's own words: promotional
// content "is not inherently considered to be spam"; SOME communities abide by
// a 10% rule; and, verbatim, "It is ultimately up to you and your team to
// decide what works best for your community." There is no sitewide ratio. A
// person can hit a perfect 1:5 and still be filtered.
//
// So the mix is displayed as a mirror and never sold as a rule, and the
// readiness verdict is built from things that mechanically exist — Crowd
// Control filters non-members, that is documented behaviour — rather than from
// a number somebody made up.
//
// ## And it is a countdown over signals, not days
//
// A competitor ships this as a fixed seven-day timer with a badge reading
// "Browse only, 6 days left". The pattern is worth taking wholesale; the timer
// is not. A timer is not a safety check — waiting seven days in a room you have
// never spoken in leaves you exactly as filterable as you were on day one.

import { roomOf } from "./platform.mjs";

/** §02, stated: refuse a third reply in one subreddit inside 24h, and a sixth
 *  overall. The measured shape that cost the operator their visibility was
 *  eleven replies in 83.9 minutes across seven subreddits with no history. */
export const PER_ROOM_24H = 2;
export const OVERALL_24H = 5;
const DAY = 864e5;

/* --------------------------------------------------------------- standing */

/**
 * What you have actually said in each room, and whether a stranger saw it.
 *
 * The second half is the part no competitor can do, because it needs Phase 0:
 * fourteen comments in a room you are being filtered out of is not standing,
 * it is fourteen invisible comments. A count alone would report it as ready.
 */
export function standing(items, checks, at = Date.now()) {
  const rooms = new Map();
  for (const it of items) {
    if (it.kind !== "comment") continue;
    const place = roomOf(it.url);
    if (!place) continue;
    const r = rooms.get(place) ?? { place, comments: 0, visible: 0, unseen: 0, unchecked: 0, first: null, last: null };
    r.comments++;
    const state = (checks.get(it.id) ?? []).at(-1)?.state ?? null;
    if (state === "visible" || state === "unlisted") r.visible++;
    else if (state === "filtered" || state === "removed") r.unseen++;
    else r.unchecked++;
    const when = it.at ?? it.seen_at ?? null;
    if (when) {
      if (!r.first || when < r.first) r.first = when;
      if (!r.last || when > r.last) r.last = when;
    }
    rooms.set(place, r);
  }
  for (const r of rooms.values()) {
    r.span_days = r.first && r.last ? Math.round((Date.parse(r.last) - Date.parse(r.first)) / DAY) : 0;
    r.quiet_days = r.last ? Math.round((at - Date.parse(r.last)) / DAY) : null;
  }
  return rooms;
}

/**
 * Ready, thin, or not — and always with the mechanical reason.
 *
 * No invented threshold. Reddit does not publish what Crowd Control's tiers
 * actually require, so this refuses to pretend a number exists: it reports the
 * one documented mechanic (the maximum tier filters people with no history in
 * the room), the one thing only this tool knows (whether your comments there
 * are visible), and the count, plainly, as a count.
 */
export function readiness(r, rules) {
  if (rules?.state === "banned") return { state: "not ready", why: "this room's rules forbid it — that is not a warm-up problem" };
  if (!r || r.comments === 0)
    return { state: "not ready", why: "no comments here at all. Crowd Control's maximum tier filters exactly this, by definition" };
  if (r.unseen > 0 && r.visible === 0)
    return { state: "not ready", why: `all ${r.unseen} of your comments here are invisible to strangers. More of them will not help` };
  if (r.visible === 0 && r.unchecked > 0)
    return { state: "unknown", why: `${r.unchecked} comments here, none checked yet — run \`es check\` before trusting this` };
  if (r.visible < 3)
    return { state: "thin", why: `${r.visible} visible comment${r.visible === 1 ? "" : "s"} here. You are a member, which is what Crowd Control tests, but membership is made of second and third replies` };
  return { state: "ready", why: `${r.visible} visible comments over ${r.span_days} day${r.span_days === 1 ? "" : "s"}` };
}

/* -------------------------------------------------------------- the burst */

/**
 * Whether posting one more right now is the shape Reddit names as spam.
 *
 * Returns a refusal or null. It is always overridable — you are the one
 * posting, and a tool that cannot be overruled just gets worked around.
 */
export function burst(sentAt, place, at = Date.now()) {
  const recent = sentAt.filter((s) => at - Date.parse(s.at) < DAY);
  const here = recent.filter((s) => s.place === place);
  if (here.length >= PER_ROOM_24H)
    return { why: `${here.length} already in r/${place} today. A third inside 24 hours is the burst shape`, count: here.length, scope: "room" };
  if (recent.length >= OVERALL_24H)
    return { why: `${recent.length} replies across all rooms today. A sixth is the burst shape`, count: recent.length, scope: "all" };
  return null;
}

/* ---------------------------------------------------------------- the mix */

/**
 * Ordinary comments against replies you sent off the back of the queue.
 *
 * Shown, never enforced. The ratio is a useful mirror and a dishonest promise:
 * selling "keep it under 1:5 and you are safe" is a checkable false claim, and
 * the person who hits it and gets filtered anyway will know exactly who told
 * them it would work.
 */
export function mix(commentsSeen, sentCount) {
  const outreach = sentCount;
  // APPROXIMATE, and labelled as such wherever it is printed. The two numbers
  // come from different places: comments are whatever your profile feed
  // returned, and outreach is what you logged. A reply you sent an hour ago is
  // in the second and not yet in the first, so the subtraction is a reasonable
  // estimate and not an accounting.
  const ordinary = Math.max(0, commentsSeen - outreach);
  return {
    seen: commentsSeen,
    ordinary,
    outreach,
    ratio: outreach === 0 ? null : ordinary / outreach,
    note: "Reddit enforces no sitewide ratio. Its own words: promotional content \"is not inherently considered to be spam\", and it is \"ultimately up to you and your team to decide what works best for your community.\" This is a mirror, not a threshold, and it is approximate: it counts the comments your profile returned against the replies you logged.",
  };
}

/** What Contributor Quality Score is made of, and why nothing here scores it.
 *  §02: surface it, you cannot manage it directly. */
export const CQS_NOTE =
  "Contributor Quality Score is account age, email verification and network signals. It is not readable from any keyless surface, and nothing here estimates it — a number invented for it would be decoration.";
