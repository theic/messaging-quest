// The chat as a channel (Stage A of the channels plan, 2026-09-21).
//
// Quest's only door out is a transcript row (lib/chat.mjs); the web chat is
// the first thing that reads it. This is the second: what one row becomes on
// Telegram, and what one Telegram update means back. Both directions are pure
// functions of their input — no network, no clock, no filesystem — so the
// whole channel is tested on a bare Node (bin/test.mjs) and the Edge Function
// that carries it stays plumbing.
//
// The words are never written here. A card already carries the labels the web
// draws ("Looks right", "I replied") and a text written to be read without
// the card at all (lib/quest.mjs opportunityText: "what an email or a Telegram
// message would show"). A button is that label with the card's id behind it,
// and nothing else is invented on the way.
//
// One rule holds the line: NOTHING IS EVER SENT TO ANYONE BUT THE CUSTOMER.
// There is no "post it for me" here and never will be; "I replied" is a
// self-report, the same as on the web.

/** What one Telegram message holds. The API's own limit is 4096 characters;
 *  splitting a little early leaves room for the line a card adds. */
export const CHUNK = 3800;

/** Telegram's own limit on the data behind a button: 64 bytes. Ours is
 *  "a|<id>|<action>" — three fields, never near it. */
export const packData = (kind, id, arg = "") => `${kind}|${id}${arg ? `|${arg}` : ""}`;

export function unpackData(s) {
  const [kind, id, arg = ""] = String(s ?? "").split("|");
  if (!["a", "d", "q"].includes(kind)) return null;
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) return null;
  if (!/^[a-z_]{0,12}$/.test(arg)) return null;
  return { kind, id: n, arg };
}

/** A long message, cut where a person would cut it: at a blank line, then at
 *  a line, then at a space, and only mid-word when a word is the problem. */
export function splitText(s, limit = CHUNK) {
  const text = String(s ?? "");
  if (text.length <= limit) return text.trim() ? [text] : [];
  const out = [];
  let rest = text;
  while (rest.length > limit) {
    const head = rest.slice(0, limit);
    let at = head.lastIndexOf("\n\n");
    if (at < limit * 0.5) at = head.lastIndexOf("\n");
    if (at < limit * 0.5) at = head.lastIndexOf(" ");
    if (at < limit * 0.5) at = limit;
    out.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest.trim()) out.push(rest);
  return out;
}

/* ------------------------------------------------------------- the buttons */

/** A card whose moment has passed carries no buttons: the offer once it is
 *  confirmed or replaced, an opportunity once it is dismissed or replied to. */
const DONE = new Set(["confirmed", "replaced", "dismissed", "replied"]);

/**
 * The buttons for a card, in the card's own words. Two actions do not survive
 * the crossing: "Copy reply" (a chat has no clipboard — the draft arrives as
 * its own message, which a long press copies) and any action whose card has
 * already moved on.
 */
export function buttonsFor(card, id) {
  if (!card || DONE.has(card.state)) return null;
  const rows = [];
  const rate = [];
  for (const a of Array.isArray(card.actions) ? card.actions : []) {
    const label = String(a?.label ?? "").trim();
    if (!label) continue;
    if (a.id === "copy") continue;
    if (a.id === "open") { if (card.url) rows.push([{ text: label, url: card.url }]); continue; }
    if (a.id === "good" || a.id === "bad") { rate.push({ text: label, callback_data: packData("a", id, a.id) }); continue; }
    // "Change something" is not an event — it is a question, and the answer
    // is an ordinary message, which the engine already knows how to read.
    if (a.id === "change") { rows.push([{ text: label, callback_data: packData("q", id, "change") }]); continue; }
    rows.push([{ text: label, callback_data: packData("a", id, a.id) }]);
  }
  if (rate.length) rows.splice(rows.length ? 1 : 0, 0, rate);
  return rows.length ? { inline_keyboard: rows } : null;
}

/** The same buttons after one was pressed: the pressed one ticked, so the
 *  thread shows what was said even when the answer takes a moment to arrive.
 *  A terminal press ("Looks right", "I replied") leaves no buttons at all. */
export function pressedButtons(card, id, action) {
  if (["confirm", "replied", "bad"].includes(action)) return null;
  const keys = buttonsFor(card, id);
  if (!keys) return null;
  const mark = (b) => (unpackData(b.callback_data)?.arg === action ? { ...b, text: `${b.text} ✓` } : b);
  return { inline_keyboard: keys.inline_keyboard.map((r) => r.map(mark)) };
}

const STYLE_WORD = { straight: "Straight", deeper: "Deeper", ask_back: "Ask back" };

/** The buttons under a draft: another version of it, or a word about what to
 *  change. The versions are the ones the writer already wrote and the card is
 *  already carrying — asking for one costs no model and no wake-up. */
export function draftButtons(id, drafts = [], shown = "straight") {
  const others = drafts.map((d) => d?.style).filter((s) => s && s !== shown && STYLE_WORD[s]);
  const rows = [[{ text: "Rewrite", callback_data: packData("q", id, "rewrite") }]];
  if (others.length) rows.push(others.map((s) => ({ text: STYLE_WORD[s], callback_data: packData("d", id, s) })));
  return { inline_keyboard: rows };
}

/* ------------------------------------------------------------ one row out */

/**
 * What a transcript row becomes on the chat: none, one or a few messages, in
 * order. `sent` maps a transcript id to the Telegram message it became, so a
 * later line can hang under the card it belongs to.
 *
 * A customer's own line is not sent back to them — they typed it, here or on
 * the web — but the cursor still passes it, so nothing is read twice.
 */
export function renderRow(row = {}, { sent = {} } = {}) {
  if (row.sender === "you") return [];
  const body = row.body ?? row;
  const id = Number(row.id ?? body.id);

  if (row.sender === "system" || body.from === "system") {
    const set = body.set ?? {};
    const ref = Number(body.ref);
    const to = sent[ref] ?? null;
    // The reply, once it is written: the first version in full, so a long
    // press copies it, under the card it answers.
    if (Array.isArray(set.drafts) && set.drafts.length) {
      const first = set.drafts[0];
      const check = Array.isArray(first.check) && first.check.length
        ? `\n\nBefore you post: ${first.check.join("; ")}`
        : "";
      return [{
        text: `${String(first.text ?? "").trim()}${check}`,
        reply_to_message_id: to,
        reply_markup: draftButtons(ref, set.drafts, first.style ?? "straight"),
      }];
    }
    if (set.no_draft) return [{ text: `I couldn't write a reply for that one — ${set.no_draft}. Your own words will do better here anyway.`, reply_to_message_id: to }];
    // Every other move a card makes (confirmed, rated, dismissed) is already
    // said in words by the message that follows it, or by the tick on the
    // button that made it. Nothing to send.
    return [];
  }

  const out = [];
  const card = body.card ?? null;
  const parts = splitText(body.text ?? "");
  const keys = card ? buttonsFor(card, id) : null;
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    out.push({ text: parts[i], ...(last && keys ? { reply_markup: keys } : {}) });
  }
  // A card with no words of its own still has to arrive as something.
  if (!out.length && keys) out.push({ text: "…", reply_markup: keys });
  return out;
}

/* ------------------------------------------------------------ one update in */

const CODE = /^[A-Z0-9]{6,12}$/;
/** How long a question the bot asked stays open. Past this the answer is an
 *  ordinary message again — a note typed an hour later was about something
 *  else. */
export const ASK_MS = 5 * 60_000;

/**
 * What a Telegram update means. `awaiting` is the question this chat was last
 * asked ({ for, card, prompt, at }); an answer to it is a note, not a message
 * for Quest. Everything unrecognised is a message — the engine reads it, and
 * it interprets an instruction better than a parser would.
 */
export function intentOf(update = {}, { awaiting = null, now = Date.now() } = {}) {
  const cb = update.callback_query;
  if (cb) {
    const d = unpackData(cb.data);
    const at = { chat: cb.message?.chat?.id ?? null, from: cb.from?.id ?? null, callback: cb.id ?? null, message: cb.message?.message_id ?? null };
    if (!d) return { kind: "ignore", ...at };
    if (d.kind === "a") return { kind: "act", id: d.id, action: d.arg, ...at };
    if (d.kind === "d") return { kind: "draft", id: d.id, style: d.arg, ...at };
    return { kind: "ask", id: d.id, for: d.arg, ...at };
  }

  const m = update.message ?? update.edited_message ?? null;
  const text = String(m?.text ?? m?.caption ?? "").trim();
  const at = { chat: m?.chat?.id ?? null, from: m?.from?.id ?? null, message: m?.message_id ?? null };
  if (!m || m.chat?.type !== "private" || !text) return { kind: "ignore", ...at };

  const cmd = /^\/(start|link|stop|help)(?:@\S+)?(?:\s+(.*))?$/is.exec(text);
  if (cmd) {
    const word = cmd[1].toLowerCase();
    const rest = String(cmd[2] ?? "").trim().toUpperCase();
    if (word === "stop") return { kind: "stop", ...at };
    if (word === "help") return { kind: "hello", ...at };
    return CODE.test(rest) ? { kind: "start", code: rest, ...at } : { kind: "hello", ...at };
  }

  // The answer to a question the bot asked: a real reply to it, or — because
  // a phone keyboard does not always reply properly — anything typed soon
  // after it.
  if (awaiting?.card && (Date.parse(awaiting.at) || 0) > now - ASK_MS) {
    const replied = m.reply_to_message?.message_id && m.reply_to_message.message_id === awaiting.prompt;
    if (replied || !m.reply_to_message) return { kind: "note", id: Number(awaiting.card), for: awaiting.for === "rewrite" ? "rewrite" : "change", text, ...at };
  }
  return { kind: "say", text, ...at };
}

/* ------------------------------------------------------------- the words */

/** The few lines the channel itself says. Everything else a customer reads
 *  was written by Quest. */
export const LINES = {
  linked: "Linked. I'll bring you what I find here — you can answer me in this chat, and everything is on the website too.",
  here: "I'm here. Tell me anything, and I'll bring you the people I find. Say “stop” to quiet this chat.",
  slow: "One at a time — give me a moment to catch up.",
  sorry: "Something went wrong on my side. Say it again in a minute.",
  unknown: "I don't know this chat yet. Open messaging.quest, sign in, and press “Get this in Telegram”.",
  spent: "That link has already been used. Press “Get this in Telegram” again for a fresh one.",
  stopped: "Stopped — nothing more here. Your account and everything I've found are still on the website, and you can link this chat again any time.",
  askRewrite: "What should change about it?",
  askChange: "What should I change?",
  noted: "Noted.",
  gone: "That card has moved on — have a look at the newest one.",
};
