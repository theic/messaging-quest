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
import { parseFeed, threadOf, waitFor, ANON_GAP_MS } from "../skills/reddit/feed.mjs";
import { classify, history } from "../lib/verdict.mjs";
import { conversation, byUrgency } from "../lib/conversation.mjs";
import { refuse, scoped } from "../skills/reddit/shapes.mjs";
import { verdictOf } from "../lib/probe.mjs";
import { fromDescription, isParody, readRoomFile, roomFile, bansPromotion } from "../lib/rules.mjs";
import { conforms } from "../lib/llm.mjs";
import { loadPlatforms, platform, roomOf } from "../lib/platform.mjs";
import { longestSharedRun, repeats, claims, inventedLinks, RUN_LIMIT } from "../lib/guards.mjs";
import { standing, readiness, burst, mix } from "../lib/ready.mjs";
import { nextCards, onboarded } from "../lib/cards.mjs";
import { relayBroker } from "../lib/relay.mjs";
import { readViaRelay } from "../skills/reddit/feed.mjs";
import { allowed, memoryProgress, memoryContext, writeMemory, seedMissing } from "../lib/memory.mjs";
import { proposable } from "../lib/cards.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ES = join(here, "es.mjs");
const box = mkdtempSync(join(tmpdir(), "earshot-test-"));
const env = { ...process.env, EARSHOT_DIR: join(box, ".earshot") };
const es = (args) => execFileSync(process.execPath, [ES, ...args], { env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
// `check` reaches the network once it has work; we only want its plan, so a
// non-zero exit that already printed the plan is a pass, not a failure.
const esFails = (args) => { try { return es(args); } catch (e) { return `${e.stdout || ""}${e.stderr || ""}`; } };
const esFails2 = (args, dir) => { try { return execFileSync(process.execPath, [ES, ...args], { env: { ...process.env, EARSHOT_DIR: dir }, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }); } catch (e) { return `${e.stdout || ""}${e.stderr || ""}`; } };

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
check("a comment's thread is the prefix up to the post id",
  threadOf({ kind: "comment", url: "https://reddit.com/r/x/comments/p1/slug/c1/" }),
  "https://reddit.com/r/x/comments/p1");
// Reddit hands out TWO permalink shapes and the web UI's has a literal
// "comment" segment. Dropping the last segment produces ".../p1/comment" —
// a string that reads as a thread, is not one, and gets checked as though it
// were. Found on a real permalink copied out of a browser.
check("...and the web UI's /comment/ shape resolves to the same thread",
  threadOf({ kind: "comment", url: "https://www.reddit.com/r/founder/comments/1vp3m8y/comment/p4lamwb/" }),
  "https://www.reddit.com/r/founder/comments/1vp3m8y");
check("a post's thread is itself, slug or no slug",
  threadOf({ kind: "post", url: "https://reddit.com/r/x/comments/p1/slug/" }),
  "https://reddit.com/r/x/comments/p1");
check("a url with no post id at all is not guessed at",
  threadOf({ kind: "comment", url: "https://reddit.com/r/x/" }), null);

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

/* ---------------------------------------------------------- conversations */
// The focused feed returning DESCENDANTS is the load-bearing assumption of
// Phase 1, and it was verified rather than assumed (2026-08-28): a child's
// subtree is a strict subset of its parent's, and the parent never appears
// inside the child's. If that ever changes, these all still pass while the tool
// silently reports strangers as people who answered you.

const c = (id, author, body, at) => ({ id, kind: "comment", author, body, at, url: "u" });
const focused = (entries) => ({ ok: true, entries });
const post = { id: "t3_p", kind: "post", author: "someone", body: "the post", at: "0" };
const mineId = { id: "t1_me", url: "https://reddit.com/r/x/comments/p1/slug/me/" };
const conv = (entries) => conversation(mineId, focused([post, { ...c("t1_me", "me", "what I said", "1"), id: "t1_me" }, ...entries]), "me");

check("nobody under it is quiet", conv([]).state, "quiet");
check("somebody under it is waiting", conv([c("t1_a", "ann", "hi", "2")]).state, "waiting");
check("...and it counts them", conv([c("t1_a", "ann", "hi", "2"), c("t1_b", "bo", "hi", "3")]).replies, 2);
check("you having replied since settles it", conv([c("t1_a", "ann", "hi", "2"), c("t1_x", "me", "ok", "3")]).state, "answered");
// The one a "did you reply at all?" flag gets wrong: answering in March does
// not settle something said yesterday.
check("but them speaking AFTER you re-opens it",
  conv([c("t1_a", "ann", "hi", "2"), c("t1_x", "me", "ok", "3"), c("t1_c", "ann", "still?", "4")]).state, "waiting");
check("...and that is flagged as since-you", conv([c("t1_a", "ann", "hi", "2"), c("t1_x", "me", "ok", "3"), c("t1_c", "ann", "still?", "4")]).since_you, true);
// A tombstone is not a person waiting for an answer.
check("a [removed] reply is not somebody waiting", conv([c("t1_a", "ann", "[removed]", "2")]).state, "quiet");
check("a [deleted] reply is not either", conv([c("t1_a", "ann", "[deleted]", "2")]).state, "quiet");
// The post is context, not a reply to you — counting it makes every comment
// you ever wrote look answered.
check("the post itself is never counted as a reply", conv([]).replies, 0);
// It is the LAST unanswered thing that is hanging, not the first.
check("the newest unanswered thing is the one surfaced",
  conv([c("t1_a", "ann", "first", "2"), c("t1_c", "bo", "newest", "4")]).latest.text, "newest");
check("a failed read is an error, not silence", conversation(mineId, { ok: false, error: "timeout" }, "me").state, "error");
// Oldest-first, because a queue sorted newest-first buries the one going cold.
check("the oldest wait comes first", byUrgency([{ at: "3" }, { at: "1" }, { at: "2" }]).map((r) => r.at), ["1", "2", "3"]);

/* ------------------------------------------------------------------ store */

es(["init"]);
es(["me", "u/tester"]);   // the /u/ prefix is what people paste
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

/* ------------------------------------------------------ phase 2 — refusals */

// The shape measurements, as refusals rather than as a ranking. The firehose
// was 76% of everything ever read and sat in the 4.2% half; a search without
// restrict_sr=1 silently becomes a site-wide search at 10%.
check("the comment firehose is refused by shape", Boolean(refuse({ kind: "comments" })), true);
check("...and by URL, however it is written", Boolean(refuse({ url: "https://www.reddit.com/r/x/comments/.rss?limit=100" })), true);
check("an unscoped search is refused", Boolean(refuse({ url: "https://www.reddit.com/r/x/search/.rss?q=a&sort=new" })), true);
check("a scoped search is allowed", refuse({ url: scoped("smallbusiness", "how do I get clients") }), null);
check("parody subs are caught by Reddit's own suffix", isParody("languagelearningjerk"), true);

// THE measurement that shaped this: r/slp is the roadmap's canonical room to
// refuse, and its public description does not contain its rule. A keyless
// check must therefore never answer "clear" — only "banned" or "unanswered".
check("r/slp's real description does not reveal its rule",
  fromDescription("A community of Speech-Language Pathologists (SLPs), Speech Therapists (STs). We discuss ideas, stories, information, and give general advice.").state, "unanswered");
check("a blunt description is still caught", fromDescription("Read the rules. No self-promotion here. Be kind.").state, "banned");
check("...and the refusal quotes the sentence, so it can be argued with", bansPromotion("Read the rules. No self-promotion here."), "No self-promotion here.");
// An unanswered room must never be silently treated as a yes.
check("a fresh room file is unanswered, not permission", readRoomFile(roomFile("slp", null)).state, "unanswered");

// The floor is a decision, not a score. The competitor's 0-100 produced eleven
// distinct values over 981 rows with a floor that never once fired.
check("under the floor does not commit", verdictOf({ read: 100, fit: 4 }).commit, false);
check("over the floor commits", verdictOf({ read: 27, fit: 18 }).commit, true);
check("nothing read is not a pass", verdictOf({ read: 0, fit: 0 }).commit, false);

/* ------------------------------------------------- phase 2 — through the CLI */

const box2 = mkdtempSync(join(tmpdir(), "earshot-find-"));
const env2 = { ...process.env, EARSHOT_DIR: join(box2, ".earshot") };
const es2 = (args, stdin) => { try { return execFileSync(process.execPath, [ES, ...args], { env: env2, input: stdin ?? "", encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }); } catch (e) { return `${e.stdout || ""}${e.stderr || ""}`; } };
es2(["init"]);
const D2 = env2.EARSHOT_DIR;

check("a room nobody has read the rules for cannot be watched", /nobody has read/.test(es2(["watch", "smallbusiness"])), true);
check("a parody sub cannot be watched at all", /parody/.test(es2(["watch", "somethingjerk"])), true);

writeFileSync(join(D2, "rooms", "smallbusiness.md"), "promotion_allowed: no\n");
check("a room recorded as forbidding it stays refused", /does not allow it/.test(es2(["watch", "smallbusiness"])), true);

// Answering "yes" is necessary, not sufficient: an unmeasured source is what
// filled the predecessor's queue with 804 rows nobody consumed.
writeFileSync(join(D2, "rooms", "smallbusiness.md"), "promotion_allowed: yes\n");
check("...and even permitted, an unmeasured room is refused", /has been judged/.test(es2(["watch", "smallbusiness"])), true);

// Now walk a real find through the store, without touching the network.
const submission = (id, author, body) => JSON.stringify({ id, place: "smallbusiness", url: `https://reddit.com/r/smallbusiness/comments/${id}/x/`, author, title: "t", body, body_sha256: "h", posted_at: "2026-08-28T10:00:00Z", seen_at: new Date().toISOString(), probe: "smallbusiness:new" }) + "\n";
writeFileSync(join(D2, "found.jsonl"), submission("t3_a", "ann", "I cannot find clients") + submission("t3_b", "bob", "buy my course") + submission("t3_c", "cat", "how do I get customers"));
writeFileSync(join(D2, "pending.json"), JSON.stringify([{ n: 1, id: "t3_a", probe: "smallbusiness:new" }, { n: 2, id: "t3_b", probe: "smallbusiness:new" }, { n: 3, id: "t3_c", probe: "smallbusiness:new" }]));

const judged = es2(["judge"], JSON.stringify([{ n: 1, fit: true, why: "stuck" }, { n: 2, fit: false, why: "selling" }, { n: 3, fit: true, why: "stuck" }]));
check("judging queues only the fits", /judged 3 · 2 queued/.test(judged), true);
// §11: the rubric hash is what answers "the queue changed — my rule or the model?"
check("every verdict carries a rubric hash", /rubric [0-9a-f]{8}/.test(judged), true);
check("a probe over the floor says so and offers the commit", /clears the 10% floor/.test(judged), true);

// Unjudged is its own state, and it is loud. It is not a no.
writeFileSync(join(D2, "pending.json"), JSON.stringify([{ n: 1, id: "t3_a" }, { n: 2, id: "t3_b" }]));
check("items that came back with no verdict stay pending", /1 came back with NO VERDICT/.test(es2(["judge"], JSON.stringify([{ n: 1, fit: true }]))), true);

check("the queue holds the fits", (es2(["queue"]).match(/^t3_/gm) || []).length, 2);
check("a judged-unfit post never appears", /t3_b/.test(es2(["queue"])), false);

// The ledger. Showing the same person twice is what makes a queue feel like a
// lottery, and it is permanent across every project by design.
// --anyway, because this store has no comment history in r/smallbusiness and
// Phase 4's gate now refuses a reply into a room you have no standing in. That
// refusal has its own tests below; these two are about the ledger.
es2(["mark", "t3_a", "sent", "--anyway"]);
check("marking sent retires that person", /never appear in a queue again/.test(es2(["mark", "t3_c", "sent", "--anyway"])), true);
writeFileSync(join(D2, "marks.jsonl"), "");
check("...and they stay gone even if the mark is lost", /queue is empty/.test(es2(["queue"])), true);

/* --------------------------------------------------- phase 3 — the refusals */

// The AI smell is SHAPE, not vocabulary. The predecessor's 29 drafts shared a
// 26-word identical run while its mail-merge check reported them clean — it
// fired on 0 of 406 pairs, because it subtracted the template's vocabulary
// before comparing. This compares runs and subtracts nothing.
const A = "i built a small tool for exactly this problem and it took a week";
const B = "hey there, i built a small tool for exactly this problem and honestly it helped";
check("a shared run is measured in consecutive words", longestSharedRun(A, B).length, 10);
check("...and the phrase itself comes back, so it can be seen", /i built a small tool/.test(longestSharedRun(A, B).phrase), true);
check("nothing in common is zero", longestSharedRun("completely unrelated words", "nothing alike here").length, 0);
check("an empty prior cannot match", longestSharedRun("", "anything at all").length, 0);
check("a run at the limit is flagged", Boolean(repeats(A, [{ id: "d1", text: B }])), true);
check("a short overlap is not", repeats("thanks, that is useful", [{ id: "d1", text: "thanks, that helps a lot" }]), null);
check("the limit is the measured one", RUN_LIMIT, 8);

// The sentence a competitor actually posted into a clinical thread under a
// real name, from an operator who had never had that job.
const said = claims("At my last job I used vocavela for some basic bridge work during intake. Nice weather.");
check("a fabricated job history is surfaced", said.length, 1);
check("...as the whole sentence, not the two words that matched", /vocavela/.test(said[0].sentence), true);
check("ordinary prose makes no claim", claims("That sounds frustrating. Have you tried asking them directly?").length, 0);
check("first person alone is not a claim about experience", claims("I would probably start there.").length, 0);

// The drafter has no search, so any URL it did not lift from the thread is invented.
check("a link from the thread is fine", inventedLinks("see https://real.example", "body https://real.example"), []);
check("a link from nowhere is not", inventedLinks("see https://made-up.example", "body https://real.example"), ["https://made-up.example"]);
check("trailing punctuation does not disguise it", inventedLinks("at https://made-up.example.", "body"), ["https://made-up.example"]);

/* --------------------------------------------------- phase 3 through the CLI */

const box3 = mkdtempSync(join(tmpdir(), "earshot-draft-"));
const env3 = { ...process.env, EARSHOT_DIR: join(box3, ".earshot") };
const es3 = (args, stdin) => { try { return execFileSync(process.execPath, [ES, ...args], { env: env3, input: stdin ?? "", encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }); } catch (e) { return `${e.stdout || ""}${e.stderr || ""}`; } };
es3(["init"]);
const D3 = env3.EARSHOT_DIR;
const one = (id) => JSON.stringify({ id, place: "smallbusiness", url: `https://reddit.com/r/smallbusiness/comments/${id}/y/`, author: "ann", title: "t", body: "I cannot find clients", body_sha256: "h", posted_at: "2026-08-28T09:00:00Z", seen_at: new Date().toISOString(), probe: "smallbusiness:new" }) + "\n";
writeFileSync(join(D3, "found.jsonl"), one("t3_x") + one("t3_y"));

// An unmeasured voice must impose NO style. That is the deletion the ported
// tests guard, checked once more at the seam where this tool renders it.
// With no samples, every measured field stays silent — and exactly one rule
// still fires. The em dash is the single most reliable machine signature in a
// forum reply, so its UNKNOWN state is a ban rather than a silence, and one
// sample containing one lifts it. That asymmetry is the ported module's
// contract, and this is the seam where it renders.
const noVoice = es3(["voice"]);
check("with no samples, nothing about the person is claimed", /Nothing about your style is measurable yet/.test(noVoice), true);
check("...and the one rule that still applies says why", /No em dashes/.test(noVoice), true);
check("...and no house style is smuggled in with it", /lowercase|non-native|sentence case/.test(noVoice), false);

const PHRASE = "picking one specific kind of customer and answering twenty of their threads properly";
// Rewriting ONE reply is not repeating yourself, and flagging it would train
// you to ignore the warning that matters. Checked first, in a clean store, so
// no other draft can be the thing it matches against.
es3(["draft", "t3_x", "--save"], PHRASE);
check("revising the same reply is not repetition", /REPEATED PHRASING/.test(es3(["draft", "t3_x", "--save"], `${PHRASE}, slowly`)), false);
// The same words aimed at a second person is precisely what Reddit names as
// reportable spam: "the same or similar comments across communities".
const dup = es3(["draft", "t3_y", "--save"], `you could try ${PHRASE} today`);
check("...but the same phrasing aimed at somebody else is", /REPEATED PHRASING/.test(dup), true);
check("a clean draft says so plainly", /No repeated phrasing, no invented links/.test(es3(["draft", "t3_y", "--save"], "what does the thing actually do?")), true);
check("nothing is ever rejected outright — you are the one sending it", /You send it yourself/.test(dup), true);

/* ------------------------------------------------------- phase 4 — the gate */

const at = Date.parse("2026-08-29T12:00:00Z");
const cmt = (id, sub, when) => ({ id, kind: "comment", url: `https://www.reddit.com/r/${sub}/comments/p/s/${id}/`, at: when });
const seen = (ids, state) => new Map(ids.map((i) => [i, [{ state }]]));

// Counting comments is not measuring standing. Fourteen comments in a room you
// are filtered out of is fourteen invisible comments, and a count alone reports
// it as ready. This is the join that needs Phase 0 and that no tool without it
// can make.
const filtered = standing([cmt("a", "SaaS", "2026-08-27T10:00:00Z")], seen(["a"], "filtered"), at);
check("comments that a stranger cannot see are not standing", readiness(filtered.get("SaaS"), null).state, "not ready");
check("...and it says more will not help", /More of them will not help/.test(readiness(filtered.get("SaaS"), null).why), true);

const visible = standing(["a", "b", "c"].map((i, n) => cmt(i, "smallbusiness", `2026-08-${10 + n * 8}T10:00:00Z`)), seen(["a", "b", "c"], "visible"), at);
check("visible history in a room is ready", readiness(visible.get("smallbusiness"), null).state, "ready");
// Crowd Control's maximum tier filters people with no history in the room. That
// is documented behaviour, so it is the one mechanical gate here.
check("no history at all is the documented filter case", readiness(null, null).state, "not ready");
check("one visible comment is membership, but thin", readiness(standing([cmt("a", "x", "2026-08-27T10:00:00Z")], seen(["a"], "visible"), at).get("x"), null).state, "thin");
// Unchecked is not a pass. It is a different word.
check("unchecked history is unknown, not ready", readiness(standing([cmt("a", "x", "2026-08-27T10:00:00Z")], new Map(), at).get("x"), null).state, "unknown");
check("a room whose rules forbid it is not a warm-up problem", readiness(visible.get("smallbusiness"), { state: "banned" }).state, "not ready");

// §02, stated: refuse a third reply in one subreddit inside 24h, and a sixth
// overall. The measured shape was 11 replies in 83.9 minutes across 7 rooms.
const two = [{ at: "2026-08-29T11:00:00Z", place: "x" }, { at: "2026-08-29T10:00:00Z", place: "x" }];
check("a third reply in one room inside 24h is the burst shape", burst(two, "x", at).scope, "room");
check("...but a first reply elsewhere is fine", burst(two, "y", at), null);
check("a sixth overall is the burst shape", burst(Array.from({ length: 5 }, (_, i) => ({ at: `2026-08-29T0${i}:00:00Z`, place: `p${i}` })), "z", at).scope, "all");
check("yesterday's replies do not count against today", burst([{ at: "2026-08-27T10:00:00Z", place: "x" }, { at: "2026-08-27T11:00:00Z", place: "x" }], "x", at), null);

// The ratio is a mirror and a dishonest promise. Reddit enforces no sitewide
// rule, so the note must travel with the number, always.
check("the mix is a ratio", mix(20, 4).ratio, 4);
check("...and never a threshold", /enforces no sitewide ratio/.test(mix(20, 4).note), true);
check("no outreach yet is not a ratio of zero", mix(20, 0).ratio, null);

// The gate through the CLI: refused by default, overridable, because a tool
// that cannot be overruled just gets worked around.
const box4 = mkdtempSync(join(tmpdir(), "earshot-gate-"));
const env4 = { ...process.env, EARSHOT_DIR: join(box4, ".earshot") };
const es4 = (a) => { try { return execFileSync(process.execPath, [ES, ...a], { env: env4, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }); } catch (e) { return `${e.stdout || ""}${e.stderr || ""}`; } };
es4(["init"]);
writeFileSync(join(env4.EARSHOT_DIR, "found.jsonl"), JSON.stringify({ id: "t3_z", place: "SaaS", url: "https://reddit.com/r/SaaS/comments/z/y/", author: "zed", title: "t", body: "b", posted_at: "2026-08-29T09:00:00Z", seen_at: "2026-08-29T10:00:00Z", probe: "SaaS:new" }) + "\n");
const blocked = es4(["mark", "t3_z", "sent"]);
check("replying where you have no standing is refused", /not logged/.test(blocked), true);
check("...and the refusal names the measured shape", /83\.9 minutes/.test(blocked), true);
check("...and offers the override rather than just saying no", /--anyway/.test(blocked), true);
check("the override works, because you are the one posting", /logged as answered/.test(es4(["mark", "t3_z", "sent", "--anyway"])), true);
// A skip is not a reply, so the gate has no business touching it.
check("a skip is never gated", /discarded/.test(es4(["mark", "t3_z", "skip"])), true);

/* ------------------------------------------------------- the dashboard */
// Served on localhost, so the interesting failures are not "does it render"
// but "what does it render, and who can reach it".

const { spawn } = await import("node:child_process");
const SERVE = join(here, "serve.mjs");
const boxW = mkdtempSync(join(tmpdir(), "earshot-web-"));
const DW = join(boxW, ".earshot");
execFileSync(process.execPath, [ES, "init"], { env: { ...process.env, EARSHOT_DIR: DW }, stdio: "ignore" });
writeFileSync(join(DW, "account.json"), JSON.stringify({ name: "tester", added: "2026-08-29T00:00:00Z" }));

// A post body is a STRANGER'S TEXT. It is the one thing on the page nobody on
// this machine wrote, and the dashboard is all that stands between it and the
// browser. If this test ever fails, a Reddit post can run script in the
// operator's session.
const NASTY = `<img src=x onerror="alert(1)"><script>fetch('http://evil.example')<\/script>`;
writeFileSync(join(DW, "found.jsonl"), JSON.stringify({
  id: "t3_evil", place: "smallbusiness", url: "https://reddit.com/r/smallbusiness/comments/evil/x/",
  author: "mallory", title: NASTY, body: NASTY, body_sha256: "h",
  posted_at: "2026-08-28T09:00:00Z", seen_at: "2026-08-28T10:00:00Z", probe: "smallbusiness:new",
}) + "\n");
writeFileSync(join(DW, "verdicts.jsonl"), JSON.stringify({ id: "t3_evil", fit: true, why: "stuck", rule: "abc12345", at: "2026-08-28T10:00:00Z" }) + "\n");
writeFileSync(join(DW, "probes.jsonl"), JSON.stringify({ place: "smallbusiness", q: null, url: "u", read: 1, at: "2026-08-28T10:00:00Z" }) + "\n");

// Port 0 — the OS hands out a free one, and serve prints the port it actually
// bound. A guessed port collided with a running hub once and every request in
// this section quietly interrogated the wrong server.
const srv = spawn(process.execPath, [SERVE, "--port", "0"], { env: { ...process.env, EARSHOT_DIR: DW }, stdio: ["ignore", "pipe", "pipe"] });
const base = await new Promise((resolve) => {
  let out = "";
  const t = setTimeout(() => resolve(null), 8000);
  srv.stdout.on("data", (d) => {
    out += d;
    const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
    if (m) { clearTimeout(t); resolve(`http://127.0.0.1:${m[1]}`); }
  });
});
const up = async () => { if (!base) return false; for (let i = 0; i < 80; i++) { try { await fetch(base + "/"); return true; } catch { await new Promise((r) => setTimeout(r, 50)); } } return false; };
const GET = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.text() }; };

if (!(await up())) { console.log("FAIL  the dashboard did not start"); fail++; }
else {
  for (const p of ["/", "/waiting", "/queue", "/rooms", "/ready", "/sources", "/voice"]) {
    check(`${p} renders`, (await GET(p)).status, 200);
  }
  check("an unknown path is a 404, not a stack trace", (await GET("/nope")).status, 404);

  const q = await GET("/queue");
  // The whole point: the words appear, the markup does not.
  check("a hostile post body is escaped, not executed", /<img src=x onerror/.test(q.body), false);
  check("...and its script tag never reaches the page", /<script>fetch/.test(q.body), false);
  check("...while the text itself is still shown", /&lt;img src=x/.test(q.body), true);
  // A CDN reference added later would break loudly instead of quietly making a
  // local-only dashboard phone home.
  const head = await fetch(base + "/");
  check("nothing may load from anywhere", /default-src 'none'/.test(head.headers.get("content-security-policy") ?? ""), true);

  // The only writes in the product, and they are clicks.
  const post = async (p, form) => (await fetch(base + p, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form), redirect: "manual" })).status;
  check("marking sent redirects rather than rendering", await post("/mark", { id: "t3_evil", mark: "sent" }), 303);
  check("...and it lands in the store", /t3_evil/.test(readFileSync(join(DW, "marks.jsonl"), "utf8")), true);
  // Permanent, across every project — the same ledger the CLI writes.
  check("...and retires that person for good", /mallory/.test(readFileSync(join(DW, "contacted.jsonl"), "utf8")), true);
  check("the queue is empty once they are answered", /Nobody is waiting/.test((await GET("/queue")).body), true);

  check("answering a room's rules redirects", await post("/room", { place: "smallbusiness", answer: "no" }), 303);
  // The markdown file is the record, and the file always wins — answering here
  // and answering in an editor have to be the same act.
  check("...and writes the same markdown the CLI reads",
    /promotion_allowed:\s*no/.test(readFileSync(join(DW, "rooms", "smallbusiness.md"), "utf8")), true);
  check("...which the CLI then honours",
    /does not allow it/.test(esFails2(["watch", "smallbusiness"], DW)), true);
}
srv.kill();

/* ------------------------------------------------------ platforms as skills */

// The loader is the one door between lib/ and skills/. If it silently loaded
// nothing, every room would resolve to "?" and standing would be empty — a
// quiet break, which is what this file is for.
await loadPlatforms(null);
check("the reddit skill loads", platform("reddit")?.name, "Reddit");
check("roomOf resolves through whichever platform recognises the url",
  roomOf("https://www.reddit.com/r/smallbusiness/comments/abc/def/"), "smallbusiness");
check("roomOf says null, not a guess, for a url no platform knows", roomOf("https://example.com/post/1"), null);

/* -------------------------------------------------- the JSON-schema check */

// One malformed element must void the batch LOUDLY — the alternative is a
// verdict written from a field that was not there.
const V = {
  type: "object", required: ["verdicts"],
  properties: { verdicts: { type: "array", items: {
    type: "object", required: ["n", "fit", "why"],
    properties: { n: { type: "number" }, fit: { type: "boolean" }, why: { type: "string" } } } } },
};
check("a valid verdict conforms", conforms(V, { verdicts: [{ n: 1, fit: true, why: "x" }] }), null);
check("a missing field is named, with its path", conforms(V, { verdicts: [{ n: 1, why: "x" }] }), "$.verdicts[0].fit is missing");
check("a wrong type is named, with both types", conforms(V, { verdicts: [{ n: "1", fit: true, why: "x" }] }),
  "$.verdicts[0].n should be a number, got string");
check("prose where an array belongs is refused", conforms(V, { verdicts: "all fine" }), "$.verdicts should be an array, got string");

/* ------------------------------------------------------------------ cards */

// The deck decides what a person is asked to do next, so a wrong card is not a
// rendering bug — it is the product giving bad advice. These pin the order.

const snap = (over = {}) => ({
  stash: {},
  account: null,
  hasKey: false,
  memory: { done: 0, total: 4, files: [
    { file: "rule.md", filled: false }, { file: "project.md", filled: false },
    { file: "icp.md", filled: false }, { file: "me.md", filled: false }] },
  voice: null,
  scout: { status: "none", url: null, error: null, proposal: null },
  probe: { running: false, last: null, fitRate: null },
  sources: [],
  rooms: [],
  pendingCount: 0,
  queue: [],
  itemCount: 0,
  contactedCount: 0,
  syncRunning: false,
  ...over,
});
const memDone = { done: 4, total: 4, files: [
  { file: "rule.md", filled: true }, { file: "project.md", filled: true },
  { file: "icp.md", filled: true }, { file: "me.md", filled: true }] };

check("a fresh dir asks who you are first", nextCards(snap())[0].id, "onboard.account");
check("skipping the account moves to the url, not back to the account",
  nextCards(snap({ stash: { account_skipped: true } }))[0].id, "onboard.url");
check("a url with no key on file asks for the key, with the site named",
  nextCards(snap({ stash: { account_skipped: true, url: "https://acme.dev" } }))[0].id, "onboard.key");
check("the voice habits run while the scout reads — the wait card comes after them",
  nextCards(snap({ account: { name: "x" }, scout: { status: "running", url: "https://acme.dev" } }))[0].kind, "onboard.voice");
const allVoice = { voice_done: ["casing", "length", "emoji", "exclamations", "dashes", "contractions", "hedging", "greeting", "roughness"] };
check("...and once they are answered the wait is all that is left",
  nextCards(snap({ account: { name: "x" }, stash: allVoice, scout: { status: "running", url: "https://acme.dev" } }))[0].id, "onboard.wait");
const prop = { project_md: "# What you sell\n\nacme", icp_md: "# Who", rule_md: "# Rule", unknown: [] };
const readyScout = { status: "ready", url: "https://acme.dev", error: null, proposal: prop };
check("a landed scout deals the proof-read, seeded with what it wrote",
  nextCards(snap({ account: { name: "x" }, stash: allVoice, scout: readyScout }))[0].field.value, prop.project_md);
check("...one file at a time", nextCards(snap({ account: { name: "x" }, stash: allVoice, scout: readyScout }))
  .filter((c) => c.kind === "onboard.file").length, 1);
const probed = { account_skipped: false, ...allVoice, probe: { place: "saas", q: "clients", fired: true } };
check("a probe above the floor leads with Watch",
  nextCards(snap({ account: { name: "x" }, stash: probed, memory: memDone, probe: { running: false, last: { read: 9 }, fitRate: 0.42 } }))[0].primary.id, "watch");
check("a probe below the floor leads with Try another — watching is the fallback",
  nextCards(snap({ account: { name: "x" }, stash: probed, memory: memDone, probe: { running: false, last: { read: 9 }, fitRate: 0.05 } }))[0].primary.id, "another");
const onb = { account: { name: "x" }, stash: { ...allVoice, welcomed: true }, memory: memDone, sources: [{ place: "saas" }], itemCount: 3 };
check("onboarded is a fact, not a mood", onboarded(snap(onb)), true);
check("an unanswered room's rules outrank everything",
  nextCards(snap({ ...onb, rooms: [{ place: "saas", state: "unanswered" }], pendingCount: 4 }))[0].id, "room.rules.saas");
const qItem = { id: "t3_q", place: "saas", author: "ana", title: "how do I get clients", body: "stuck", why: "asks directly", url: "https://reddit.com/r/saas/comments/q/x/", draft: { text: "try this", flags: null }, blockedWhy: null, readyState: "ready", readyWhy: null };
check("a judged person with a draft is the card, with I-posted-it live",
  nextCards(snap({ ...onb, rooms: [{ place: "saas", state: "yes" }], queue: [qItem] }))[0].actions[0].disabled, undefined);
check("...and the governor's no arrives as a disabled button that says why",
  nextCards(snap({ ...onb, rooms: [{ place: "saas", state: "yes" }], queue: [{ ...qItem, blockedWhy: "2 replies in r/saas in 24h" }] }))[0].actions[0].why, "2 replies in r/saas in 24h");
check("a machine that is on and quiet says so honestly",
  nextCards(snap({ ...onb, rooms: [{ place: "saas", state: "yes" }] }))[0].id, "work.quiet");

/* ------------------------------------------------------------ the deck API */

// A second throwaway server: the acts write, so they get their own dir.
const boxC = mkdtempSync(join(tmpdir(), "earshot-cards-"));
const DC = join(boxC, ".earshot");
execFileSync(process.execPath, [ES, "init"], { env: { ...process.env, EARSHOT_DIR: DC }, stdio: "ignore" });
const srvC = spawn(process.execPath, [SERVE, "--port", "0"], { env: { ...process.env, EARSHOT_DIR: DC }, stdio: ["ignore", "pipe", "pipe"] });
const baseC = await new Promise((resolve) => {
  let out = "";
  const t = setTimeout(() => resolve(null), 8000);
  srvC.stdout.on("data", (d) => {
    out += d;
    const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
    if (m) { clearTimeout(t); resolve(`http://127.0.0.1:${m[1]}`); }
  });
});

if (!baseC) { console.log("FAIL  the cards server did not start"); fail++; }
else {
  const deck = async () => (await (await fetch(baseC + "/api/cards")).json()).cards;
  const act = async (body, type = "application/json") =>
    await fetch(baseC + "/api/cards/act", { method: "POST", headers: { "content-type": type }, body: JSON.stringify(body) });

  check("the deck is JSON and opens with the account card", (await deck())[0].id, "onboard.account");

  // The CSRF boundary: a cross-origin page can send a form; it cannot send
  // application/json without a preflight, and nothing here answers preflights.
  check("an act that is not declared JSON is refused",
    (await act({ card: "onboard.account", action: "skip" }, "application/x-www-form-urlencoded")).status, 400);

  const skipped = await act({ card: "onboard.account", action: "skip" });
  check("skipping the account is accepted", skipped.status, 200);
  check("...and the deck moves on", (await deck())[0].id, "onboard.url");

  const voiced = await act({ card: "onboard.voice.casing", action: "next", choice: "lowercase-starts" });
  check("a voice answer is accepted", voiced.status, 200);
  check("...and lands in voice.json as the user's word, not a measurement",
    JSON.parse(readFileSync(join(DC, "voice.json"), "utf8")).user.casing.value, "lowercase-starts");

  // The send gate, server-side: a stale panel must not be able to record a
  // send the governor already refused. Two sent replies in the room inside
  // 24h is the measured limit.
  const at = new Date().toISOString();
  appendFileSync(join(DC, "found.jsonl"),
    ["a", "b", "c"].map((n) => JSON.stringify({ id: `t3_${n}`, place: "saas", url: `https://reddit.com/r/saas/comments/${n}/x/`, author: `u${n}`, title: "t", body: "b", posted_at: at, seen_at: at, probe: "saas:new" })).join("\n") + "\n");
  appendFileSync(join(DC, "marks.jsonl"),
    ["a", "b"].map((n) => JSON.stringify({ id: `t3_${n}`, mark: "sent", at })).join("\n") + "\n");
  const gated = await act({ card: "work.reply.t3_c", action: "posted" });
  check("the burst governor refuses the third reply into one room", gated.status, 400);
  check("...and the refusal says which room and why", /saas/.test((await gated.json()).error), true);

  // The strategist seam, without a network: an empty message answers without a
  // model, and a real one fails loudly for want of a key rather than hanging.
  const agentEmpty = await fetch(baseC + "/api/agent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "" }) });
  const agentReal = await fetch(baseC + "/api/agent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "hi" }) });
  check("the agent route answers an empty message without a model", agentEmpty.status, 200);
  check("...and a real one without a key is an error that names the fix",
    /key|not installed/.test((await agentReal.json()).error ?? ""), true);

  /* The read lane, end to end over HTTP: a read blocks, a "browser" claims
     it, answers with a feed, and the blocked read resolves with the body. */
  const reading = fetch(baseC + "/api/relay/read", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://www.reddit.com/r/saas/new.rss" }),
  });
  await new Promise((r) => setTimeout(r, 150));
  const claimed = (await (await fetch(baseC + "/api/relay/jobs")).json()).jobs;
  check("a waiting read is claimable by a browser", claimed.length, 1);
  check("...and the deck reports the lane as attached", (await (await fetch(baseC + "/api/cards")).json()).relay.attached, true);
  await fetch(baseC + "/api/relay/answer", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: claimed[0].id, status: 200, body: feed, finalUrl: claimed[0].url }),
  });
  const relayed = await (await reading).json();
  check("the answered body reaches the caller", relayed.status, 200);
  check("...verbatim", /t1_aaa/.test(relayed.body), true);
}
srvC.kill();

/* -------------------------------------------------------- the browser lane */

// The broker: everything times out, nothing is fetched twice, and only a
// platform's own rooms may ride the user's cookies.

{
  const b = relayBroker({ ttlMs: 60_000 });
  check("the lane is https only", (await b.read("http://www.reddit.com/r/x/new.rss")).error, "relay reads https only");
  check("the lane refuses a URL no platform recognises",
    (await b.read("https://example.com/feed.rss")).error, "relay reads only a platform's own rooms");

  const p = b.read("https://www.reddit.com/r/saas/new.rss");
  const jobs = await b.claim();
  check("a queued read is handed to exactly one claimer", jobs.length, 1);
  check("...and never handed out twice", (await b.claim()).length, 0);
  b.answer(jobs[0].id, { status: 200, body: "<feed></feed>", finalUrl: jobs[0].url });
  check("the answer resolves the read", (await p).status, 200);
  check("an answer for a job that is gone is late, not an error", b.answer("r999", { status: 200 }), false);

  const fast = relayBroker({ ttlMs: 120 });
  const dead = await fast.read("https://www.reddit.com/r/saas/new.rss");
  check("a read nobody claims dies with its reason", /unanswered/.test(dead.error), true);

  const tiny = relayBroker({ cap: 1 });
  tiny.read("https://www.reddit.com/r/a/new.rss");
  check("the queue has a ceiling", (await tiny.read("https://www.reddit.com/r/b/new.rss")).error, "relay queue is full");
}

// The relayed body goes through the SAME three-outcome logic as the anonymous
// lane — a block page or a silent redirect is the same lie from either seat.
{
  const { createServer } = await import("node:http");
  const answers = [
    { status: 200, body: feed, finalUrl: "https://www.reddit.com/r/x/new.rss" },
    { status: 200, body: "<html>blocked</html>", finalUrl: "https://www.reddit.com/r/x/new.rss" },
    { error: "no browser attached" },
  ];
  const stub = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(answers.shift()));
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const stubBase = `http://127.0.0.1:${stub.address().port}`;

  const good = await readViaRelay(stubBase, "https://www.reddit.com/r/x/new.rss");
  check("a relayed feed parses like an anonymous one", good.ok && good.entries.length, 1);
  check("...and says which seat read it", good.via, "browser");
  const blocked = await readViaRelay(stubBase, "https://www.reddit.com/r/x/new.rss");
  check("a block page through the relay is still an error, never 'empty'", blocked.ok, false);
  const dark = await readViaRelay(stubBase, "https://www.reddit.com/r/x/new.rss");
  check("a dark lane is a failed read with the relay named", /^relay:/.test(dark.error), true);
  stub.close();
}

/* -------------------------------------------------------- agent proposals */

// The strategist may reach for buttons it can see but not press. The
// allowlist is a security boundary: it lives in the zero-dep heart so this
// suite guards it without the brain installed, and the server re-parses the
// verb from its own stash at act time — the card can never do more than its
// label says.

check("the specialist may propose judging", proposable("judge")?.label, "Judge them");
check("...a probe, phrase and all", proposable("probe saas how do I get clients")?.args, ["saas", "--q", "how do I get clients"]);
check("...a specific draft", proposable("draft t3_abc12")?.args, ["t3_abc12"]);
check("it may NOT propose marking something sent", proposable("mark t3_x sent"), null);
check("...or watching a room the probe has not earned", proposable("watch saas"), null);
check("...or anything with a flag smuggled in", proposable("tick --limit 99"), null);

const proposalSnap = snap({
  account: { name: "x" }, stash: { welcomed: true, agent_card: { question: "Judge the backlog?", why: "4 waiting", verb: "judge" } },
  memory: memDone, sources: [{ place: "saas" }], rooms: [{ place: "saas", state: "yes" }], itemCount: 3,
});
check("a proposal lands on the deck with the verb's own label",
  nextCards(proposalSnap).find((c) => c.kind === "agent.propose")?.primary.label, "Judge them");
check("...riding second, behind the system's own top action",
  nextCards(proposalSnap)[1]?.kind, "agent.propose");
// The first live proposal was stashed mid-onboarding and never rendered,
// which made the strategist's "it's on your deck now" a lie. Never again:
check("a proposal is visible during onboarding too",
  nextCards(snap({ stash: { agent_card: { question: "q", why: "w", verb: "tick" } } }))[1]?.kind, "agent.propose");
check("a proposal with a verb outside the law never renders",
  nextCards({ ...proposalSnap, stash: { ...proposalSnap.stash, agent_card: { question: "x", why: "y", verb: "rm -rf /" } } })
    .some((c) => c.kind === "agent.propose"), false);

/* ---------------------------------------------------------------- persona */

// persona.md is memory the operator owns, like the other files — and UNLIKE
// them it reaches only the strategist's seat. A persona in the judge's
// context is a judge with a personality, which is a rubric drift nobody
// asked for; these pin the boundary.

{
  seedMissing(DC); // an older .earshot grows the new file, same as boot does
  check("persona.md is editable memory", allowed("persona.md"), true);
  const prog = memoryProgress(DC);
  check("the editor lists it", prog.files.some((f) => f.file === "persona.md"), true);
  check("...but setup does not count it — unedited is a working persona", prog.total, 4);
  writeMemory(DC, "persona.md", "# Your specialist\n\nYou are Vera. Blunt, kind, allergic to fluff.");
  writeMemory(DC, "project.md", "# What you sell\n\nA thing people pay for.");
  const ctx = memoryContext(DC);
  check("the judge and writer hear about the project", /pay for/.test(ctx), true);
  check("...and never about the persona, even once it is written", /Vera/.test(ctx), false);
}

// THE DOCTRINE, pinned: only the finding verbs may take the browser lane.
// sync/check/back measure what a logged-out stranger sees, and a logged-in
// read would answer that question wrongly while looking right. If this count
// moves, somebody changed who is allowed to ride the user's session — that
// must be a decision, not a drive-by.
{
  const src = readFileSync(ES, "utf8");
  check("exactly two call sites — tick and probe — may use the browser lane",
    (src.match(/fetchAnon\([^)]*relay: true/g) ?? []).length, 2);
  check("the visibility verbs pass no relay flag at all",
    (src.match(/fetchAnon\((userFeed|threadFeed|commentFeed)[^)]*relay/g) ?? []).length, 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
