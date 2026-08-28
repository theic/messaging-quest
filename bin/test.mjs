#!/usr/bin/env node
// Tests for the things that would break QUIETLY. A loud break shows up the
// first time anybody runs `es check`; these are the ones that would keep
// working and start lying.
//
//   node bin/test.mjs
//
// The fixtures are synthetic, but every field shape in them was copied from a
// live feed measured 2026-08-28 — a real one is not committed, because a tool
// with a 48-hour retention rule should not ship somebody's comments in its
// own test directory.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFeed, threadOf, waitFor, ANON_GAP_MS } from "../lib/reddit.mjs";
import { classify, history } from "../lib/verdict.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ES = join(here, "es.mjs");
const box = mkdtempSync(join(tmpdir(), "earshot-test-"));
const env = { ...process.env, EARSHOT_DIR: join(box, ".earshot") };
const es = (args) => execFileSync(process.execPath, [ES, ...args], { env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
// `check` reaches the network once it has work; we only want its plan, so a
// non-zero exit that already printed the plan is a pass, not a failure.
const esFails = (args) => { try { return es(args); } catch (e) { return `${e.stdout || ""}${e.stderr || ""}`; } };

let pass = 0, fail = 0;
const check = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "  ok  " : "FAIL  "}${what}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

/* ---------------------------------------------------------------- parsing */

const entryXml = (id, bodyHtml, extra = "") => `<entry><author><name>/u/me</name></author>${extra}
<id>${id}</id><link href="https://www.reddit.com/r/x/comments/p1/slug/${id.replace(/^t1_/, "")}/" />
<updated>2026-08-28T10:00:00+00:00</updated><title>/u/me on a thread</title>
<content type="html">${bodyHtml}</content></entry>`;

const CHROME = "&lt;!-- SC_OFF --&gt;&lt;div class=&quot;md&quot;&gt;&lt;p&gt;the words&lt;/p&gt;&lt;/div&gt;&lt;!-- SC_ON --&gt; &lt;p&gt;submitted by /u/me [link] [comments]&lt;/p&gt;";

const feed = `<feed>${entryXml("t1_aaa", CHROME)}
<entry><id>t5_zzz</id><title>a subreddit</title><updated>2008-01-01T00:00:00+00:00</updated></entry></feed>`;

const parsed = parseFeed(feed);
// Reddit surrounds the author's words with its own chrome. Leaving it in means
// every stored body ends in boilerplate and every hash is a hash of that.
check("only what sits between SC_OFF/SC_ON is kept", parsed[0].body, "the words");
// t5_ entries are subreddit records carrying FOUNDING dates. Left in, they put
// the feed out of order and get checked as if somebody had said them.
check("t5_ subreddit records are dropped", parsed.length, 1);
check("the author's /u/ prefix is not part of the name", parsed[0].author, "me");
// Comment entries carry no <published> at all; reading it dates every comment null.
check("the date comes from <updated>", parsed[0].at, "2026-08-28T10:00:00+00:00");

// String surgery that silently reads the wrong page is worse than a crash.
check("a comment's thread is its permalink minus the comment",
  threadOf({ kind: "comment", url: "https://reddit.com/r/x/comments/p1/slug/c1/" }),
  "https://reddit.com/r/x/comments/p1/slug");
check("a post's thread is itself",
  threadOf({ kind: "post", url: "https://reddit.com/r/x/comments/p1/slug/" }),
  "https://reddit.com/r/x/comments/p1/slug");

/* ------------------------------------------------------------ classifying */

const mine = { id: "t1_aaa", kind: "comment", url: "https://reddit.com/r/x/comments/p1/slug/aaa/" };
const thread = (entries, over = {}) => ({ ok: true, entries, redirected: false, truncated: false, ...over });
const full = (n) => Array.from({ length: n }, (_, i) => ({ id: `t1_o${i}`, body: "someone else" }));

check("present and intact is visible", classify(mine, thread([{ id: "t1_aaa", body: "the words" }])).state, "visible");
check("[removed] is somebody else taking it down", classify(mine, thread([{ id: "t1_aaa", body: "[removed]" }])).state, "removed");
check("[deleted] is you taking it down", classify(mine, thread([{ id: "t1_aaa", body: "[deleted]" }])).state, "deleted");
check("absent from a COMPLETE read is filtered", classify(mine, thread(full(12))).state, "filtered");

// The dangerous one. A thread longer than one page does not contain most of
// itself either, and calling that "you are shadowbanned" is the exact failure
// this whole tool exists to be better than.
check("absent from a TRUNCATED read is not a finding",
  classify(mine, thread(full(100), { truncated: true })).state, "inconclusive");
check("...and it does not claim confidence",
  classify(mine, thread(full(100), { truncated: true })).confident, false);
// Escalation settles it, and only then.
check("absent from the comment's OWN view settles it",
  classify(mine, thread(full(100), { truncated: true }), thread(full(3))).state, "filtered");
check("present in its own view but unconfirmed in the thread is named separately",
  classify(mine, thread(full(100), { truncated: true }), thread([{ id: "t1_aaa", body: "the words" }])).state, "unlisted");

// A read that broke is not a finding about your comment. Collapsing these two
// is how a monitoring tool starts reporting outages as removals.
check("a failed read is an error, not a removal", classify(mine, { ok: false, error: "timeout" }).state, "error");
check("a redirected permalink is gone, not filtered", classify(mine, thread([], { redirected: true })).state, "gone");

/* ---------------------------------------------------------------- history */

const h = history([
  { at: "2026-08-01T00:00:00Z", state: "visible" },
  { at: "2026-08-03T00:00:00Z", state: "filtered" },
]);
// The transition is the entire thing a by-hand private-window check cannot give
// you, so losing it would be losing the product.
check("a change of state is remembered", h.changed_at.to, "filtered");
check("...and that it was once visible", h.ever_visible, true);
check("never visible is different from went away",
  history([{ at: "a", state: "filtered" }, { at: "b", state: "filtered" }]).never_visible, true);

/* ------------------------------------------------------------------ store */

es(["init"]);
es(["watch", "u/tester"]);   // the /u/ prefix is what people paste
const ITEMS = join(env.EARSHOT_DIR, "items.jsonl");
const item = (over = {}) => JSON.stringify({ id: "t1_aaa", kind: "comment", url: "https://reddit.com/r/x/comments/p1/slug/aaa/", author: "me", at: "2026-08-28T10:00:00Z", title: null, body: "what I actually said", body_sha256: "h", seen_at: new Date().toISOString(), source: "profile", ...over }) + "\n";

writeFileSync(ITEMS, item());
appendFileSync(ITEMS, item({ body: "TRUNCATED RE-READ" }));

// Checks accumulate; nothing is ever replaced. Overwriting here would silently
// destroy the only thing this tool has that a private window does not.
appendFileSync(join(env.EARSHOT_DIR, "checks.jsonl"),
  JSON.stringify({ id: "t1_aaa", at: "2026-08-01T00:00:00Z", state: "visible", why: "", confident: true }) + "\n" +
  JSON.stringify({ id: "t1_aaa", at: "2026-08-03T00:00:00Z", state: "filtered", why: "", confident: true }) + "\n");
check("status shows the change, not just the latest state", /visible -> filtered/.test(es(["status"])), true);

// A later read of the same comment must never replace what you said. The
// report, the hash and every future comparison all run on the first one.
check("a re-read never overwrites what you said", /what I actually said/.test(es(["status"])), true);
check("...and the later body is nowhere in the report", /TRUNCATED RE-READ/.test(es(["status"])), false);
check("log replays every check in order", (es(["log"]).match(/t1_aaa/g) || []).length, 2);

// A read that BROKE is not an answer. Letting one count as "checked" retires
// the comment from the tool on a single timeout — quietly, and forever.
writeFileSync(join(env.EARSHOT_DIR, "checks.jsonl"),
  JSON.stringify({ id: "t1_aaa", at: "2026-08-04T00:00:00Z", state: "error", why: "timeout", confident: false }) + "\n");
// An unroutable host, so this asserts the PLAN without sending anything to
// Reddit: a test suite that quietly reads the live site is a test suite that
// fails on a train, and it spends the one-a-minute budget the tool is careful
// with everywhere else.
writeFileSync(ITEMS, item({ url: "https://reddit.invalid/r/x/comments/p1/slug/aaa/" }));
const plan = esFails(["check"]);
check("an item whose last check errored is still due", /1 to check across 1 threads/.test(plan), true);
check("...and the failed re-read is recorded as an error, not a removal", /error/.test(plan), true);
writeFileSync(join(env.EARSHOT_DIR, "checks.jsonl"),
  JSON.stringify({ id: "t1_aaa", at: "2026-08-04T00:00:00Z", state: "visible", why: "", confident: true }) + "\n");
check("...and one with a real answer is not", /settled answer/.test(es(["check"])), true);

// §04: the words expire, the evidence does not.
writeFileSync(ITEMS, item({ seen_at: "2026-01-01T00:00:00Z" }));
es(["sweep"]);
const swept = JSON.parse(readFileSync(ITEMS, "utf8").trim());
check("a body past 48h is dropped", swept.body, "");
check("...but its hash survives, so an edit is still detectable", swept.body_sha256, "h");
check("...and so does the url", swept.url, "https://reddit.com/r/x/comments/p1/slug/aaa/");

check("a pasted /u/ prefix is not part of the username",
  JSON.parse(readFileSync(join(env.EARSHOT_DIR, "account.json"), "utf8")).name, "tester");

// The governor. Every command is a fresh process, so the gap can only live on
// disk — and the failure it prevents is silent: reads still "work" while the
// address collects 429s and every thread comes back unreadable.
check("a request 30s after the last one still waits", waitFor(Date.now() - 30_000) > 0, true);
check("a request after the gap does not", waitFor(Date.now() - ANON_GAP_MS - 1), 0);
check("a clock that was never stamped does not block the first read", waitFor(0), 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
