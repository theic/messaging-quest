// The channel — one transcript per customer, and the record that makes a
// project a customer's (Stage 1 of the Quest plan, 2026-09-18).
//
// Quest talks to people through exactly one door: a line appended to
// chat.jsonl in the customer's own project directory. The web chat is the
// first thing that reads it. An email digest, a Telegram bot or WhatsApp are
// more readers and writers of the same file — a `messages` table once the
// store moves to Supabase — so adding a channel never touches the agent.
//
// A CUSTOMER is a project with a customer.json: somebody who pasted what they
// sell on the front page and said where to send what Quest finds. Sign-up is
// a stub in Stage 1 — an email, not checked — and customer.json is its whole
// record. Supabase Auth replaces the stub in Stage 2; this file keeps its
// shape.
//
// Rows, append-only, one JSON object a line:
//   {id, at, from: "you" | "quest", text}          something somebody said
//   {id, at, from: "quest", text?, card: {...}}     something to act on
//   {id, at, from: "system", ref, set: {...}}       a card's state moving
// `id` counts up from 1, so a reader can ask what came after the last one it
// saw. A card's later state is folded into it on the way out (chatState),
// never edited in place: the file stays the history.

import { existsSync, readFileSync, writeFileSync, appendFileSync, join } from "./fs.mjs";

export const CUSTOMER_FILE = "customer.json";
export const CHAT_FILE = "chat.jsonl";

/** The longest thing one message keeps. A pasted essay is still read; the
 *  transcript is not where a whole document lives. */
const MAX_TEXT = 8000;

/* --------------------------------------------------------------- customers */

export const isCustomer = (dir) => Boolean(dir) && existsSync(join(dir, CUSTOMER_FILE));

export function customerOf(dir) {
  try { return JSON.parse(readFileSync(join(dir, CUSTOMER_FILE), "utf8")); } catch { return null; }
}

/** Merge fields into the record. Returns what is on disk now. */
export function writeCustomer(dir, fields = {}) {
  const next = { ...(customerOf(dir) ?? {}), ...fields };
  for (const k of Object.keys(next)) if (next[k] === null || next[k] === undefined) delete next[k];
  writeFileSync(join(dir, CUSTOMER_FILE), JSON.stringify(next, null, 2) + "\n");
  return next;
}

/** A plausible email — the stub's whole check. Deliberately loose: the
 *  address is a name for the account until Stage 2 sends it a code. */
export const looksLikeEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s ?? "").trim());

/**
 * The site in what somebody typed: the first http(s) address, or the first
 * bare domain ("acme.com/pricing"), as an https URL. Null when there is none —
 * a CV pasted as text, or a sentence about what they do.
 */
export function siteOf(text) {
  const t = String(text ?? "");
  const full = /\bhttps?:\/\/[^\s<>"')]+/i.exec(t);
  if (full) return full[0].replace(/[.,;:!?]+$/, "");
  const bare = /(?:^|[\s(])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?:\/[^\s<>"')]*)?)/i.exec(t);
  if (!bare) return null;
  const host = bare[1].replace(/[.,;:!?]+$/, "");
  // "e.g." and "i.e." are not sites; neither is a file name.
  if (/^(e\.g|i\.e)\b/i.test(host) || /\.(pdf|docx?|txt|md|png|jpe?g)$/i.test(host)) return null;
  return `https://${host}`;
}

/** The host a person would say out loud: "acme.com", not "https://www.acme.com/". */
export const hostOf = (url) => { try { return new URL(url).host.replace(/^www\./, ""); } catch { return null; } };

/* -------------------------------------------------------------- transcript */

const raw = (dir) => { const p = join(dir, CHAT_FILE); return existsSync(p) ? readFileSync(p, "utf8") : ""; };

function rows(dir, text = raw(dir)) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    // A torn last line (the process died mid-append) is not a reason to lose
    // the conversation above it.
    try { out.push(JSON.parse(line)); } catch { /* skipped */ }
  }
  return out;
}

const clean = (msg) => {
  const out = {};
  if (msg.text != null) out.text = String(msg.text).replace(/\r\n/g, "\n").trim().slice(0, MAX_TEXT);
  if (msg.card && typeof msg.card === "object") out.card = msg.card;
  if (msg.ref != null) out.ref = Number(msg.ref);
  if (msg.set && typeof msg.set === "object") out.set = msg.set;
  if (msg.error) out.error = true;
  return out;
};

/** Append one row and hand it back, id and all. */
export function post(dir, from, msg = {}) {
  const text = raw(dir);
  const all = rows(dir, text);
  const last = all.length ? Number(all[all.length - 1].id) : 0;
  const row = { id: (Number.isFinite(last) ? last : all.length) + 1, at: new Date().toISOString(), from, ...clean(msg) };
  // After a torn line the next row starts on a line of its own, or it would
  // be glued to the fragment and lost with it.
  const lead = text && !text.endsWith("\n") ? "\n" : "";
  appendFileSync(join(dir, CHAT_FILE), lead + JSON.stringify(row) + "\n");
  return row;
}

/** The first line of a model's reply when it is the clock the seat was
 *  handed (lib/clock.mjs) — "Friday, 18 September 2026 at 21:22 in
 *  Europe/London — just now." — copied back out. That line is the seat's
 *  context, not news for a customer; a zone name ("Area/City") is what no
 *  sentence written for a person carries, so it is the tell. */
const CLOCK_ECHO = /^[^\n]*\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b[^\n]*\b\d{1,2}:\d{2}\b[^\n]*\bin [a-z]+\/[a-z_/-]+[^\n]*(?:\n+|$)/i;
export const unclocked = (s) => String(s ?? "").replace(CLOCK_ECHO, "").trim();

/** Quest says something — a sentence, or a card to act on. A sentence that
 *  was only the clock copied back says nothing, and nothing is written. */
export const say = (dir, msg) => {
  if (typeof msg !== "string") return post(dir, "quest", msg ?? {});
  const text = unclocked(msg);
  return text ? post(dir, "quest", { text }) : null;
};
/** The customer said something. */
export const heard = (dir, text) => post(dir, "you", { text });
/** A card moved: answered, dismissed, opened. Folded into it by chatState. */
export const setCard = (dir, ref, set) => post(dir, "system", { ref, set });

/**
 * What a reader shows: the last `limit` messages, each card carrying its
 * latest state, and a version that changes whenever anything was written —
 * so a client polling every second repaints only when there is something new.
 */
export function chatState(dir, { limit = 200 } = {}) {
  const all = rows(dir);
  const byId = new Map();
  const shown = [];
  for (const r of all) {
    if (r.from === "system") {
      const target = byId.get(r.ref);
      if (target?.card && r.set) target.card = { ...target.card, ...r.set };
      continue;
    }
    const m = { ...r, ...(r.card ? { card: { ...r.card } } : {}) };
    byId.set(r.id, m);
    shown.push(m);
  }
  return { version: all.length, messages: shown.slice(-limit) };
}

/** One message by id, its card folded — for a route acting on a card. */
export const messageOf = (dir, id) => chatState(dir, { limit: Infinity }).messages.find((m) => m.id === Number(id)) ?? null;
