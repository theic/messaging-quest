#!/usr/bin/env node
// earshot — phase 0, the listener.
//
// It watches one thing: what Reddit did to the comments you already wrote. It
// posts nothing, reads nobody else's account, calls no model, needs no key and
// sends nothing anywhere. Everything is append-only JSONL in .earshot/.
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
import { setTimeout as sleep } from "node:timers/promises";
import { ANON_GAP_MS, waitFor, read, userFeed, threadFeed, commentFeed, threadOf, subredditOf } from "../lib/reddit.mjs";
import { classify, history, STATES } from "../lib/verdict.mjs";

const DIR = process.env.EARSHOT_DIR || ".earshot";
const F = (n) => join(DIR, n);
const now = () => new Date().toISOString();
const die = (m) => { console.error(`earshot: ${m}`); process.exit(1); };
const sha = (s) => createHash("sha256").update(String(s)).digest("hex");

/** §04. Reddit requires deleting what was deleted from Reddit and recommends
 *  dropping stored content within 48 hours. The excerpt is a convenience for
 *  reading the report; the hash is what every measurement actually runs on, so
 *  the excerpt can expire without costing anything. */
const BODY_TTL_MS = 48 * 3600_000;

/* ------------------------------------------------------------------ store */

const readJsonl = (name) => {
  const p = F(name);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter((l) => l.trim())
    .map((l, i) => { try { return JSON.parse(l); } catch { die(`${name}:${i + 1} is not JSON`); } });
};
const append = (name, obj) => appendFileSync(F(name), JSON.stringify(obj) + "\n");

const items = () => {
  const m = new Map();
  for (const r of readJsonl("items.jsonl")) if (!m.has(r.id)) m.set(r.id, r); // first wins
  return m;
};
const checksById = () => {
  const m = new Map();
  for (const c of readJsonl("checks.jsonl")) (m.get(c.id) ?? m.set(c.id, []).get(c.id)).push(c);
  return m;
};
const account = () => (existsSync(F("account.json")) ? JSON.parse(readFileSync(F("account.json"), "utf8")) : null);

/* ------------------------------------------------- the anonymous governor */

// Anonymously Reddit answers one request a minute, per address, measured. The
// gap is therefore held ACROSS runs — a limit tracked only in memory is one that
// a second `es check` in the same minute walks straight through.
const clock = () => (existsSync(F("clock")) ? Number(readFileSync(F("clock"), "utf8")) : 0);

async function fetchAnon(url, { quiet = false } = {}) {
  const wait = waitFor(clock());
  if (wait > 0) {
    if (!quiet) process.stdout.write(`  waiting ${Math.ceil(wait / 1000)}s — anonymous Reddit answers one request a minute\n`);
    await sleep(wait);
  }
  writeFileSync(F("clock"), String(Date.now()));
  const r = await read(url);
  append("reads.jsonl", { url, at: now(), ok: r.ok, err: r.ok ? null : r.error, n: r.ok ? r.entries.length : 0 });
  // A 429 means the gap was not enough; wait it out and say so rather than
  // recording a finding that is really our own impatience.
  if (!r.ok && r.error === "rate_limited") {
    if (!quiet) process.stdout.write(`  rate limited — waiting ${r.retryAfter}s\n`);
    await sleep((r.retryAfter + 2) * 1000);
    writeFileSync(F("clock"), String(Date.now()));
    return await read(url);
  }
  return r;
}

/* --------------------------------------------------------------- commands */

const cmds = {};

cmds.init = () => {
  mkdirSync(DIR, { recursive: true });
  for (const f of ["items.jsonl", "checks.jsonl", "reads.jsonl"]) if (!existsSync(F(f))) writeFileSync(F(f), "");
  console.log(`ready — ${DIR}/\n\nNext:  es watch <your-reddit-username>\n       es sync\n       es check`);
};

cmds.watch = (args) => {
  const name = String(args[0] || die("usage: es watch <your-reddit-username>")).replace(/^\/?u\//, "").trim();
  if (!/^[\w-]{3,20}$/.test(name)) die(`that does not look like a Reddit username: '${name}'`);
  writeFileSync(F("account.json"), JSON.stringify({ name, added: now() }, null, 2));
  console.log(`listening for u/${name}.\n\nNothing is posted, nothing is sent, and only your own account is read.\nNext: es sync`);
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
  const acct = account() || die("nobody to listen to yet — run: es watch <your-reddit-username>");
  console.log(`reading reddit.com/user/${acct.name} as a stranger would\n`);
  const r = await fetchAnon(userFeed(acct.name));

  if (!r.ok) {
    if (r.error === "http_404") {
      console.log(`  404 — logged out, that profile does not render at all.`);
      console.log(`\n  That is the site-wide signal. A suspended or shadowbanned account 404s to`);
      console.log(`  strangers while looking normal to you. Check reddit.com/user/${acct.name} in a`);
      console.log(`  private window to confirm with your own eyes, then appeal at reddit.com/appeals.`);
      return;
    }
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
  if (r.entries.length === 0) {
    console.log(`\n  Zero entries, logged out, with a 200.`);
    console.log(`  Either you have not commented, or nothing you wrote is visible to strangers.`);
    console.log(`  Those look identical from here and the tool will not guess between them.`);
    console.log(`\n  To tell them apart: paste a permalink you know you posted —`);
    console.log(`      es add <permalink>   then   es check`);
    console.log(`  If it comes back 'filtered', the profile being empty is not an absence of writing.`);
  } else if (fresh) {
    console.log(`\n  Next: es check`);
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
  const url = String(args[0] || die("usage: es add <reddit-permalink>")).split("?")[0].replace(/\/+$/, "");
  if (!/^https?:\/\/(www\.|old\.)?reddit\.com\/r\/[^/]+\/comments\//i.test(url)) die("that is not a Reddit post or comment permalink");
  const parts = url.split("/");
  const post = parts[parts.indexOf("comments") + 1];
  const tail = parts[parts.length - 1];
  // .../comments/<post>/<slug>/<comment>/  — a trailing segment that is neither
  // the post id nor the slug is a comment id. Getting this wrong checks the
  // wrong thing and reports confidently about it.
  const isComment = tail !== post && parts.indexOf("comments") + 2 < parts.length - 1;
  const id = isComment ? `t1_${tail}` : `t3_${post}`;
  if (items().has(id)) return console.log(`already listening to ${id}`);
  append("items.jsonl", { id, kind: isComment ? "comment" : "post", url, author: account()?.name ?? null, at: null, title: null, body: "", body_sha256: null, seen_at: now(), source: "by hand" });
  console.log(`added ${id}\n  ${url}\nNext: es check`);
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
  if (!store.size) die("nothing to check yet — run `es sync` (or `es add <permalink>`)");

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
  if (!todo.length) return console.log(`every item has a settled answer. \`es check --all\` re-reads them — that is how a change gets caught.`);

  // group by conversation
  const groups = new Map();
  for (const it of todo) {
    const t = threadOf(it);
    if (!t) continue;
    (groups.get(t) ?? groups.set(t, []).get(t)).push(it);
  }
  const work = [...groups.entries()].slice(0, limit);
  const mins = Math.ceil((work.length * ANON_GAP_MS) / 60_000);
  console.log(`${todo.length} to check across ${groups.size} threads; doing ${work.length}.`);
  // "At least", because a thread longer than one page costs a second read to
  // settle, and quoting the floor as though it were the total is how a progress
  // estimate becomes a small lie.
  console.log(`At least ${mins} minute${mins === 1 ? "" : "s"} — logged out, Reddit answers one request a minute.\n`);

  for (const [thread, group] of work) {
    const sub = subredditOf(thread);
    console.log(`r/${sub ?? "?"}  ${group.length} of yours`);
    const t = await fetchAnon(threadFeed(thread));
    for (const it of group) {
      let verdict = classify(it, t);
      // Only the genuinely open question is worth another minute.
      if (verdict.state === "inconclusive" && it.kind === "comment") {
        console.log(`    thread is longer than a page — reading the comment's own view`);
        const f = await fetchAnon(commentFeed(it.url));
        verdict = classify(it, t, f);
      }
      append("checks.jsonl", { id: it.id, at: now(), state: verdict.state, why: verdict.why, confident: verdict.confident, entries: t.ok ? t.entries.length : 0 });
      console.log(`    ${mark(verdict.state)} ${verdict.state.padEnd(12)} ${line(it)}`);
      if (!verdict.confident) console.log(`                    ${verdict.why}`);
    }
  }
  console.log(`\nes status`);
};

const mark = (s) => ({ visible: "  ", unlisted: " ?", filtered: " !", removed: " !", deleted: "  ", gone: " ?", inconclusive: " ?", error: " x" })[s] ?? "  ";
const line = (it) => {
  const body = (it.body || "").replace(/\s+/g, " ").trim();
  return (body || it.title || it.url || it.id).slice(0, 68);
};

cmds.status = () => {
  const store = items(), checks = checksById(), acct = account();
  if (!store.size) return console.log("nothing stored yet — run `es sync`.");
  const tally = new Map();
  const unchecked = [];
  for (const it of store.values()) {
    const h = history(checks.get(it.id) ?? []);
    if (h.state === "unchecked") { unchecked.push(it); continue; }
    tally.set(h.state, (tally.get(h.state) ?? 0) + 1);
  }
  console.log(`u/${acct?.name ?? "?"} — ${store.size} things you said\n`);
  for (const [state, n] of [...tally].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${state.padEnd(13)} ${STATES[state]}`);
  }
  if (unchecked.length) console.log(`  ${String(unchecked.length).padStart(4)}  ${"unchecked".padEnd(13)} not looked at yet — es check`);

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
cmds.sweep = () => {
  const rows = readJsonl("items.jsonl");
  const cutoff = Date.now() - BODY_TTL_MS;
  let n = 0;
  const out = rows.map((r) => {
    if (r.body && Date.parse(r.seen_at) < cutoff) { n++; return { ...r, body: "", body_expired: true }; }
    return r;
  });
  writeFileSync(F("items.jsonl"), out.map((r) => JSON.stringify(r)).join("\n") + (out.length ? "\n" : ""));
  console.log(`${n} bodies past 48h dropped. Ids, urls, dates, hashes and every check are untouched.`);
};

/* ------------------------------------------------------------------- main */

const [, , cmd, ...args] = process.argv;
if (!cmd || !cmds[cmd]) {
  console.log(`earshot — what did Reddit actually do to your comments?

  init                    make .earshot/ here
  watch <username>        whose comments to listen to (yours)
  sync                    read your profile as a logged-out stranger
  add <permalink>         add one by hand — the path that still works
                          when your profile itself is invisible
  check [--all] [--limit N]   re-read each thread as a stranger
  status                  what became of the things you said
  log [item-id]           every check, in order
  sweep                   drop stored bodies past 48h

Nothing here posts, messages, votes, or reads anybody else's account.`);
  process.exit(cmd ? 1 : 0);
}
if (!existsSync(DIR) && cmd !== "init") die(`no ${DIR}/ here — run \`es init\` first`);
await cmds[cmd](args);
