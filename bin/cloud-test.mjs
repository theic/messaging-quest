#!/usr/bin/env node
// Tests for the cloud (lib/cloud.mjs) — a customer's engine on Supabase, one
// wake-up at a time — against a database kept in this process and models that
// answer from a script. What is checked is what would go wrong quietly: a
// message applied twice, a read asked for twice, a job nobody records, a card
// that never gets its reply, a wake-up that spins.
//
//   node bin/cloud-test.mjs          (CLOUD_LOG=1 prints the cloud's own log)

import "../lib/node.mjs";   // the Node host for lib/fs.mjs — first, before anything in lib/
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cloud, restDb } from "../lib/cloud.mjs";
import { install as installHost, host as hostNow } from "../lib/fs.mjs";
import { BUILTIN_ADAPTERS } from "../skills/index.mjs";
import { readListing, readSite, readText } from "../lib/reads.mjs";
import { loadPlatforms } from "../lib/platform.mjs";
import { rulesVerdict, roomRead } from "../lib/rules.mjs";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "  ok  " : "FAIL  "}${what}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};
const log = (l) => { if (process.env.CLOUD_LOG) console.error("   log:", String(l).slice(0, 600)); };

// The built-in ring, as the entry point hands it over: every file under
// skills/, by path on the memory host.
const skills = [];
const walk = (dir, rel = "") => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) walk(p, `${rel}/${e.name}`); else skills.push([`/skills${rel}/${e.name}`, readFileSync(p, "utf8")]); } };
walk(join(here, "..", "skills"));

/** The database, in memory: the tables and the few calls lib/cloud.mjs makes. */
function fakeDb() {
  const T = { customers: new Map(), files: new Map(), messages: new Map(), events: [], jobs: [], leases: new Set(), pokes: [], statuses: [], releases: [] };
  let jobSeq = 0, evSeq = 0;
  return {
    T,
    take: async (id) => { if (T.leases.has(id)) return false; T.leases.add(id); return true; },
    release: async (id, { nextAt, state }) => { T.leases.delete(id); T.releases.push({ id, nextAt, state }); const c = T.customers.get(id); if (c) Object.assign(c, { next_at: nextAt, state }); },
    status: async (id, patch) => { T.statuses.push({ id, ...patch }); },
    customer: async (id) => T.customers.get(id) ?? null,
    files: async (id) => [...(T.files.get(id) ?? new Map())].map(([path, content]) => ({ path, content })),
    messages: async (id) => [...(T.messages.get(id) ?? new Map()).values()].map((body) => ({ id: body.id, body })),
    saveFiles: async (id, rows) => { const m = T.files.get(id) ?? new Map(); for (const r of rows) m.set(r.path, r.content); T.files.set(id, m); },
    dropFiles: async (id, paths) => { const m = T.files.get(id); for (const p of paths) m?.delete(p); },
    addMessages: async (id, rows) => { const m = T.messages.get(id) ?? new Map(); for (const r of rows) if (!m.has(r.id)) m.set(r.id, r); T.messages.set(id, m); },
    events: async (id) => T.events.filter((e) => e.customer_id === id && !e.done_at).map((e) => ({ ...e })),
    doneEvents: async (ids) => { for (const e of T.events) if (ids.includes(e.id)) e.done_at = "done"; },
    jobs: async (id) => T.jobs.filter((j) => j.customer_id === id && !j.consumed_at).map((j) => ({ ...j })),
    addJob: async (id, kind, args) => { const j = { id: ++jobSeq, customer_id: id, kind, args, state: "queued", result: null, error: null, note: null }; T.jobs.push(j); return { ...j }; },
    consumeJob: async (jid) => { const j = T.jobs.find((x) => x.id === jid); if (j) j.consumed_at = "now"; },
    lane: async () => ({ attached: true }),
    poke: async (id) => { T.pokes.push(id); },
    // the test's own hands
    event: (id, kind, body) => T.events.push({ id: ++evSeq, customer_id: id, kind, body, done_at: null }),
    finish: (jid, result, error = null) => { const j = T.jobs.find((x) => x.id === jid); Object.assign(j, { state: error ? "failed" : "done", result, error, done_at: new Date().toISOString() }); },
    chat: (id) => [...(T.messages.get(id) ?? new Map()).values()].sort((a, b) => a.id - b.id),
    file: (id, p) => T.files.get(id)?.get(p) ?? null,
    open: (id) => T.jobs.filter((j) => j.customer_id === id && !j.consumed_at),
  };
}

/** Models that answer from a script, and remember being asked. */
const asked = [];
const PLACES = ["saas", "startups", "smallbusiness"];
const models = {
  offerFromPages: async (dir, url, pages) => { asked.push(["offer", url, pages.length]); return { name: "Acme", one_line: "A scheduling tool for independent consultants.", problem: "I lose clients to back-and-forth about meeting times", signals: ["ask for a scheduling tool", "complain about double bookings"], searches: ["scheduling tool", "calendly alternative"], project_md: "# Acme\n\nScheduling for consultants.", icp_md: "# Who\n\nConsultants.", rule_md: "# Who to answer\n\nAnswer YES when somebody struggles to schedule clients.", places: PLACES, unknown: [] }; },
  offerFromMaterial: async () => { asked.push(["material"]); return null; },
  judgeItems: async (dir, items) => { asked.push(["judge", items.length]); const out = items.map((x) => ({ n: x.n, fit: true, why: `They said it: "${String(x.title).slice(0, 30)}"` })); out.failed = []; return out; },
  draftReply: async (dir, prompt) => { asked.push(["draft", /Need a scheduling tool/.test(prompt)]); return { drafts: [{ style: "straight", text: "I built Acme for exactly this — it books the slot for you." }, { style: "deeper", text: "Two things helped me." }, { style: "ask_back", text: "How many clients a week?" }], no_fit: null }; },
  interpretInstruction: async () => ({ leave_out: [], places: [], also_asks: true }),
};
const turns = [];
const quest = {
  turn: async (dir, content, opts) => { turns.push({ content, history: opts.history?.length ?? 0, lane: opts.lane?.attached?.() ?? null }); return content === "HEARTBEAT" ? "noted" : "Thanks — I'm reading your site now and will post what I understood right here."; },
  history: () => [],
  heartbeatAsk: "HEARTBEAT",
};

const nodeHost = hostNow();
const db = fakeDb();
const ENV = { OPENROUTER_API_KEY: "sk-or-v1-test-key-1234567890" };
const C = cloud({ db, skills, adapters: BUILTIN_ADAPTERS, env: ENV, quest, models, log });
const ID = "11111111-2222-3333-4444-555555555555";
db.T.customers.set(ID, { id: ID, user_id: "u-1", email: "sam@example.com", created_at: new Date().toISOString() });

/* ---------------------------------------------------------------- sign-up */

db.event(ID, "start", { text: "acme.io", email: "sam@example.com" });
let r = await C.step(ID);
const chat1 = db.chat(ID);
check("sign-up: what they typed is the first message, and Quest answers it", chat1.map((m) => [m.from, m.text?.slice(0, 20)]), [["you", "acme.io"], ["quest", "Thanks — I'm reading"]]);
check("...their record is written, with the site", JSON.parse(db.file(ID, "customer.json") ?? "{}").url, "https://acme.io");
check("...the site is asked of the operator's browser as one whole read", db.open(ID).map((j) => [j.kind, j.args.purpose, j.args.url, j.state]), [["site", "site", "https://acme.io", "queued"]]);
check("...the event is applied once and marked done", db.T.events.map((e) => e.done_at), ["done"]);
check("...Quest was told the browser is connected", turns[0]?.lane, true);
check("...and the customer's row says what is being read for them", db.T.customers.get(ID).state?.working?.map((w) => w.label), ["Reading your site"]);
check("...the transcript is not a file in the files table", db.file(ID, "chat.jsonl"), null);

r = await C.step(ID);
check("a wake-up with nothing new asks for nothing twice and says nothing", [db.open(ID).length, db.chat(ID).length, r.again], [1, 2, false]);

// The same event delivered again (a wake-up that died after writing its
// effects and before marking it done) is not applied twice.
db.T.events.push({ id: 1, customer_id: ID, kind: "start", body: { text: "acme.io" }, done_at: null });
await C.step(ID);
check("an event already applied is skipped when it comes round again", db.chat(ID).length, 2);

/* ------------------------------------------------------------- the offer */

const site = db.open(ID)[0];
db.finish(site.id, { ok: true, pages: [{ url: "https://acme.io/", title: "Acme", text: "Acme books meetings for consultants." }, { url: "https://acme.io/pricing", title: "Pricing", text: "$9 a month." }] });
r = await C.step(ID);
const offerMsg = db.chat(ID).find((m) => m.card?.kind === "offer");
check("the site's pages come back; the offer card is written from them", [asked.find((a) => a[0] === "offer"), Boolean(offerMsg), /r\/saas/.test(offerMsg?.text ?? "")], [["offer", "https://acme.io", 2], true, true]);
check("...and the read is consumed, so nothing is asked again", db.open(ID).length, 0);

/* ----------------------------------------------------------- Looks right */

db.event(ID, "act", { id: offerMsg?.id, action: "confirm" });
r = await C.step(ID);
const confirmed = db.chat(ID).filter((m) => m.from === "quest" && /^Good\./.test(m.text ?? ""));
check("Looks right: the card is confirmed and Quest says where it starts", confirmed.length, 1);
check("...the three files the judge and the writer read are written", [/struggles to schedule/.test(db.file(ID, "rule.md") ?? ""), /Scheduling for consultants/.test(db.file(ID, "project.md") ?? "")], [true, true]);
check("...and the first community's rules page is asked for", db.open(ID).map((j) => [j.kind, j.args.purpose, j.args.place]), [["text", "rules", "saas"]]);

/* ------------------------------------------------- the rules, the look */

const rules = db.open(ID)[0];
db.finish(rules.id, { ok: true, text: "Rules. 1. Be kind. 2. Stay on topic." });
r = await C.step(ID);
check("rules that allow it: the room is answered yes and searched next", [/promotion_allowed: yes/.test(db.file(ID, "rooms/saas.md") ?? ""), db.open(ID).map((j) => [j.kind, j.args.purpose, j.args.place, j.args.q])], [true, [["listing", "probe", "saas", "scheduling tool"]]]);
const probe = db.open(ID)[0];
check("...the search is the platform's own, for the offer's phrase", /reddit\.com\/r\/saas\/search/.test(probe?.args?.url ?? ""), true);

const fresh = new Date(Date.now() - 3600_000).toISOString();
db.finish(probe.id, { ok: true, total: 12, entries: [{ kind: "post", id: "t3_abc123", url: "https://www.reddit.com/r/saas/comments/abc123/need_a_scheduling_tool/", author: "bob", title: "Need a scheduling tool", body: "Clients keep rescheduling and I lose them.", at: fresh, comments: 2 }] });
r = await C.step(ID);
const opp = db.chat(ID).find((m) => m.card?.kind === "opportunity");
check("the posts come back: recorded, judged, and the fit is in the chat as a card", [asked.some((a) => a[0] === "judge"), Boolean(opp), opp?.card?.item], [true, true, "t3_abc123"]);
check("...the writer was given the post", asked.find((a) => a[0] === "draft"), ["draft", true]);
const folded = (() => { const rows = db.chat(ID); const card = { ...(opp?.card ?? {}) }; for (const x of rows) if (x.from === "system" && x.ref === opp?.id) Object.assign(card, x.set); return card; })();
check("...and its three replies are on the card", [folded.drafts?.length, /Acme/.test(folded.draft ?? "")], [3, true]);
check("...the next community's rules are asked for, one read at a time", db.open(ID).map((j) => [j.args.purpose, j.args.place]), [["rules", "startups"]]);

/* ---------------------------------------------------------- the buttons */

db.event(ID, "act", { id: opp?.id, action: "replied" });
await C.step(ID);
const marks = db.file(ID, "marks.jsonl") ?? "";
const contacted = db.file(ID, "contacted.jsonl") ?? "";
check("I replied: the card says so and the author is never found again", [/"replied"/.test(JSON.stringify(db.chat(ID).filter((m) => m.from === "system").map((m) => m.set))), /t3_abc123/.test(marks), /bob/.test(contacted)], [true, true, true]);

/* ------------------------------------------------------------ a failure */

const rules2 = db.open(ID)[0];
db.finish(rules2.id, null, "the page did not load");
await C.step(ID);
check("a read that failed is asked again, and counted against the room", [db.open(ID).map((j) => j.args.place), JSON.parse(db.file(ID, "cards.json") ?? "{}").look?.rooms?.find((x) => x.place === "startups")?.tries], [["startups"], 1]);

/* ------------------------------------------------------- a busy lease */

db.T.leases.add(ID);
check("a customer already being worked on is left alone", await C.step(ID), { busy: true });
db.T.leases.delete(ID);

/* ------------------------------------------------------------- the time */

// Out of time for a model step with one wanted: heard now, answered on the
// next wake-up — which is asked for at once.
db.event(ID, "say", { text: "Why that one?" });
const pokes = db.T.pokes.length;
r = await C.step(ID, { budgetMs: 30_000 });
check("a message with no time left for Quest: heard now, answered on the next wake-up", [db.chat(ID).filter((m) => m.from === "you").pop()?.text, r.again, db.T.pokes.length - pokes, db.T.statuses.some((s) => s.thinking)], ["Why that one?", true, 1, true]);
r = await C.step(ID);
check("...which answers it", [db.chat(ID).filter((m) => m.from === "quest").pop()?.text?.slice(0, 6), r.again], ["Thanks", false]);

// A model that keeps failing waits out its five minutes rather than spinning.
let judgeFailed = 0;
const failing = cloud({ db, skills, adapters: BUILTIN_ADAPTERS, env: ENV, quest, models: { ...models, judgeItems: async () => { judgeFailed++; throw new Error("429 rate limited"); } }, log });
const rules3 = db.open(ID)[0];
db.finish(rules3.id, { ok: true, text: "Be kind." });
await failing.step(ID);
const probe2 = db.open(ID)[0];
db.finish(probe2.id, { ok: true, total: 3, entries: [{ kind: "post", id: "t3_def456", url: "https://www.reddit.com/r/startups/comments/def456/scheduling/", author: "amy", title: "Scheduling clients is a mess", body: "Any tool?", at: fresh, comments: 0 }] });
r = await failing.step(ID);
const again = await failing.step(ID);
check("a failing judge: tried once, then left alone for five minutes, not woken again", [judgeFailed, r.again, again.again, again.did.includes("judge")], [1, false, false, false]);

// A message that lands while a wake-up is at work finds the lease taken; the
// wake-up that holds it notices on its way out and asks for another.
{
  const late = fakeDb();
  late.T.customers.set(ID, { id: ID, user_id: "u-1", email: "sam@example.com", created_at: new Date().toISOString() });
  const L = cloud({ db: late, skills, adapters: BUILTIN_ADAPTERS, env: ENV, quest: { ...quest, turn: async (d, c, o) => { late.event(ID, "say", { text: "and another thing" }); return quest.turn(d, c, o); } }, models, log });
  late.event(ID, "start", { text: "acme.io" });
  const out = await L.step(ID);
  check("something said during a wake-up: it is not left for the clock — another wake-up is asked for", [out.again, late.T.pokes.length], [true, 1]);
}

installHost(nodeHost);
await loadPlatforms(null);

/* ------------------------------------------------------- the whole reads */

// lib/reads.mjs against a scripted browser — what the extension's worker runs.
{
  const pages = {
    "https://acme.io/": { text: "Acme. Scheduling for consultants.", links: [{ href: "/pricing", text: "Pricing" }, { href: "/login", text: "Log in" }, { href: "/terms", text: "Terms" }, { href: "https://other.com/about", text: "About" }, { href: "/how-it-works", text: "How it works" }, { href: "/blog/post-1", text: "A post" }] },
    "https://acme.io/pricing": { text: "$9 a month." },
    "https://acme.io/how-it-works": { text: "You share a link." },
  };
  const opened = [];
  let at = null;
  const b = {
    open: async (u) => { at = u; opened.push(u); return { ok: true, url: u }; },
    goto: async (u) => { at = u; opened.push(u); return { ok: true, url: u }; },
    text: async () => ({ ok: true, text: pages[at]?.text ?? "", url: at, title: "" }),
    extract: async () => ({ ok: true, rows: pages[at]?.links ?? [] }),
  };
  const s = await readSite(b, "https://acme.io/", { pages: 4 });
  check("a site is read the way a person reads it: the page, then pricing and how it works — never login, terms, a post or another site", [s.ok, opened], [true, ["https://acme.io/", "https://acme.io/pricing", "https://acme.io/how-it-works"]]);
  const t = await readText({ open: async () => ({ ok: true }), text: async () => ({ ok: true, text: "No self-promotion. Be kind." }) }, "https://x/rules");
  check("a rules page read whole says what it forbids", rulesVerdict(t.text), { state: "banned", quote: "No self-promotion." });
  check("...and the room file is answered with the sentence", /promotion_allowed: no[\s\S]*No self-promotion/.test(roomRead("promotion_allowed: UNANSWERED\n", rulesVerdict(t.text), "2026-09-19")), true);
  const p = BUILTIN_ADAPTERS.reddit.default ?? BUILTIN_ADAPTERS.reddit;
  const listing = await readListing({}, "https://www.reddit.com/r/saas/search/?q=x", { platform: { ...p, read: async () => ({ ok: true, redirected: true, finalUrl: "https://www.reddit.com/subreddits/search?q=saas", entries: [{ kind: "post", id: "t3_a" }] }), readPost: async () => { throw new Error("opened a post of a room that does not exist"); } } });
  check("a room that redirects is read, and no post of it is opened", [listing.ok, listing.redirected, listing.entries.length, listing.total], [true, true, 0, 1]);
}

/* ------------------------------------------------------ the REST calls */

{
  const calls = [];
  const f = async (url, init = {}) => { calls.push([init.method ?? "GET", url.replace("https://x.supabase.co/rest/v1/", ""), init.headers]); return new Response(JSON.stringify(true), { status: 200, headers: { "content-type": "application/json" } }); };
  const R = restDb({ url: "https://x.supabase.co", key: "sb_secret_test", fetch: f });
  await R.take("c1", 140);
  await R.dropFiles("c1", ['rooms/a"b.md', "x.md"]);
  check("the secret key goes in the apikey header and nowhere else — the new keys are not JWTs", [calls[0][2].apikey, calls[0][2].authorization ?? calls[0][2].Authorization ?? null], ["sb_secret_test", null]);
  check("...the lease is an RPC", [calls[0][0], calls[0][1]], ["POST", "rpc/quest_take"]);
  check("...and a file name with a quote in it cannot break out of the filter", decodeURIComponent(calls[1][1]).includes('"rooms/a\\"b.md"'), true);
}

/* ------------------------------------------------- the extension's worker */

// extension/worker.js against a Supabase that answers from a script: it
// claims, reads whole, hands back — and stops for an account that is not a
// worker rather than asking every fifteen seconds for ever.
{
  const { questWorker } = await import("../extension/worker.js");
  const calls = [];
  let queue = [{ id: 7, kind: "listing", args: { url: "https://www.reddit.com/r/saas/search/?q=x", purpose: "probe", skip: ["t3_old"], skipAuthors: ["Bob"], label: "Looking in r/saas" } }];
  let refuse = false;
  const f = async (url, init = {}) => {
    const fn = url.split("/rpc/")[1];
    const body = JSON.parse(init.body ?? "{}");
    calls.push([fn, body, init.headers?.authorization]);
    const json = (status, obj) => new Response(obj === null ? "" : JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
    if (refuse) return json(403, { code: "42501", message: "not a worker" });
    if (fn === "quest_claim") return json(200, queue.shift() ?? null);
    return json(204, null);
  };
  const seen = [];
  const reads = {
    readListing: async (b, url, o) => { seen.push(["listing", url, [...o.skip], [...o.skipAuthors], o.checkDescription]); return { ok: true, total: 3, entries: [{ kind: "post", id: "t3_new", url: "https://www.reddit.com/r/saas/comments/new/x/", body: "y".repeat(9000) }] }; },
    readSite: async () => { throw new Error("the tab closed"); },
    readText: async () => ({ ok: true, text: "rules" }),
  };
  const W = questWorker({ account: { token: async () => "jwt-1" }, engine: async () => ({ CONTROL: {} }), fetch: f, reads, sleep: async () => {} });
  check("the worker claims a read under its own session", [await W.once(), calls[0][0], calls[0][2]], [true, "quest_claim", "Bearer jwt-1"]);
  check("...reads it whole, with the ids and the people to skip", seen[0], ["listing", "https://www.reddit.com/r/saas/search/?q=x", ["t3_old"], ["bob"], true]);
  const fin = calls.find((c) => c[0] === "quest_finish")?.[1];
  check("...and hands it back, bodies cut to what the store keeps", [fin?.p_job, fin?.p_error, fin?.p_result?.entries?.[0]?.body.length], [7, null, 4000]);
  queue = [{ id: 8, kind: "site", args: { url: "https://acme.io" } }];
  await W.once();
  check("a read that breaks is handed back as a failure, with why", calls.filter((c) => c[0] === "quest_finish").pop()?.[1], { p_job: 8, p_result: null, p_error: "the tab closed" });
  check("nothing to read is nothing done", await W.once(), false);
  refuse = true;
  await W.start();
  check("an account that is not a worker stops asking, and the panel is told why", [W.status().status, W.status().on], ["not a worker", false]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
