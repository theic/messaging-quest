// The whole reads — what one job asks of the operator's browser (Stage 2 of
// the Quest plan, 2026-09-19).
//
// A read used to be a verb's own business: `probe` opened a community, read
// it, opened the posts it only previewed, and wrote what it found, all in one
// process that held the lane. On Supabase the engine that writes and the
// browser that reads are on two machines — the quest Edge Function owns a
// customer's files; the operator's Chrome is the only thing allowed to open a
// page ("real tabs, no background fetches") — so a read has to be a thing of
// its own: asked for as a job, done whole in the extension's worker ("no
// network round trip per page"), and handed back as data. These are those
// reads. The verbs call them too, so a probe on the operator's own machine
// and a probe the cloud asked for turn exactly the same pages.
//
// Each takes a browser from lib/browse.mjs (the lane's pace, pauses and holds
// are its business, not ours) and never closes it: the caller leased it and
// the caller gives it back. Nothing here writes a file.

import { platformFor, preferred } from "./platform.mjs";
import { fromDescription } from "./rules.mjs";

/** Posts a search or a listing only previewed get their own page opened,
 *  one by one, for the author and the full body — up to the platform's
 *  number per read, the way a person opens the ones that look like them. */
export async function fillBodies(p, b, entries) {
  const cap = Number(p?.bodiesPerRead) || 0;
  if (!cap || typeof p?.readPost !== "function") return entries;
  const out = [];
  let opened = 0;
  for (const e of entries) {
    const wants = e.kind === "post" && (e.preview || !e.body || !e.author);
    if (!wants || opened >= cap) { out.push(e); continue; }
    opened++;
    const r = await p.readPost(e.url, { browse: b });
    const full = r.ok ? (r.entries.find((x) => x.kind === "post" && x.id === e.id) ?? r.entries.find((x) => x.kind === "post")) : null;
    out.push(full ? { ...e, ...full, id: e.id, url: e.url, preview: false } : e);
  }
  return out;
}

/**
 * A listing — a community's search, or its newest posts — read whole: the
 * page, then the posts it only previewed, in the same tab. What comes back:
 *   { ok, error?, redirected?, finalUrl?, subtitle?, total, entries }
 * where `total` is everything the page showed and `entries` the posts worth
 * recording — new ones only (`skip` holds the ids already known, `skipAuthors`
 * the people already answered), each with its body when one could be opened.
 * A room that does not exist (the platform redirects instead of a 404) or
 * whose own description forbids promotion gets no posts opened at all: the
 * refusal is the recorder's to write, and a page turn spent on a room that
 * will be refused is a page turn a person would not have made.
 */
export async function readListing(b, url, { platform = null, skip = new Set(), skipAuthors = new Set(), checkDescription = true } = {}) {
  const p = platform ?? platformFor(url) ?? preferred();
  if (!p || typeof p.read !== "function") return { ok: false, error: "no platform skill can read that address", total: 0, entries: [] };
  const r = await p.read(url, { browse: b });
  if (!r.ok) return { ok: false, error: r.error ?? "the read failed", total: 0, entries: [] };
  const total = r.entries.length;
  const head = { ok: true, total, redirected: Boolean(r.redirected), finalUrl: r.finalUrl ?? null, subtitle: r.subtitle ?? null };
  if (r.redirected) return { ...head, entries: [] };
  if (checkDescription && fromDescription(r.subtitle).state === "banned") return { ...head, entries: [] };
  const seen = new Set();
  const fresh = r.entries.filter((e) => e.kind === "post" && !skip.has(e.id) && !seen.has(e.id) && seen.add(e.id)
    && !(e.author && skipAuthors.has(String(e.author).toLowerCase())));
  return { ...head, entries: await fillBodies(p, b, fresh) };
}

/** One page's readable text — a community's rules page. */
export async function readText(b, url, { max = 20_000 } = {}) {
  const o = await b.open(url);
  if (o.error) return { ok: false, error: o.error };
  const t = await b.text(max);
  if (t.error) return { ok: false, error: t.error };
  return { ok: true, url: t.url ?? o.url ?? url, title: t.title ?? o.title ?? "", text: t.text ?? "" };
}

/* ------------------------------------------------------------ a site */

const LINKS = { items: "a[href]", limit: 200, fields: { href: "href", text: "text" } };
/** What a person opens off a landing page to learn what a company sells —
 *  the pages the site scout (lib/agents.mjs) was measured choosing. */
const WANT = /(pricing|prices?|plans?|product|features?|how[-_ ]?it[-_ ]?works|about|use[-_ ]?cases?|solutions?|customers?|faq|why|services?|what[-_ ]?we[-_ ]?do|for[-_ ])/i;
/** …and what a person leaves alone: the doors in, the company's own rules
 *  (a scout once turned a terms page into who to answer), and anything that
 *  is not a page. */
const AVOID = /(log[-_ ]?in|sign[-_ ]?(in|up|on)|register|account|checkout|cart|terms|privacy|cookie|legal|refund|policy|gdpr|imprint|careers|jobs|press|status|\/blog\/.+|\.(pdf|png|jpe?g|gif|svg|zip|mp4)$)/i;
const bareHost = (u) => String(u).toLowerCase().replace(/^www\./, "");

/**
 * A company's own site, read the way a person reads it before deciding what
 * it sells: the page they were given, then up to `pages - 1` of the pages it
 * links to that say more (pricing, product, how it works, about), each in the
 * same tab and never off the site. Deterministic on purpose — the model that
 * used to choose them (lib/agents.mjs scoutSite) needs a key, and the
 * extension that runs this has none; the choosing that matters is which
 * words go on the card, and that is still a model's, on the server.
 *   { ok, error?, pages: [{ url, title, text }] }
 */
export async function readSite(b, url, { pages = 4, max = 20_000 } = {}) {
  const first = await readText(b, url, { max });
  if (!first.ok) return { ok: false, error: first.error, pages: [] };
  const out = [{ url: first.url, title: first.title, text: first.text }];
  let at;
  try { at = new URL(first.url); } catch { at = new URL(url); }
  const host = bareHost(at.host);
  const got = await b.extract(LINKS);
  const byHref = new Map();
  for (const r of got?.rows ?? []) {
    let u;
    try { u = new URL(String(r.href ?? ""), at); } catch { continue; }
    u.hash = "";
    if (!/^https?:$/.test(u.protocol) || bareHost(u.host) !== host) continue;
    if (u.pathname.replace(/\/+$/, "") === at.pathname.replace(/\/+$/, "") || AVOID.test(u.pathname)) continue;
    const text = String(r.text ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    const score = (WANT.test(u.pathname) ? 2 : 0) + (WANT.test(text) ? 1 : 0);
    if (!score) continue;
    const had = byHref.get(u.href);
    if (!had || had.score < score) byHref.set(u.href, { href: u.href, path: u.pathname, score });
  }
  const next = [...byHref.values()].sort((a, c) => c.score - a.score || a.path.length - c.path.length).slice(0, Math.max(0, pages - 1));
  for (const n of next) {
    const g = await b.goto(n.href);
    if (g.error) continue;
    const t = await b.text(max);
    if (t.error || !String(t.text ?? "").trim()) continue;
    out.push({ url: t.url ?? n.href, title: t.title ?? "", text: t.text });
  }
  return { ok: true, pages: out };
}
