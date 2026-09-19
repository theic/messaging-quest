// A customer's side of the engine, as functions of a directory (Stage 2 of
// the Quest plan, 2026-09-19).
//
// These were closures inside lib/engine.mjs — the offer card, "Looks right",
// the buttons on an opportunity, an instruction applied before Quest reads the
// message, the next card to deliver. Two things run them now: the operator's
// `mq serve` (engine.mjs, on its ten-second clock) and the quest Edge Function
// (lib/cloud.mjs, once per wake-up), so they live here, where neither owns
// them. What differs between the two is handed in: `room` turns a bare name
// into what the platform's people write ("r/saas"), `tell` hears what the
// operator's CMO would want to know (the cloud has no CMO and hands a no-op),
// `mark` runs the `mark` verb, `interpret` reads an instruction with a model.
//
// Zero-dependency, like the rest of the heart.

import { readStash, patchStash } from "./cards.mjs";
import { readOne, writeMemory } from "./memory.mjs";
import { writeCampaign } from "./campaigns.mjs";
import { customerOf, hostOf as siteHost, say, heard, setCard, chatState, messageOf, isCustomer } from "./chat.mjs";
import { offerFrom, offerCard, saysNothing, list, filesOf, campaignOf, meOf, lookOf, isFresh, instructionFrom, opportunityText, FIRST_LOOK } from "./quest.mjs";
import { applyRevision } from "./revise.mjs";
import { results } from "./guards.mjs";
import { PER_ROOM_24H, OVERALL_24H } from "./ready.mjs";

const noop = () => {};
const DAY = 24 * 3600_000;

/** The people waiting for an answer: every fit verdict not yet sent or
 *  skipped, whose author was never answered before, newest first. */
export function queueOf(S) {
  const v = S.verdicts(), marks = S.marks(), all = S.found(), gone = S.contacted();
  const rows = [];
  for (const [id, ver] of v) {
    if (!ver.fit) continue;
    const m = marks.get(id);
    if (m && m.mark !== "undo") continue;          // sent or skipped, and not undone
    const it = all.get(id);
    if (!it) continue;
    if (it.author && gone.has(it.author.toLowerCase())) continue;
    rows.push({ ...it, why: ver.why });
  }
  return rows.sort((a, b) => String(b.posted_at ?? b.seen_at).localeCompare(String(a.posted_at ?? a.seen_at)));
}

/* ------------------------------------------------------------- the offer */

/** The reader's proposal, as the card a customer answers. */
export function postOffer(dir, proposal, { room = (p) => p, tell = noop } = {}) {
  const offer = offerFrom(proposal);
  if (saysNothing(offer)) {
    // Read, and nothing in it: the customer is asked, once, and nothing is
    // read again by itself — their answer (describe_offer) is the next read.
    const c = customerOf(dir) ?? {};
    const what = c.url ? siteHost(c.url) ?? c.url : c.cv ? "your CV" : "that";
    patchStash(dir, { scoutJob: null, site_job: null, scout_empty: true });
    return say(dir, `I read ${what}, but it doesn't say yet what you sell. Tell me in a sentence or two what it is and who buys it, and I'll take it from there.`);
  }
  const msg = say(dir, offerCard(offer, { room }));
  patchStash(dir, { offer: { ...offer, state: "open", card: msg.id, at: new Date().toISOString() } });
  tell({ type: "offer.proposed", title: offer.one_line });
  return msg;
}

/** "Looks right": the offer becomes the three files the judge and the
 *  writer already read, and the card says so. */
export function confirmOffer(dir, { room = (p) => p, tell = noop } = {}) {
  const offer = readStash(dir).offer;
  if (!offer) return { error: "there is nothing to confirm yet" };
  if (offer.state === "confirmed") return { ok: true, already: true };
  for (const [file, body] of Object.entries(filesOf(offer))) writeMemory(dir, file, body);
  // What a reply may say about them — that they built it — unless they
  // have written their own; and the one campaign their finds are made
  // under, which is what lets a first reply name it, disclosed.
  if (!readOne(dir, "me.md")?.filled) writeMemory(dir, "me.md", meOf(offer));
  writeCampaign(dir, campaignOf(offer));
  patchStash(dir, {
    offer: { ...offer, state: "confirmed", confirmed_at: new Date().toISOString() },
    look: lookOf(offer.places.slice(0, FIRST_LOOK), offer.searches ?? []),
  });
  setCard(dir, offer.card, { state: "confirmed" });
  const where = offer.places.slice(0, FIRST_LOOK).map(room);
  say(dir, `Good. I'll start with ${list(where) || "the communities where this comes up"} and bring you the people I find, here, as I find them. The first look takes some minutes.`);
  tell({ type: "offer.confirmed", title: offer.one_line, places: offer.places });
  return { ok: true };
}

/* --------------------------------------------------------- the buttons */

/** The buttons on an opportunity. Each is a fact worth keeping — the
 *  feedback the plan calls the moat: was it relevant, did they open it,
 *  did they reply. The last two also reach the store the way the
 *  operator's own replies do: a 👎 skips the post, "I replied" marks it
 *  sent and retires the author from every future queue. */
export async function actOpportunity(dir, m, action, body = {}, { mark = async () => {}, tell = noop } = {}) {
  const at = new Date().toISOString();
  const item = m.card.item;
  const told = (type) => tell({ type, title: m.card.title, place: m.card.place, item });
  if (action === "rewrite") {
    // The note rides on the card, the reply is cleared, and the customer
    // clock writes it again — the same three-tab round the operator's own
    // "Rewrite" asks the writer for, from the same note.
    const note = String(body.note ?? "").replace(/\s+/g, " ").trim().slice(0, 600);
    if (!note) return { error: "say what should change" };
    if (m.card.state === "dismissed") return { error: "you marked that one not relevant" };
    if (m.card.rewriting) return { error: "it is being rewritten already — a moment" };
    const style = ["straight", "deeper", "ask_back"].includes(body.style) ? body.style : null;
    setCard(dir, m.id, { rewriting: { note, style, at }, draft: null, drafts: null, no_draft: null });
    told("opportunity.rewrite");
    return { ok: true };
  }
  if (action === "open") { setCard(dir, m.id, { opened_at: m.card.opened_at ?? at }); return { ok: true }; }
  if (action === "copy") { setCard(dir, m.id, { copied_at: m.card.copied_at ?? at }); return { ok: true }; }
  if (action === "good") { setCard(dir, m.id, { rating: "good", rated_at: at }); told("opportunity.good"); return { ok: true }; }
  if (action === "bad") {
    setCard(dir, m.id, { rating: "bad", rated_at: at, state: "dismissed" });
    await mark([item, "skip"]).catch(() => {});
    told("opportunity.bad");
    return { ok: true };
  }
  if (action === "replied") {
    if (m.card.state === "replied") return { ok: true, already: true };
    setCard(dir, m.id, { state: "replied", replied_at: at });
    // --anyway: the gate in `mark` measures the OPERATOR's own standing in
    // a room; the customer already posted, from their own account.
    await mark([item, "sent", "--anyway"]).catch(() => {});
    told("opportunity.replied");
    return { ok: true };
  }
  return { error: "that is not something this card does" };
}

/** A button on a card in the chat. The card is looked up here and must still
 *  be the live one — a customer pressing an old card after it was replaced
 *  gets told, not a stale confirmation. */
export async function chatAct(dir, body = {}, { room = (p) => p, mark = async () => {}, tell = noop } = {}) {
  if (!isCustomer(dir)) return { error: "nobody is signed up here — start on the front page", status: 409 };
  const m = messageOf(dir, body.id);
  if (!m?.card) return { error: "no such card" };
  if (m.card.kind === "offer") {
    if (readStash(dir).offer?.card !== m.id) return { error: "that card was replaced by a newer one — answer the latest" };
    if (body.action === "confirm") return confirmOffer(dir, { room, tell });
  }
  if (m.card.kind === "opportunity") return actOpportunity(dir, m, String(body.action ?? ""), body, { mark, tell });
  return { error: "that is not something this card does" };
}

/* ------------------------------------------------------- what they say */

/** Something the customer said, into the transcript — and, when a read of
 *  their site failed, a nudge to look again now (the clock's autoOffer).
 *  "Try again" after it gave up is more than a nudge — the three tries are
 *  spent — so it is a fresh round: measured 2026-09-19, said twice, and
 *  nothing happened either time. */
export function heardFrom(dir, text) {
  const row = heard(dir, text);
  const st0 = readStash(dir);
  if (st0.scoutJob || st0.site_job) {
    const again = st0.scout_gaveup && /\b(try again|retry|read it again|one more time|once more)\b/i.test(text);
    patchStash(dir, { scout_nudge: new Date().toISOString(), ...(again ? { scout_gaveup: null, scout_tries: 0, scout_walled: null } : {}) });
  }
  return row;
}

/**
 * A customer's message, read for what it asks to change about who is found —
 * kinds of people to leave out, communities to add — and applied at once
 * (lib/revise.mjs), before any chat model sees it. Returns null when there is
 * nothing to apply (no offer yet, a question, a model that did not answer),
 * else { said, done, note }: what to tell them, whether that was the whole
 * message, and what to tell Quest about the rest. `interpret` is the model.
 */
export async function applyInstruction(dir, text, { interpret, room = (p) => p, log = console.error } = {}) {
  const st = readStash(dir);
  if (!st.offer) return null;
  let got;
  try {
    got = instructionFrom(await interpret(dir, text));
  } catch (e) {
    log(`an instruction could not be read: ${String(e?.message ?? e).split("\n")[0]}`);
    return null;
  }
  // "Leave out" is kinds of PEOPLE. A free model handed "are you sure
  // r/ExpatForum exists?" answered leave_out: ["ExpatForum"] (measured
  // 2026-09-19, on the cloud's first live run) — a community in the people
  // list, told to the customer as "I'll leave out ExpatForum". A name the
  // offer uses for a community, or anything spelled like one, is not a person.
  const rooms = new Set([...(st.offer.places ?? []), ...got.places].map((p) => String(p).toLowerCase()));
  got.leave_out = got.leave_out.filter((x) => !rooms.has(String(x).replace(/^\/?r\//i, "").toLowerCase()) && !/(^|\s)\/?r\/\w/i.test(x));
  if (!got.leave_out.length && !got.places.length) return null;
  const r = applyRevision(dir, { leave_out: got.leave_out, add_places: got.places }, { room });
  if (!r.ok) return null;
  // An open card was replaced by a corrected one, which says it on its face
  // ("Leaving out: …"); a confirmed offer has no card to say it on.
  const said = st.offer.state === "confirmed"
    ? [r.leftOut.length ? `Got it — I'll leave out ${list(r.leftOut)} from now on.` : "", r.added.length ? `I'll add ${list(r.added.map(room))} to where I look.` : ""].filter(Boolean).join(" ")
    : "";
  return {
    said,
    done: !got.also_asks,
    note: `Already done for them (they have been told; do not do it again or repeat it): ${[r.leftOut.length ? `leaving out ${list(r.leftOut)}` : "", r.added.length ? `adding ${list(r.added.map(room))}` : ""].filter(Boolean).join(" and ") || "the corrected card"}. Answer whatever else they asked; if there is nothing else, reply with the single word noted.`,
  };
}

/* -------------------------------------------------------- opportunities */

// A post's body arrives with its paragraph breaks gone ("calls.No commission",
// measured 2026-09-19 on a real post): a full stop straight into a capital
// gets its space back, for the eye only.
export const excerpt = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").replace(/([a-z0-9€$%)][.!?])([A-Z])/g, "$1 $2").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

export function postOpportunity(dir, r, { room = (p) => p } = {}) {
  return say(dir, {
    text: opportunityText(r, { room }),
    card: {
      kind: "opportunity", state: "open", item: r.id, url: r.url, place: r.place, room: room(r.place),
      author: r.author ?? null, posted_at: r.posted_at ?? null, title: excerpt(r.title, 300), quote: excerpt(r.body, 700), why: excerpt(r.why, 400),
      draft: null, drafts: null,
      actions: [{ id: "open", label: "Open thread" }, { id: "copy", label: "Copy reply" }, { id: "good", label: "👍" }, { id: "bad", label: "👎" }, { id: "replied", label: "I replied" }],
    },
  });
}

/**
 * Delivery, minus the writer: every fit, posted in the chat the moment it is
 * judged — at most two a community and five a day, the pacing the operator's
 * own replies are held to, here holding how often a customer is interrupted —
 * and a finished round of replies put onto the card that was waiting for it.
 * One thing per call. Returns what happened, and — when a reply is still to
 * be written — which card and the `draft` verb's arguments for it:
 *   { posted } | { applied } | { declined } | { draft: { card, args } } | {}
 * `lastDraft` is how the last attempt ended ({ id, error, at } or null): a
 * writer that declined leaves the card saying so; one that failed waits ten
 * minutes before the same card is tried again.
 */
export function deliverStep(dir, { S, room = (p) => p, tell = noop, lastDraft = null, busy = false, now = Date.now() } = {}) {
  if (!isCustomer(dir) || readStash(dir).offer?.state !== "confirmed") return {};
  const cards = chatState(dir, { limit: Infinity }).messages.filter((m) => m.card?.kind === "opportunity");
  const had = new Set(cards.map((m) => m.card.item));
  const today = cards.filter((m) => now - Date.parse(m.at) < DAY);
  if (today.length < OVERALL_24H) {
    const next = queueOf(S).find((r) => !had.has(r.id) && isFresh(r, now) && S.roomState(r.place).state !== "banned"
      && today.filter((m) => m.card.place === r.place).length < PER_ROOM_24H);
    if (next) {
      const msg = postOpportunity(dir, next, { room });
      tell({ type: "opportunity.new", title: next.title ?? "", place: next.place });
      return { posted: msg };
    }
  }
  // The reply, onto the card that is waiting for one — one at a time.
  const want = cards.find((m) => !m.card.draft && !m.card.no_draft && m.card.state !== "dismissed");
  if (!want) return {};
  // A "Rewrite" (the customer's note on the reply they were shown): what
  // comes back is the round written after the note, never the one they just
  // turned down.
  const rw = want.card.rewriting ?? null;
  const since = rw ? Date.parse(rw.at) : 0;
  const round = S.drafts().filter((d) => d.id === want.card.item && Date.parse(d.at) > since).pop();
  if (round) {
    const drafts = (Array.isArray(round.drafts) && round.drafts.length ? round.drafts : [{ style: "straight", text: round.text }]).filter((d) => String(d?.text ?? "").trim());
    // A result the reply claims for them (lib/guards.mjs results) rides on the
    // draft, so the card can say "check this before you post" beside it.
    if (drafts.length) {
      setCard(dir, want.id, { rewriting: null, draft: drafts[0].text, drafts: drafts.map((d) => { const check = results(d.text); return { style: d.style, text: d.text, ...(check.length ? { check } : {}) }; }) });
      return { applied: want.id };
    }
  }
  // A writer already at work (or none to work with) — nothing to decide yet.
  if (busy) return {};
  if (lastDraft?.id === want.card.item) {
    if (/declined/.test(lastDraft.error ?? "")) { setCard(dir, want.id, { no_draft: lastDraft.error, rewriting: null }); return { declined: want.id }; }
    if (now - lastDraft.at < 10 * 60_000) return {};
  }
  return { draft: { card: want.id, args: rw ? [want.card.item, "--note", rw.note, ...(rw.style ? ["--style", rw.style] : [])] : [want.card.item] } };
}
