#!/usr/bin/env node
// Messaging Quest — the CLI: one implementation of every verb.
//
// It began as the listener: what the platform did to the comments you already
// wrote. It posts nothing, reads nobody else's account, calls no model, needs
// no key and sends nothing anywhere. Everything is append-only JSONL in .mq/.
//
// From 0.6.0 every read happens in the operator's own browser (lib/browse.mjs)
// — a real tab, rendered, read in the isolated world, closed after — and
// nowhere else; every verb acts on the current PROJECT (lib/projects.mjs); a
// person found under a CAMPAIGN (lib/campaigns.mjs) is judged and drafted
// under its direction; and nothing here names a platform — the active adapter
// (lib/platform.mjs) supplies the pages, the labels and the refusals.
//
// Why this and not a lead tool first: Reddit removed 154 million posts and
// comments in one half-year, 44.7% of them by admins, and told almost nobody.
// Its own description of the work is "our most effective work happens before a
// post is ever seen by a human." The only method anybody has for finding out is
// opening a private window by hand, one comment at a time. This is that, done
// continuously, with a memory.
//
// The store rules, and they are the whole design:
//   - items:  FIRST write wins. A re-read must never overwrite what you said.
//   - checks: nothing is ever overwritten. A comment that was visible on Monday
//             and is not on Thursday is the finding, and you only have it if
//             both reads are still on disk.

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { loadPlatforms, platforms, first, platformFor, labelsOf } from "../lib/platform.mjs";
import { skillState, writeChoice } from "../lib/skills.mjs";
import { PLANS, ROLES, plan, setPlan, chosen, choose, localConfig, setLocal, probeLocal, hasKey, keySource } from "../lib/models.mjs";
import { classify, history, STATES } from "../lib/verdict.mjs";
import { conversation, byUrgency } from "../lib/conversation.mjs";
import { conversationRows, openConversation, bindConversations, recordReturn, waiting as waitingRows, yourTurns, dueConversations, unbound, campaignDigest, digestText } from "../lib/conversations.mjs";
import { readStash, patchStash } from "../lib/cards.mjs";
import { verdictOf } from "../lib/probe.mjs";
import { fromDescription, roomFile } from "../lib/rules.mjs";
import { store, FILES, dataDir } from "../lib/store.mjs";
import { browser, serverBase } from "../lib/browse.mjs";
import { readCampaigns, readCampaign, setCampaignStatus, writerBlock } from "../lib/campaigns.mjs";
import { listProjects, createProject, useProject, currentDir } from "../lib/projects.mjs";
import { seedMissing } from "../lib/memory.mjs";
import { measureVoice, mergeVoice, voiceRules, voiceSummary, lengthCeiling, MIN_SAMPLE_CHARS } from "../lib/voice.mjs";
import { signalWritingRules, communityRisks } from "../lib/writing.mjs";
import { repeats, claims, inventedLinks, tells, RUN_LIMIT } from "../lib/guards.mjs";
import { standing, readiness, burst, mix, CQS_NOTE, PER_ROOM_24H, OVERALL_24H } from "../lib/ready.mjs";

const ROOT = dataDir();          // the root: the default project, the registry, the machine's files
const DIR = currentDir(ROOT);    // the project every verb below acts on
const F = (n) => join(DIR, n);
const now = () => new Date().toISOString();
const die = (m) => { console.error(`mq: ${m}`); process.exit(1); };

// The registry finds skills/ and <ROOT>/skills/. Everything platform-mechanical
// this CLI does comes through the active adapter; nothing here names one.
await loadPlatforms(ROOT);
const P = () => first() ?? die("no platform skill is active — `mq skills` says why");
const L = () => labelsOf(P());
const roomOfUrl = (url) => platformFor(url)?.roomOf(url) ?? null;
const isParody = (place) => Boolean(P().parody?.(place));
const rulesUrl = (place) => P().rulesUrl?.(place) ?? "the room's own rules page";
const threadOf = (it) => (platformFor(it.url) ?? P()).threadOf?.(it) ?? null;
const sha = (s) => createHash("sha256").update(String(s)).digest("hex");

/** §04. Reddit requires deleting what was deleted from Reddit and recommends
 *  dropping stored content within 48 hours; the same courtesy holds anywhere. The excerpt is a convenience for
 *  reading the report; the hash is what every measurement actually runs on, so
 *  the excerpt can expire without costing anything. */
const BODY_TTL_MS = 48 * 3600_000;

/* ------------------------------------------------------------------ store */
// Shared with the dashboard — see lib/store.mjs for why it is not inline here.

const S = store(DIR, die);
const sentLog = () => S.sentLog();
const { readJsonl, append, items, found, verdicts, checksById, contacted,
        account, roomPath, roomState, ruleHash, pending, setPending,
        lastById, rewrite } = S;
const sources = S.sources;

/* ------------------------------------------------------------ the browser */

// Every read is a page in the operator's own Chrome (lib/browse.mjs), reached
// through the server that holds the control lane. `mq serve` sets MQ_SERVER
// for the children it spawns; a bare terminal reaches the same server when
// one is running, and otherwise the verb says so and stops — there is no
// other way to read, by the operator's rule. Two seats: the operator's own
// session for finding people, the stranger's (an Incognito tab) for what
// became of their own words.
const lane = ({ stranger = false, task = null } = {}) =>
  browser(serverBase() ?? "http://127.0.0.1:8787", { task: task ?? `mq ${cmd}`, stranger, project: DIR });

/** One page, on a lease, into the read ledger. Three outcomes, never two. */
async function readPage(b, url, { source = null } = {}) {
  const r = await P().read(url, { browse: b });
  append("reads.jsonl", { url, ...(source ? { source } : {}), at: now(), ok: r.ok, err: r.ok ? null : r.error, n: r.ok ? r.entries.length : 0, via: b.stranger ? "stranger" : "browser" });
  return r;
}

/** Posts a search or a listing only previewed get their own page opened,
 *  one by one, for the author and the full body — up to the platform's
 *  number per read, the way a person opens the ones that look like them. */
async function fillBodies(b, entries) {
  const cap = Number(P().bodiesPerRead) || 0;
  if (!cap || typeof P().readPost !== "function") return entries;
  const out = [];
  let opened = 0;
  for (const e of entries) {
    const wants = e.kind === "post" && (e.preview || !e.body || !e.author);
    if (!wants || opened >= cap) { out.push(e); continue; }
    opened++;
    const r = await P().readPost(e.url, { browse: b });
    const full = r.ok ? (r.entries.find((x) => x.kind === "post" && x.id === e.id) ?? r.entries.find((x) => x.kind === "post")) : null;
    out.push(full ? { ...e, ...full, id: e.id, url: e.url, preview: false } : e);
  }
  return out;
}

/* --------------------------------------------------------------- commands */

const cmds = {};

cmds.init = () => {
  mkdirSync(DIR, { recursive: true });
  mkdirSync(join(DIR, "rooms"), { recursive: true });
  for (const f of FILES) if (!existsSync(F(f))) writeFileSync(F(f), "");
  // rule.md, project.md, icp.md and me.md. They live in lib/memory.mjs because
  // the dashboard edits them and the agents read them, and a seed defined in
  // two places is a rubric that means two things.
  seedMissing(DIR);
  console.log(`ready — ${DIR}/\n\nThe quickest way in is the dashboard:  mq serve   (every read happens in your own browser, through it)\n\nOr by hand:  mq me <your-username>\n             mq sync\n             mq check\n\nWhen you want to find people: edit ${DIR}/rule.md, then \`mq probe <room> --q "<phrase>"\`.`);
};

cmds.me = (args) => {
  const name = String(args[0] || die("usage: mq me <your-username>")).replace(/^\/?u\//, "").trim();
  if (!/^[\w-]{3,20}$/.test(name)) die(`that does not look like a ${P().name} username: '${name}'`);
  writeFileSync(F("account.json"), JSON.stringify({ name, platform: P().id, added: now() }, null, 2));
  console.log(`listening for ${name} on ${P().name}.\n\nNothing is posted, nothing is sent, and only your own account is read — in an Incognito tab of your browser, the way a stranger sees it.\nNext: mq sync`);
};

/**
 * Read your own public profile the way a logged-out stranger reads it.
 *
 * This single request is also the site-wide test from §02, and it is the whole
 * two-minutes-in-a-private-window check with a memory bolted on. An empty
 * profile is not "you have not posted" — it is the loudest thing this tool can
 * find, and it is reported as a question rather than a verdict, because an
 * account with genuinely no comments looks identical.
 */
cmds.sync = async () => {
  const acct = account() || die("nobody to listen to yet — run: mq me <your-username>");
  if (typeof P().userPage !== "function") die(`${P().name} has no profile page this install can read`);
  console.log(`reading ${acct.name}'s profile as a stranger would — an Incognito tab of your own browser\n`);
  const b = lane({ stranger: true, task: `mq sync — ${acct.name} as a stranger` });
  const r = await readPage(b, P().userPage(acct.name));
  await b.close();

  if (!r.ok) {
    if (r.error === "http_404") return console.log(notFound(acct.name));
    return console.log(`  could not read it: ${r.error}\n  That is a failed read, not a finding about your account. Try again.`);
  }
  if (r.redirected) return console.log(`  the profile URL redirected — check the spelling of '${acct.name}'.`);

  const known = items();
  const mine = r.entries.filter((e) => !e.author || e.author.toLowerCase() === acct.name.toLowerCase());
  let fresh = 0;
  for (const e of mine) {
    if (known.has(e.id)) continue;
    append("items.jsonl", {
      id: e.id, kind: e.kind, url: e.url, author: e.author, at: e.at,
      title: e.kind === "post" ? e.title : null, // a comment's title is Reddit's own synthesis, not your words
      body: e.body.slice(0, 500), body_sha256: sha(e.body), seen_at: now(), source: "profile",
    });
    fresh++;
  }

  console.log(`  ${r.entries.length} on the profile, ${fresh} new to the store.`);
  // A conversation opened on "I posted it" is bound to the comment that
  // turned up on the profile in the same thread, so the return pass knows
  // which page to read for its replies.
  const bound = bindConversations(S, { threadOf: (x) => threadOf(x) });
  if (bound) console.log(`  ${bound} conversation${bound === 1 ? "" : "s"} bound to your own comments — the return pass reads their replies.`);
  if (r.entries.length === 0) {
    console.log(`\n  Zero entries, logged out, with a 200.`);
    console.log(`  Either you have not commented, or nothing you wrote is visible to strangers.`);
    console.log(`  Those look identical from here and the tool will not guess between them.`);
    console.log(`\n  To tell them apart: paste a permalink you know you posted —`);
    console.log(`      mq add <permalink>   then   mq check`);
    console.log(`  If it comes back 'filtered', the profile being empty is not an absence of writing.`);
  } else if (fresh) {
    console.log(`\n  Next: mq check`);
  }
};

/**
 * Add something by hand.
 *
 * The one path that works when the profile itself is invisible — which is
 * exactly the person who most needs an answer, and exactly the person a
 * profile-only tool cannot help.
 */
cmds.add = (args) => {
  const url = String(args[0] || die("usage: mq add <permalink>")).split("?")[0].replace(/\/+$/, "");
  // The platform says what a permalink is and whether it names a post or a
  // comment — getting that wrong checks the wrong thing and reports
  // confidently about it, which is why it is the adapter's to say.
  const it = platformFor(url)?.itemOf?.(url) ?? null;
  if (!it) die("that is not a post or comment permalink on a platform this install reads");
  const { id, kind } = it;
  if (items().has(id)) return console.log(`already listening to ${id}`);
  append("items.jsonl", { id, kind, url, author: account()?.name ?? null, at: null, title: null, body: "", body_sha256: null, seen_at: now(), source: "by hand" });
  console.log(`added ${id}\n  ${url}\nNext: mq check`);
};

/**
 * The stranger check.
 *
 * One read answers for every comment you left in the same thread, which is why
 * the work is grouped by thread rather than run per item: at a request a minute,
 * grouping is the difference between four minutes and one.
 */
cmds.check = async (args) => {
  const all = args.includes("--all");
  const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : Infinity;
  const store = items();
  if (!store.size) die("nothing to check yet — run `mq sync` (or `mq add <permalink>`)");

  const checked = checksById();
  // An item is due if nobody has looked, OR if the last look BROKE. A failed
  // read is not an answer, and letting one count as "checked" means a single
  // timeout retires a comment from the tool permanently while `status` reports
  // `error` about it forever. Same rule as everywhere else here: three
  // outcomes, never two.
  const settled = (it) => {
    const h = checked.get(it.id);
    return h?.length && h[h.length - 1].state !== "error";
  };
  const todo = [...store.values()].filter((it) => all || !settled(it));
  if (!todo.length) return console.log(`every item has a settled answer. \`mq check --all\` re-reads them — that is how a change gets caught.`);

  // group by conversation
  const groups = new Map();
  for (const it of todo) {
    const t = threadOf(it);
    if (!t) continue;
    (groups.get(t) ?? groups.set(t, []).get(t)).push(it);
  }
  const work = [...groups.entries()].slice(0, limit);
  console.log(`${todo.length} to check across ${groups.size} threads; doing ${work.length}.`);
  // A page turn each, in an Incognito tab of your own browser — and a thread
  // longer than one page costs a second read to settle.
  console.log(`Each thread is a page turn in an Incognito tab of your browser — the stranger's seat.\n`);

  const p = P();
  if (typeof p.threadPage !== "function") die(`${p.name} has no thread page this install can read`);
  const b = lane({ stranger: true, task: "mq check — as a stranger" });
  for (const [thread, group] of work) {
    const sub = roomOfUrl(thread);
    console.log(`${sub ? L().room(sub) : "?"}  ${group.length} of yours`);
    const t = await readPage(b, p.threadPage(thread));
    for (const it of group) {
      let verdict = classify(it, t);
      // Only the genuinely open question is worth another page.
      if (verdict.state === "inconclusive" && it.kind === "comment") {
        console.log(`    thread is longer than a page — reading the comment's own view`);
        const f = await readPage(b, p.commentPage(it.url));
        verdict = classify(it, t, f);
      }
      append("checks.jsonl", { id: it.id, at: now(), state: verdict.state, why: verdict.why, confident: verdict.confident, entries: t.ok ? t.entries.length : 0 });
      console.log(`    ${mark(verdict.state)} ${verdict.state.padEnd(12)} ${line(it)}`);
      if (!verdict.confident) console.log(`                    ${verdict.why}`);
    }
    // A lane that is dark stays dark for every thread after this one: the
    // error is on each of this group's checks (never a removal), and the
    // rest wait for the next run rather than each failing in turn.
    if (!t.ok && /not attached|no server|Incognito/i.test(t.error)) { console.log(`\n  ${t.error}`); break; }
  }
  await b.close();
  console.log(`\nmq status`);
};

/**
 * Phase 1 — who is waiting for you.
 *
 * Costs one read per comment, because the reply tree only exists in the
 * comment's own focused view; the flat thread feed carries no parent for
 * anything. Bounded by recency rather than by a page count: a reply to
 * something you wrote five months ago is not a conversation you can still walk
 * back into, and reading for it spends the same minute as one you can.
 */
cmds.back = async (args) => {
  const acct = account() || die("nobody to listen to yet — run: mq me <your-username>");
  const me = acct.name.toLowerCase();
  const days = args.includes("--days") ? Number(args[args.indexOf("--days") + 1]) : 14;
  const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : 25;
  const store = items();
  if (!store.size) die("nothing stored yet — run `mq sync`");

  const cutoff = Date.now() - days * 864e5;
  const checks = checksById();
  // A comment a stranger cannot see is not a comment anybody is replying to.
  // Skipping those is not an optimisation, it is the right answer — and it is
  // what makes Phase 0 worth having run first.
  const unseen = new Set(["filtered", "removed", "gone", "deleted"]);
  const todo = [...store.values()].filter((it) => {
    if (it.kind !== "comment") return false;
    if (it.at && Date.parse(it.at) < cutoff) return false;
    return !unseen.has(history(checks.get(it.id) ?? []).state);
  }).slice(0, limit);

  if (!todo.length) return console.log(`nothing from the last ${days} days that a stranger can still see. \`mq back --days 60\` looks further back.`);
  console.log(`${todo.length} of your comments from the last ${days} days.`);
  console.log(`One page each, in an Incognito tab of your browser — only a comment's own view carries its replies.\n`);

  const p = P();
  if (typeof p.commentPage !== "function") die(`${p.name} has no comment page this install can read`);
  const b = lane({ stranger: true, task: "mq back — as a stranger" });
  const waiting = [];
  for (const it of todo) {
    const f = await readPage(b, p.commentPage(it.url));
    if (!f.ok && /not attached|no server|Incognito/i.test(f.error)) { console.log(`  ${f.error}`); break; }
    const c = conversation(it, f, me);
    append("replies.jsonl", { id: it.id, at: now(), state: c.state, replies: c.replies ?? 0, latest: c.latest ?? null, since_you: c.since_you ?? false });
    noteReturn(it, c);
    if (c.state === "waiting") waiting.push({ it, c });
    process.stdout.write(`  ${c.state === "waiting" ? "!" : " "} ${c.state.padEnd(9)} ${(c.replies ?? 0)} repl${(c.replies ?? 0) === 1 ? "y" : "ies"}  ${line(it)}\n`);
  }

  await b.close();
  if (!waiting.length) return console.log(`\nNobody is waiting on you.`);
  console.log(`\n${waiting.length} waiting for you — oldest first, because that is the one going cold:\n`);
  for (const { it, c } of byUrgency(waiting.map(({ it, c }) => ({ it, c, at: c.at })))) {
    console.log(`  u/${c.latest.author} · ${ago(c.latest.at)}${c.since_you ? " · since you last spoke" : ""}`);
    console.log(`    they said: ${(c.latest.text || "").replace(/\s+/g, " ").slice(0, 150)}`);
    console.log(`    you said:  ${line(it)}`);
    console.log(`    ${c.latest.url || it.url}\n`);
  }
  console.log(`You answer these yourself, in your own words. Nothing here writes or sends anything.`);
};

/** One read of one of your comments, folded into the conversation it
 *  belongs to (if the operator opened one on "I posted it"). A reply this
 *  machine had not seen is the one event worth the specialist's inbox. */
const noteReturn = (it, c) => {
  const conv = [...conversationRows(S).values()].find((k) => k.comment_id === it.id);
  if (!conv) return null;
  const { row, fresh } = recordReturn(S, conv, c);
  if (fresh) S.note("reply.waiting", { id: row.id, author: row.latest?.author ?? null, place: row.place, campaign: row.campaign ?? null, url: row.latest?.url ?? row.url, title: `${row.latest?.author ?? "somebody"} wrote back in ${L().room(row.place)}`, text: String(row.latest?.text ?? "").slice(0, 300) });
  return row;
};

/** The return half of a tick: the conversations due a look, read from the
 *  stranger's seat. Returns how many were read, or -1 when the lane is dark. */
async function returnPass(due) {
  const acct = account();
  const me = acct?.name?.toLowerCase();
  if (!me || typeof P().commentPage !== "function") return 0;
  const store = items();
  const b = lane({ stranger: true, task: `mq tick — ${due.length} conversation${due.length === 1 ? "" : "s"} as a stranger` });
  let read = 0;
  for (const conv of due) {
    const it = store.get(conv.comment_id);
    if (!it) continue;
    const f = await readPage(b, P().commentPage(it.url));
    if (!f.ok && /not attached|no server|Incognito/i.test(f.error)) { console.log(`  ${f.error}`); await b.close(); return -1; }
    const c = conversation(it, f, me);
    append("replies.jsonl", { id: it.id, at: now(), state: c.state, replies: c.replies ?? 0, latest: c.latest ?? null, since_you: c.since_you ?? false });
    const row = noteReturn(it, c);
    read++;
    console.log(`  ${row?.state === "waiting" ? "!" : " "} ${String(c.state).padEnd(9)} ${row?.author ?? "?"} in ${L().room(conv.place)}`);
  }
  await b.close();
  return read;
}

/** The day's numbers into the specialist's inbox, at most once in 20 hours
 *  — or now, when something just came back. Counted, never tallied by a
 *  model. */
const noteDigest = ({ force = false } = {}) => {
  const last = readStash(DIR).digest_at;
  if (!force && last && Date.now() - Date.parse(last) < 20 * 3600_000) return false;
  const rows = campaignDigest(S, readCampaigns(DIR));
  const w = waitingRows(S).length;
  S.note("day.digest", { title: `${w} waiting on you · ${rows.reduce((n, r) => n + r.found, 0)} found in all`, text: digestText(rows), waiting: w, campaigns: rows });
  patchStash(DIR, { digest_at: now() });
  return true;
};

const ago = (iso) => {
  if (!iso) return "at some point";
  const h = (Date.now() - Date.parse(iso)) / 3600_000;
  if (!Number.isFinite(h)) return "at some point";
  if (h < 1) return "just now";
  if (h < 48) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

const mark = (s) => ({ visible: "  ", unlisted: " ?", filtered: " !", removed: " !", deleted: "  ", gone: " ?", inconclusive: " ?", error: " x" })[s] ?? "  ";
const line = (it) => {
  const body = (it.body || "").replace(/\s+/g, " ").trim();
  return (body || it.title || it.url || it.id).slice(0, 68);
};

/**
 * Where the models run, and which model has each seat. Three plans — paid,
 * free, local — and the picks are kept per plan, so trying the free one for
 * a week does not lose the paid writer you chose.
 */
cmds.models = async (args) => {
  const [sub, a, b] = args;
  if (sub === "use") setPlan(DIR, a || die("usage: mq models use <paid|free|local>"));
  else if (sub === "set") { if (!a || !b) die("usage: mq models set <judge|scout|writer> <model-id>"); choose(DIR, a, b); }
  else if (sub === "url") setLocal(DIR, { baseUrl: a || die("usage: mq models url <http://host:port/v1>") });
  else if (sub) die("usage: mq models [use <paid|free|local> | set <role> <model> | url <base-url>]");
  const p = plan(DIR), pick = chosen(DIR);
  console.log(`${PLANS[p].title} plan — ${PLANS[p].what}\n`);
  for (const r of Object.values(ROLES)) console.log(`  ${r.key.padEnd(7)} ${pick[r.key]}`);
  if (p === "local") {
    const { baseUrl } = localConfig(DIR);
    const pr = await probeLocal(baseUrl);
    console.log(`\n  ${baseUrl} — ${pr.ok
      ? `reachable, ${pr.models.length} model${pr.models.length === 1 ? "" : "s"} installed${pr.models.length ? `: ${pr.models.slice(0, 12).join(", ")}` : ""}`
      : pr.error}`);
    const missing = [...new Set(Object.values(pick))].filter((m) => pr.ok && !pr.models.includes(m));
    if (missing.length) console.log(`  not pulled yet: ${missing.map((m) => `ollama pull ${m}`).join("  ·  ")}`);
  } else {
    console.log(`\n  ${hasKey(DIR) ? `OpenRouter key: set (${keySource(DIR)})` : `no OpenRouter key — ${DIR}/openrouter.key or OPENROUTER_API_KEY; the free plan needs one too`}`);
    if (p === "free") console.log(`  free variants: 20 requests a minute, 50 a day (1,000 once $10 of credit was ever bought) — OpenRouter's limits, read 2026-09-01`);
  }
  console.log(`\nchange it:  mq models use <paid|free|local>  ·  mq models set <role> <model>  ·  mq models url <base-url>`);
};

/** The 404 finding, worded once. `sync` prints it the moment it happens and
 *  `status` prints it again off the read ledger — because an empty store is
 *  what a 404 leaves behind, and "nothing stored yet" would be the tool
 *  forgetting its own loudest finding the moment the terminal scrolled. */
const notFound = (name, at = null) => [
  `  404 — logged out, that profile does not render at all${at ? ` (read ${at.slice(0, 16).replace("T", " ")} UTC)` : ""}.`,
  ``,
  `  That is the site-wide signal. A suspended or shadowbanned account 404s to`,
  `  strangers while looking normal to you. Open your profile in a private window`,
  `  to confirm with your own eyes, then appeal${L().appeals ? ` at ${L().appeals.replace(/^https?:\/\/(www\.)?/, "")}` : " where the platform takes appeals"}.`,
].join("\n");

cmds.status = () => {
  const store = items(), checks = checksById(), acct = account();
  const pend = pending().length;
  const backlog = pend ? `\n  ${pend} found post${pend === 1 ? "" : "s"} waiting for a verdict — mq judge` : "";
  if (!store.size) {
    const r = acct?.name && typeof P().userPage === "function" ? S.lastReadOf(P().userPage(acct.name)) : null;
    if (r && !r.ok && r.err === "http_404") return console.log(notFound(acct.name, r.at) + backlog);
    return console.log("nothing stored yet — run `mq sync`." + backlog);
  }
  const tally = new Map();
  const unchecked = [];
  for (const it of store.values()) {
    const h = history(checks.get(it.id) ?? []);
    if (h.state === "unchecked") { unchecked.push(it); continue; }
    tally.set(h.state, (tally.get(h.state) ?? 0) + 1);
  }
  console.log(`${acct?.name ?? "?"} — ${store.size} things you said\n`);
  for (const [state, n] of [...tally].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${state.padEnd(13)} ${STATES[state]}`);
  }
  if (unchecked.length) console.log(`  ${String(unchecked.length).padStart(4)}  ${"unchecked".padEnd(13)} not looked at yet — mq check`);

  const invisible = [...store.values()].filter((it) => {
    const h = history(checks.get(it.id) ?? []);
    return h.state === "filtered" || h.state === "removed";
  });
  const seen = tally.get("visible") ?? 0;
  if (invisible.length && seen + invisible.length > 0) {
    const pct = Math.round((invisible.length / (seen + invisible.length)) * 100);
    console.log(`\n  ${pct}% of what a stranger could have read, they cannot.`);
  }

  // A change is the thing a private window cannot show you, so it leads.
  const moved = [];
  for (const it of store.values()) {
    const h = history(checks.get(it.id) ?? []);
    if (h.changed_at) moved.push({ it, h });
  }
  if (moved.length) {
    console.log(`\nchanged since the first look:`);
    for (const { it, h } of moved.slice(0, 10)) {
      console.log(`  ${h.changed_at.from} -> ${h.changed_at.to}  ${h.changed_at.at.slice(0, 16).replace("T", " ")}`);
      console.log(`     ${line(it)}\n     ${it.url}`);
    }
  }
  const never = [...store.values()].filter((it) => history(checks.get(it.id) ?? []).never_visible);
  if (never.length) console.log(`\n${never.length} never rendered to a stranger on any look we took.`);
  if (backlog) console.log(backlog);
};

cmds.log = (args) => {
  const id = args[0];
  const rows = readJsonl("checks.jsonl").filter((c) => !id || c.id === id);
  if (!rows.length) return console.log(id ? `no checks for ${id}` : "no checks yet.");
  const store = items();
  for (const c of rows.slice(-40)) {
    console.log(`${c.at.slice(0, 16).replace("T", " ")}  ${c.state.padEnd(12)} ${c.id}`);
    console.log(`   ${c.why}`);
  }
  if (id && store.get(id)) console.log(`\n${store.get(id).url}`);
};

/** §04, and it is also just correct: content deleted from Reddit should not
 *  live on here. The hash stays so an edit is still detectable; the words go. */
/**
 * Take what another machine already found, instead of reading it again.
 *
 * The hub costs a minute a request to fill, exactly as this would; the point is
 * that it costs a minute ONCE rather than once per person watching the same
 * room. Ten clients on five shared sources is fifty reads an hour done
 * separately and five done here.
 *
 * What arrives is public posts and nothing else. Everything that makes the
 * queue yours happens after this line and on this machine: the verdicts are
 * judged against YOUR rule.md, the drafts are written in YOUR voice, and
 * `contacted` is consulted here — so somebody you have already answered never
 * enters your queue, and the hub is never told that you answered them.
 *
 *   mq pull https://hub.example.com --token es_… [--limit 500]
 */
cmds.pull = async (args) => {
  const base = String(args[0] || die(`usage: mq pull <hub-url> --token <token>`)).replace(/\/+$/, "");
  const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : 500;

  // Cursors are per hub, so pulling from two of them does not make each one
  // skip what the other already advanced past. The token is remembered here
  // too, so a scheduled `mq pull <url>` needs no secret on its command line —
  // a token in a cron entry is a token in every process list on the machine.
  const cursorFile = F("pull.json");
  const state = existsSync(cursorFile) ? JSON.parse(readFileSync(cursorFile, "utf8")) : {};
  const token = (args.includes("--token") ? args[args.indexOf("--token") + 1] : null)
    ?? process.env.MQ_FEED_TOKEN ?? state[base]?.token;
  if (!token) die("no token — pass --token once and it is remembered, or set MQ_FEED_TOKEN");
  let cursor = state[base]?.cursor ?? "";

  const known = found(), gone = contacted(), p = pending();
  let added = 0, skipped = 0, pages = 0;

  for (;;) {
    const u = `${base}/feed?after=${encodeURIComponent(cursor)}&limit=${limit}`;
    let r;
    try {
      r = await fetch(u, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      die(`could not reach the hub: ${e.message}`);
    }
    if (r.status === 401) die("the hub refused that token");
    if (!r.ok) die(`the hub answered ${r.status}`);
    const body = await r.json();
    pages++;

    for (const it of body.items ?? []) {
      if (!it.id || known.has(it.id)) { skipped++; continue; }
      // Somebody you have already written to is not a new lead, ever. Checked
      // HERE rather than at the hub, because the hub must never be told who
      // that is.
      if (it.author && gone.has(String(it.author).toLowerCase())) { skipped++; continue; }
      const row = { ...it, via: base, pulled_at: now() };
      append("found.jsonl", row);
      known.set(it.id, row);
      p.push({ n: p.length + 1, id: it.id, probe: it.probe ?? `${base}:feed` });
      added++;
    }

    cursor = body.cursor ?? cursor;
    if (!body.more) break;
  }

  setPending(p);
  state[base] = { cursor, at: now(), token };
  writeFileSync(cursorFile, JSON.stringify(state, null, 2) + "\n");

  console.log(`${added} new from ${base}${skipped ? `, ${skipped} already known or already answered` : ""}${pages > 1 ? ` (${pages} pages)` : ""}.`);
  if (added) console.log(`\nThey are judged against YOUR rule.md, on this machine:  mq judge   (or press Judge in the dashboard)`);
  else console.log(`\nNothing new. The cursor is at ${cursor || "the beginning"}.`);
};

cmds.sweep = () => {
  const cutoff = Date.now() - BODY_TTL_MS;
  let n = 0, m = 0;

  const items_ = readJsonl("items.jsonl").map((r) => {
    if (r.body && Date.parse(r.seen_at) < cutoff) { n++; return { ...r, body: "", body_expired: true }; }
    return r;
  });
  rewrite("items.jsonl", items_);

  // Somebody else's words, which is the case §04 is actually about: your own
  // comments are yours, but a stranger's reply sitting on your disk for a month
  // is the thing the retention rule exists for.
  const replies = readJsonl("replies.jsonl").map((r) => {
    if (r.latest?.text && Date.parse(r.at) < cutoff) { m++; return { ...r, latest: { ...r.latest, text: "" }, text_expired: true }; }
    return r;
  });
  rewrite("replies.jsonl", replies);

  console.log(`${n} of your bodies and ${m} replies past 48h dropped.`);
  console.log(`Ids, urls, dates, hashes and every check and reply count are untouched.`);
};



/* ------------------------------------------------------- phase 2 — find */

/**
 * Try a room before committing to it.
 *
 * One read, then a decision that is a yes or a no rather than a score out of a
 * hundred. The refusals run BEFORE the read, because a room that forbids
 * promotion is not worth a request, let alone a place in a queue.
 */
cmds.probe = async (args) => {
  const place = String(args[0] || die(`usage: mq probe <room> --q "<phrase>" [--campaign <id>]`)).replace(/^\/?r\//, "").trim();
  const q = args.includes("--q") ? args[args.indexOf("--q") + 1] : null;
  const campaign = args.includes("--campaign") ? String(args[args.indexOf("--campaign") + 1] ?? "").toLowerCase() : null;
  if (campaign && !readCampaign(DIR, campaign)) die(`no campaign "${campaign}" — mq campaigns`);
  const label = L().room(place);

  if (isParody(place)) return refused(`${label} is a parody community — the platform's own convention for one. A competitor's picker put one of these top of its list at 100/100.`);
  const room = roomState(place);
  if (room.state === "banned") return refused(`${label} does not allow it — ${room.source ?? "recorded"}.`);

  const url = P().sourceUrl({ place, q });
  const no = P().refuse({ url });
  if (no) return refused(no);

  console.log(`probing ${label}${q ? ` for "${q}"` : " (new posts)"}${campaign ? ` under the campaign ${campaign}` : ""} — in a tab of your own browser\n`);
  const b = lane({ task: `mq probe ${label}` });
  const r = await readPage(b, url);
  if (!r.ok) { await b.close(); return console.log(`  could not read it: ${r.error}\n  That is a failed read, not a verdict on the room.`); }
  // A room that does not exist is answered by a silent redirect, with a 200.
  // Only the final URL gives it away.
  if (r.redirected) { await b.close(); return refused(`there is no ${label} — the page redirected to ${r.finalUrl}, which the platform does instead of 404ing.`); }

  // Free, and it catches the blunt cases.
  const desc = fromDescription(r.subtitle);
  if (desc.state === "banned") {
    await b.close();
    writeRoom(place, desc.quote);
    return refused(`${label}'s own description says: "${desc.quote}"`);
  }

  const known = found();
  const seen = new Set();
  const fresh0 = r.entries.filter((e) => e.kind === "post" && !known.has(e.id) && !seen.has(e.id) && seen.add(e.id));
  const filled = await fillBodies(b, fresh0);   // a person opens the ones that look like them
  await b.close();
  const tag = `${place}:${q ?? "new"}`;
  const fresh = filled.map((e) => ({ id: e.id, place, url: e.url, author: e.author, title: e.title,
    body: String(e.body ?? "").slice(0, 1200), body_sha256: sha(e.body ?? ""), posted_at: e.at, seen_at: now(), probe: tag, via: "browser",
    comments: Number.isFinite(Number(e.comments)) ? Number(e.comments) : null,
    ...(campaign ? { campaign } : {}) }));
  for (const f of fresh) append("found.jsonl", f);
  append("probes.jsonl", { place, q: q ?? null, url, read: fresh.length, at: now(), settled: false, via: "browser", ...(campaign ? { campaign } : {}) });

  const p = pending();
  for (const f of fresh) p.push({ n: p.length + 1, id: f.id, probe: tag });
  setPending(p);

  writeRoom(place, null);
  const bodies = fresh.filter((f) => f.body).length;
  console.log(`  ${r.entries.length} posts on the page, ${fresh.length} new to judge${bodies < fresh.length ? ` (${fresh.length - bodies} previewed only — the page showed no body and the ${P().bodiesPerRead}-per-read cap on opening posts was spent)` : ""}.`);
  console.log(`\n  Its rules are NOT readable from here — measured, and the public description is not the rules list.`);
  console.log(`  Read them once:  ${rulesUrl(place)}`);
  console.log(`  Then answer the line in ${roomPath(place)}`);
  console.log(`\n  Judge what came back:  mq pending    then    mq judge < verdicts.json`);
};

const refused = (why) => { console.log(`  refused — ${why}`); console.log(`  no source written. This is not a score, it is a no.`); };

const writeRoom = (place, found_) => {
  const p = roomPath(place);
  if (existsSync(p)) return;
  mkdirSync(join(DIR, "rooms"), { recursive: true });
  writeFileSync(p, roomFile(place, found_, { label: L().room(place), rulesUrl: P().rulesUrl?.(place) ?? null }));
};

/**
 * Findings from the BROWSER lane — the scout reading a search in the
 * operator's own signed-in session (skills/reddit/agent.md), where the
 * anonymous feed cannot go. stdin: { place, q, url, items: [{ id?, url,
 * author, title, body, posted_at }] }. Same table, same law as probe: the
 * room's refusals run first, ids are the platform's (t3_… off the permalink),
 * first write wins, everything new goes to pending for the judge, and the
 * read is recorded on probes.jsonl with `via: "browser"` so the fit rate
 * settles the same way. A page of posts is one call.
 */
cmds.found = (args, stdin) => {
  let body;
  try { body = JSON.parse(stdin); } catch { die("stdin is not JSON — expected { place, q, campaign?, items: [{ url, title, author, body }] }"); }
  const place = String(body?.place ?? "").replace(/^\/?r\//, "").replace(/[^\w-]/g, "");
  if (!place) die("no place — which room were these read in?");
  const label = L().room(place);
  const q = body.q ? String(body.q).slice(0, 120) : null;
  let campaign = body.campaign ? String(body.campaign).toLowerCase().slice(0, 40) : null;
  if (campaign && !readCampaign(DIR, campaign)) { console.log(`no campaign "${campaign}" in this project — recorded under the general fit instead.`); campaign = null; }
  if (isParody(place)) return refused(`${label} is a parody community — the platform's own convention for one. Nothing recorded.`);
  const room = roomState(place);
  if (room.state === "banned") return refused(`${label} does not allow it — ${room.source ?? "recorded"}. Nothing recorded.`);

  const known = found(), fresh = [];
  let dupes = 0, noId = 0;
  for (const it of (Array.isArray(body.items) ? body.items : []).slice(0, 200)) {
    const url = String(it?.url ?? "").split("?")[0];
    // The id is the platform's — off the permalink, by the adapter — so a
    // colleague cannot invent one and first-write-wins stays honest.
    const id = /^t[13]_[a-z0-9]+$/i.test(String(it?.id ?? "")) ? String(it.id) : ((platformFor(url) ?? P()).idOf?.(url) ?? null);
    if (!id) { noId++; continue; }
    if (known.has(id) || fresh.some((f) => f.id === id)) { dupes++; continue; }
    const text = String(it.body ?? "").slice(0, 1200);
    fresh.push({
      id, place, url, author: it.author ? String(it.author).replace(/^u\//, "").slice(0, 60) : null,
      title: String(it.title ?? "").slice(0, 300), body: text, body_sha256: sha(text),
      posted_at: it.posted_at ? String(it.posted_at).slice(0, 40) : null, seen_at: now(),
      comments: Number.isFinite(Number(it.comments)) ? Number(it.comments) : null,
      probe: `${place}:${q ?? "new"}`, via: "browser", ...(campaign ? { campaign } : {}),
    });
  }
  for (const f of fresh) append("found.jsonl", f);
  append("probes.jsonl", { place, q, url: body.url ? String(body.url).slice(0, 400) : null, read: fresh.length, at: now(), settled: false, via: "browser", ...(campaign ? { campaign } : {}) });
  const p = pending();
  for (const f of fresh) p.push({ n: p.length + 1, id: f.id, probe: `${place}:${q ?? "new"}` });
  setPending(p);
  writeRoom(place, null);

  console.log(`${fresh.length} new post${fresh.length === 1 ? "" : "s"} recorded from ${label}${q ? ` for "${q}"` : ""}${campaign ? ` under ${campaign}` : ""}${dupes ? `, ${dupes} already known` : ""}${noId ? `, ${noId} without a post permalink (skipped)` : ""}.`);
  if (fresh.length) console.log(`They wait on a verdict: mq pending, then mq judge — or the Judge button.`);
  if (room.state === "unanswered") console.log(`${label}'s rules are not readable from here — a human reads ${rulesUrl(place)} once and answers ${roomPath(place)}.`);
};

cmds.rooms = () => {
  const rows = readJsonl("probes.jsonl");
  const places = [...new Set(rows.map((r) => r.place))];
  if (!places.length) return console.log(`no rooms probed yet — \`mq probe <room> --q "<phrase>"\``);
  for (const place of places) {
    const st = roomState(place);
    const flag = st.state === "allowed" ? "ok " : st.state === "banned" ? "NO " : "?  ";
    console.log(`${flag} ${L().room(place).padEnd(26)} ${st.state === "unanswered" ? `rules unread — ${rulesUrl(place)}` : st.state}`);
  }
  console.log(`\nA room stays unwatchable until its file answers. That is deliberate.`);
};

/**
 * Commit a probed room to the watch list.
 *
 * Refuses on: unread rules, a room that bans it, a shape measured dead, and a
 * probe that did not clear the floor. Four ways to say no and one to say yes.
 */
cmds.watch = (args) => {
  const place = String(args[0] || die(`usage: mq watch <room> [--q "<phrase>"] [--campaign <id>]`)).replace(/^\/?r\//, "").trim();
  const q = args.includes("--q") ? args[args.indexOf("--q") + 1] : null;
  const campaign = args.includes("--campaign") ? String(args[args.indexOf("--campaign") + 1] ?? "").toLowerCase() : null;
  if (campaign && !readCampaign(DIR, campaign)) die(`no campaign "${campaign}" — mq campaigns`);
  const id = `${place}:${q ?? "new"}`.toLowerCase();
  const label = L().room(place);

  if (isParody(place)) return refused(`${label} is a parody community.`);
  const room = roomState(place);
  if (room.state === "banned") return refused(`${label} does not allow it — ${room.source ?? "recorded"}.`);
  if (room.state === "unanswered")
    return refused(`nobody has read ${label}'s rules yet.\n  Read them: ${rulesUrl(place)}\n  Then answer the line in ${roomPath(place)}`);

  const url = P().sourceUrl({ place, q });
  const no = P().refuse({ url });
  if (no) return refused(no);

  // The probe has to have cleared the floor. A source nobody measured is the
  // thing that filled the predecessor's queue with 804 rows nobody consumed.
  const v = verdicts();
  const mine = [...found().values()].filter((f) => f.probe === `${place}:${q ?? "new"}`);
  const judged = mine.filter((f) => v.has(f.id));
  if (!judged.length) return refused(`nothing from ${label} has been judged yet — run \`mq probe\`, then \`mq judge\`.`);
  const decision = verdictOf({ read: judged.length, fit: judged.filter((f) => v.get(f.id).fit).length });
  if (!decision.commit) return refused(decision.why);

  if (sources().some((x) => x.id === id)) return console.log(`already watching ${id}`);
  append("sources.jsonl", { id, place, q, url, cadence_min: 60, added: now(), ...(campaign ? { campaign } : {}) });
  console.log(`watching ${id}${campaign ? ` under ${campaign}` : ""} — ${decision.why}`);
};

cmds.unwatch = (args) => {
  const id = String(args[0] || die("usage: mq unwatch <source-id>")).toLowerCase();
  append("sources.jsonl", { id, deleted: true, at: now() });
  console.log(`stopped watching ${id}. What it already found is untouched.`);
};

cmds.sources = () => {
  const all = sources();
  if (!all.length) return console.log("watching no sources yet.");
  const lr = new Map(readJsonl("reads.jsonl").filter((r) => r.source).map((r) => [r.source, r]));
  const seen = [...found().values()];
  for (const s of all) {
    const r = lr.get(s.id);
    console.log(`${s.id.padEnd(34)} ${String(seen.filter((f) => f.probe === s.id).length).padStart(4)} found   ${!r ? "never read" : r.ok ? `read ${r.at.slice(0, 16).replace("T", " ")}` : `ERROR ${r.err ?? ""}`}${s.campaign ? `   campaign ${s.campaign}` : ""}`);
  }
};

/** The platforms this install can read. One today, on purpose — the contract
 *  in skills/README.md grows by extraction from a mastered platform, not by
 *  speculation about unmeasured ones. */
cmds.platforms = () => {
  for (const p of platforms()) {
    console.log(`${p.id.padEnd(12)} ${p.name.padEnd(10)} ${p.origin.padEnd(9)} page turns at least ${Math.round(p.gapMs / 1000)}s apart, in your own browser`);
  }
  console.log(`\nA platform is a skill: a folder with a SKILL.md and an adapter.mjs.`);
  console.log(`Built-in ones live in skills/; drop your own into ${DIR}/skills/ and it loads.`);
  console.log(`The contract is skills/README.md.`);
};

/** The whole registry, not just the platforms: what runs, what is stuck on a
 *  choice, what refused to load — with the fix printed beside each. */
cmds.skills = async (args) => {
  if (args[0] === "use") {
    const [, slot, id] = args;
    if (!slot || !id) die("usage: mq skills use <slot> <id>   (or: mq skills use <slot> --clear)");
    writeChoice(DIR, slot, id === "--clear" ? null : id);
    await loadPlatforms(DIR); // re-resolve now, so the line below tells the truth
    const active = skillState().active.find((s) => s.provides === slot);
    console.log(active ? `${slot} → ${active.id}` : `${slot} → nobody (no active skill provides it)`);
    return;
  }
  const st = skillState();
  for (const s of st.active)
    console.log(`${s.id.padEnd(14)} ${(s.ring === "local" ? "yours" : "built-in").padEnd(9)} ${(s.provides ?? "knowledge").padEnd(22)} ${Object.keys(s.seats).join(", ") || "—"}`);
  for (const c of st.conflicts)
    console.log(`\n! ${c.slot} — ${c.why}\n  fix: mq skills use ${c.slot} <${c.candidates.join("|")}>`);
  for (const r of st.refused)
    console.log(`\nx ${r.id} (${r.ring}) — ${r.why}`);
  if (!st.conflicts.length && !st.refused.length)
    console.log(`\nEverything discovered is running. New skills: skills/README.md, CONTRIBUTING.md.`);
};

/** Read every source whose cadence is up. Plain code — there is no model in
 *  this loop, and that is the point of §07: the agent takes the rare supervised
 *  jobs, never the one that runs all day. */
cmds.tick = async (args) => {
  const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : Infinity;
  const lr = new Map(readJsonl("reads.jsonl").filter((r) => r.source).map((r) => [r.source, r]));
  const due = sources().filter((s) => {
    const r = lr.get(s.id);
    return !r || Date.now() - Date.parse(r.at) >= s.cadence_min * 60_000;  // never read is always due
  }).slice(0, limit);
  // The return half: conversations the operator opened, bound to their own
  // comments, not looked at in twelve hours. A reply going cold costs more
  // than a missed post, so it runs even when no source is due.
  const dueC = dueConversations(S);
  if (!due.length && !dueC.length) { noteDigest(); return console.log("nothing is due."); }
  if (due.length) console.log(`${due.length} source${due.length === 1 ? "" : "s"} due — read in a tab of your own browser, a page turn every few seconds.\n`);

  const known = found(), gone = contacted();
  const p = pending();
  let total = 0;
  let dark = false;
  const b = due.length ? lane({ task: `mq tick — ${due.length} source${due.length === 1 ? "" : "s"}` }) : null;
  for (const s of due) {
    const r = await readPage(b, s.url, { source: s.id });
    if (!r.ok) { console.log(`  ${s.id}: ${r.error}`); if (/not attached|no server/i.test(r.error)) { dark = true; break; } continue; }
    const seen = new Set();
    const fresh0 = r.entries.filter((e) => e.kind === "post" && !known.has(e.id) && !seen.has(e.id) && seen.add(e.id)
      && !(e.author && gone.has(e.author.toLowerCase())));
    const filled = await fillBodies(b, fresh0);
    let fresh = 0;
    for (const e of filled) {
      // Somebody you have already written to is not a new lead, ever, and
      // across every project. This is the check that makes a queue trustworthy
      // — asked again here because the author may only be known after the
      // post's own page was read.
      if (e.author && gone.has(e.author.toLowerCase())) continue;
      const row = { id: e.id, place: s.place, url: e.url, author: e.author, title: e.title,
        body: String(e.body ?? "").slice(0, 1200), body_sha256: sha(e.body ?? ""), posted_at: e.at, seen_at: now(), probe: s.id, via: "browser",
        comments: Number.isFinite(Number(e.comments)) ? Number(e.comments) : null,
        ...(s.campaign ? { campaign: s.campaign } : {}) };
      append("found.jsonl", row); known.set(e.id, row);
      p.push({ n: p.length + 1, id: e.id, probe: s.id });
      fresh++; total++;
    }
    console.log(`  ${s.id}: ${r.entries.length} read, ${fresh} new`);
  }
  if (b) await b.close();
  setPending(p);
  if (due.length) console.log(`\n${total} new to judge — mq pending`);

  let back = 0;
  if (dueC.length && !dark) {
    console.log(`\n${dueC.length} conversation${dueC.length === 1 ? "" : "s"} due a look — the comment's own page, in an Incognito tab.\n`);
    back = await returnPass(dueC);
    if (back < 0) console.log(`  the stranger's seat is not open — Chrome needs "Allow in Incognito" for the extension; the conversations stay due.`);
  }
  const w = waitingRows(S).length;
  if (w) console.log(`\n${w} waiting on you — mq waiting`);
  const ub = unbound(S).length;
  if (ub) console.log(`${ub} conversation${ub === 1 ? "" : "s"} not yet found on your profile — mq sync binds them.`);
  noteDigest({ force: back > 0 && w > 0 });
};

/** Who wrote back and is waiting on you, from the conversations this
 *  machine tracks. Oldest first — that is the one going cold. */
cmds.waiting = (args) => {
  const rows = waitingRows(S).map((c) => ({ id: c.id, author: c.latest?.author ?? c.author, place: c.place, campaign: c.campaign ?? null, url: c.latest?.url ?? c.url, at: c.latest?.at ?? null, turns: (c.turns ?? []).length, they_said: String(c.latest?.text ?? "").slice(0, 300), you_said: String((c.turns ?? []).filter((t) => t.by === "you").pop()?.text ?? "").slice(0, 300) }));
  if (args.includes("--json")) return console.log(JSON.stringify(rows, null, 2));
  const all = [...conversationRows(S).values()].filter((c) => c.state !== "closed");
  if (!rows.length) return console.log(`nobody is waiting on you. ${all.length} conversation${all.length === 1 ? "" : "s"} tracked${unbound(S).length ? `, ${unbound(S).length} not yet found on your profile (mq sync)` : ""}.`);
  console.log(`${rows.length} waiting for you — oldest first:\n`);
  for (const r of rows) {
    console.log(`  ${r.id}  u/${r.author} in ${L().room(r.place)} · ${ago(r.at)}${r.campaign ? `  [${r.campaign}]` : ""}`);
    console.log(`    they said: ${r.they_said.replace(/\s+/g, " ").slice(0, 150)}`);
    console.log(`    you said:  ${r.you_said.replace(/\s+/g, " ").slice(0, 150)}`);
    console.log(`    ${r.url}\n`);
  }
  console.log(`mq draft <id> writes the next turn's material; you post it yourself.`);
};

cmds.pending = () => {
  const p = pending(), all = found();
  if (!p.length) return console.log("nothing waiting on a verdict.");
  console.log(JSON.stringify(p.map((x) => {
    const it = all.get(x.id);
    return { n: x.n, author: it?.author ?? null, title: it?.title ?? "", body: (it?.body ?? "").slice(0, 1200), comments: it?.comments ?? null, posted_at: it?.posted_at ?? null };
  }), null, 2));
};

/** stdin: [{n, fit, why}]. The model lives OUTSIDE this process — the store
 *  never calls one, which is what keeps the tool free, local and swappable. */
cmds.judge = (args, stdin) => {
  const p = pending();
  if (!p.length) die("nothing pending to judge");
  let vs;
  try { vs = JSON.parse(stdin); } catch { die("stdin is not JSON — expected [{n, fit, why}]"); }
  if (!Array.isArray(vs)) die("expected a JSON array of [{n, fit, why}]");
  const rule = ruleHash();
  const byN = new Map(p.map((x) => [x.n, x.id]));
  const all = found();
  const seen = new Set();
  let fits = 0;
  for (const v of vs) {
    const id = byN.get(v.n);
    if (!id) { console.error(`  no item numbered ${v.n} — skipped`); continue; }
    // A verdict under a campaign carries the campaign's rubric hash beside
    // rule.md's, so "the queue changed" is answerable for both.
    const c = all.get(id)?.campaign ? readCampaign(DIR, all.get(id).campaign) : null;
    append("verdicts.jsonl", { id, fit: !!v.fit, why: v.why ?? "", rule, ...(c ? { campaign: c.id, campaign_hash: c.hash } : {}), at: now() });
    seen.add(v.n);
    if (v.fit) fits++;
  }
  const missing = p.filter((x) => !seen.has(x.n));
  setPending(missing);
  console.log(`judged ${seen.size} · ${fits} queued · rubric ${rule}`);
  // Unjudged is its own state, and it is loud. It is not a no.
  if (missing.length) console.log(`${missing.length} came back with NO VERDICT and stay pending — run judge again`);

  // Settle any probe these items belonged to.
  for (const probe of new Set(p.map((x) => x.probe).filter(Boolean))) {
    const v = verdicts();
    const rows = [...found().values()].filter((f) => f.probe === probe && v.has(f.id));
    if (!rows.length) continue;
    const d = verdictOf({ read: rows.length, fit: rows.filter((f) => v.get(f.id).fit).length });
    console.log(`  ${probe}: ${d.why}`);
    if (d.commit) console.log(`    commit it with:  mq watch ${probe.split(":")[0]}${probe.endsWith(":new") ? "" : ` --q "${probe.split(":").slice(1).join(":")}"`}`);
  }
};

cmds.queue = (args) => {
  const v = verdicts(), m = lastById("marks.jsonl"), all = found(), gone = contacted();
  const rows = [];
  for (const [id, ver] of v) {
    if (!ver.fit || m.has(id)) continue;
    const it = all.get(id);
    if (!it) continue;
    if (it.author && gone.has(it.author.toLowerCase())) continue;
    rows.push({ ...it, why: ver.why });
  }
  rows.sort((a, b) => (b.posted_at ?? b.seen_at).localeCompare(a.posted_at ?? a.seen_at));
  if (args.includes("--json")) return console.log(JSON.stringify(rows, null, 2));
  if (!rows.length) return console.log("queue is empty.");
  for (const r of rows) {
    console.log(`\n${r.id}  ${L().room(r.place)}  ${(r.posted_at ?? r.seen_at).slice(0, 16).replace("T", " ")}  ${r.author ?? "?"}${r.campaign ? `  [${r.campaign}]` : ""}`);
    console.log(`  ${(r.title || "").slice(0, 90)}`);
    console.log(`  ${(r.body || "").replace(/\s+/g, " ").slice(0, 160)}`);
    console.log(`  ${r.url}`);
  }
  console.log(`\n${rows.length} waiting. You write and send these yourself.`);
};

cmds.mark = (args) => {
  const [id, mark] = args;
  if (!id || !["sent", "skip"].includes(mark)) die("usage: mq mark <item-id> <sent|skip> [--anyway]");
  const it = found().get(id) || die(`no such item: ${id}`);

  // The gate. It fires before the mark is written, and only on `sent` — a skip
  // is not a reply. Cancel is the default and "post anyway" is the weaker
  // option, which is the one pattern worth taking wholesale from a competitor;
  // what is NOT taken is their fixed seven-day timer, because a timer is not a
  // safety check.
  if (mark === "sent" && !args.includes("--anyway")) {
    const place = it.place ?? roomOfUrl(it.url) ?? "?";
    const b = burst(sentLog(), place);
    const stand = readiness(standing([...items().values()], checksById()).get(place), roomState(place));
    const stop = b ? b.why : stand.state === "not ready" ? `you are not ready in ${L().room(place)} — ${stand.why}` : null;
    if (stop) {
      console.log(`  not logged — ${stop}.\n`);
      console.log(`  The shape that cost this project its visibility was eleven replies in`);
      console.log(`  83.9 minutes across seven subreddits with no history in any of them.`);
      console.log(`  The limits here are ${PER_ROOM_24H} a room and ${OVERALL_24H} overall in 24 hours.\n`);
      console.log(`  If you have already posted it, say so:  mq mark ${id} sent --anyway`);
      return;
    }
  }
  append("marks.jsonl", { id, mark, at: now() });
  if (mark === "sent") {
    const last = readJsonl("drafts.jsonl").filter((d) => d.id === id).pop();
    openConversation(S, it, { text: last?.text ?? "", via: "cli" });
  }
  if (mark === "sent" && it.author) {
    // Permanent, and across every project. Cheaper to write than to explain
    // why the same person turned up twice.
    append("contacted.jsonl", { author: it.author, id, at: now() });
    console.log(`logged as answered: ${id}\n  ${it.author} will never appear in a queue again — in any project.`);
  } else console.log(mark === "sent" ? `logged as answered: ${id}` : `discarded: ${id}`);
};

/* ------------------------------------------------------ phase 3 — draft */

const voiceOf = () => (existsSync(F("voice.json")) ? JSON.parse(readFileSync(F("voice.json"), "utf8")) : null);
const meFile = () => (existsSync(F("me.md")) ? readFileSync(F("me.md"), "utf8") : "");

/**
 * Measure how you write, from what you have already written.
 *
 * Phase 0 already stores your own comments, so this needs no new reads and no
 * persona menu — the samples are your actual words. Presence is decisive at one
 * sample and absence is never decisive below five, so a thin corpus produces a
 * mostly-empty fingerprint, which renders NO instructions at all. That is the
 * correct outcome, not a gap to fill with a default.
 */
cmds.voice = () => {
  const bodies = [...items().values()].map((i) => i.body).filter((b) => b && b.length >= MIN_SAMPLE_CHARS);
  const measured = measureVoice(bodies);
  const merged = mergeVoice(measured, voiceOf()?.user ?? null);
  writeFileSync(F("voice.json"), JSON.stringify({ measured, user: voiceOf()?.user ?? null, at: now(), samples: bodies.length }, null, 2));

  const all = [...items().values()].filter((i) => i.body).length;
  console.log(`${bodies.length} of your comments were long enough to measure${all > bodies.length ? ` (${all - bodies.length} were under ${MIN_SAMPLE_CHARS} characters)` : ""}.\n`);
  const rules = voiceRules(merged);
  const summary = voiceSummary(merged);
  console.log(`${summary ?? "Nothing about your style is measurable yet, and nothing is being guessed."}\n`);
  for (const r of rules) console.log(`  - ${r}`);
  if (!summary) {
    // Exactly one rule fires with no evidence, and saying why stops it looking
    // like a default that crept in. Absence is not decisive below five samples;
    // the em dash is the one case where the unknown state is a ban, because a
    // model left alone reaches for it every time.
    console.log(`\nThat one rule applies with no evidence, deliberately. Every other dimension`);
    console.log(`stays silent until your own comments show it — run \`mq sync\` for more samples.`);
  }
  console.log(`\nCorrect any line by editing ${DIR}/voice.json — what you say beats what was measured.`);
};

/**
 * The material for answering one person. It writes nothing.
 *
 * Everything below is assembled from what is already on disk. The model, if you
 * use one, runs outside this process like the judge does — which is what keeps
 * this free, local and swappable.
 */
cmds.draft = (args, stdin) => {
  const id = args[0] || die("usage: mq draft <item-id>   (then: mq draft <item-id> --save < reply.txt)");
  const it = found().get(id) || die(`no such item: ${id}`);
  const fp = mergeVoice(voiceOf()?.measured ?? null, voiceOf()?.user ?? null);

  if (args.includes("--save")) return saveDraft(it, stdin, fp, { turn: (() => { const k = conversationRows(S).get(id); return k && k.state !== "closed" && yourTurns(k) > 0 ? yourTurns(k) + 1 : 1; })() });

  // The campaign this person came in under, if any: its direction is the
  // idea the writer applies, its mention rule decides the stage, and what
  // was already said under it is shown so "in your own words" is checkable.
  const c = it.campaign ? readCampaign(DIR, it.campaign) : null;
  // They wrote back: the stage is a conversation, whatever the campaign's
  // mention rule said for the opener. Read off the facts, never configured.
  const conv = conversationRows(S).get(id);
  const turn = conv && conv.state !== "closed" && yourTurns(conv) > 0 ? yourTurns(conv) + 1 : 1;
  const stage = turn > 1 ? "conversation" : c?.mention === "disclosed" ? "disclosed" : "opener";
  const me = meFile().trim();
  const note = args.includes("--note") ? String(args[args.indexOf("--note") + 1] ?? "").trim() : "";
  console.log(turn > 1 ? `# Answer this person — turn ${turn}\n` : `# Answer this person\n`);
  console.log(`${it.author ?? "?"} in ${L().room(it.place)} — ${it.url}${c ? `\nCampaign: ${c.name} (${c.id}, mention: ${c.mention})` : ""}\n`);
  console.log(`## What they said\n\n${it.title ? `**${it.title}**\n\n` : ""}${(it.body || "").slice(0, 1600)}\n`);
  if (turn > 1) {
    console.log(`## The exchange so far\n`);
    for (const t of conv.turns ?? []) console.log(`--- ${t.by === "you" ? "you" : `u/${t.author ?? "them"}`} · ${String(t.at ?? "").slice(0, 16).replace("T", " ")} ---\n${String(t.text ?? "").slice(0, 1600)}\n`);
    console.log(`## What they wrote back — answer THIS\n\n${String(conv.latest?.text ?? (conv.turns ?? []).filter((t) => t.by === "them").pop()?.text ?? "").slice(0, 1600)}\n`);
  }
  console.log(`## How to write it\n`);
  console.log(signalWritingRules({
    intent: "leads", stage,
    pitch: firstLine(me) || "(nothing in me.md yet — write it, or this is guesswork)",
    problem: null, style: null, styleNotes: null, voice: fp,
  }).trim());
  if (note) {
    const prior = readJsonl("drafts.jsonl").filter((d) => d.id === id && (d.turn ?? 1) === turn).pop();
    console.log(`\n## What the operator said about the last draft — this outranks everything above except the refusals\n\n${note}\n`);
    if (prior) console.log(`The draft they were looking at:\n\n--- rejected ---\n${prior.text}\n--- end ---\n\nWrite a different reply that does what the note asks. Do not lightly edit the rejected one.`);
  }
  const risks = communityRisks(it.url, P().id, stage === "conversation" ? "conversation" : "opener");
  if (risks.length) { console.log(`\n## Where you are writing\n`); for (const r of risks) console.log(`- ${r}`); }
  if (c) {
    const said = readJsonl("drafts.jsonl").filter((d) => d.campaign === c.id && d.id !== it.id).map((d) => d.text);
    console.log(`\n## The campaign\n\n${writerBlock(c, { said })}`);
  }

  // §15 keeps this block: named axes of difference, labels the writer chooses,
  // and one option being a correct answer.
  console.log(`\n## Three options, differing by MOVE\n`);
  console.log(`Three ways of saying one sentence is a worse product than one good reply, and you can tell instantly.`);
  console.log(`Different approaches means: answering the literal question versus answering what is behind it;`);
  console.log(`leading with the specific detail versus leading with the shared experience; solving it outright`);
  console.log(`versus pointing them at whoever already solved it. If there is only ONE honest thing to say here,`);
  console.log(`write one — that is a correct answer and a better one than padding.`);
  console.log(`\nEach option carries a SHORT NAME you write, one or two words, naming what actually differs:`);
  console.log(`"direct", "story first", "just the link", "asks back". Never "option 2".`);
  console.log(`\nUnder ${lengthCeiling(fp)} characters.`);
  if (me) console.log(`\n## What you can honestly say about yourself\n\n${me.slice(0, 1200)}`);
  else console.log(`\n## me.md is empty\n\nWrite ${DIR}/me.md — what you have actually built. Every first-person claim gets checked against it.`);
  console.log(`\n---\nWhen you have a draft:  mq draft ${id} --save < reply.txt`);
};

const firstLine = (s) => String(s).split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#")) ?? "";

/** The two hard refusals, plus the one the store already had. Nothing is
 *  rejected outright — you are the one sending it — but nothing is quiet
 *  either. */
const saveDraft = (it, text, fp, { turn = 1 } = {}) => {
  const body = String(text ?? "").trim();
  if (!body) die("no draft text on stdin");
  // Everything you have drafted for SOMEBODY ELSE. Revisions of this same item
  // are excluded deliberately: rewriting one reply is not repeating yourself,
  // and flagging it would train you to ignore the warning that matters.
  const priors = readJsonl("drafts.jsonl").filter((d) => d.id !== it.id).map((d) => ({ id: d.id, text: d.text }));

  const rep = repeats(body, priors);
  const said = claims(body);
  const links = inventedLinks(body, `${it.body} ${it.url}`);
  const tell = tells(body, fp);
  append("drafts.jsonl", { id: it.id, url: it.url, text: body, at: now(), turn, ...(it.campaign ? { campaign: it.campaign } : {}), flags: { repeat: rep?.length ?? 0, claims: said.length, links: links.length, tells: tell.length } });
  console.log(`draft saved for ${it.id}${turn > 1 ? ` (turn ${turn})` : ""}\n`);

  if (rep) {
    console.log(`!! REPEATED PHRASING — ${rep.length} identical consecutive words you have used before:`);
    console.log(`   "${rep.phrase}"`);
    console.log(`   Reddit names "the same or similar comments across communities" as reportable spam — and a campaign is a direction, never a template.`);
    console.log(`   The corpus this was measured on shared a 26-word run while its duplicate check reported clean.\n`);
  }
  if (links.length) {
    console.log(`!! INVENTED LINK — not present in the thread we read:`);
    for (const u of links) console.log(`   ${u}`);
    console.log(`   Delete it. It is a checkable false statement under your own name.\n`);
  }
  if (said.length) {
    console.log(`?? CLAIMS ABOUT YOU — each is either true or it is the thing that ends the account:`);
    for (const c of said) console.log(`   "${c.sentence}"`);
    console.log(`   Check each against ${DIR}/me.md. A competitor posted "at my last job i used <product>"`);
    console.log(`   into a clinical thread under a real name. Nobody had ever had that job.\n`);
  }
  if (tell.length) {
    console.log(`?? READS LIKE A TEMPLATE — ${tell.length} phrase${tell.length === 1 ? "" : "s"} nobody types to one person: ${tell.map((t) => `"${t}"`).join(", ")}`);
    console.log(`   Rewrite those sentences in your own words. They are what makes a comment read as generated.\n`);
  }
  if (!rep && !links.length && !said.length && !tell.length) console.log(`No repeated phrasing, no invented links, no claims about your history, no template phrases.`);
  console.log(`You send it yourself, from your own account. Nothing here posts.`);
};

/* ------------------------------------------------------- phase 4 — the gate */

/** Everything you have marked as answered, with the room it was in. The
 *  governor's whole input. */

/**
 * Where you stand, room by room.
 *
 * §06 calls this the shareable artifact, and the reasoning is worth keeping in
 * front of whoever changes it: nobody screenshots a lead queue, because it is
 * private and slightly embarrassing. People absolutely screenshot a tool that
 * told them no. So this is built to be legible on its own, out of context, to
 * somebody who does not have the tool.
 */
cmds.ready = (args) => {
  const only = args[0] ? String(args[0]).replace(/^\/?r\//, "") : null;
  const mine = [...items().values()];
  const rooms = standing(mine, checksById());

  // Rooms you have probed but never spoken in are the ones most worth showing:
  // an empty row here is the whole point of the command.
  for (const pr of readJsonl("probes.jsonl")) if (!rooms.has(pr.place)) rooms.set(pr.place, null);
  for (const src of sources()) if (!rooms.has(src.place)) rooms.set(src.place, null);

  const names = [...rooms.keys()].filter((p) => !only || p.toLowerCase() === only.toLowerCase()).sort();
  if (!names.length) return console.log(only ? `nothing known about ${L().room(only)} yet.` : `no rooms yet — \`mq sync\` to read your own history, or \`mq probe <room>\`.`);

  for (const place of names) {
    const r = rooms.get(place);
    const v = readiness(r, roomState(place));
    const label = { ready: "ready    ", thin: "thin     ", unknown: "unknown  ", "not ready": "not ready" }[v.state];
    console.log(`  ${label}  ${L().room(place)}`);
    console.log(`             ${wrap(v.why, 66, "             ")}`);
    if (r?.quiet_days != null && r.quiet_days > 14 && v.state !== "not ready")
      console.log(`             last comment ${r.quiet_days} days ago`);
  }

  // The mirror, and the sentence that stops it becoming a promise.
  const sent = sentLog();
  const m = mix(mine.filter((i) => i.kind === "comment").length, sent.length);
  console.log(`\n  ${m.seen} of your comments seen · ${m.outreach} answered from the queue${m.ratio ? ` · about ${m.ratio.toFixed(1)} to 1` : ""}`);
  console.log(`  ${wrap(m.note, 74, "  ")}`);
  console.log(`\n  ${wrap(CQS_NOTE, 74, "  ")}`);
};

const wrap = (text, width, pad) => {
  const out = []; let line = "";
  for (const w of String(text).split(/\s+/)) {
    if ((line + " " + w).trim().length > width) { out.push(line.trim()); line = w; } else line += " " + w;
  }
  if (line.trim()) out.push(line.trim());
  return out.join(`\n${pad}`);
};

/* -------------------------------------------------- campaigns, projects */

/** Campaigns: directions, never templates (lib/campaigns.mjs). Proposed by
 *  the specialist on the panel and written by the operator's Save, or
 *  written by hand; listed and paused here. */
cmds.campaigns = (args) => {
  const all = readCampaigns(DIR);
  if (args.includes("--json")) return console.log(JSON.stringify(all, null, 2));
  if (!all.length) return console.log(`no campaigns yet. Describe a tactic to the specialist on the panel and it proposes one as cards — or write ${join(DIR, "campaigns")}/<id>.md by hand (the shape is in lib/campaigns.mjs).`);
  for (const c of all) console.log(`${c.status === "active" ? "on " : "off"} ${c.id.padEnd(28)} ${c.name.slice(0, 40).padEnd(40)} mention: ${c.mention.padEnd(9)} rubric ${c.hash}`);
  console.log(`\nA campaign is a direction, never a template: the writer applies it to one person at a time, in its own words, and a draft that repeats eight words of an earlier one is flagged.`);
};

cmds.campaign = (args) => {
  const [verb, id] = args;
  if (verb === "pause" || verb === "resume") {
    const r = setCampaignStatus(DIR, String(id ?? ""), verb === "pause" ? "paused" : "active");
    if (r.error) die(r.error);
    return console.log(`${r.id}: ${r.status}`);
  }
  if (verb === "show") {
    const c = readCampaign(DIR, String(id ?? ""));
    if (!c) die(`no campaign "${id}" — mq campaigns`);
    return console.log(readFileSync(c.path, "utf8"));
  }
  die("usage: mq campaign show|pause|resume <id>");
};

/** Projects: one isolated context each (lib/projects.mjs). The root is the
 *  default project; every verb acts on the current one. */
cmds.projects = (args) => {
  const all = listProjects(ROOT);
  if (args.includes("--json")) return console.log(JSON.stringify(all, null, 2));
  for (const p of all) console.log(`${p.current ? "* " : "  "}${p.id.padEnd(24)} ${p.name.slice(0, 30).padEnd(30)} ${p.dir}`);
  console.log(`\nEvery verb acts on the current project (*). mq project use <id> switches; mq project new "<name>" starts another — complete, isolated, its setup on the panel.`);
};

cmds.project = (args) => {
  const [verb, ...rest] = args;
  if (verb === "new") {
    const r = createProject(ROOT, rest.join(" "));
    if (r.error) die(r.error);
    return console.log(`made ${r.id} at ${r.dir} — and switched to it.\nIts setup starts on the panel: the account, the site, your voice, the first room. The key, the seats and the people you have already answered are shared; everything else is its own.`);
  }
  if (verb === "use") {
    const r = useProject(ROOT, rest[0]);
    if (r.error) die(r.error);
    return console.log(`now on ${r.id} (${r.name}) — ${r.dir}`);
  }
  die('usage: mq project new "<name>" | mq project use <id>');
};

/** The dashboard. Imported rather than shelled out to, so one process, one
 *  store, and ctrl-c stops the thing you started. */
cmds.serve = async (args) => {
  const { serve } = await import("./serve.mjs");
  await serve(args.includes("--port") ? Number(args[args.indexOf("--port") + 1]) : 8787);
  await new Promise(() => {});   // hold the process open until ctrl-c
};

/* ------------------------------------------------------------------- main */

const [, , cmd, ...args] = process.argv;
if (!cmd || !cmds[cmd]) {
  console.log(`Messaging Quest — your marketing specialist, one card at a time.
Every read below happens in a tab of YOUR browser (keep \`mq serve\` running,
Chrome open, the extension loaded); the stranger's view in an Incognito tab.

  init                    make .mq/ here
  me <username>           whose comments to listen to (yours)
  sync                    read your profile as a logged-out stranger
  add <permalink>         add one by hand — the path that still works
                          when your profile itself is invisible
  check [--all] [--limit N]   re-read each thread as a stranger
  back [--days N] [--limit N] who replied to you, and has not been answered
  waiting [--json]        the conversations waiting on you, oldest first
  status                  what became of the things you said
  log [item-id]           every check, in order

find — other people, and the rooms it refuses to look in

  probe <room> --q "..."  try a room once. Refuses parody rooms, rooms whose
        [--campaign <id>] own words forbid it, and shapes measured dead
  rooms                   which rooms' rules have been read, and which have not
  watch <room> [--q "..."] commit a probed room. Refuses until its rules are read
        [--campaign <id>]
  unwatch <id>            stop
  sources                 what is watched, and when each was last read
  tick [--limit N]        read what is due. No model runs in this loop
  found < items.json      record posts a colleague read in YOUR browser
                          ({place, q, campaign?, items:[{url,title,author,body}]})
                          — same table and refusals as probe, judged the same way
  pending                 what needs a verdict, numbered, as JSON
  judge < verdicts.json   [{n, fit, why}] — the model lives outside this process
  queue [--json]          who is waiting for an answer from you
  mark <id> sent|skip     answered, or discard. "sent" retires that person
                          from every future queue, permanently. Refused if the
                          burst limits or your standing say no; --anyway posts

  ready [<sub>]           where you stand, room by room, and your mix
  voice                   how you write, measured from your own comments
  draft <id>              the material for answering one person
  draft <id> --save       save a reply and run the refusals over it

campaigns and projects

  campaigns               this project's campaigns: a direction each, never a template
  campaign show|pause|resume <id>
  projects                every project on this machine; * is the one every verb acts on
  project new "<name>"    another project — its own memory, store, campaigns, colleagues
  project use <id>        switch (the panel and the dashboard follow)

  serve [--port N]        the dashboard, on localhost, in your browser
  models                  where the models run — paid, free or local — and which has each seat
  models use <plan>       paid | free | local
  models set <role> <id>  judge | scout | writer, from that plan's menu (any tag, locally)
  models url <base-url>   the local server, default http://127.0.0.1:11434/v1 (Ollama)
  sweep                   drop stored bodies past 48h
  platforms               the platforms this install can read — each one is a
                          skill folder; drop your own into .mq/skills/
  skills                  the whole registry: running, stuck, refused
  skills use <slot> <id>  when two skills serve one purpose, pick the one
                          that runs (recorded in .mq/skills.json)

sharing one machine's reading with several

  pull <hub-url> --token <t>   take what another machine already found, instead
                          of spending a minute a request reading it again.
                          Public posts only. Judged here, against YOUR rule.md
  node bin/hub.mjs        BE that machine: a read-only feed of found.jsonl on
                          its own port. Tunnel to THAT, never to the dashboard

Nothing here posts, messages, votes, or reads anybody else's account.`);
  process.exit(cmd ? 1 : 0);
}
if (!existsSync(ROOT) && cmd !== "init") die(`no ${ROOT}/ here — run \`mq init\` first`);
// `judge` is the one place a verdict comes IN from outside — the model runs in
// whatever you point at this, never in here.
const wantsStdin = cmd === "judge" || cmd === "found" || (cmd === "draft" && args.includes("--save"));
const stdin = wantsStdin && !process.stdin.isTTY ? readFileSync(0, "utf8") : "";
await cmds[cmd](args, stdin);
