#!/usr/bin/env node
// Tests for the things that would break QUIETLY. A loud break shows up the
// first time anybody runs `mq check`; these are the ones that would keep
// working and start lying.
//
//   node bin/test.mjs
//
// The fixtures are synthetic, but every field shape in them was copied from a
// live feed measured 2026-08-28 — a real one is not committed, because a tool
// with a 48-hour retention rule should not ship somebody's comments in its
// own test directory.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { threadOf, itemOf, postEntries, searchEntries, commentEntries, kindOf, readPage, SPECS, pageOf } from "../skills/reddit/pages.mjs";
import { classify, history } from "../lib/verdict.mjs";
import { conversation, byUrgency } from "../lib/conversation.mjs";
import { refuse, scoped, isParody } from "../skills/reddit/shapes.mjs";
import { verdictOf } from "../lib/probe.mjs";
import { fromDescription, readRoomFile, roomFile, bansPromotion } from "../lib/rules.mjs";
import { conforms } from "../lib/llm.mjs";
import { loadPlatforms, platform, roomOf } from "../lib/platform.mjs";
import { longestSharedRun, repeats, claims, inventedLinks, theirs, RUN_LIMIT } from "../lib/guards.mjs";
import { standing, readiness, burst, mix } from "../lib/ready.mjs";
import { nextCards, onboarded, questionCards } from "../lib/cards.mjs";
import { agentDefinition } from "../lib/skills.mjs";
import { controlBroker, permitted, familiesOf, grantsOf, TOOLKIT } from "../lib/control.mjs";
import { browser, NOT_ATTACHED } from "../lib/browse.mjs";
import { parseCampaign, campaignFile, writeCampaign, readCampaigns, readCampaign, writerBlock, judgeLine, campaignDraft, campaignHash, MENTIONS } from "../lib/campaigns.mjs";
import { createProject, useProject, listProjects, currentDir, slug as projectSlug } from "../lib/projects.mjs";
import { sharedDir, isChildProject } from "../lib/dirs.mjs";
import { signalWritingRules } from "../lib/writing.mjs";
import { labelsOf, composerOf, first } from "../lib/platform.mjs";
import { allowed, memoryProgress, memoryContext, writeMemory, seedMissing } from "../lib/memory.mjs";
import { proposable } from "../lib/cards.mjs";
import { store } from "../lib/store.mjs";
import { voiceQuestions } from "../lib/voice.mjs";
import { conversationRows, bindConversations, recordReturn, recordTurn, closeConversation, waiting as waitingRows, yourTurns, dueConversations, unbound, campaignDigest, digestText } from "../lib/conversations.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ES = join(here, "mq.mjs");
const box = mkdtempSync(join(tmpdir(), "mq-test-"));
const env = { ...process.env, MQ_DIR: join(box, ".mq") };
const es = (args) => execFileSync(process.execPath, [ES, ...args], { env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
// `check` reaches the network once it has work; we only want its plan, so a
// non-zero exit that already printed the plan is a pass, not a failure.
const esFails = (args) => { try { return es(args); } catch (e) { return `${e.stdout || ""}${e.stderr || ""}`; } };
const esFails2 = (args, dir) => { try { return execFileSync(process.execPath, [ES, ...args], { env: { ...process.env, MQ_DIR: dir }, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }); } catch (e) { return `${e.stdout || ""}${e.stderr || ""}`; } };

let pass = 0, fail = 0;
const check = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "  ok  " : "FAIL  "}${what}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

/* ---------------------------------------------------------------- parsing */

// A source watched before 0.6.0 still carries the feed's URL. The skill
// reads the page it stands for; the stored row is not rewritten.
check("a legacy feed URL from a 0.5 source reads as its page, and a page URL is left alone",
  [pageOf("https://www.reddit.com/r/sideproject/search/.rss?q=where%20do%20I%20find%20clients&restrict_sr=1&sort=new&t=week&limit=100"), pageOf("https://www.reddit.com/r/saas/new/.rss"), pageOf("https://www.reddit.com/r/saas/search/?q=x&type=posts&restrict_sr=1&sort=new&t=week")],
  ["https://www.reddit.com/r/sideproject/search/?q=where%20do%20I%20find%20clients&restrict_sr=1&sort=new&t=week", "https://www.reddit.com/r/saas/new/", "https://www.reddit.com/r/saas/search/?q=x&type=posts&restrict_sr=1&sort=new&t=week"]);

/* ---- the pages: rows off a rendered page → the store's entries (0.6.0).
   The feed's Atom went with the anonymous lane; what a page looks like is a
   declared spec (skills/reddit/pages.mjs) and these pin the mapping. */
{
  const rows = [
    { id: "t3_abc", title: "how do I get clients", author: "ana", permalink: "/r/saas/comments/abc/how_do_i_get_clients/", at: "2026-09-01T10:00:00.000Z", comments: "3", score: "2", type: "text", body: "stuck at zero\n\nany ideas", sub: "r/saas" },
    { id: null, title: "no permalink", author: "bo", permalink: null, at: null },
    { id: "t3_def", title: "link post", author: null, permalink: "https://www.reddit.com/r/saas/comments/def/link_post/?utm=x", at: "junk", comments: null, body: "" },
  ];
  const posts = postEntries(rows);
  check("a listing's rows become post entries, ids and permalinks the platform's", posts.map((e) => [e.id, e.kind, e.url]), [["t3_abc", "post", "https://www.reddit.com/r/saas/comments/abc/how_do_i_get_clients/"], ["t3_def", "post", "https://www.reddit.com/r/saas/comments/def/link_post/"]]);
  check("...with the author, the date as ISO, and the body as written", [posts[0].author, posts[0].at, posts[0].body], ["ana", "2026-09-01T10:00:00.000Z", "stuck at zero\n\nany ideas"]);
  check("...and a date the page did not give is null, never invented", [posts[1].at, posts[1].author], [null, null]);
  const search = searchEntries([{ href: "https://www.reddit.com/r/saas/comments/zz9/x/?ref=search", title: "x" }, { href: "https://www.reddit.com/r/saas/comments/zz9/x/", title: "x again" }, { href: "https://www.reddit.com/r/saas/", title: "not a post" }]);
  check("a search page's rows are previews — an id off the link, no body, once each", search.map((e) => [e.id, e.preview, e.body]), [["t3_zz9", true, ""]]);
  const cs = commentEntries([{ id: "t1_aaa", author: "me", depth: "0", permalink: "/r/x/comments/p1/slug/aaa/", body: "what I said", at: "2026-09-01T10:00:00Z" }, { id: "t5_sub", author: "x" }, { id: "t1_bbb", author: "[deleted]", body: "[removed]", permalink: "/r/x/comments/p1/slug/bbb/" }]);
  check("a thread's rows become comment entries; a subreddit row is dropped", cs.map((e) => [e.id, e.kind, e.body]), [["t1_aaa", "comment", "what I said"], ["t1_bbb", "comment", "[removed]"]]);
  check("what a permalink names is the platform's to say", [itemOf("https://www.reddit.com/r/x/comments/p1/slug/aaa/"), itemOf("https://www.reddit.com/r/x/comments/p1/slug/"), itemOf("https://www.reddit.com/r/x/comments/p1/comment/aaa/"), itemOf("https://example.com/x")],
    [{ id: "t1_aaa", kind: "comment" }, { id: "t3_p1", kind: "post" }, { id: "t1_aaa", kind: "comment" }, null]);
  check("a page's kind is read off its url", ["https://www.reddit.com/r/saas/new/", "https://www.reddit.com/r/saas/search/?q=x&restrict_sr=1", "https://www.reddit.com/r/saas/comments/abc/t/", "https://www.reddit.com/r/saas/comments/abc/t/ccc/", "https://www.reddit.com/user/ana/comments/"].map(kindOf),
    ["listing", "search", "thread", "comment", "profile"]);
  check("every spec is a selector and a field map — the extension runs it, the skill declares it", Object.values(SPECS).every((s) => typeof s.items === "string" && s.items && Object.values(s.fields).every((f) => /^(attr:[^@]+(@.+)?|text(:.+)?|href(:.+)?|tag)$/.test(f))), true);
}

// Comment entries carry no <published> at all; reading it dates every comment null.

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
const ITEMS = join(env.MQ_DIR, "items.jsonl");
const item = (over = {}) => JSON.stringify({ id: "t1_aaa", kind: "comment", url: "https://reddit.com/r/x/comments/p1/slug/aaa/", author: "me", at: "2026-08-28T10:00:00Z", title: null, body: "what I actually said", body_sha256: "h", seen_at: new Date().toISOString(), source: "profile", ...over }) + "\n";

writeFileSync(ITEMS, item());
appendFileSync(ITEMS, item({ body: "TRUNCATED RE-READ" }));

// Checks accumulate; nothing is ever replaced. Overwriting here would silently
// destroy the only thing this tool has that a private window does not.
appendFileSync(join(env.MQ_DIR, "checks.jsonl"),
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
writeFileSync(join(env.MQ_DIR, "checks.jsonl"),
  JSON.stringify({ id: "t1_aaa", at: "2026-08-04T00:00:00Z", state: "error", why: "timeout", confident: false }) + "\n");
// An unroutable host, so this asserts the PLAN without sending anything to
// Reddit: a test suite that quietly reads the live site is a test suite that
// fails on a train, and it spends the one-a-minute budget the tool is careful
// with everywhere else.
writeFileSync(ITEMS, item({ url: "https://reddit.invalid/r/x/comments/p1/slug/aaa/" }));
const plan = esFails(["check"]);
check("an item whose last check errored is still due", /1 to check across 1 threads/.test(plan), true);
check("...and the failed re-read is recorded as an error, not a removal", /error/.test(plan), true);
writeFileSync(join(env.MQ_DIR, "checks.jsonl"),
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
  JSON.parse(readFileSync(join(env.MQ_DIR, "account.json"), "utf8")).name, "tester");


/* ------------------------------------------------------ phase 2 — refusals */

// The shape measurements, as refusals rather than as a ranking. The firehose
// was 76% of everything ever read and sat in the 4.2% half; a search without
// restrict_sr=1 silently becomes a site-wide search at 10%.
check("the comment firehose is refused by shape", Boolean(refuse({ kind: "comments" })), true);
check("...and by URL, however it is written", Boolean(refuse({ url: "https://www.reddit.com/r/x/comments/" })), true);
check("an unscoped search is refused", Boolean(refuse({ url: "https://www.reddit.com/r/x/search/?q=a&sort=new" })), true);
check("a site-wide search is refused", Boolean(refuse({ url: "https://www.reddit.com/search/?q=a" })), true);
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

const box2 = mkdtempSync(join(tmpdir(), "mq-find-"));
const env2 = { ...process.env, MQ_DIR: join(box2, ".mq") };
const es2 = (args, stdin) => { try { return execFileSync(process.execPath, [ES, ...args], { env: env2, input: stdin ?? "", encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }); } catch (e) { return `${e.stdout || ""}${e.stderr || ""}`; } };
es2(["init"]);
const D2 = env2.MQ_DIR;

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

// "i built doctick" — to the person who built DocTick (a free writer, 2026-09-07,
// with me.md still the seed). The claim is theirs; the guard says so by name.
const theirPost = "I built DocTick: a passwordless client document portal for Google Drive. Giving away 50 passes for feedback.";
check("claiming the product in their own post as yours is named", theirs("Hey i built doctick to fix google drive's missing file request feature.", theirPost, ""), ["doctick"]);
check("...once, however many times it is said", theirs("i built doctick. later i made DocTick better.", theirPost, ""), ["doctick"]);
check("a product me.md names is yours to claim", theirs("i built doctick for exactly this", theirPost, "# me\n\nI built DocTick last spring."), []);
check("a thing that is not a name never matches", theirs("i built a small tool that does that, and i made something similar", theirPost, ""), []);
check("a name not in their post is a history claim, not theirs", theirs("i built questboard for this", theirPost, ""), []);
check("no post, nothing to compare against", theirs("i built doctick", "", ""), []);

// The drafter has no search, so any URL it did not lift from the thread is invented.
check("a link from the thread is fine", inventedLinks("see https://real.example", "body https://real.example"), []);
check("a link from nowhere is not", inventedLinks("see https://made-up.example", "body https://real.example"), ["https://made-up.example"]);
check("trailing punctuation does not disguise it", inventedLinks("at https://made-up.example.", "body"), ["https://made-up.example"]);

/* --------------------------------------------------- phase 3 through the CLI */

const box3 = mkdtempSync(join(tmpdir(), "mq-draft-"));
const env3 = { ...process.env, MQ_DIR: join(box3, ".mq") };
const es3 = (args, stdin) => { try { return execFileSync(process.execPath, [ES, ...args], { env: env3, input: stdin ?? "", encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }); } catch (e) { return `${e.stdout || ""}${e.stderr || ""}`; } };
es3(["init"]);
const D3 = env3.MQ_DIR;
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
const box4 = mkdtempSync(join(tmpdir(), "mq-gate-"));
const env4 = { ...process.env, MQ_DIR: join(box4, ".mq") };
const es4 = (a) => { try { return execFileSync(process.execPath, [ES, ...a], { env: env4, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }); } catch (e) { return `${e.stdout || ""}${e.stderr || ""}`; } };
es4(["init"]);
writeFileSync(join(env4.MQ_DIR, "found.jsonl"), JSON.stringify({ id: "t3_z", place: "SaaS", url: "https://reddit.com/r/SaaS/comments/z/y/", author: "zed", title: "t", body: "b", posted_at: "2026-08-29T09:00:00Z", seen_at: "2026-08-29T10:00:00Z", probe: "SaaS:new" }) + "\n");
const blocked = es4(["mark", "t3_z", "sent"]);
check("replying where you have no standing is refused", /not logged/.test(blocked), true);
check("...and the refusal names the measured shape", /83\.9 minutes/.test(blocked), true);
check("...and offers the override rather than just saying no", /--anyway/.test(blocked), true);
check("the override works, because you are the one posting", /logged as answered/.test(es4(["mark", "t3_z", "sent", "--anyway"])), true);
// A skip is not a reply, so the gate has no business touching it.
check("a skip is never gated", /discarded/.test(es4(["mark", "t3_z", "skip"])), true);

// The rename migration: a directory written under the tool's earlier name is
// carried over by rename — same data, current name, exactly once.
{
  const box5 = mkdtempSync(join(tmpdir(), "mq-rename-"));
  const legacy = join(box5, ".earshot");
  const envBare = { ...process.env };
  delete envBare.MQ_DIR;
  execFileSync(process.execPath, [ES, "init"], { cwd: box5, env: { ...envBare, MQ_DIR: legacy }, stdio: "ignore" });
  writeFileSync(join(legacy, "items.jsonl"), JSON.stringify({ id: "t1_keep", kind: "comment", url: "https://reddit.com/r/x/comments/a/b/", author: "me", at: "2026-08-01T00:00:00Z" }) + "\n");
  execFileSync(process.execPath, [ES, "status"], { cwd: box5, env: envBare, stdio: "ignore" });
  const { existsSync: ex } = await import("node:fs");
  check("an .earshot/ directory is renamed to .mq/ on first touch", ex(join(box5, ".mq")) && !ex(legacy), true);
  check("...and the data came along", /t1_keep/.test(readFileSync(join(box5, ".mq", "items.jsonl"), "utf8")), true);
}

/* ------------------------------------------------------- the dashboard */
// Served on localhost, so the interesting failures are not "does it render"
// but "what does it render, and who can reach it".

const { spawn } = await import("node:child_process");
const SERVE = join(here, "serve.mjs");
const boxW = mkdtempSync(join(tmpdir(), "mq-web-"));
const DW = join(boxW, ".mq");
execFileSync(process.execPath, [ES, "init"], { env: { ...process.env, MQ_DIR: DW }, stdio: "ignore" });
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
const srv = spawn(process.execPath, [SERVE, "--port", "0"], { env: { ...process.env, MQ_DIR: DW }, stdio: ["ignore", "pipe", "pipe"] });
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
  for (const p of ["/", "/people", "/people?view=waiting", "/campaigns", "/you", "/standing", "/waiting", "/queue", "/rooms", "/ready", "/sources", "/voice"]) {
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

/* The registry beneath the door: rings, slots, and the choice that resolves
   them. Two skills may serve one purpose; which one runs is the instance's
   call, never a guess — and every refusal names its fix. */
const { frontmatter, discoverSkills, resolveSkills, readChoices, writeChoice } = await import("../lib/skills.mjs");
const { mkdirSync: mkd } = await import("node:fs");

const fmParsed = frontmatter("---\nname: x\ndescription: d\nprovides: page:board\n---\nbody");
check("frontmatter reads the scalars", [fmParsed.name, fmParsed.provides], ["x", "page:board"]);
check("prose without fences is not a manifest", frontmatter("# just prose"), {});

const ringbox = mkdtempSync(join(tmpdir(), "mq-skills-"));
const RING1 = join(ringbox, "shipped"), RING2 = join(ringbox, "yours");
const putSkill = (root, id, fmText, files = {}) => {
  mkd(join(root, id), { recursive: true });
  writeFileSync(join(root, id, "SKILL.md"), fmText);
  for (const [n, body] of Object.entries(files)) writeFileSync(join(root, id, n), body);
};
putSkill(RING1, "alpha", "---\nname: alpha\ndescription: knows things\n---\n");
putSkill(RING1, "board", "---\nname: board\ndescription: a board\nprovides: page:board\n---\n", { "page.mjs": "export default {}" });
putSkill(RING1, "board2", "---\nname: board2\ndescription: another board\nprovides: page:board\n---\n", { "page.mjs": "export default {}" });
putSkill(RING1, "_template", "---\nname: t\ndescription: t\n---\n");
putSkill(RING1, "broken", "no frontmatter at all");
putSkill(RING2, "alpha", "---\nname: alpha-local\ndescription: yours\n---\n");
const RINGS = [{ root: RING1, ring: "built-in" }, { root: RING2, ring: "local" }];
const disc = discoverSkills(null, RINGS);
check("a folder whose manifest carries no name is refused with its reason",
  disc.refused.find((r) => r.id === "broken")?.why.includes("name and description"), true);
check("_template is not a skill", disc.found.some((s) => s.id === "_template"), false);
check("your ring replaces the built-in on the same id", disc.found.find((s) => s.id === "alpha")?.name, "alpha-local");
check("a seat is a file, detected and nothing more", disc.found.find((s) => s.id === "board")?.seats.page !== undefined, true);

const res0 = resolveSkills(disc.found, {});
check("knowledge is always active", res0.active.some((s) => s.id === "alpha"), true);
check("two skills on one slot with no choice: neither is active", res0.active.some((s) => s.provides === "page:board"), false);
check("...and the conflict names the slot and the fix", /page:board/.test(res0.conflicts[0]?.why), true);
check("the choice file resolves it", resolveSkills(disc.found, { "page:board": "board2" }).active.find((s) => s.provides === "page:board")?.id, "board2");
check("a stale choice is a conflict that names the ghost",
  /"gone"/.test(resolveSkills(disc.found, { "page:board": "gone" }).conflicts[0]?.why), true);

putSkill(RING2, "board3", "---\nname: board3\ndescription: your board\nprovides: page:board\n---\n", { "page.mjs": "export default {}" });
check("a sole local candidate wins its slot — dropping the folder in was the choice",
  resolveSkills(discoverSkills(null, RINGS).found, {}).active.find((s) => s.provides === "page:board")?.id, "board3");

const choiceBox = mkdtempSync(join(tmpdir(), "mq-choice-"));
writeChoice(choiceBox, "page:board", "board2");
check("a choice round-trips through skills.json", readChoices(choiceBox)["page:board"], "board2");
writeChoice(choiceBox, "page:board", null);
check("...and a null choice clears it", readChoices(choiceBox)["page:board"] ?? null, null);

/* End to end through the platform door: a local platform skill in a scratch
   data dir loads beside the built-in, answers roomOf, and vanishes cleanly. */
const platBox = mkdtempSync(join(tmpdir(), "mq-plat-"));
putSkill(join(platBox, "skills"), "fakenet",
  "---\nname: fakenet\ndescription: a test platform\nprovides: platform:fakenet\n---\n",
  { "adapter.mjs": `export default { id: "fakenet", name: "FakeNet", gapMs: 1, read: () => ({ ok: false, error: "x" }), sourceUrl: () => "https://f.example/x", refuse: () => null, roomOf: (u) => /fakenet\\.example\\/g\\/(\\w+)/.exec(String(u))?.[1] ?? null, roomLabel: (p) => "g/" + p };` });
await loadPlatforms(platBox);
check("a local platform skill loads through the door", platform("fakenet")?.name, "FakeNet");
check("...beside the built-in, not instead of it", platform("reddit")?.name, "Reddit");
check("roomOf consults it", roomOf("https://fakenet.example/g/hall"), "hall");
await loadPlatforms(null); // back to built-ins for the rest of the suite
check("reloading from scratch drops what is gone", platform("fakenet"), null);

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
  hasModel: false,
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
// A site the extension may not read outranks everything — the button Chrome
// needs the click from rides on the card itself, not on a line under it.
{
  const g = nextCards(snap({ grants: ["https://www.reddit.com"] }))[0];
  check("a site the extension may not read yet is the first card", [g.id, g.kind, g.primary.id, g.secondary.id, g.data.origin],
    ["grant.https://www.reddit.com", "grant.ask", "allow", "later", "https://www.reddit.com"]);
  check("...naming the host on the button", g.primary.label, "Allow www.reddit.com");
}
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

// PEOPLE OUTRANK SETUP — the day-one bug, pinned. Probing from the dashboard
// filled a queue of twenty judged people while the panel, gating work behind
// "a source is watched", kept asking which room to look in first.
const noSources = { account: { name: "x" }, stash: allVoice, memory: memDone, sources: [], itemCount: 3 };
check("a judged person deals even when nothing is watched yet",
  nextCards(snap({ ...noSources, queue: [qItem] }))[0].kind, "work.reply");
check("...and pending verdicts deal before the room question, not instead of it",
  nextCards(snap({ ...noSources, pendingCount: 40 })).map((c) => c.id).slice(0, 2), ["work.judge", "onboard.room"]);
// The judge runs by itself (0.9.1): the card waits while it does, and after
// a failure says why and offers it again — never a button that looks
// unpressed over a job that failed in a log nobody opened.
{
  const judging = nextCards(snap({ ...noSources, pendingCount: 40, hasModel: true, judging: true }))[0];
  const failed = nextCards(snap({ ...noSources, pendingCount: 40, hasModel: true, judgeFailed: "429 rate limited" }))[0];
  check("while the judge runs by itself the card waits; after it failed the card says why and offers it again",
    [judging.kind, judging.primary.id, failed.kind, failed.primary.label, /429 rate limited/.test(failed.help)], ["work.judge.wait", "wait", "work.judge", "Try again now", true]);
  const unwritten = { ...qItem, draft: null };
  const writing = nextCards(snap({ ...noSources, hasModel: true, queue: [unwritten], drafting: "t3_q" }))[0];
  const declined = nextCards(snap({ ...noSources, hasModel: true, queue: [unwritten], draftFailed: { id: "t3_q", error: "the writer declined: it would have to name the product" } }))[0];
  check("a person whose draft is being written is a wait, not a button; a failed attempt says why and offers it again",
    [writing.kind, writing.primary.id, writing.secondary, declined.kind, declined.primary.label, /writer declined/.test(declined.help)], ["work.draft.wait", "wait", undefined, "work.draft", "Write it again", true]);
  check("...and somebody else's failure is not this person's", nextCards(snap({ ...noSources, hasModel: true, queue: [unwritten], draftFailed: { id: "t3_other", error: "x" } }))[0].primary.label, "Write the draft");
}

/* ------------------------------------------------------------ the deck API */

// A second throwaway server: the acts write, so they get their own dir.
const boxC = mkdtempSync(join(tmpdir(), "mq-cards-"));
const DC = join(boxC, ".mq");
execFileSync(process.execPath, [ES, "init"], { env: { ...process.env, MQ_DIR: DC }, stdio: "ignore" });
const srvC = spawn(process.execPath, [SERVE, "--port", "0"], { env: { ...process.env, MQ_DIR: DC }, stdio: ["ignore", "pipe", "pipe"] });
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

  /* No read lane any more (0.6.0): the deck names its project instead. */
  check("the deck says which project it is, and lists the others", (await (await fetch(baseC + "/api/cards")).json()).project, { id: "default", name: "default", all: [{ id: "default", name: "default", current: true }] });
  check("...and there is no background read lane to claim from", (await fetch(baseC + "/api/relay/jobs")).status, 404);

  /* The control lane, end to end over HTTP: a lease blocks until a "browser"
     answers with the tab it opened; a call carries THAT tab, never the
     caller's; a click is refused by the grant screen before any browser hears
     of it; release closes the tab. */
  const cpost = (p, body) => fetch(baseC + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const cjobs = async () => (await (await fetch(baseC + "/api/control/jobs")).json()).jobs;
  const leasing = cpost("/api/control/lease", { task: "smoke", url: "https://www.reddit.com/r/saas/" });
  await new Promise((r) => setTimeout(r, 150));
  let cj = await cjobs();
  check("a lease is handed to the browser as a tab to open, in the operator's own session", [cj.map((j) => j.tool), cj[0]?.input?.stranger], [["lease"], false]);
  await cpost("/api/control/answer", { id: cj[0].id, tabId: 41, groupId: 7, windowId: 1 });
  const lease = await (await leasing).json();
  check("...and resolves with the tab the browser opened", lease.tabId, 41);
  const foreign = await cpost("/api/control/act", { lease: lease.id, tool: "read_page", input: { tabId: 999 } });
  check("a call may not name a tab the lease does not hold", foreign.status, 403);
  const treeing = cpost("/api/control/act", { lease: lease.id, tool: "read_page", input: { filter: "interactive" } });
  await new Promise((r) => setTimeout(r, 150));
  cj = await cjobs();
  check("a read carries the lease's own tab", cj[0]?.input?.tabId, 41);
  check("...and the deck reports the lane attached, with the lease on it",
    (await (await fetch(baseC + "/api/cards")).json()).control.leases[0]?.tabs, [41]);
  await cpost("/api/control/answer", { id: cj[0].id, tree: 'button "Comment" [ref_3]', lines: 1 });
  check("the tree reaches the caller", /ref_3/.test((await (await treeing).json()).tree), true);
  const clicking = await cpost("/api/control/act", { lease: lease.id, tool: "computer", input: { action: "left_click", ref: "ref_3" } });
  check("a click with read-only grants is refused before the browser hears of it", clicking.status, 403);
  check("...naming the grant it lacks", /"click" grant/.test((await clicking.json()).error), true);
  check("...and nothing was queued for the browser", (await cjobs()).length, 0);
  const releasing = cpost("/api/control/release", { lease: lease.id });
  await new Promise((r) => setTimeout(r, 150));
  cj = await cjobs();
  check("release closes the lease's tabs", cj[0]?.input?.tabIds, [41]);
  await cpost("/api/control/answer", { id: cj[0].id, ok: true });
  check("...and the lease is gone", (await (await releasing).json()).ok, true);
  check("a call on a released lease is refused", (await cpost("/api/control/act", { lease: lease.id, tool: "read_page", input: {} })).status, 403);
}
srvC.kill();

/* ------------------------------------------------------------ the browser */

// The ONE reading mechanism (0.6.0): a page in the operator's own Chrome,
// through the control lane. A stub server plays the lane — it answers each
// toolkit call the way the extension would for a page it "shows" — and the
// reddit skill's readPage is driven through it end to end: rows → entries,
// a silent redirect, a wall, a profile that does not exist, and a dark lane.
{
  const { createServer } = await import("node:http");
  let page = null;        // what the "browser" shows: { url, title, rows: { post|comment|... }, text }
  const calls = [];
  const stub = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const out = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      const b = body ? JSON.parse(body) : {};
      if (req.url === "/api/control/leases") return out({ attached: true, leases: [], grants: [] });
      if (req.url === "/api/control/lease") { calls.push(["lease", b.url, b.stranger]); return out({ id: "L1", tabId: 41, url: page?.url ?? b.url, title: page?.title ?? "" }); }
      if (req.url === "/api/control/release") { calls.push(["release"]); return out({ ok: true }); }
      if (req.url === "/api/control/act") {
        calls.push([b.tool, b.input?.spec?.items ?? b.input?.url ?? null]);
        if (b.tool === "navigate") return out({ url: page?.url ?? b.input.url, title: page?.title ?? "", status: "complete" });
        if (b.tool === "tabs_context") return out({ tabs: [{ tabId: 41, url: page?.url, title: page?.title, status: "complete" }] });
        if (b.tool === "get_page_text") return out({ text: page?.text ?? "", url: page?.url, title: page?.title });
        if (b.tool === "read_dom") { const rows = page?.rows?.[b.input.spec.items] ?? []; return out({ rows, total: rows.length, url: page?.url, title: page?.title }); }
        return out({ error: `the stub does not do ${b.tool}` });
      }
      out({ error: "not found" });
    });
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${stub.address().port}`;

  page = { url: "https://www.reddit.com/r/saas/new/", title: "r/saas", rows: { "shreddit-post": [{ id: "t3_abc", title: "how do I get clients", author: "ana", permalink: "/r/saas/comments/abc/x/", at: "2026-09-01T10:00:00Z", body: "stuck" }] }, text: "" };
  const b1 = browser(base, { task: "test" });
  const listing = await readPage("https://www.reddit.com/r/saas/new/", b1);
  check("a listing read in the browser comes back as entries", [listing.ok, listing.entries.map((e) => e.id), listing.redirected], [true, ["t3_abc"], false]);
  check("...on a lease the verb opened, with the page's rows asked for by the skill's spec", [calls[0], calls.some((c) => c[0] === "read_dom" && c[1] === "shreddit-post")], [["lease", "https://www.reddit.com/r/saas/new/", false], true]);
  await b1.close();
  check("...and closed after", calls[calls.length - 1], ["release"]);

  page = { url: "https://www.reddit.com/search/?q=nosuchroom", title: "search", rows: {}, text: "no results" };
  const b2 = browser(base, { task: "test" });
  const moved = await readPage("https://www.reddit.com/r/nosuchroom/new/", b2);
  check("a room that does not exist is a silent redirect — caught by the final url, never 'nothing new'", [moved.ok, moved.redirected], [true, true]);
  await b2.close();

  page = { url: "https://www.reddit.com/r/private/new/", title: "r/private", rows: { "shreddit-blocking-modal, [data-testid='login-modal'], form[action*='login'], h1": [{ tag: "shreddit-blocking-modal", text: "You've been blocked by network security" }] }, text: "" };
  const b3 = browser(base, { task: "test" });
  const walled = await readPage("https://www.reddit.com/r/private/new/", b3);
  check("a wall is an error with its words, never an empty read", [walled.ok, /wall/.test(walled.error), /blocked/.test(walled.error)], [false, true, true]);
  await b3.close();

  page = { url: "https://www.reddit.com/user/nobody/comments/", title: "reddit", rows: {}, text: "Sorry, nobody on Reddit goes by that name." };
  const b4 = browser(base, { task: "test", stranger: true });
  const gone = await readPage("https://www.reddit.com/user/nobody/comments/", b4);
  check("a profile that does not render is the 404 finding, asked for from the stranger's seat", [gone.ok, gone.error, calls[calls.length - 1][0] === "get_page_text" || calls.some((c) => c[0] === "lease" && c[2] === true)], [false, "http_404", true]);
  await b4.close();

  page = { url: "https://www.reddit.com/r/saas/comments/abc/x/", title: "thread", rows: { "shreddit-post": [{ id: "t3_abc", title: "x", author: "ana", permalink: "/r/saas/comments/abc/x/", comments: "3" }], "shreddit-comment": [{ id: "t1_aaa", author: "me", depth: "0", permalink: "/r/saas/comments/abc/x/aaa/", body: "what I said" }] }, text: "" };
  const b5 = browser(base, { task: "test", stranger: true });
  const thread = await readPage("https://www.reddit.com/r/saas/comments/abc/x/", b5);
  check("a thread read carries the post and its comments, and says when it did not see them all", [thread.ok, thread.entries.map((e) => e.id), thread.truncated], [true, ["t3_abc", "t1_aaa"], true]);
  check("...so the verdict logic runs on it unchanged", classify({ id: "t1_aaa", kind: "comment", url: "https://www.reddit.com/r/saas/comments/abc/x/aaa/" }, thread).state, "visible");
  await b5.close();
  stub.close();

  // The lane that is not there: a failed read with the door named, in a
  // second, not a minute-long wait for a browser that never comes.
  const dark = browser("http://127.0.0.1:9", { task: "test" });
  const t0 = Date.now();
  const nothing = await dark.open("https://www.reddit.com/r/saas/new/");
  check("a dark lane is a failed read that names what to do", [nothing.error, Date.now() - t0 < 6000], [NOT_ATTACHED, true]);
}

/* -------------------------------------------------------- the control lane */

// The second protocol the extension speaks (PLAN.md 2026-09-03). Screened
// twice: here by GRANT — the agent's tools line, parsed in the zero-dep heart
// so this suite guards it without the brain — and in the page by LABEL
// (extension/screen.js). No agent holds click or type in milestone 1.

{
  check("read_page is a read", familiesOf("read_page"), ["read"]);
  check("a click is a click, by action", familiesOf("computer", { action: "left_click" }), ["click"]);
  check("form_input is typing", familiesOf("form_input"), ["type"]);
  check("a batch needs the union of its items",
    familiesOf("batch", { actions: [{ name: "navigate", input: { url: "https://x" } }, { name: "computer", input: { action: "type", text: "a" } }] }), ["read", "type"]);
  check("a batch with an unknown action is refused whole", familiesOf("batch", { actions: [{ name: "read_page" }, { name: "eval" }] }), null);
  check("a batch inside a batch is refused", familiesOf("batch", { actions: [{ name: "batch", input: { actions: [] } }] }), null);
  check("there is no eval in the toolkit", Object.keys(TOOLKIT).some((t) => /eval|javascript|script/.test(t)), false);
  check("a tools line grants families, and nothing else", grantsOf("browser.read, ask_person, judge"), ["read"]);
  check("read-only grants refuse a click, naming the grant",
    permitted("computer", { action: "left_click", ref: "ref_1" }, ["read"]).why?.includes('"click" grant'), true);
  check("...and a screenshot passes", permitted("computer", { action: "screenshot" }, ["read"]).ok, true);
  check("an unknown action is not a toolkit call, whatever the grants", permitted("computer", { action: "eval" }, ["read", "click", "type"]).ok, false);

  const b = controlBroker({ ttlMs: 60_000, paceMs: 120 });
  check("a lease opens on http(s) only", (await b.lease({ task: "t", url: "file:///etc/passwd" })).error, "a lease opens on an http(s) url");
  const leasing = b.lease({ task: "scout", url: "https://www.reddit.com/r/saas/" });
  let jobs = await b.claim(1000);
  check("a lease is a tab to open, handed to one claimer", jobs.map((j) => j.tool), ["lease"]);
  check("...never twice", (await b.claim()).length, 0);
  b.answer(jobs[0].id, { tabId: 12, groupId: 3, windowId: 1 });
  const L = await leasing;
  check("the lease holds the tab the browser opened", L.tabId, 12);
  check("a caller may not name a tab it does not hold", (await b.act(L.id, "read_page", { tabId: 13 })).refused, true);
  const clicking = await b.act(L.id, "computer", { action: "left_click", coordinate: [1, 1] }, { grants: ["read"] });
  check("a click without the grant is refused here, and the browser never hears of it", [clicking.refused, b.pending()], [true, 0]);
  check("typing needs its own grant", (await b.act(L.id, "form_input", { ref: "ref_1", value: "x" }, { grants: ["read", "click"] })).refused, true);
  // Pacing: two navigations to one host are handed out paceMs apart.
  const n1 = b.act(L.id, "navigate", { url: "https://www.reddit.com/r/a/" });
  const n2 = b.act(L.id, "navigate", { url: "https://www.reddit.com/r/b/" });
  const j1 = await b.claim(2000); const at1 = Date.now();
  check("a navigation carries the lease's tab", j1[0]?.input.tabId, 12);
  b.answer(j1[0].id, { url: "https://www.reddit.com/r/a/" });
  const j2 = await b.claim(2000); const at2 = Date.now();
  check("navigations to one host are spaced by the lane", at2 - at1 >= 100, true);
  b.answer(j2[0].id, { url: "https://www.reddit.com/r/b/" });
  check("both callers get their answers", [(await n1).url, (await n2).url].map((u) => u.slice(-3)), ["/a/", "/b/"]);
  // The grant that is missing: the browser names the origin, the lane
  // remembers, the panel asks — never a dialog from a worker nobody watches.
  const reading = b.act(L.id, "read_page", {});
  jobs = await b.claim(1000);
  b.answer(jobs[0].id, { error: "not_granted", origin: "https://acme.dev" });
  check("a site the extension may not read is named back", (await reading).grant, "https://acme.dev");
  check("...and listed for the panel to ask", b.grantsNeeded(), ["https://acme.dev"]);
  b.granted("https://acme.dev/*");
  check("...until the operator grants it", b.grantsNeeded(), []);
  // A script that hits the wall and releases still leaves the ask standing —
  // the panel shows the button to whoever looks next, not only while a lease lives.
  const reading2 = b.act(L.id, "read_page", {});
  jobs = await b.claim(1000);
  b.answer(jobs[0].id, { error: "not_granted", origin: "https://acme.dev" });
  await reading2;
  const releasing = b.release(L.id);
  jobs = await b.claim(1000);
  check("release closes exactly the lease's tabs", jobs[0]?.input.tabIds, [12]);
  b.answer(jobs[0].id, { ok: true });
  check("...and is idempotent", [(await releasing).ok, (await b.release(L.id)).ok], [true, true]);
  check("the ask outlives the lease that hit the wall", b.grantsNeeded(), ["https://acme.dev"]);
  b.granted("https://acme.dev");
  check("...and clears once the operator grants it", b.grantsNeeded(), []);
  check("a released lease refuses calls", (await b.act(L.id, "read_page", {})).refused, true);
  const dead = controlBroker({ ttlMs: 100 });
  check("a lease nobody claims dies with its reason", /unanswered/.test((await dead.lease({ task: "t", url: "https://x.y/" })).error), true);
}

/* ---------------------------------------------- findings from the browser */

// The scout reads a search page in the operator's own browser and records
// what it saw through `mq found` — the same table, the same refusals and the
// same judging as a probe; only the lane differs, and the row says which.
{
  const boxF = mkdtempSync(join(tmpdir(), "mq-found-"));
  const DF = join(boxF, ".mq");
  execFileSync(process.execPath, [ES, "init"], { env: { ...process.env, MQ_DIR: DF }, stdio: "ignore" });
  const found = (body) => { try { return execFileSync(process.execPath, [ES, "found"], { env: { ...process.env, MQ_DIR: DF }, encoding: "utf8", input: JSON.stringify(body), stdio: ["pipe", "pipe", "pipe"] }); } catch (e) { return `${e.stdout || ""}${e.stderr || ""}`; } };
  const items = [
    { url: "https://www.reddit.com/r/saas/comments/abc123/how_do_i_get_clients/", title: "how do I get clients", author: "u/ana", body: "stuck at zero" },
    { url: "https://www.reddit.com/r/saas/comments/def456/anyone_else/?utm=x", title: "anyone else", author: "bo", body: "same" },
    { url: "https://www.reddit.com/r/saas/", title: "not a post" },
  ];
  const out = found({ place: "saas", q: "how do I get clients", items });
  check("a colleague's findings are recorded through the CLI, ids off the permalink", /2 new posts/.test(out), true);
  check("...and a line without a post permalink is skipped, said so", /1 without a post permalink/.test(out), true);
  const rows = readFileSync(join(DF, "found.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  check("the rows carry the platform's id, the room, and which lane read them", [rows[0].id, rows[0].place, rows[0].via, rows[0].author], ["t3_abc123", "saas", "browser", "ana"]);
  check("...and wait on a verdict like any probe's", JSON.parse(readFileSync(join(DF, "pending.json"), "utf8")).length, 2);
  check("the same page recorded twice adds nothing", /0 new posts.*2 already known/.test(found({ place: "saas", q: "how do I get clients", items })), true);
  check("a parody room is refused, nothing recorded", /refused.*parody/.test(found({ place: "saasjerk", items })), true);
  check("the room's rules line is opened for a human to answer", readFileSync(join(DF, "rooms", "saas.md"), "utf8").includes("promotion_allowed"), true);

  const { discoverSkills: discover } = await import("../lib/skills.mjs");
  const def = agentDefinition(discover(null).found.find((s) => s.id === "reddit"));
  check("the reddit skill ships the scout as agent.md", [def.name, def.model], ["reddit-scout", "scout"]);
  check("...read-only in the browser, with the engine's verbs by name",
    [grantsOf(def.tools.join(",")), def.tools.includes("record_findings"), def.tools.includes("judge_pending"), def.tools.includes("write_draft")], [["read"], true, true, true]);
  check("...and never click or type", def.tools.some((t) => /click|type/.test(t)), false);
}

// The insert screen IS the click screen, one layer down: every label
// insert.js refuses to press, the control lane refuses too — plus the
// composer openers a human-initiated insert is allowed to press.
{
  const insertSrc = readFileSync(join(here, "..", "extension", "insert.js"), "utf8");
  const never = /const NEVER = \/\\b\(([^)]+)\)\\b\/i/.exec(insertSrc)?.[1].split("|") ?? [];
  const { CLICK_SCREEN } = await import("../extension/screen.js");
  const screen = new RegExp(CLICK_SCREEN, "i");
  check("insert.js's NEVER list was found", never.length > 5, true);
  check("every label the insert screen refuses, the click screen refuses", never.filter((w) => !screen.test(w)), []);
  check("...and the composer openers too", ["Comment", "Reply", "Add a comment"].every((w) => screen.test(w)), true);
  check("...while an ordinary control passes", screen.test("Open the thread"), false);
}

// The browser is a person's. The page-side code READS: it never fires a
// synthetic event, sets a value, scrolls by script, or enables the CDP
// domain sites test for — every scroll, click and key goes through Chrome's
// own input pipeline (isTrusted), and that would break quietly if a
// convenience crept back in.
{
  const src = ["control.js", "insert.js"].map((f) => readFileSync(join(here, "..", "extension", f), "utf8")).join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");   // code, not the comments that name what it avoids
  const tells = ["dispatchEvent(", "execCommand(", "scrollIntoView(", "scrollBy(", ".click()", "Runtime.enable", ".value =", "setAttribute("];
  check("the extension's page code writes nothing into the page", tells.filter((t) => src.includes(t)), []);
  check("...every input event is the browser's own", ["Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "mouseWheel", "Log.enable"].every((t) => src.includes(t)), true);
  check("...and it never fetches a page itself", /fetch\((?!`\$\{base\}|`data:)/.test(src), false);
  check("...and before any input it asks the page whether Chrome is drawing it, raising the window when not", src.includes("document.visibilityState") && src.includes("focused: true"), true);
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

/* ------------------------------------------------- the question list, tasks */

// ONE input primitive: a list of questions, dealt one card at a time, the
// answers returned together. A worker's pause and the specialist's own
// question are the same shape; the deck decides the order.

{
  const qs = [
    { id: "second", question: "Read a second page?", choices: [{ id: "yes", label: "yes, this one" }, { id: "no", label: "no" }], field: { placeholder: "https://…" } },
    { id: "why", question: "Why?", optional: true },
  ];
  const first = questionCards(qs, {}, { prefix: "task.ask.t1", kind: "task.ask", eyebrow: "reader · needs you" });
  check("the first unanswered question is the card, under the prefix", [first.id, first.kind], ["task.ask.t1.second", "task.ask"]);
  check("...with its choices AND its field when it asked for both", [first.choices.length, Boolean(first.field)], [2, true]);
  check("...and its place in the list", first.progress, { step: 1, of: 2 });
  const second = questionCards(qs, { second: "no" }, { prefix: "task.ask.t1" });
  check("an answered question is not dealt again", second.id, "task.ask.t1.why");
  check("a question with no choices gets a field, so it can be answered", Boolean(second.field), true);
  check("an optional question can be skipped", second.secondary?.id, "skip");
  check("a finished list deals nothing", questionCards(qs, { second: "no", why: null }, { prefix: "x" }), null);
  check("a question with a bad id is dropped rather than dealt", questionCards([{ id: "no good", question: "?" }], {}, { prefix: "x" }), null);

  const blocked = { id: "t1", title: "reader", status: "blocked", askedAt: "2026-09-03T10:00:00Z", questions: qs, answers: {}, shot: "2026-09-03T10:00:01Z", lease: { tabId: 44 } };
  const older = { ...blocked, id: "t0", askedAt: "2026-09-03T09:00:00Z", shot: null, lease: null };
  const withWork = snap({ ...onb, rooms: [{ place: "saas", state: "yes" }], queue: [qItem], tasks: [blocked] });
  check("a worker waiting on a person outranks the queue", nextCards(withWork)[0].kind, "task.ask");
  check("...oldest first, one at a time", nextCards(snap({ tasks: [blocked, older] })).filter((c) => c.kind === "task.ask").map((c) => c.id), ["task.ask.t0.second"]);
  const card = nextCards(snap({ tasks: [blocked] }))[0];
  check("the card carries the screenshot and the tab", [card.image, card.data.tabId, card.actions[0].id], ["/api/tasks/t1/screenshot", 44, "show"]);
  const finished = { id: "t2", title: "scout", status: "done", finishedAt: "2026-09-03T11:00:00Z", result: "3 threads worth answering.\nAll in r/saas.", acked: false };
  const doneDeck = nextCards(snap({ ...onb, rooms: [{ place: "saas", state: "yes" }], queue: [qItem], tasks: [finished] }));
  check("a finished task's result is a card after the people, not before", doneDeck.map((c) => c.kind).slice(0, 2), ["work.reply", "task.done"]);
  check("...leading with the count, one action", [doneDeck[1].question, doneDeck[1].primary.id], ["3 threads worth answering.", "ack"]);
  check("...and once acknowledged it is gone", nextCards(snap({ tasks: [{ ...finished, acked: true }] })).some((c) => c.kind === "task.done"), false);
  const failed = nextCards(snap({ tasks: [{ ...finished, status: "failed", error: "no key" }] })).find((c) => c.kind === "task.failed");
  check("a failed task says why and offers a retry", [failed.help, failed.primary.id], ["no key", "retry"]);

  // The specialist's proposals and notes ride second, like the verb card.
  const prop = { question: "Search r/saas for people asking this?", why: "3 posts a day", task: { agent: "reddit", input: { url: "https://www.reddit.com/r/saas/" } } };
  const withProp = nextCards(snap({ ...onb, rooms: [{ place: "saas", state: "yes" }], queue: [qItem], stash: { ...onb.stash, proposals: [prop] } }));
  check("a task proposal rides second, behind the top action", [withProp[0].kind, withProp[1].kind], ["work.reply", "cmo.propose"]);
  check("...naming the colleague it starts", /reddit colleague/.test(withProp[1].help), true);
  check("a note takes that seat when there is no proposal",
    nextCards(snap({ stash: { cmo_note: { text: "Two of the six were the same person." } } }))[1].kind, "cmo.note");
  const ask = nextCards(snap({ stash: { cmo_ask: { id: "a1", questions: [{ id: "room", question: "Which room first?", choices: [{ id: "saas", label: "r/saas" }] }] } } }));
  check("the specialist's own question is dealt before setup, never interrupting its thread", ask[0].id, "cmo.ask.room");
}

// The registry reads a colleague off agent.md — a manifest, not a seat it
// runs — and the definition carries what the runtime screens against.
{
  const ringBox = mkdtempSync(join(tmpdir(), "mq-ring-"));
  const folder = join(ringBox, "skills", "reader");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "SKILL.md"), "---\nname: reader\ndescription: reads\n---\n# reader\n");
  writeFileSync(join(folder, "agent.md"), readFileSync(join(here, "..", "skills", "_template", "agent.md"), "utf8"));
  const { found } = discoverSkills(null, [{ root: join(ringBox, "skills"), ring: "local" }]);
  const def = agentDefinition(found[0]);
  check("a folder with agent.md carries the colleague seat", Object.keys(found[0].seats), ["agent.md"]);
  check("...read as a definition: name, tools, seat, prompt", [def.name, def.tools, def.model, def.prompt.length > 100], ["page-reader", ["browser.read", "ask_person"], "scout", true]);
  check("...whose grants are read-only", grantsOf(def.tools.join(",")), ["read"]);
  writeFileSync(join(folder, "agent.md"), "---\nname: x\n---\nno description");
  check("a definition without a description is refused, not seated", agentDefinition(discoverSkills(null, [{ root: join(ringBox, "skills"), ring: "local" }]).found[0]), null);
  check("the template folder itself is never discovered", discoverSkills(null).found.some((s) => s.id === "_template"), false);
}

/* ---------------------------------------------------------------- persona */

// persona.md is memory the operator owns, like the other files — and UNLIKE
// them it reaches only the strategist's seat. A persona in the judge's
// context is a judge with a personality, which is a rubric drift nobody
// asked for; these pin the boundary.

{
  seedMissing(DC); // an older .mq grows the new file, same as boot does
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

// The MCP pipe obeys the same boundary end-to-end. The assistant on the other
// side holds the judge tool, so resources/list handing it the persona would be
// the leak the block above pins — through a different door.
{
  const MCP = join(here, "mcp.mjs");
  const rpc = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "resources/list" }),
  ].join("\n") + "\n";
  const out = execFileSync(process.execPath, [MCP], {
    input: rpc, encoding: "utf8",
    env: { ...process.env, MQ_DIR: DC }, stdio: ["pipe", "pipe", "pipe"],
  });
  const listed = out.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.id === 2)?.result?.resources ?? [];
  check("MCP serves the four working files as resources", listed.length, 4);
  check("...and the persona is not among them — that assistant is also the judge",
    listed.some((r) => r.name === "persona.md"), false);
}

/* ------------------------------------------------- the page door, end to end */

// A third throwaway server, whose scratch ring carries a page skill and a
// deliberate slot stalemate: the door must mount the one and refuse to guess
// the other, and the Skills screen must offer the fix it then accepts.
{
  const boxS = mkdtempSync(join(tmpdir(), "mq-door-"));
  const DS = join(boxS, ".mq");
  execFileSync(process.execPath, [ES, "init"], { env: { ...process.env, MQ_DIR: DS }, stdio: "ignore" });
  putSkill(join(DS, "skills"), "board",
    "---\nname: board\ndescription: a contributed page\nprovides: page:board\n---\n",
    { "page.mjs": `export default { path: "/board", title: "Board", render: () => "<h2>hello from a skill</h2>" };` });
  putSkill(join(DS, "skills"), "coin", "---\nname: coin\ndescription: heads\nprovides: probe:coin\n---\n");
  putSkill(join(DS, "skills"), "coin2", "---\nname: coin2\ndescription: tails\nprovides: probe:coin\n---\n");
  const srvS = spawn(process.execPath, [SERVE, "--port", "0"], { env: { ...process.env, MQ_DIR: DS }, stdio: ["ignore", "pipe", "pipe"] });
  const baseS = await new Promise((resolve) => {
    let out = "";
    const t = setTimeout(() => resolve(null), 8000);
    srvS.stdout.on("data", (d) => {
      out += d;
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { clearTimeout(t); resolve(`http://127.0.0.1:${m[1]}`); }
    });
  });
  if (!baseS) { console.log("FAIL  the page-door server did not start"); fail++; }
  else {
    const G = async (p) => { const r = await fetch(baseS + p); return { status: r.status, body: await r.text() }; };
    check("a skill's page mounts beside the core views", (await G("/board")).status, 200);
    check("...rendering its body inside the dashboard chrome", /hello from a skill/.test((await G("/board")).body), true);
    check("...and the nav carries it", /href="\/board"/.test((await G("/")).body), true);
    check("the Skills screen names the stalemate and its candidates", /probe:coin/.test((await G("/skills")).body), true);
    const posted = await fetch(baseS + "/skills/choose", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ slot: "probe:coin", id: "coin2" }), redirect: "manual",
    });
    check("a choice posts and returns to the Skills screen", posted.status, 303);
    const after = (await G("/skills")).body;
    check("...and the chosen skill is running, the stalemate gone",
      /coin2/.test(after) && !/Needs a decision/.test(after), true);
  }
  srvS.kill();
}

// THE DOCTRINE, pinned (0.6.0): the operator's browser is the only way
// anything here reads a platform. No fetch of a page in the engine, none in
// the skill, none in the extension — a page is read in a tab a person can
// watch, or not at all. The visibility verbs ask for the stranger's seat,
// and the finding verbs never do. If one of these moves, somebody added a
// second way to read — that must be a decision, not a drive-by.
{
  const cli = readFileSync(ES, "utf8");
  check("the CLI fetches nothing but the hub (pull) — every platform read is a lease in the browser",
    (cli.match(/\bfetch\(/g) ?? []).length, 1);
  // sync, check, back — and the tick's return pass (0.7.0): four seats.
  check("the visibility verbs take the stranger's seat; the finding verbs do not",
    [(cli.match(/lane\(\{ stranger: true/g) ?? []).length, /cmds\.probe[\s\S]*?lane\(\{ task/.test(cli) && !/cmds\.probe[\s\S]*?lane\(\{ stranger: true[\s\S]*?cmds\.found/.test(cli)], [4, true]);
  const skill = ["adapter.mjs", "pages.mjs", "shapes.mjs"].map((f) => readFileSync(join(here, "..", "skills", "reddit", f), "utf8")).join("\n");
  check("the reddit skill makes no network call of its own", /\bfetch\(/.test(skill), false);
  check("...and neither does the site scout", /\bfetch\(/.test(readFileSync(join(here, "..", "lib", "agents.mjs"), "utf8")), false);
  check("the read lane is gone — no relay module, no relay pass in the extension",
    [existsSync(join(here, "..", "lib", "relay.mjs")), existsSync(join(here, "..", "extension", "relay.js")), /relayPass/.test(readFileSync(join(here, "..", "extension", "sw.js"), "utf8"))], [false, false, false]);
}

/* ------------------------------------------------ projects and campaigns */

// A project is a whole data directory; the root is the default one. What
// crosses the line is short and pinned: the key and the seats, the people
// already answered, the local ring. Everything else is the project's own.
{
  const boxP = mkdtempSync(join(tmpdir(), "mq-proj-"));
  const RP = join(boxP, ".mq");
  execFileSync(process.execPath, [ES, "init"], { env: { ...process.env, MQ_DIR: RP }, stdio: "ignore" });
  writeFileSync(join(RP, "openrouter.key"), "sk-or-test\n");
  writeFileSync(join(RP, "account.json"), JSON.stringify({ name: "shared_me", platform: "reddit" }));
  appendFileSync(join(RP, "contacted.jsonl"), JSON.stringify({ author: "ana", id: "t3_a", at: "2026-09-01T00:00:00Z" }) + "\n");
  writeFileSync(join(RP, "rule.md"), "# Fit rule\n\nOnly for the default project.\n");
  const esP = (args, stdin) => { try { return execFileSync(process.execPath, [ES, ...args], { env: { ...process.env, MQ_DIR: RP }, input: stdin ?? "", encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }); } catch (e) { return `${e.stdout || ""}${e.stderr || ""}`; } };

  check("a slug is letters, digits and hyphens; the layout's own names are refused", [projectSlug("The Other Product!"), projectSlug("default"), projectSlug("projects"), projectSlug("")], ["the-other-product", "", "", ""]);
  check("the root is the default project, current until told otherwise", listProjects(RP).map((p) => [p.id, p.current, p.dir === RP]), [["default", true, true]]);
  const made = createProject(RP, "The Other Product");
  check("a new project is made complete under projects/<id>/ and switched to", [made.id, made.dir === join(RP, "projects", "the-other-product"), currentDir(RP) === made.dir, isChildProject(made.dir)], ["the-other-product", true, true, true]);
  check("...with the memory seeds and the store files, and no contacted ledger of its own", [existsSync(join(made.dir, "rule.md")), existsSync(join(made.dir, "found.jsonl")), existsSync(join(made.dir, "rooms")), existsSync(join(made.dir, "contacted.jsonl"))], [true, true, true, false]);
  check("...its rule.md is the seed, not the default project's", /Only for the default/.test(readFileSync(join(made.dir, "rule.md"), "utf8")), false);
  check("...and it inherits the operator's account as a copy", JSON.parse(readFileSync(join(made.dir, "account.json"), "utf8")).name, "shared_me");
  check("a duplicate name is refused", Boolean(createProject(RP, "the other product").error), true);
  check("the machine's files resolve to the root from a child project", sharedDir(made.dir) === RP && sharedDir(RP) === RP, true);
  const { readKey } = await import("../lib/models.mjs");
  check("...so the key is shared", readKey(made.dir), "sk-or-test");
  const { store: mkStore } = await import("../lib/store.mjs");
  check("...and so is who was already answered — the same human never twice, in any project", mkStore(made.dir).contacted().has("ana"), true);
  mkStore(made.dir).append("contacted.jsonl", { author: "bo", id: "t3_b", at: "2026-09-02T00:00:00Z" });
  check("...written from a child, read at the root", mkStore(RP).contacted().has("bo"), true);
  check("a bare verb acts on the current project", /the-other-product/.test(esP(["projects"]).split("\n").find((l) => l.startsWith("*")) ?? ""), true);
  check("switching moves every surface's pointer", [useProject(RP, "default").id, currentDir(RP) === RP, /^\* default/.test(esP(["projects"]))], ["default", true, true]);
  check("a project that does not exist is refused by name", Boolean(useProject(RP, "nope").error), true);
  check("MQ_DIR pointed straight at a child project is its own answer — no registry inside one", currentDir(made.dir) === made.dir, true);
}

// A campaign is a direction, never a template: the file, its hash, and what
// the writer and the judge are handed.
{
  const text = campaignFile({ name: 'Honest comments under "finding clients"', platform: "reddit", status: "active", mention: "disclosed", added: "2026-09-04T20:00:00Z",
    idea: "Say plainly that most replies they see are generated, that commenting where buyers ask is itself the answer, and that you built a tool for exactly that — offer to try it on their project and ask for feedback.",
    fit: "People asking where to find their first clients. Not agencies selling it.", never: "Never a link unless they ask." });
  const c = parseCampaign(text, "honest-comments-under-finding-clients");
  check("a campaign file round-trips: frontmatter and the three sections", [c.name, c.platform, c.status, c.mention, c.idea.startsWith("Say plainly"), c.fit.startsWith("People asking"), c.never], ['Honest comments under "finding clients"', "reddit", "active", "disclosed", true, true, "Never a link unless they ask."]);
  check("an unknown mention or status falls back to the house rule — there is no undisclosed setting", [parseCampaign("---\nname: x\nmention: covert\nstatus: on\n---\n# The idea\nfoo").mention, parseCampaign("---\nname: x\nmention: covert\n---\n# The idea\nfoo").status], ["never", "active"]);
  check("the hash follows the instructions, not the name", [campaignHash(c) === c.hash, campaignHash({ ...c, idea: c.idea + " more" }) === c.hash, campaignHash({ ...c, name: "other" }) === c.hash], [true, false, true]);
  const block = writerBlock(c, { said: ["hey — most of what you see here is bots, honestly. i built a thing for exactly this", "plain second"] });
  check("the writer gets the direction as a DIRECTION, the campaign's refusals, and what was already said under it", [/DIRECTION, never a script/.test(block), /Never a link/.test(block), /earlier 1/.test(block) && /earlier 2/.test(block), /eight identical words/.test(block)], [true, true, true, true]);
  check("the judge gets one line, and only when the campaign narrows the fit", [/narrows the fit: People asking/.test(judgeLine(c)), judgeLine({ ...c, fit: "" })], [true, ""]);
  check("a disclosed campaign lifts the opener's rule in the disclosed form only", [/SAY IT IS YOURS/.test(signalWritingRules({ intent: "leads", stage: "disclosed", pitch: "x" })), /SELLS NOTHING/.test(signalWritingRules({ intent: "leads", stage: "disclosed", pitch: "x" })), /SELLS NOTHING/.test(signalWritingRules({ intent: "leads", stage: "opener", pitch: "x" }))], [true, false, true]);
  check("a draft off the deck is capped and slugged", [campaignDraft({ name: "  Big Idea  ", idea: "x".repeat(5000), mention: "covert", place: "r/saas" }).id, campaignDraft({ name: "Big Idea", idea: "x".repeat(5000), mention: "covert" }).idea.length, campaignDraft({ name: "Big Idea", idea: "x", mention: "covert", place: "r/saas" }).mention, campaignDraft({ name: "Big Idea", idea: "x", place: "r/saas" }).place], ["big-idea", 3000, "never", "saas"]);
  check("the two mention rules are the whole menu", Object.keys(MENTIONS), ["never", "disclosed"]);

  // Through the CLI: a finding under a campaign, judged under its hash,
  // drafted under its direction with what was said before shown.
  const boxK = mkdtempSync(join(tmpdir(), "mq-camp-"));
  const DK = join(boxK, ".mq");
  execFileSync(process.execPath, [ES, "init"], { env: { ...process.env, MQ_DIR: DK }, stdio: "ignore" });
  const esK = (args, stdin) => { try { return execFileSync(process.execPath, [ES, ...args], { env: { ...process.env, MQ_DIR: DK }, input: stdin ?? "", encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }); } catch (e) { return `${e.stdout || ""}${e.stderr || ""}`; } };
  const written = writeCampaign(DK, { name: "Honest comments", platform: "reddit", mention: "disclosed", idea: c.idea, fit: c.fit, never: c.never });
  check("a campaign is written by a person's Save, under campaigns/<id>.md", [written.id, existsSync(join(DK, "campaigns", "honest-comments.md")), readCampaigns(DK).length], ["honest-comments", true, 1]);
  check("...and a campaign with no idea is refused", Boolean(writeCampaign(DK, { name: "Empty" }).error), true);
  check("the CLI lists it", /on  honest-comments/.test(esK(["campaigns"])), true);
  const rec = esK(["found"], JSON.stringify({ place: "saas", q: "find clients", campaign: "honest-comments", items: [{ url: "https://www.reddit.com/r/saas/comments/c1/where_do_i_find_clients/", title: "where do I find clients", author: "u/cara", body: "launched last week, zero users" }] }));
  check("a colleague's findings are recorded under the campaign", /1 new post recorded from r\/saas for "find clients" under honest-comments/.test(rec), true);
  check("...a campaign that does not exist is said so, and the finding kept under the general fit", /no campaign "nope"/.test(esK(["found"], JSON.stringify({ place: "saas", campaign: "nope", items: [{ url: "https://www.reddit.com/r/saas/comments/c2/x/", title: "x" }] }))), true);
  const rowsK = readFileSync(join(DK, "found.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  check("...the rows say which", [rowsK[0].campaign, rowsK[1].campaign], ["honest-comments", undefined]);
  esK(["judge"], JSON.stringify([{ n: 1, fit: true, why: "asks" }, { n: 2, fit: true, why: "asks" }]));
  const vK = readFileSync(join(DK, "verdicts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  check("a verdict under a campaign carries the campaign's rubric hash beside rule.md's", [vK[0].campaign, vK[0].campaign_hash === written.hash, /^[0-9a-f]{8}$/.test(vK[0].rule), vK[1].campaign], ["honest-comments", true, true, undefined]);
  writeFileSync(join(DK, "rooms", "saas.md"), "promotion_allowed: yes\n");
  esK(["draft", "t3_c1", "--save"], "hey — most of what you see here is bots. i built a small tool for exactly this problem");
  const material = esK(["draft", "t3_c1"]);
  check("the writer's material names the campaign, its direction, and the disclosed rule", [/Campaign: Honest comments \(honest-comments, mention: disclosed\)/.test(material), /## The campaign/.test(material), /SAY IT IS YOURS/.test(material), /SELLS NOTHING/.test(material)], [true, true, true, false]);
  const d2 = esK(["found"], JSON.stringify({ place: "saas", q: "find clients", campaign: "honest-comments", items: [{ url: "https://www.reddit.com/r/saas/comments/c3/first_users/", title: "first users", author: "u/dan", body: "how do I find people" }] }));
  esK(["judge"], JSON.stringify([{ n: 1, fit: true, why: "asks" }]));
  const material2 = esK(["draft", "t3_c3"]);
  check("...and what was already said under the campaign, so 'in your own words' is checkable", /earlier 1 ---\nhey — most of what you see here is bots/.test(material2), true);
  const saved = esK(["draft", "t3_c3", "--save"], "hey — most of what you see here is bots. i built a small tool for exactly this problem too");
  check("a draft that repeats the earlier one is flagged on save — the template guard is the enforcement", /REPEATED PHRASING/.test(saved) && /never a template/.test(saved), true);
  check("...and the saved draft carries the campaign", readFileSync(join(DK, "drafts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).campaign), ["honest-comments", "honest-comments"]);
  check("watching under a campaign records it on the source", (() => { esK(["watch", "saas", "--q", "find clients", "--campaign", "honest-comments"]); return JSON.parse(readFileSync(join(DK, "sources.jsonl"), "utf8").trim().split("\n").pop()).campaign; })(), "honest-comments");
  check("a paused campaign says so", [/off honest-comments/.test((esK(["campaign", "pause", "honest-comments"]), esK(["campaigns"]))), readCampaign(DK, "honest-comments").status], [true, "paused"]);
}

// The heart carries no platform word: labels come from the adapter, with
// plain fallbacks, and the composer's words ride on the reply card.
{
  const L = labelsOf(first());
  check("the platform's labels come from its adapter", [L.id, L.room("saas"), L.rulesUrl("saas"), /Reddit/.test(L.account.question)], ["reddit", "r/saas", "https://www.reddit.com/r/saas/about/rules", true]);
  const G = labelsOf(null);
  check("...and a platform with none still reads as English", [G.room("saas"), G.rulesUrl("saas"), G.account.question, G.submit], ["saas", null, "Which account is yours?", "the platform's own button"]);
  check("the composer the Insert flow looks for is the platform's, off the url", composerOf("https://www.reddit.com/r/x/comments/1/t/").hosts, ["shreddit-composer", "comment-composer-host"]);
  check("...with the element that holds one comment, so a comment on the post never lands under the first comment's Reply", composerOf("https://www.reddit.com/r/x/comments/1/t/").comments, ["shreddit-comment"]);
  const generic = nextCards({ ...snap({ account: { name: "x" }, stash: allVoice, memory: memDone, sources: [{ place: "saas" }], rooms: [{ place: "saas", state: "unanswered" }] }) })[0];
  check("a card without a platform names the room plainly", [generic.eyebrow, generic.links], ["saas", undefined]);
  const labelled = nextCards({ ...snap({ platform: L, account: { name: "x" }, stash: allVoice, memory: memDone, sources: [{ place: "saas" }], rooms: [{ place: "saas", state: "unanswered" }] }) })[0];
  check("...and with one, the platform's words and its rules page", [labelled.eyebrow, labelled.links[0].href], ["r/saas", "https://www.reddit.com/r/saas/about/rules"]);
  const reply = nextCards(snap({ platform: L, account: { name: "x" }, stash: { ...allVoice, welcomed: true }, memory: memDone, sources: [{ place: "saas" }], rooms: [{ place: "saas", state: "allowed" }], queue: [{ ...qItem, campaign: "honest-comments", composer: composerOf(qItem.url) }] }))[0];
  check("the reply card carries the composer, the platform's button, and the campaign", [reply.data.insert.opens.length > 0, reply.data.submit, /honest-comments/.test(reply.eyebrow)], [true, "Reddit's own Comment button", true]);
  check("...and where the reply belongs: a comment on their post goes into the thread's own box", [reply.data.insert.target, reply.data.insert.comments], ["post", ["shreddit-comment"]]);
  check("the heart's card module names no platform of its own", /reddit|subreddit/i.test(readFileSync(join(here, "..", "lib", "cards.mjs"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")), false);
}

// The campaign walk-through on the deck: one card per thing to settle, a
// field for the operator's own words on each, the file written by the last
// Save — and a question with choices always takes a custom answer too.
{
  const draft = { name: "Honest comments", id: "honest-comments", idea: "say it plainly", fit: "", mention: "disclosed", place: "saas", q: "find clients", why: "because", done: [] };
  const base = { account: { name: "x" }, stash: { ...allVoice, welcomed: true, campaign_draft: draft }, memory: memDone, sources: [{ place: "sideproject" }], rooms: [{ place: "sideproject", state: "allowed" }] };
  const walk = (done) => nextCards(snap({ ...base, stash: { ...base.stash, campaign_draft: { ...draft, done } } }))[0];
  check("the walk deals the idea first, seeded with the proposal, with a way out", [walk([]).id, walk([]).field.value, walk([]).secondary.id, walk([]).progress], ["campaign.idea", "say it plainly", "drop", { step: 1, of: 5 }]);
  check("...then who it fits, the mention rule (proposed first), the room with the rooms it knows and a field, the phrase", [walk(["idea"]).id, walk(["idea", "fit"]).choices.map((c) => c.id), walk(["idea", "fit", "mention"]).choices.map((c) => c.id), Boolean(walk(["idea", "fit", "mention"]).field), walk(["idea", "fit", "mention", "room"]).id], ["campaign.fit", ["disclosed", "never"], ["saas", "sideproject"], true, "campaign.phrase"]);
  check("...and outranks the queue and setup — the operator asked for it — but not a colleague waiting on them",
    [nextCards(snap({ ...base, queue: [qItem] }))[0].id, nextCards(snap(base)).map((c) => c.id).indexOf("campaign.idea"), nextCards(snap({ ...base, tasks: [{ id: "t1", title: "scout", status: "blocked", askedAt: "2026-09-04T00:00:00Z", questions: [{ id: "q", question: "A wall?" }], answers: {} }] }))[0].kind],
    ["campaign.idea", 0, "task.ask"]);
  const q = questionCards([{ id: "which", question: "Which first?", choices: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }], {}, { prefix: "cmo.ask" });
  check("a question with choices always takes an answer in the operator's own words", [q.choices.length, q.field.placeholder], [2, "Or answer in your own words"]);
  check("...unless the question says its choices are the whole answer", questionCards([{ id: "w", question: "?", choices: [{ id: "a", label: "A" }], field: false }], {}, { prefix: "x" }).field, undefined);
  const probing = nextCards(snap({ ...base, stash: { ...allVoice, welcomed: true, probe: { place: "saas", q: "find clients", fired: true, campaign: "honest-comments" } }, probe: { running: true } }))[0];
  check("a campaign's probe deals its cards on a project that already watches something", [probing.id, /honest-comments/.test(probing.eyebrow)], ["onboard.probing", true]);
  const landed = nextCards(snap({ ...base, stash: { ...allVoice, welcomed: true, probe: { place: "saas", q: "find clients", fired: true, campaign: "honest-comments" } }, probe: { running: false, fitRate: 0.5 } }))[0];
  check("...and the watch card names the campaign it will watch under", [landed.id, landed.primary.id, /honest-comments/.test(landed.eyebrow)], ["onboard.watch", "watch", true]);
}

/* -------------------------------------------------------------- the plans */

// Three ways to fill a seat, one file, and nothing above lib/models.mjs
// knowing which. What would break quietly: a plan switch that kept the old
// plan's picks, a local seat that demanded a key, an OpenRouter-only request
// field reaching a local server, a fallback list that silently did nothing.
{
  const { plan, setPlan, chosen, choose, seat, hasModel, cost, localConfig, setLocal, LOCAL_URL } = await import("../lib/models.mjs");
  const { complete, structured, salvage } = await import("../lib/llm.mjs");
  const envWas = { MQ_PLAN: process.env.MQ_PLAN, MQ_LOCAL_URL: process.env.MQ_LOCAL_URL, MQ_LOCAL_KEY: process.env.MQ_LOCAL_KEY, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY };
  for (const k of Object.keys(envWas)) delete process.env[k];
  const boxM = mkdtempSync(join(tmpdir(), "mq-models-"));

  check("the plan is free until somebody says otherwise (0.8.0 — it was paid)", plan(boxM), "free");
  check("...and a seat on it needs a key, and the refusal says where a free one comes from", (() => { try { seat(boxM, "judge"); return "no throw"; } catch (e) { return /no OpenRouter key/.test(e.message) && /openrouter\.ai\/keys/.test(e.message); } })(), true);
  writeFileSync(join(boxM, "models.json"), JSON.stringify({ judge: "qwen/qwen3.7-flash" }));
  check("a flat models.json — the old shape — still names the paid picks", chosen(boxM, "paid").judge, "qwen/qwen3.7-flash");
  setPlan(boxM, "free");
  check("switching to free keeps the paid pick where it was", chosen(boxM, "paid").judge, "qwen/qwen3.7-flash");
  check("...and the free plan starts from its own measured default", chosen(boxM).judge, "poolside/laguna-s-2.1:free");
  check("every free default is a free variant", Object.values(chosen(boxM)).every((m) => /:free$/.test(m)), true);
  check("a pick from another plan's menu is refused, not stored",
    (() => { try { choose(boxM, "judge", "moonshotai/kimi-k3"); return "stored"; } catch { return "refused"; } })(), "refused");
  check("nothing on the free plan is billed", cost(boxM, "writer", 1e6, 1e6), 0);
  process.env.OPENROUTER_API_KEY = "sk-or-test";
  check("a fallback list never exceeds three — OpenRouter refuses four with a 400 (measured 2026-09-01)",
    ["judge", "scout", "writer"].every((r) => seat(boxM, r).models.length <= 3 && true), true);
  delete process.env.OPENROUTER_API_KEY;
  setPlan(boxM, "local");
  check("the local plan fills a seat with no key at all", hasModel(boxM), true);
  const local = seat(boxM, "judge");
  check("...at Ollama's address by default", local.baseUrl, LOCAL_URL);
  check("...with none of OpenRouter's fields", [local.openrouter, local.models], [false, null]);
  choose(boxM, "writer", "gemma4:12b");
  check("...and any tag the operator names goes through as written", chosen(boxM).writer, "gemma4:12b");
  check("a server address without a scheme is refused",
    (() => { try { setLocal(boxM, { baseUrl: "localhost:11434" }); return "kept"; } catch { return "refused"; } })(), "refused");
  setLocal(boxM, { baseUrl: "http://10.0.0.5:8080/v1/" });
  check("...a good one is kept, trailing slash removed", localConfig(boxM).baseUrl, "http://10.0.0.5:8080/v1");
  process.env.MQ_PLAN = "paid";
  check("MQ_PLAN in the environment outranks the file", plan(boxM), "paid");
  delete process.env.MQ_PLAN;

  // What actually leaves the machine, per plan — captured by a stub that
  // speaks just enough OpenAI to answer.
  const { createServer } = await import("node:http");
  const seenReqs = [];
  let reply = { choices: [{ message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
  const stubM = createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      seenReqs.push({ auth: req.headers.authorization ?? null, body: JSON.parse(b) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(typeof reply === "function" ? reply(seenReqs.length) : reply));
    });
  });
  await new Promise((r) => stubM.listen(0, "127.0.0.1", r));
  setLocal(boxM, { baseUrl: `http://127.0.0.1:${stubM.address().port}/v1` });
  await complete(seat(boxM, "judge"), [{ role: "user", content: "hi" }]);
  check("a local request carries no bearer header when there is no key", seenReqs[0].auth, null);
  check("...and none of OpenRouter's routing fields", ["models", "provider"].filter((k) => k in seenReqs[0].body), []);
  setLocal(boxM, { key: "secret-1" });
  await complete(seat(boxM, "judge"), [{ role: "user", content: "hi" }]);
  check("a local server that wants a key gets it", seenReqs[1].auth, "Bearer secret-1");
  await complete({ ...seat(boxM, "judge"), openrouter: true, models: ["a", "b"] }, [{ role: "user", content: "hi" }]);
  check("an OpenRouter seat sends its fallback list and routing", [seenReqs[2].body.models, seenReqs[2].body.provider?.allow_fallbacks], [["a", "b"], true]);
  // A server that takes tool_choice and ignores it answers in prose. The
  // JSON inside is the answer — checked by the same validator.
  const V2 = { type: "object", required: ["verdicts"], properties: { verdicts: { type: "array" } } };
  reply = { choices: [{ message: { role: "assistant", content: "Sure, here you go:\n```json\n{\"verdicts\": [{\"n\": 1, \"fit\": true, \"why\": \"x\"}]}\n```" } }] };
  const got = await structured(seat(boxM, "judge"), [{ role: "user", content: "judge" }], V2, { name: "verdicts" });
  check("a conforming JSON object inside a prose answer is the answer", got.data.verdicts[0].n, 1);
  check("...and one call was enough", seenReqs.length, 4);
  check("prose with no conforming object is not salvaged", salvage("the answer is {\"verdicts\": \"none\"}", V2), null);

  // The writer, held to three (0.8.0). Two come back: the third is asked
  // for once, with the two in front of it; the round is three in the fixed
  // order, the first answer per style kept, the unknown style dropped.
  const { draftReply, mendNewlines } = await import("../lib/agents.mjs");
  // A free model's line breaks arriving as a bare "n" (measured 2026-09-06)
  // are put back — only in a text with no newline and at least two seams.
  check("a writer's lost newlines are mended; prose with a real newline, or one odd seam, is left alone",
    [mendNewlines("Hey.  nI'd start by telling friends.nAsk if they need a site or know someone who doesnThat's a first step"), mendNewlines("Hey.|nI'd start with a free audit.|nClose one of them."), mendNewlines("Hey roosrock.|I'd use a service account.|Avoids the storage trap."), mendNewlines("first step.\nAsk them"), mendNewlines("Ask LinkedInThey answer"), mendNewlines("plain text, no seam")],
    ["Hey.\nI'd start by telling friends.\nAsk if they need a site or know someone who does\nThat's a first step", "Hey.\nI'd start with a free audit.\nClose one of them.", "Hey roosrock.\nI'd use a service account.\nAvoids the storage trap.", "first step.\nAsk them", "Ask LinkedInThey answer", "plain text, no seam"]);
  const toolCall = (args) => ({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "drafts", arguments: JSON.stringify(args) } }] } }], usage: {} });
  const before = seenReqs.length;
  reply = (n) => (n - before === 1
    ? toolCall({ drafts: [{ style: "ask", text: "A" }, { style: "straight", text: "S" }, { style: "straight", text: "S again" }, { style: "bold", text: "?" }, { style: "deeper", text: "   " }] })
    : toolCall({ drafts: [{ style: "deeper", text: "D" }] }));
  const got3 = await draftReply(boxM, "the material", {});
  check("two of three come back: the writer is asked once more for the missing one, and the round is three in order", [got3.drafts.map((d) => [d.style, d.text]), got3.no_fit, seenReqs.length - before], [[["straight", "S"], ["deeper", "D"], ["ask", "A"]], null, 2]);
  check("...and the second ask shows it what it already wrote, and names the missing style", (() => { const m = seenReqs[seenReqs.length - 1].body.messages; return [/Written so far/.test(m[2].content), /deeper draft/.test(m[3].content), m[0].content === seenReqs[before].body.messages[0].content]; })(), [true, true, true]);
  reply = toolCall({ drafts: [], no_fit: "nothing honest to say without naming it" });
  const nf = await draftReply(boxM, "m", {});
  check("no drafts with a reason is the writer declining, not a failure", [nf.drafts, nf.no_fit], [[], "nothing honest to say without naming it"]);
  const b2 = seenReqs.length;
  reply = () => toolCall({ drafts: [{ style: "straight", text: "only this" }] });
  const one = await draftReply(boxM, "m", {});
  check("a writer that keeps sending one is asked once more and no more — what came back is kept, never padded", [one.drafts.map((d) => d.style), seenReqs.length - b2], [["straight"], 2]);
  stubM.close();
  for (const [k, v] of Object.entries(envWas)) if (v !== undefined) process.env[k] = v;
}

/* ------------------------------------------------------- template phrases */

// The third flag on a draft. Phrases, never vocabulary — and the em dash
// only against a voice that has not been seen typing one.
{
  const { tells } = await import("../lib/guards.mjs");
  check("the phrases nobody types to one person are named", tells("Great question! Hope this helps, and good luck!"), ["great question", "hope this helps", "good luck"]);
  check("a plain reply carries none", tells("Move the migration out of the deploy step. It bit us on a managed db too, what are you on?"), []);
  check("the em dash counts against an unmeasured voice", tells("Do it — now."), ["em dash"]);
  check("...and not against somebody seen typing one", tells("Do it — now.", { dashes: { value: "yes" } }), []);
  check("'as someone who' is a tell only as an opener", tells("I asked, as someone who cares."), []);
}

/* -------------------------------------------------------- the 404 finding */

// A profile that 404s to a stranger stores nothing, so every "nothing stored
// yet" screen used to swallow the tool's loudest finding. The read ledger
// remembers; these pin that every surface asks it.
{
  const box4 = mkdtempSync(join(tmpdir(), "mq-404-"));
  const D4 = join(box4, ".mq");
  execFileSync(process.execPath, [ES, "init"], { env: { ...process.env, MQ_DIR: D4 }, stdio: "ignore" });
  writeFileSync(join(D4, "account.json"), JSON.stringify({ name: "ghost_42", added: "2026-08-31T00:00:00Z" }));
  // The read ledger's key is the page the stranger's seat opened (0.6.0).
  appendFileSync(join(D4, "reads.jsonl"), JSON.stringify({ url: "https://www.reddit.com/user/ghost_42/comments/", at: "2026-09-01T14:33:51Z", ok: false, err: "http_404", n: 0, via: "stranger" }) + "\n");
  const st = esFails2(["status"], D4);
  check("`status` after a 404 profile read reports the finding, not 'nothing stored'", /404 — logged out/.test(st) && !/nothing stored yet/.test(st), true);
  check("...with the appeal address and the date of the read", /reddit\.com\/appeals/.test(st) && /2026-09-01 14:33/.test(st), true);

  const srv4 = spawn(process.execPath, [SERVE, "--port", "0"], { env: { ...process.env, MQ_DIR: D4 }, stdio: ["ignore", "pipe", "pipe"] });
  const base4 = await new Promise((resolve) => {
    let out = "";
    const t = setTimeout(() => resolve(null), 8000);
    srv4.stdout.on("data", (d) => { out += d; const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/); if (m) { clearTimeout(t); resolve(`http://127.0.0.1:${m[1]}`); } });
  });
  if (!base4) { console.log("FAIL  the 404 dashboard did not start"); fail++; }
  else {
    const G4 = async (p) => { const r = await fetch(base4 + p); return { status: r.status, body: await r.text() }; };
    const home = await G4("/standing");
    check("the Standing page says the profile does not render", /does not render/.test(home.body) && !/Nothing stored yet/.test(home.body), true);
    check("...and Ready says the same, not 'no standing measured'", /does not render/.test((await G4("/ready")).body), true);
    // Settings on each plan renders, and a plan switch is one POST.
    check("Settings shows the three plans", /Where the models run/.test((await G4("/settings")).body), true);
    const sw = await fetch(base4 + "/settings/plan", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ plan: "local" }), redirect: "manual" });
    check("switching the plan is a POST that comes straight back", sw.status, 303);
    check("...and the local plan's page says, honestly, that nothing is listening yet",
      /nothing is listening at http:\/\/127\.0\.0\.1:11434\/v1/.test((await G4("/settings")).body), true);
  }
  srv4.kill();
}

/* ------------------------------------------- rules before watch (2026-09-04) */

// The done-when run found the deck's watch step looping: `mq watch` refuses
// a room whose rules nobody recorded, the job said ok, the deck went back to
// the room card. Now the probed room is on the rooms list — its rules card
// is dealt before the watch card — the handler refuses an unanswered or
// forbidden room in words, and the watch carries the probed phrase.
{
  const boxW = mkdtempSync(join(tmpdir(), "mq-watch-"));
  const DWr = join(boxW, ".mq");
  execFileSync(process.execPath, [ES, "init"], { env: { ...process.env, MQ_DIR: DWr }, stdio: "ignore" });
  writeFileSync(join(DWr, "account.json"), JSON.stringify({ name: "watcher_7", added: "2026-09-04T00:00:00Z" }));
  writeFileSync(join(DWr, "project.md"), "# What we sell\n\nA small tool that finds the people asking for what you built.\n");
  writeFileSync(join(DWr, "icp.md"), "# Who it is for\n\nA builder who just launched and has no idea where the first users are.\n");
  writeFileSync(join(DWr, "rule.md"), "# Fit rule\n\nYes when the author just launched and asks where to find users. No otherwise.\n");
  writeFileSync(join(DWr, "cards.json"), JSON.stringify({ probe: { place: "testroom", q: "find clients", fired: true } }));
  // Two probed posts, both judged fit: the floor the watch verb checks is cleared.
  for (const id of ["t3_w1", "t3_w2"]) {
    appendFileSync(join(DWr, "found.jsonl"), JSON.stringify({ id, place: "testroom", url: `https://www.reddit.com/r/testroom/comments/${id.slice(3)}/x/`, author: "a", title: "just launched, where are the users", body: "", probe: "testroom:find clients", at: "2026-09-04T00:00:00Z" }) + "\n");
    appendFileSync(join(DWr, "verdicts.jsonl"), JSON.stringify({ id, fit: true, why: "asks where the users are", rule: "test", at: "2026-09-04T00:00:01Z" }) + "\n");
  }
  const srvW = spawn(process.execPath, [SERVE, "--port", "0"], { env: { ...process.env, MQ_DIR: DWr }, stdio: ["ignore", "pipe", "pipe"] });
  const baseW = await new Promise((resolve) => {
    let out = "";
    const t = setTimeout(() => resolve(null), 8000);
    srvW.stdout.on("data", (d) => { out += d; const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/); if (m) { clearTimeout(t); resolve(`http://127.0.0.1:${m[1]}`); } });
  });
  if (!baseW) { console.log("FAIL  the watch dashboard did not start"); fail++; }
  else {
    const actW = async (body) => { const r = await fetch(baseW + "/api/cards/act", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return r.json(); };
    const deckW = async () => (await (await fetch(baseW + "/api/cards")).json()).cards.map((c) => c.id);
    check("the probed room's rules card is dealt before it is watched", (await deckW()).includes("room.rules.testroom"), true);
    check("the watch card refuses, in words, while the rules are unanswered", /rules first/.test((await actW({ card: "onboard.watch", action: "watch" })).error ?? ""), true);
    await actW({ card: "room.rules.testroom", action: "record", choice: "no" });
    check("...and a room whose rules forbid it", /forbid/.test((await actW({ card: "onboard.watch", action: "watch" })).error ?? ""), true);
    check("...writing no source either way", existsSync(join(DWr, "sources.jsonl")) ? readFileSync(join(DWr, "sources.jsonl"), "utf8").trim() : "", "");
    await actW({ card: "room.rules.testroom", action: "record", choice: "yes" });
    check("with the rules recorded the watch goes through", (await actW({ card: "onboard.watch", action: "watch" })).ok, true);
    let src = "";
    for (let i = 0; i < 40 && !src; i++) { await new Promise((r) => setTimeout(r, 250)); src = existsSync(join(DWr, "sources.jsonl")) ? readFileSync(join(DWr, "sources.jsonl"), "utf8").trim() : ""; }
    check("...watched the way it was measured, phrase and all", /"q":"find clients"/.test(src) && /"place":"testroom"/.test(src), true);
  }
  srvW.kill();
}

/* --------------------------------------------------- the return (0.7.0) */

// A conversation opens on "I posted it" with what actually went up, binds
// to the operator's own comment when the profile is read, folds each return
// read in, and deals a turn card BEFORE any new person. Tracking is the
// engine's and deterministic; the specialist is reminded by the digest.
{
  const boxR = mkdtempSync(join(tmpdir(), "mq-return-"));
  const DR = join(boxR, ".mq");
  execFileSync(process.execPath, [ES, "init"], { env: { ...process.env, MQ_DIR: DR }, stdio: "ignore" });
  const esR = (args, stdin) => { try { return execFileSync(process.execPath, [ES, ...args], { env: { ...process.env, MQ_DIR: DR }, input: stdin ?? "", encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }); } catch (e) { return `${e.stdout || ""}${e.stderr || ""}`; } };
  writeFileSync(join(DR, "account.json"), JSON.stringify({ name: "Ret_Tester", added: "2026-09-06T00:00:00Z" }));
  const SR = store(DR);
  appendFileSync(join(DR, "found.jsonl"), JSON.stringify({ id: "t3_r1", place: "saas", url: "https://www.reddit.com/r/saas/comments/r1/where_are_the_users/", author: "cara", title: "where are the users", body: "launched last week, zero users", probe: "saas:find clients", campaign: "honest-comments", seen_at: "2026-09-06T01:00:00Z", comments: 14 }) + "\n");
  appendFileSync(join(DR, "verdicts.jsonl"), JSON.stringify({ id: "t3_r1", fit: true, why: "asks", rule: "test", at: "2026-09-06T01:00:01Z" }) + "\n");
  writeCampaign(DR, { name: "Honest comments", platform: "reddit", mention: "disclosed", idea: "say plainly that most answers here are generated", voice: "dry, short sentences" });
  writeFileSync(join(DR, "rooms", "saas.md"), "promotion_allowed: yes\n");
  check("a campaign may carry a voice of its own, and the writer is told it sits under the measured one", [readCampaign(DR, "honest-comments").voice, /How it sounds under this campaign/.test(writerBlock(readCampaign(DR, "honest-comments")))], ["dry, short sentences", true]);
  esR(["draft", "t3_r1", "--save"], "most of what you see here is generated. i built a small tool for exactly this");
  esR(["mark", "t3_r1", "sent", "--anyway"]);
  const convs = () => conversationRows(SR);
  check("'I posted it' opens a conversation with the draft as the first turn", [convs().get("t3_r1")?.state, convs().get("t3_r1")?.turns?.[0]?.by, /generated/.test(convs().get("t3_r1")?.turns?.[0]?.text ?? ""), convs().get("t3_r1")?.campaign], ["sent", "you", true, "honest-comments"]);
  check("...and it is unbound until the profile is read", [unbound(SR).length, dueConversations(SR).length], [1, 0]);
  // The operator's own comments, as sync stores them: one in the thread after
  // the post, one older in the same thread.
  // The opener was posted just now (the mark above), so the comment that
  // binds is the one written after it — a minute from now on this clock.
  appendFileSync(join(DR, "items.jsonl"), JSON.stringify({ id: "t1_mine1", kind: "comment", url: "https://www.reddit.com/r/saas/comments/r1/where_are_the_users/mine1/", author: "Ret_Tester", at: new Date(Date.now() + 60_000).toISOString(), body: "most of what you see here is generated", seen_at: "2026-09-06T03:00:00Z", source: "profile" }) + "\n");
  appendFileSync(join(DR, "items.jsonl"), JSON.stringify({ id: "t1_old", kind: "comment", url: "https://www.reddit.com/r/saas/comments/r1/where_are_the_users/old/", author: "Ret_Tester", at: "2026-08-01T02:00:00Z", body: "an older comment in the same thread", seen_at: "2026-09-06T03:00:00Z", source: "profile" }) + "\n");
  const bound = bindConversations(SR, { threadOf: (x) => threadOf(x) });
  check("a profile read binds it to the comment in the same thread written after the post — not the older one", [bound, convs().get("t3_r1")?.comment_id, convs().get("t3_r1")?.state], [1, "t1_mine1", "quiet"]);
  check("...and now it is due a look", dueConversations(SR).length, 1);
  const focused = { ok: true, entries: [
    { id: "t1_mine1", kind: "comment", author: "Ret_Tester", body: "most of what you see here is generated", at: "2026-09-06T02:00:00Z", url: "https://www.reddit.com/r/saas/comments/r1/where_are_the_users/mine1/" },
    { id: "t1_theirs", kind: "comment", author: "cara", body: "wait, is that true? what tool?", at: "2026-09-06T05:00:00Z", url: "https://www.reddit.com/r/saas/comments/r1/where_are_the_users/theirs/" },
  ] };
  const c1 = conversation({ id: "t1_mine1", url: focused.entries[0].url }, focused, "ret_tester");
  const r1 = recordReturn(SR, convs().get("t3_r1"), c1, { at: "2026-09-06T06:00:00Z" });
  check("a reply folds in as their turn, waiting, and is fresh once", [r1.fresh, r1.row.state, r1.row.turns.length, r1.row.turns[1].by, r1.row.latest.author], [true, "waiting", 2, "them", "cara"]);
  const r2 = recordReturn(SR, convs().get("t3_r1"), c1, { at: "2026-09-06T07:00:00Z" });
  check("...the same reply read again is not fresh, not a second turn, and not due for twelve hours", [r2.fresh, r2.row.turns.length, dueConversations(SR, { now: Date.parse("2026-09-06T08:00:00Z") }).length, dueConversations(SR, { now: Date.parse("2026-09-06T20:00:00Z") }).length], [false, 2, 0, 1]);
  check("waiting lists it, and the CLI prints it", [waitingRows(SR).map((c) => c.id), /u\/cara in r\/saas/.test(esR(["waiting"])), JSON.parse(esR(["waiting", "--json"]))[0].they_said], [["t3_r1"], true, "wait, is that true? what tool?"]);
  const m2 = esR(["draft", "t3_r1"]);
  check("the next draft is turn 2: the exchange, what they wrote back, the conversation rules — not the opener's", [/turn 2/.test(m2), /## The exchange so far/.test(m2), /answer THIS/.test(m2), /They wrote back, so this is a conversation/.test(m2), /SELLS NOTHING/.test(m2)], [true, true, true, true, false]);
  esR(["draft", "t3_r1", "--save"], "yes — i built it, it's called x. happy to show you if you want");
  const rowsD = readFileSync(join(DR, "drafts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  check("...and the saved draft carries the turn", rowsD.map((d) => d.turn), [1, 2]);
  const m3 = esR(["draft", "t3_r1", "--note", "too eager — answer the question, drop the offer"]);
  check("a rewrite note reaches the writer with the rejected draft, above everything but the refusals", [/What the operator said about the last round/.test(m3), /too eager/.test(m3), /--- rejected ---\nyes — i built it/.test(m3)], [true, true, true]);
  recordTurn(SR, convs().get("t3_r1"), { text: "yes, i built it", at: "2026-09-06T09:00:00Z" });
  check("the operator's answer is their second turn and the conversation is answered", [convs().get("t3_r1").state, yourTurns(convs().get("t3_r1"))], ["answered", 2]);
  const dg = campaignDigest(SR, readCampaigns(DR));
  const hc = dg.find((r) => r.id === "honest-comments");
  check("the digest counts per campaign: found, fit, sent, replied, second turns, waiting, crowding", [hc.found, hc.fit, hc.sent, hc.replies, hc.second, hc.waiting, hc.crowd], [1, 1, 1, 1, 1, 0, 14]);
  check("...and says it in words", /Honest comments \(honest-comments, active\): 1 found, 1 judged, 1 fit \(100%\), 1 sent, 1 replied, 1 reached a second turn, 0 waiting on you, crowding 14/.test(digestText(dg)), true);
  check("a tick with nothing due still writes the day's digest into the specialist's inbox — once in twenty hours", (() => { esR(["tick"]); esR(["tick"]); const ev = readFileSync(join(DR, "inbox.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)); return [ev.filter((e) => e.type === "day.digest").length, /waiting on you/.test(ev[0].title), Array.isArray(ev[0].campaigns)]; })(), [1, true, true]);
  appendFileSync(join(DR, "found.jsonl"), JSON.stringify({ id: "t3_r2", place: "saas", url: "https://www.reddit.com/r/saas/comments/r2/x/", author: "dan", title: "x", body: "y", probe: "saas:find clients", seen_at: "2026-09-06T01:00:00Z", comments: 3, posted_at: "2026-09-06T00:30:00Z" }) + "\n");
  writeFileSync(join(DR, "pending.json"), JSON.stringify([{ n: 1, id: "t3_r2", probe: "saas:find clients" }]));
  check("pending carries the crowding number to the judge", JSON.parse(esR(["pending"]))[0].comments, 3);
  closeConversation(SR, convs().get("t3_r1"));
  check("let go is closed, and closed is neither waiting nor due", [convs().get("t3_r1").state, waitingRows(SR).length, dueConversations(SR).length], ["closed", 0, 0]);
  check("a campaign can be paused, and paused is not active", [esR(["campaign", "pause", "honest-comments"]) && readCampaign(DR, "honest-comments").status, readCampaigns(DR).filter((c) => c.status === "active").length], ["paused", 0]);
}

// The deck: a reply waiting deals before a new person; Rewrite is on the
// reply card and deals a note card; the specialist's status proposal and
// the clock's card.
{
  const person = { id: "t3_q", place: "saas", url: "https://www.reddit.com/r/saas/comments/q/x/", author: "a", title: "t", body: "b", why: "asks", draft: { text: "a draft" }, readyState: "ready", blockedWhy: null };
  const conv = { id: "t3_c", author: "cara", place: "saas", url: "https://www.reddit.com/r/saas/comments/r1/x/theirs/", campaign: "honest-comments", latest: { text: "what tool?\nand does it work", at: "2026-09-06T05:00:00Z", author: "cara" }, said: "most of it is generated", turn: 2, draft: null, composer: null };
  const d1 = nextCards(snap({ hasModel: true, queue: [person], conversations: [conv] }));
  check("somebody who wrote back outranks a new person, and the card offers to write the turn", [d1[0].id, d1[0].kind, d1[0].question, d1[0].primary.id, /You said: most of it is generated/.test(d1[0].help), /turn 2/.test(d1[0].eyebrow), d1[1].id], ["work.turn.t3_c", "work.turn", "what tool?", "draft", true, true, "work.reply.t3_q"]);
  const d2 = nextCards(snap({ hasModel: true, conversations: [{ ...conv, draft: { text: "yes, i built it", flags: null } }] }));
  check("...with a draft for this turn it is the control panel: the field, Insert, I posted it, Rewrite, Let it go", [d2[0].field.value, d2[0].primary.id, d2[0].actions.map((a) => a.id), d2[0].secondary.id, d2[0].data.client, d2[0].data.turn], ["yes, i built it", "insert", ["posted", "rewrite"], "skip", "insert", 2]);
  check("...aimed under THEIR comment, not at the thread's box", d2[0].data.insert.target, "comment");
  const dw = nextCards(snap({ hasModel: true, conversations: [conv], drafting: "t3_c" }))[0];
  check("...and while the reply is being written the turn card waits and says so", [dw.kind, dw.primary.id, /writer is on it/.test(dw.help)], ["work.turn.wait", "wait", true]);
  const reply = nextCards(snap({ hasModel: true, queue: [person] })).find((c) => c.kind === "work.reply");
  check("the reply card gained Rewrite", reply.actions.map((a) => a.id), ["posted", "rewrite"]);
  const d3 = nextCards(snap({ hasModel: true, queue: [person], conversations: [conv], stash: { rewrite: { id: "t3_q", prior: "a draft", who: "u/a" } } }));
  check("a rewrite the operator asked for deals first, with a field for the note and the rejected draft in view", [d3[0].id, d3[0].primary.id, d3[0].secondary.id, /a draft/.test(d3[0].help), d3[0].field.multiline], ["work.rewrite.t3_q", "rewrite", "keep", true, true]);
  const d4 = nextCards(snap({ stash: { campaign_status_draft: { id: "hc", name: "Honest comments", status: "paused", why: "crowding went from 3 to 14 in a week" } } }));
  check("the specialist's status proposal is one card: pause it, or leave it", [d4[0].id, d4[0].primary.label, d4[0].secondary.id, /crowding/.test(d4[0].help)], ["campaign.status", "Pause it", "leave", true]);
  check("...and it is a suggestion: a person waiting and a person worth answering both deal before it", nextCards(snap({ hasModel: true, queue: [person], conversations: [conv], stash: { campaign_status_draft: { id: "hc", name: "Honest comments", status: "paused", why: "saturated" } } })).map((c) => c.id).slice(0, 3), ["work.turn.t3_c", "work.reply.t3_q", "campaign.status"]);
  check("a person who wrote back outranks even a campaign walk; the walk still outranks the queue", nextCards(snap({ hasModel: true, queue: [person], conversations: [conv], stash: { campaign_draft: { name: "The real read", id: "the-real-read", idea: "one true observation", mention: "disclosed", place: "saas", q: "feedback", why: "the gap", done: [] } } })).map((c) => c.id).slice(0, 3), ["work.turn.t3_c", "campaign.idea", "work.reply.t3_q"]);
  // Onboarded: an account, the files, a source, the voice habits answered.
  const ready = { account: { name: "x" }, itemCount: 3, sources: [{ id: "s", place: "saas" }], rooms: [{ place: "saas", state: "allowed" }], stash: { voice_done: voiceQuestions(null).map((q) => q.key), welcomed: true }, memory: { done: 4, total: 4, files: [{ file: "rule.md", filled: true }, { file: "project.md", filled: true }, { file: "icp.md", filled: true }, { file: "me.md", filled: true }] } };
  const d5 = nextCards(snap({ ...ready, due: { sources: 2, conversations: 1, unbound: 1, running: false } }));
  check("the clock's card: what is due, computed, with the profile read named when a posted reply is unbound", [d5[0].id, d5[0].question, /2 watched rooms and 1 conversation to look at/.test(d5[0].help), /1 posted reply not yet found on your profile/.test(d5[0].help), d5[0].primary.id], ["work.due", "3 reads are due.", true, true, "tick"]);
  check("...not while a read runs, not while snoozed, not when nothing is due", [nextCards(snap({ ...ready, due: { sources: 2, conversations: 0, unbound: 0, running: true } }))[0].id, nextCards(snap({ ...ready, due: { sources: 2, conversations: 0, unbound: 0, running: false }, stash: { ...ready.stash, due_later: new Date().toISOString() } }))[0].id, nextCards(snap({ ...ready, due: { sources: 0, conversations: 0, unbound: 0, running: false } }))[0].id], ["work.quiet", "work.quiet", "work.quiet"]);
}

// Through the server: "I posted it" from the panel opens the conversation
// with the words as edited; Rewrite deals the note; the four pages render
// with the return on them.
{
  const boxV = mkdtempSync(join(tmpdir(), "mq-today-"));
  const DV = join(boxV, ".mq");
  execFileSync(process.execPath, [ES, "init"], { env: { ...process.env, MQ_DIR: DV }, stdio: "ignore" });
  writeFileSync(join(DV, "account.json"), JSON.stringify({ name: "today_7", added: "2026-09-06T00:00:00Z" }));
  writeFileSync(join(DV, "rooms", "saas.md"), "promotion_allowed: yes\n");
  appendFileSync(join(DV, "found.jsonl"), JSON.stringify({ id: "t3_v1", place: "saas", url: "https://www.reddit.com/r/saas/comments/v1/x/", author: "vera", title: "where are the users", body: "zero users", probe: "saas:find clients", seen_at: "2026-09-06T01:00:00Z", comments: 2 }) + "\n");
  appendFileSync(join(DV, "verdicts.jsonl"), JSON.stringify({ id: "t3_v1", fit: true, why: "asks", rule: "test", at: "2026-09-06T01:00:01Z" }) + "\n");
  appendFileSync(join(DV, "drafts.jsonl"), JSON.stringify({ id: "t3_v1", url: "https://www.reddit.com/r/saas/comments/v1/x/", text: "the machine's draft", at: "2026-09-06T01:30:00Z", turn: 1, flags: {} }) + "\n");
  const SV = store(DV);
  const srvV = spawn(process.execPath, [SERVE, "--port", "0"], { env: { ...process.env, MQ_DIR: DV }, stdio: ["ignore", "pipe", "pipe"] });
  const baseV = await new Promise((resolve) => {
    let out = "";
    const t = setTimeout(() => resolve(null), 8000);
    srvV.stdout.on("data", (d) => { out += d; const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/); if (m) { clearTimeout(t); resolve(`http://127.0.0.1:${m[1]}`); } });
  });
  if (!baseV) { console.log("FAIL  the today dashboard did not start"); fail++; }
  else {
    const actV = async (body) => { const r = await fetch(baseV + "/api/cards/act", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return r.json(); };
    const GV = async (p) => { const r = await fetch(baseV + p); return { status: r.status, body: await r.text() }; };
    const deckV = async () => (await (await fetch(baseV + "/api/cards")).json()).cards;
    check("the reply card is dealt with Rewrite on it", (await deckV())[0].actions.map((a) => a.id), ["posted", "rewrite"]);
    await actV({ card: "work.reply.t3_v1", action: "rewrite", text: "the machine's draft" });
    check("Rewrite deals the note card, and Keep clears it", [(await deckV())[0].id, (await actV({ card: "work.rewrite.t3_v1", action: "keep" })).ok, (await deckV())[0].id], ["work.rewrite.t3_v1", true, "work.reply.t3_v1"]);
    check("...and a rewrite with no note is refused in words", /say what should change/.test((await (async () => { await actV({ card: "work.reply.t3_v1", action: "rewrite" }); return actV({ card: "work.rewrite.t3_v1", action: "rewrite", text: "" }); })()).error ?? ""), true);
    await actV({ card: "work.reply.t3_v1", action: "posted", text: "my own words, edited on the card" });
    const cv = conversationRows(SV).get("t3_v1");
    check("'I posted it' from the panel opens the conversation with the words as edited, not the machine's draft", [cv?.state, cv?.turns?.[0]?.text, cv?.turns?.[0]?.via], ["sent", "my own words, edited on the card", "panel"]);
    // Somebody wrote back: seed the bound, waiting row the return pass would write.
    SV.append("conversations.jsonl", { ...cv, comment_id: "t1_v1mine", state: "waiting", checked_at: "2026-09-06T06:00:00Z", latest: { author: "vera", text: "which tool?", at: "2026-09-06T05:00:00Z", url: "https://www.reddit.com/r/saas/comments/v1/x/vera/" }, turns: [...cv.turns, { by: "them", author: "vera", text: "which tool?", at: "2026-09-06T05:00:00Z", url: "https://www.reddit.com/r/saas/comments/v1/x/vera/" }] });
    const turn = (await deckV())[0];
    check("the turn card is dealt, with their reply and the operator's own words", [turn.id, turn.question, /You said: my own words, edited on the card/.test(turn.help), turn.data.url], ["work.turn.t3_v1", "which tool?", true, "https://www.reddit.com/r/saas/comments/v1/x/vera/"]);
    const today = await GV("/");
    check("Today shows the next card, who is waiting, what is due and the queue", [today.status, /<h1>Today<\/h1>/.test(today.body), /Waiting for you/.test(today.body), /u\/vera/.test(today.body), /which tool\?/.test(today.body), /read is due|reads are due|Nothing is due/.test(today.body), /Open the panel/.test(today.body)], [200, true, true, true, true, true, true]);
    check("the nav is four questions", [/>Today<\/a>/.test(today.body), />People<\/a>/.test(today.body), />Campaigns<\/a>/.test(today.body), />You<\/a>/.test(today.body), />Prospects<\/a>/.test(today.body), />Tasks<\/a>/.test(today.body)], [true, true, true, true, false, false]);
    const people = await GV("/people?view=waiting");
    check("People has a Waiting for you tab that lists them", [people.status, /u\/vera/.test(people.body), /you said: my own words/.test(people.body)], [200, true, true]);
    const you = await GV("/you");
    check("You is a hub: the account, the voice, what it knows, the models, and the advanced doors", [you.status, /today_7/.test(you.body), /What it knows about you/.test(you.body), /Advanced/.test(you.body), /href="\/tasks"/.test(you.body)], [200, true, true, true, true]);
    check("the older pages still answer, under their question", [(await GV("/standing")).status, (await GV("/tasks")).status, (await GV("/sources")).status, /class="on" href="\/you"/.test((await GV("/settings")).body), /class="on" href="\/people"/.test((await GV("/queue")).body)], [200, 200, 200, true, true]);
    await actV({ card: "work.turn.t3_v1", action: "posted", text: "it is called x" });
    const cv2 = conversationRows(SV).get("t3_v1");
    check("'I posted it' on the turn records the operator's words as their next turn", [cv2.state, cv2.turns.length, cv2.turns[2].text, (await deckV())[0].id !== "work.turn.t3_v1"], ["answered", 3, "it is called x", true]);
  }
  srvV.kill();
}

/* --------------------------------- three drafts, and the panel's tabs (0.8.0) */

// The writer always writes three, one per named style; the card shows them
// as tabs; a note on one writes all three again; free is the default; and
// the panel stands on its own — campaigns, rooms and settings as tabs with
// one state route and one act route behind them.
{
  const { STYLES, draftsBlock, styleOf, styleLabel, YOURS } = await import("../lib/writing.mjs");
  const { DEFAULT_PLAN, FREE_MODELS, KEY_URL } = await import("../lib/models.mjs");
  check("three styles, by name, in a fixed order — and each says what the reply DOES, not how it sounds", [STYLES.map((s) => s.id), STYLES.every((s) => s.what.length > 40 && !/\btone\b/i.test(s.what))], [["straight", "deeper", "ask"], true]);
  const blk = draftsBlock({ ceiling: 600 });
  check("the writer's block names all three, the ceiling, and three every time", [/straight — Straight/.test(blk), /deeper — Deeper/.test(blk), /ask — Ask back/.test(blk), /under 600 characters/.test(blk), /THREE replies/.test(blk), /up to/i.test(blk)], [true, true, true, true, true, false]);
  const blk2 = draftsBlock({ ceiling: 900, note: "shorter", prior: "the old one", style: "deeper" });
  check("...and on a rewrite carries the note, which draft it was about, the rejected text, and that all three come back", [/What the operator said about the last round/.test(blk2), /shorter/.test(blk2), /DEEPER draft/.test(blk2), /--- rejected ---\nthe old one\n--- end ---/.test(blk2), /Write all three again/.test(blk2)], [true, true, true, true, true]);
  check("a style is known whatever its case; an unknown one is nobody's; a pasted draft is the operator's own", [styleOf("STRAIGHT")?.id, styleOf("bold"), styleLabel("yours"), YOURS.id], ["straight", null, "Yours", "yours"]);
  check("free is the default plan, a free key has a named page, and the free menu holds only what OpenRouter still serves", [DEFAULT_PLAN, /openrouter\.ai\/keys/.test(KEY_URL), "z-ai/glm-5.2:free" in FREE_MODELS], ["free", true, false]);

  /* Through the CLI: a round of three saves as one row. */
  const boxT = mkdtempSync(join(tmpdir(), "mq-three-"));
  const DT = join(boxT, ".mq");
  execFileSync(process.execPath, [ES, "init"], { env: { ...process.env, MQ_DIR: DT }, stdio: "ignore" });
  const esT = (args, stdin) => { try { return execFileSync(process.execPath, [ES, ...args], { env: { ...process.env, MQ_DIR: DT }, input: stdin ?? "", encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }); } catch (e) { return `${e.stdout || ""}${e.stderr || ""}`; } };
  writeCampaign(DT, { name: "Launch posts", platform: "reddit", mention: "never", idea: "one true observation about what they built" });
  appendFileSync(join(DT, "found.jsonl"), [
    JSON.stringify({ id: "t3_a", place: "saas", url: "https://www.reddit.com/r/saas/comments/a/x/", author: "ana", title: "launched, zero users", body: "we launched Zerolist and nothing", probe: "saas:launch", campaign: "launch-posts", seen_at: "2026-09-06T01:00:00Z" }),
    JSON.stringify({ id: "t3_b", place: "saas", url: "https://www.reddit.com/r/saas/comments/b/x/", author: "bo", title: "same", body: "same here", probe: "saas:launch", campaign: "launch-posts", seen_at: "2026-09-06T01:00:00Z" }),
  ].join("\n") + "\n");
  const mat = esT(["draft", "t3_a"]);
  check("the material asks for three drafts, one per style, every time — never 'up to'", [/## Three drafts, one per style — every time/.test(mat), /straight — Straight/.test(mat), /up to three/i.test(mat)], [true, true, false]);
  const three = { drafts: [
    { style: "straight", text: "put the landing page in front of ten people before you touch the code again. what did the last one say?" },
    { style: "deeper", text: "zero users after a launch usually means the page answers a question nobody typed. i used it at my last job and it was fine. pick the one sentence they search and rewrite the title to it." },
    { style: "ask", text: "what were you expecting to happen on day one, signups or feedback?" },
  ] };
  const saved = esT(["draft", "t3_a", "--save"], JSON.stringify(three));
  const rowsT = () => readFileSync(join(DT, "drafts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  check("a round of three saves as one row: the tabs, the first doubled as text for older readers, round 1", [rowsT().length, rowsT()[0].drafts.map((d) => d.style), rowsT()[0].text === three.drafts[0].text, rowsT()[0].round, /3 drafts saved/.test(saved)], [1, ["straight", "deeper", "ask"], true, 1, true]);
  check("...the refusals run over each, and flag the one that claims a history — not the others", [rowsT()[0].drafts.map((d) => d.flags.claims), /\[Deeper\]/.test(saved), /CLAIMS ABOUT YOU/.test(saved)], [[0, 1, 0], true, true]);
  check("the material treats an unfilled me.md as empty, and says nothing is yours to name", [/## me.md is empty/.test(mat), /never the thing THEY built/.test(mat), /What you have actually done/.test(mat)], [true, true, false]);
  const noteT = esT(["draft", "t3_a", "--note", "too long", "--style", "deeper"]);
  check("a note names the draft it was about and quotes that tab as rejected", [/too long/.test(noteT), /DEEPER draft/.test(noteT), /--- rejected ---\nzero users after a launch/.test(noteT)], [true, true, true]);
  const other = esT(["draft", "t3_b"]);
  check("under a campaign, every tab of a round already written counts as 'already said'", [/--- earlier 1 ---/.test(other), /--- earlier 3 ---/.test(other), /what were you expecting/.test(other)], [true, true, true]);
  const rep = esT(["draft", "t3_b", "--save"], JSON.stringify({ drafts: [{ style: "straight", text: "what were you expecting to happen on day one, signups or feedback? same question here." }, { style: "deeper", text: "d" }, { style: "ask", text: "a" }] }));
  check("the repeat guard reads every tab of everybody else's rounds", [/REPEATED PHRASING/.test(rep), rowsT().find((r) => r.id === "t3_b").drafts[0].flags.repeat >= 8], [true, true]);
  const flat = esT(["draft", "t3_a", "--save"], "my own words, typed by hand");
  check("plain text saves as the operator's own, and is the next round", [rowsT()[2].drafts.map((d) => d.style), rowsT()[2].round, /^draft saved/.test(flat)], [["yours"], 2, true]);
  esT(["draft", "t3_a", "--save"], JSON.stringify({ drafts: [{ style: "bold", text: "x" }, { style: "ask", text: "  " }, { style: "straight", text: "first" }, { style: "straight", text: "second" }], note: "shorter", style: "deeper" }));
  check("an unknown style is the operator's, a blank is dropped, a duplicate keeps the first, and the note rides on the row", [rowsT()[3].drafts.map((d) => [d.style, d.text]), rowsT()[3].note, rowsT()[3].style, rowsT()[3].round], [[["yours", "x"], ["straight", "first"]], "shorter", "deeper", 3]);
  check("text that merely starts with a brace is text", (() => { esT(["draft", "t3_a", "--save"], "{ not json at all"); const d = rowsT()[4].drafts[0]; return [d.style, d.text]; })(), ["yours", "{ not json at all"]);
  check("a JSON round with nothing in it is refused", /no draft with any text/.test(esT(["draft", "t3_a", "--save"], JSON.stringify({ drafts: [{ style: "ask", text: "" }] }))), true);
  check("the MCP and the runtime's save still take plain text", /draft saved/.test(esT(["draft", "t3_b", "--save"], "plain, from an assistant")), true);
  const tookT = esT(["draft", "t3_a", "--save"], JSON.stringify({ drafts: [{ style: "straight", text: "we launched too. i built zerolist to fix exactly this." }, { style: "deeper", text: "i built nothing here, honestly: the page answers a question nobody typed." }, { style: "ask", text: "what did the first ten people say?" }] }));
  check("a draft that claims what THEY posted about as yours is flagged by name, on that tab only — a plain word they also used is not", [rowsT().filter((d) => d.id === "t3_a").pop().drafts.map((d) => d.flags.theirs ?? 0), /THEIRS, NOT YOURS/.test(tookT), /"zerolist"/.test(tookT)], [[1, 0, 0], true, true]);

  /* The deck: tabs on the card, the note card naming the tab, a walk from a name. */
  const person = { id: "t3_q", place: "saas", url: "https://www.reddit.com/r/saas/comments/q/x/", author: "a", title: "t", body: "b", why: "asks", readyState: "ready", blockedWhy: null, draft: { round: 2, drafts: [{ style: "straight", text: "S", flags: { claims: 0 } }, { style: "deeper", text: "D", flags: { claims: 1, tells: 2 } }, { style: "ask", text: "A", flags: { theirs: 1 } }] } };
  const cardT = nextCards(snap({ hasModel: true, queue: [person] }))[0];
  check("the reply card carries the three as tabs, the first in the field, the flags in words on the tab they belong to", [cardT.tabs.map((t) => [t.id, t.label]), cardT.field.value, cardT.tabs[1].warnings, cardT.tabs[0].warnings, cardT.tabs[2].warnings, cardT.data.round], [[["straight", "Straight"], ["deeper", "Deeper"], ["ask", "Ask back"]], "S", ["1 claim about your history — check against me.md", "2 template phrases"], [], ["says you built what THEY built — theirs, not yours"], 2]);
  const oldT = nextCards(snap({ hasModel: true, queue: [{ ...person, draft: { text: "one old draft", flags: null } }] }))[0];
  check("a draft saved before 0.8.0 is one tab, the operator's own", [oldT.tabs.map((t) => t.label), oldT.field.value], [["Yours"], "one old draft"]);
  const rwT = nextCards(snap({ hasModel: true, queue: [person], stash: { rewrite: { id: "t3_q", prior: "D edited", style: "deeper", who: "u/a" } } }))[0];
  check("the note card says which draft the note is about, and that all three come back", [/Deeper/.test(rwT.eyebrow), /D edited/.test(rwT.help), rwT.primary.label], [true, true, "Rewrite all three"]);
  check("the campaign walk deals on a name alone — the idea is the first card, empty", (() => { const c = nextCards(snap({ stash: { campaign_draft: { name: "Launch posts", id: "launch-posts", by: "you", done: [] } } }))[0]; return [c.id, c.field.value]; })(), ["campaign.idea", ""]);
  const onbT = { account: { name: "x" }, stash: { ...allVoice, welcomed: true }, memory: memDone, sources: [{ id: "s", place: "saas" }], rooms: [{ place: "saas", state: "allowed" }], itemCount: 3 };
  check("a room tried from the panel deals its cards once the project is onboarded", nextCards(snap({ ...onbT, stash: { ...onbT.stash, probe: { place: "founder", q: "x", fired: true } }, probe: { running: false, last: { read: 5 }, fitRate: 0.4 } }))[0].id, "onboard.watch");
  check("Watch pressed and not landed yet is a wait, never the room question again", [nextCards(snap({ ...onbT, sources: [], stash: { ...onbT.stash, probe: { place: "founder", q: "x", fired: true, watching: true } }, probe: { running: false, last: { read: 5 }, fitRate: 0.4 } }))[0].id, nextCards(snap({ ...onbT, stash: { ...onbT.stash, probe: { place: "founder", q: "x", fired: true, watching: true } } }))[0].question], ["onboard.watching", "Watching founder."]);
  check("a focused deck says so when it is quiet", /under “launch-posts”/.test(nextCards(snap({ ...onbT, focus: "launch-posts" }))[0].question), true);

  /* Through the server: the panel's state and its buttons, and the tabs. */
  const boxP = mkdtempSync(join(tmpdir(), "mq-panel-"));
  const DP = join(boxP, ".mq");
  const { OPENROUTER_API_KEY: _k, MQ_PLAN: _p, ...envP } = process.env;
  execFileSync(process.execPath, [ES, "init"], { env: { ...envP, MQ_DIR: DP }, stdio: "ignore" });
  writeFileSync(join(DP, "account.json"), JSON.stringify({ name: "panel_8", added: "2026-09-06T00:00:00Z" }));
  writeFileSync(join(DP, "rooms", "saas.md"), "promotion_allowed: yes\n");
  writeCampaign(DP, { name: "Launch posts", platform: "reddit", mention: "never", idea: "one true observation" });
  appendFileSync(join(DP, "found.jsonl"), JSON.stringify({ id: "t3_p1", place: "saas", url: "https://www.reddit.com/r/saas/comments/p1/x/", author: "pia", title: "launched", body: "zero users", probe: "saas:launch", seen_at: "2026-09-06T01:00:00Z", comments: 2 }) + "\n");
  appendFileSync(join(DP, "verdicts.jsonl"), JSON.stringify({ id: "t3_p1", fit: true, why: "asks", rule: "test", at: "2026-09-06T01:00:01Z" }) + "\n");
  appendFileSync(join(DP, "drafts.jsonl"), JSON.stringify({ id: "t3_p1", url: "https://www.reddit.com/r/saas/comments/p1/x/", at: "2026-09-06T01:30:00Z", turn: 1, round: 1, drafts: [{ style: "straight", text: "S1", flags: {} }, { style: "deeper", text: "D1", flags: {} }, { style: "ask", text: "A1", flags: {} }], text: "S1", flags: {} }) + "\n");
  const SP = store(DP);
  const srvP = spawn(process.execPath, [SERVE, "--port", "0"], { env: { ...envP, MQ_DIR: DP }, stdio: ["ignore", "pipe", "pipe"] });
  const baseP = await new Promise((resolve) => {
    let out = "";
    const t = setTimeout(() => resolve(null), 8000);
    srvP.stdout.on("data", (d) => { out += d; const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/); if (m) { clearTimeout(t); resolve(`http://127.0.0.1:${m[1]}`); } });
  });
  if (!baseP) { console.log("FAIL  the panel server did not start"); fail++; }
  else {
    const GP = async (p) => { const r = await fetch(baseP + p); return { status: r.status, json: await r.json().catch(() => null) }; };
    const PP = async (p, body, type = "application/json") => { const r = await fetch(baseP + p, { method: "POST", headers: { "content-type": type }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null) }; };
    const stP = async () => (await GP("/api/panel")).json;
    const deckP = async () => (await GP("/api/cards")).json.cards;
    const st0 = await stP();
    check("the panel's state: free by default, no key yet and where one comes from, the campaign with its numbers, the seats on free models", [st0.settings.plan, st0.settings.key.set, /openrouter\.ai\/keys/.test(st0.settings.key.url), st0.campaigns.map((c) => c.id), st0.campaigns[0].numbers.found, st0.settings.roles.map((r) => r.key), st0.settings.roles.every((r) => /:free$/.test(r.model)), st0.general.found, st0.account, st0.focus, typeof st0.contacted], ["free", false, true, ["launch-posts"], 0, ["judge", "scout", "writer"], true, 1, "panel_8", null, "number"]);
    check("a panel act that is not JSON is refused; one the panel cannot do is named", [(await PP("/api/panel/act", { do: "tick" }, "text/plain")).status, (await PP("/api/panel/act", { do: "explode" })).json.error], [400, "not a thing the panel can do: explode"]);
    check("the key is checked before it is kept, and can be removed", [(await PP("/api/panel/act", { do: "settings.key", key: "hunter2" })).status, (await PP("/api/panel/act", { do: "settings.key", key: "sk-or-test-key" })).status, (await stP()).settings.key.set, (await PP("/api/panel/act", { do: "settings.key", key: "" })).status, (await stP()).settings.key.set], [400, 200, true, 200, false]);
    check("a seat takes only its plan's menu; the plan switches, refuses a made-up one, and switches back", [(await PP("/api/panel/act", { do: "settings.model", role: "judge", model: "moonshotai/kimi-k3" })).status, (await PP("/api/panel/act", { do: "settings.model", role: "judge", model: "inclusionai/ling-3.0-flash-fin:free" })).status, (await stP()).settings.roles[0].model, (await PP("/api/panel/act", { do: "settings.plan", plan: "paid" })).status, (await stP()).settings.plan, (await PP("/api/panel/act", { do: "settings.plan", plan: "gold" })).status, (await PP("/api/panel/act", { do: "settings.plan", plan: "free" })).status], [400, 200, "inclusionai/ling-3.0-flash-fin:free", 200, "paid", 400, 200]);
    check("the deck focuses on a campaign, on nobody's, on everything — and refuses a campaign that is not there", [(await PP("/api/panel/act", { do: "campaign.focus", id: "launch-posts" })).status, (await deckP()).some((c) => c.id === "work.reply.t3_p1"), (await stP()).focus, (await PP("/api/panel/act", { do: "campaign.focus", id: "none" })).status, (await deckP())[0].id, (await PP("/api/panel/act", { do: "campaign.focus", id: "" })).status, (await stP()).focus, (await PP("/api/panel/act", { do: "campaign.focus", id: "nope" })).status], [200, false, "launch-posts", 200, "work.reply.t3_p1", 200, null, 400]);
    await PP("/api/panel/act", { do: "campaign.focus", id: "launch-posts" });
    check("pausing the focused campaign pauses it and lets the focus go; resume brings it back", [(await PP("/api/panel/act", { do: "campaign.status", id: "launch-posts", status: "paused" })).status, readCampaign(DP, "launch-posts").status, (await stP()).focus, (await PP("/api/panel/act", { do: "campaign.status", id: "launch-posts", status: "active" })).status, (await PP("/api/panel/act", { do: "campaign.status", id: "launch-posts", status: "gone" })).status], [200, "paused", null, 200, 400]);
    check("a campaign is edited from the panel: the voice and the mention, the idea untouched", [(await PP("/api/panel/act", { do: "campaign.save", id: "launch-posts", voice: "dry", mention: "disclosed" })).status, readCampaign(DP, "launch-posts").voice, readCampaign(DP, "launch-posts").mention, readCampaign(DP, "launch-posts").idea, (await PP("/api/panel/act", { do: "campaign.save", id: "nope", voice: "x" })).status], [200, "dry", "disclosed", "one true observation", 400]);
    check("a new campaign from the panel needs a name, refuses a name already taken, and starts the walk on the deck", [(await PP("/api/panel/act", { do: "campaign.new", name: "" })).status, (await PP("/api/panel/act", { do: "campaign.new", name: "Launch posts" })).status, (await PP("/api/panel/act", { do: "campaign.new", name: "Roast me threads" })).status, (await deckP())[0].id, /Roast me threads/.test((await deckP())[0].eyebrow), (await deckP())[0].field.value], [400, 400, 200, "campaign.idea", true, ""]);
    await PP("/api/cards/act", { card: "campaign.idea", action: "drop" });
    check("a room needs a name before it is probed, under a campaign or not; a source has to be watched to be stopped", [(await PP("/api/panel/act", { do: "campaign.probe", id: "launch-posts", place: "" })).status, (await PP("/api/panel/act", { do: "probe", place: "" })).status, (await PP("/api/panel/act", { do: "unwatch", id: "saas:new" })).status, (await PP("/api/panel/act", { do: "account", name: "" })).status], [400, 400, 400, 400]);
    check("a room's rules are recorded from the panel", [(await PP("/api/panel/act", { do: "room.rules", place: "founder", answer: "yes" })).status, SP.roomState("founder").state !== "unanswered", (await PP("/api/panel/act", { do: "room.rules", place: "founder", answer: "maybe" })).status], [200, true, 400]);
    check("a project is made and switched from the panel, and switched back", [(await PP("/api/panel/act", { do: "project.new", name: "Other thing" })).status, (await GP("/api/cards")).json.project.id, (await PP("/api/panel/act", { do: "project.use", id: "default" })).status, (await GP("/api/cards")).json.project.id], [200, "other-thing", 200, "default"]);
    const top = (await deckP())[0];
    check("the reply card from the store carries the tabs", [top.id, top.tabs.map((t) => t.id), top.field.value], ["work.reply.t3_p1", ["straight", "deeper", "ask"], "S1"]);
    await PP("/api/cards/act", { card: "work.reply.t3_p1", action: "rewrite", text: "D1 edited", tab: "deeper" });
    const rwP = (await deckP())[0];
    check("Rewrite from the second tab: the note card knows which draft, with the words as edited", [rwP.id, /Deeper/.test(rwP.eyebrow), /D1 edited/.test(rwP.help)], ["work.rewrite.t3_p1", true, true]);
    await PP("/api/cards/act", { card: "work.rewrite.t3_p1", action: "keep" });
    await PP("/api/cards/act", { card: "work.reply.t3_p1", action: "posted", text: "", tab: "ask" });
    const cp = conversationRows(SP).get("t3_p1");
    check("'I posted it' from the third tab records that tab's words, and which style went up, on the conversation and the mark", [cp.turns[0].text, cp.turns[0].style, SP.marks().get("t3_p1").style], ["A1", "ask", "ask"]);
    check("the panel's files are served, tabs and all", [/es-tabs/.test(await (await fetch(baseP + "/panel/")).text()), /es-tabs-strip/.test(await (await fetch(baseP + "/panel/card.css")).text()), /api\/panel/.test(await (await fetch(baseP + "/panel/sidepanel.js")).text())], [true, true, true]);
    check("...and the suggestions under the card, with the deck saying whether a specialist is there to ask", [/id="suggest"/.test(await (await fetch(baseP + "/panel/")).text()), (await fetch(baseP + "/panel/suggest.js")).status, /es-chip/.test(await (await fetch(baseP + "/panel/card.css")).text()), typeof (await (await fetch(baseP + "/api/cards")).json()).brain], [true, 200, true, "boolean"]);
    // The strip (0.9.1): one place at the top for everything running, and
    // the deck saying what last finished and how — the old jobs line is gone.
    const panelHtml = await (await fetch(baseP + "/panel/")).text();
    const deckNow = await (await fetch(baseP + "/api/cards")).json();
    check("...and the strip at the top: on the page, styled, fed by the deck's running and recent jobs", [/id="status"/.test(panelHtml), /id="jobs"/.test(panelHtml), /es-status-dot/.test(await (await fetch(baseP + "/panel/card.css")).text()), Array.isArray(deckNow.recent), Array.isArray(deckNow.jobs)], [true, false, true, true, true]);
  }
  srvP.kill();
}

/* ------------------------------------------- the suggestions under the card (0.9.0) */

// What people typically ask their specialist is offered, not guessed at: the
// chips come from the panel's state, so a campaign is named, a waiting person
// counted, and the person on the deck asked about. Pure, so it is held here.
{
  const { suggestionsFor } = await import("../extension/suggest.js");
  const shape = (chips) => chips.every((c) => c.label && ((typeof c.ask === "string") !== (typeof c.view === "string")));
  const fresh = suggestionsFor({ state: { setup: { done: 0, total: 4 }, campaigns: [], sources: [], rooms: [], waiting: 0 }, card: { kind: "onboard.url" } });
  check("a fresh directory offers the one question that always applies, and nowhere to go yet", [fresh.map((c) => c.label), shape(fresh)], [["What should I do next?"], true]);
  const st = { setup: { done: 4, total: 4 }, focus: null, waiting: 2, sources: [{ id: "founder:x" }], rooms: [{ place: "founder" }],
    campaigns: [{ id: "launch-posts", name: "Launch posts", status: "paused" }, { id: "help", name: "Help only", status: "active" }] };
  const busy = suggestionsFor({ state: st, card: { kind: "work.reply" } });
  check("a working directory names the active campaign, counts who is waiting, asks about the person on the deck, and points at the rooms and campaigns",
    [busy.map((c) => c.label), shape(busy), busy.length <= 7],
    [["What should I do next?", "Who is waiting on me?", "Why this person?", "How is “Help only” going?", "What campaign should I try next?", "Try a room", "The campaigns"], true, true]);
  check("the focus wins over the first active campaign", suggestionsFor({ state: { ...st, focus: "launch-posts" }, card: null }).find((c) => /going/.test(c.label))?.label, "How is “Launch posts” going?");
  check("no campaign yet, setup done: the first campaign is proposed, and Start a campaign leads to its tab", suggestionsFor({ state: { ...st, campaigns: [], waiting: 0 }, card: null }).map((c) => c.label), ["What should I do next?", "Propose my first campaign", "What is my brand about?", "Which room next?", "Try a room", "Start a campaign"]);
  check("without a specialist installed there is nothing to ask, only places to go", suggestionsFor({ state: st, card: null, brain: false }).map((c) => c.label), ["Try a room", "The campaigns"]);
  check("no state, no chips", suggestionsFor({ state: null }), []);
  check("every question chip is a full sentence for the specialist, not a label", busy.filter((c) => c.ask).every((c) => c.ask.length > 40 && /[?.]$/.test(c.ask)), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
