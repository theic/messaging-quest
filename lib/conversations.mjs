// Conversations — what happens AFTER the opener is posted (0.7.0).
//
// The opener was the whole product until now: find a person, judge, draft,
// post, retire the author. But membership is made of second and third
// replies (lib/conversation.mjs), and a reply that goes cold costs more than
// a missed post. So a conversation is a row of its own, opened the moment
// the operator says "I posted it", bound to their own comment when `sync`
// reads their profile, and updated by the return pass (`mq back`, or the
// return half of `mq tick`) from the stranger's seat.
//
// One row per person (the found item's id), append-only, last write wins —
// the same shape as verdicts. The turns are the exchange as this machine
// knows it: what the operator posted (as they edited it, not as the writer
// drafted it), and what came back.
//
//   state: sent      posted, not yet found on the profile
//          quiet     bound; nobody has answered
//          waiting   somebody answered and the ball is in the operator's court
//          answered  the operator replied since they last spoke
//          closed    the operator let it go ("not this one" on the turn card)

const GONE = /^\s*\[(removed|deleted)\]\s*$/i;

/** Every conversation, last row per person. */
export const conversationRows = (S) => S.lastById("conversations.jsonl");

/** Open one: the operator posted. `text` is what they actually posted — the
 *  card's field as edited, not the draft — so the campaign's "already said"
 *  memory and the repeat guard hold what went up. */
export function openConversation(S, it, { text = "", at = new Date().toISOString(), via = "panel", style = null } = {}) {
  const row = {
    id: it.id, url: it.url, place: it.place ?? null, author: it.author ?? null,
    ...(it.campaign ? { campaign: it.campaign } : {}),
    opened_at: at, comment_id: null, state: "sent", checked_at: null, latest: null,
    // `style` (0.8.0): which of the three drafts went up — the tab they
    // pressed from — so what people actually choose is on the ledger.
    turns: [{ by: "you", text: String(text ?? "").slice(0, 4000), at, via, ...(style ? { style } : {}) }],
  };
  S.append("conversations.jsonl", row);
  return row;
}

/**
 * Bind open conversations to the operator's own comments, once `sync` has
 * read them: the comment in the same thread, written at or after the
 * opener was posted (an hour of slack for clocks and for "I posted it"
 * pressed late). Returns how many were bound.
 */
export function bindConversations(S, { threadOf, now = Date.now() } = {}) {
  const rows = conversationRows(S);
  const items = [...S.items().values()].filter((i) => i.kind === "comment");
  let bound = 0;
  for (const c of rows.values()) {
    if (c.comment_id || c.state === "closed") continue;
    const thread = threadOf?.({ url: c.url }) ?? null;
    if (!thread) continue;
    const opened = Date.parse(c.opened_at) - 3600_000;
    const mine = items
      .filter((i) => threadOf({ url: i.url }) === thread && (!i.at || Date.parse(i.at) >= opened))
      .sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")));
    if (!mine.length) continue;
    S.append("conversations.jsonl", { ...c, comment_id: mine[0].id, comment_url: mine[0].url, state: c.state === "sent" ? "quiet" : c.state, bound_at: new Date(now).toISOString() });
    bound++;
  }
  return bound;
}

/**
 * Fold one return read into a conversation. `c` is lib/conversation.mjs's
 * answer for the bound comment. Returns { row, fresh } — fresh when a reply
 * this machine had not seen is now waiting, which is the one thing worth an
 * inbox event.
 */
export function recordReturn(S, conv, c, { at = new Date().toISOString() } = {}) {
  if (!c || c.state === "error") {
    const row = { ...conv, checked_at: at, last_error: c?.why ?? "read failed" };
    S.append("conversations.jsonl", row);
    return { row, fresh: false };
  }
  const turns = [...(conv.turns ?? [])];
  let fresh = false;
  if (c.state === "waiting" && c.latest && !GONE.test(c.latest.text ?? "")) {
    const key = c.latest.url || `${c.latest.author}@${c.latest.at}`;
    const seen = turns.some((t) => t.by === "them" && (t.url || `${t.author}@${t.at}`) === key);
    if (!seen) {
      turns.push({ by: "them", author: c.latest.author ?? null, text: String(c.latest.text ?? "").slice(0, 4000), at: c.latest.at ?? at, url: c.latest.url ?? null });
      fresh = true;
    }
  }
  const state = c.state === "waiting" ? "waiting" : c.state === "answered" ? "answered" : "quiet";
  const row = { ...conv, turns, state, checked_at: at, replies: c.replies ?? 0, latest: c.state === "waiting" ? c.latest : conv.latest, last_error: null };
  S.append("conversations.jsonl", row);
  return { row, fresh };
}

/** The operator answered a turn (the turn card's "I posted it"). */
export function recordTurn(S, conv, { text = "", at = new Date().toISOString(), via = "panel", style = null } = {}) {
  const row = { ...conv, turns: [...(conv.turns ?? []), { by: "you", text: String(text ?? "").slice(0, 4000), at, via, ...(style ? { style } : {}) }], state: "answered", answered_at: at };
  S.append("conversations.jsonl", row);
  return row;
}

export function closeConversation(S, conv, { at = new Date().toISOString() } = {}) {
  const row = { ...conv, state: "closed", closed_at: at };
  S.append("conversations.jsonl", row);
  return row;
}

/** Who is waiting on the operator, oldest first — that is the one going cold. */
export const waiting = (S) =>
  [...conversationRows(S).values()]
    .filter((c) => c.state === "waiting")
    .sort((a, b) => String(a.latest?.at ?? a.checked_at ?? "").localeCompare(String(b.latest?.at ?? b.checked_at ?? "")));

/** How many turns the operator has taken; the next draft is turn n+1. */
export const yourTurns = (conv) => (conv?.turns ?? []).filter((t) => t.by === "you").length;

/**
 * Which conversations the return pass should read now: open, bound, from
 * the last `days`, and not looked at for `everyMs`. A conversation nobody
 * has answered in two weeks is not one the operator can still walk back
 * into, and reading for it costs the same page as one they can.
 */
export function dueConversations(S, { days = 14, everyMs = 12 * 3600_000, now = Date.now() } = {}) {
  const cutoff = now - days * 864e5;
  return [...conversationRows(S).values()].filter((c) => {
    if (!c.comment_id || c.state === "closed") return false;
    if (Date.parse(c.opened_at) < cutoff) return false;
    return !c.checked_at || now - Date.parse(c.checked_at) >= everyMs;
  });
}

/** Open conversations that `sync` has not bound yet — the reason to read
 *  the profile again. */
export const unbound = (S) => [...conversationRows(S).values()].filter((c) => !c.comment_id && c.state === "sent");

/* --------------------------------------------------------------- numbers */

const median = (xs) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/**
 * Per campaign, the numbers the specialist and the Campaigns page read —
 * counted from the store, never tallied by a model: found, judged, fit,
 * sent, replies, second turns, waiting, and CROWDING (the median comment
 * count posts had when found — a dozen replies in the first hours is the
 * signal that a room's question has been discovered by everybody's bots).
 * "—" (null campaign) is everything found under no campaign.
 */
export function campaignDigest(S, campaigns = []) {
  const found = [...S.found().values()];
  const verdicts = S.verdicts();
  const marks = S.marks();
  const convs = [...conversationRows(S).values()];
  const ids = [...new Set([...campaigns.map((c) => c.id), ...found.map((f) => f.campaign ?? null)])];
  const out = [];
  for (const id of ids) {
    const rows = found.filter((f) => (f.campaign ?? null) === id);
    const judged = rows.filter((f) => verdicts.has(f.id));
    const fit = judged.filter((f) => verdicts.get(f.id).fit);
    const sent = rows.filter((f) => marks.get(f.id)?.mark === "sent");
    const cs = convs.filter((c) => (c.campaign ?? null) === id);
    const replies = cs.filter((c) => (c.turns ?? []).some((t) => t.by === "them"));
    const second = cs.filter((c) => yourTurns(c) >= 2);
    const c = campaigns.find((k) => k.id === id) ?? null;
    out.push({
      id, name: c?.name ?? (id ?? "no campaign"), status: c?.status ?? (id ? "gone" : null),
      found: rows.length, judged: judged.length, fit: fit.length,
      fitRate: judged.length ? fit.length / judged.length : null,
      sent: sent.length, replies: replies.length, second: second.length,
      waiting: cs.filter((k) => k.state === "waiting").length,
      crowd: median(rows.map((f) => Number(f.comments))),
      last_found: rows.map((f) => f.seen_at ?? "").sort().pop() || null,
    });
  }
  return out.sort((a, b) => (a.id === null) - (b.id === null) || String(a.name).localeCompare(String(b.name)));
}

const pctOf = (x) => (x == null ? "—" : `${Math.round(x * 100)}%`);

/** The digest as lines a person or the specialist reads. */
export function digestText(rows) {
  if (!rows.length) return "nothing found under any campaign yet";
  return rows.map((r) =>
    `- ${r.name}${r.id ? ` (${r.id}, ${r.status})` : ""}: ${r.found} found, ${r.judged} judged, ${r.fit} fit (${pctOf(r.fitRate)}), ${r.sent} sent, ${r.replies} replied, ${r.second} reached a second turn, ${r.waiting} waiting on you${r.crowd != null ? `, crowding ${r.crowd} comments a post when found` : ""}`,
  ).join("\n");
}
