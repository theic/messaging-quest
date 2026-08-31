#!/usr/bin/env node
// The dashboard — every verb this product has, reachable from a browser.
//
// It used to be a reader: seven views over .earshot/ plus two writes. The CLI
// did the work and the browser watched. That is a defensible shape for a tool
// and a bad one for a product, because the first thing it asks a new person to
// do is leave it and go and type something.
//
// So the rule now is the one the operator set: EVERYTHING IS AVAILABLE FROM THE
// UI. Onboarding, prospects, the memory files, the models, and every verb that
// reads Reddit. The CLI is still there and still the one implementation — the
// buttons spawn it (see lib/jobs.mjs) rather than reimplementing it.
//
// What has NOT changed, and is not going to:
//   * bound to 127.0.0.1, never 0.0.0.0
//   * no account, no hosted anything, no bill
//   * no verb that posts to Reddit
//   * everything a stranger wrote is escaped at one seam
//
//   node bin/serve.mjs [--port 8787]

import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { store } from "../lib/store.mjs";
import { history, STATES } from "../lib/verdict.mjs";
import { standing, readiness, burst, mix, PER_ROOM_24H, OVERALL_24H, CQS_NOTE } from "../lib/ready.mjs";
import { sidebarUrl, roomFile } from "../lib/rules.mjs";
import { mergeVoice, voiceRules, voiceSummary } from "../lib/voice.mjs";
import { jobStore } from "../lib/jobs.mjs";
import { MEMORY, readMemory, readOne, writeMemory, seedMissing, memoryProgress } from "../lib/memory.mjs";
import { MODELS, ROLES, chosen, choose, readKey, writeKey, hasKey, keySource, judgeEstimate, money } from "../lib/models.mjs";
import { page, esc, empty, runBtn, tag, steps, setupBanner, APP_JS, CSP } from "../lib/ui.mjs";
import { tokens, issueToken, revokeToken } from "../lib/feed.mjs";
import { loadPlatforms } from "../lib/platform.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ES = join(ROOT, "bin", "es.mjs");
const DIR = process.env.EARSHOT_DIR || ".earshot";
// Platform skills — the store resolves rooms through the registry.
await loadPlatforms(DIR);
const argv = process.argv.slice(2);
const PORT = argv.includes("--port") ? Number(argv[argv.indexOf("--port") + 1]) : 8787;
if (!existsSync(DIR)) { console.error(`earshot: no ${DIR}/ here — run \`es init\` first`); process.exit(1); }
const S = store(DIR, (m) => { throw new Error(m); });
const J = jobStore(DIR);

// An .earshot/ made by an older build has no memory files. Grow them on boot
// rather than making the first page load a migration the user has to notice.
seedMissing(DIR);

/* ------------------------------------------------------------------ helpers */

const acct = () => S.account();
const who = () => (acct()?.name ? "u/" + acct().name : "no account yet");

/** Every view goes through here so the setup banner and the account line are
 *  not something a new screen can forget to render. */
const render = (path, title, body, opts = {}) =>
  page({ path, title, body, who: who(), banner: setupBanner(memoryProgress(DIR)), ...opts });

const fmt = (s) => esc(String(s ?? "").slice(0, 16).replace("T", " "));
const ago = (iso) => {
  const d = Date.parse(iso);
  if (!Number.isFinite(d)) return "";
  const h = (Date.now() - d) / 36e5;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m ago`;
  if (h < 48) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

/**
 * Shown once on the next render, then gone.
 *
 * A freshly issued feed token has to reach the screen exactly once, and must
 * not travel in a URL — a secret in a query string ends up in the browser's
 * history, and this codebase's own rule about that is the reason there is a
 * variable here rather than a redirect carrying it. It is not stored anywhere
 * in the clear either: `lib/feed.mjs` keeps only a SHA-256.
 */
let flash = {};
const takeFlash = () => { const f = flash; flash = {}; return f; };

const PER_PAGE = 25;
const pageWindow = (param, total, per = PER_PAGE) => {
  const pages = Math.max(1, Math.ceil(total / per));
  const at = Math.min(Math.max(1, Number(param) || 1), pages);
  return { at, pages, from: (at - 1) * per, to: Math.min(total, at * per) };
};
const pager = (base, at, pages) =>
  pages <= 1 ? "" : `<div class="actions" style="justify-content:space-between">
    ${at > 1 ? `<a class="btn small" href="${base}page=${at - 1}">← previous</a>` : "<span></span>"}
    <span class="muted">page ${at} of ${pages}</span>
    ${at < pages ? `<a class="btn small" href="${base}page=${at + 1}">next →</a>` : "<span></span>"}
  </div>`;

/**
 * Run the CLI and await it, inside a job that is already running.
 *
 * This is how the model-driven verbs reuse the CLI rather than reimplementing
 * it: the writer produces text, and then `es draft <id> --save` runs the two
 * refusals over it, exactly as it would for a human's own words. One
 * implementation of the guards, not two.
 */
const runEs = (verb, args = [], { stdin = null, ctl } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ES, verb, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, EARSHOT_DIR: DIR },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    if (stdin !== null) child.stdin.write(stdin);
    child.stdin.end();
    const take = (c) => { out += c; ctl?.log?.(String(c).replace(/\n$/, "")); };
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${verb} exited ${code}`))));
  });

/** The same, but the output is the answer and is not echoed into the log —
 *  `es draft <id>` prints a whole prompt and the job log is not where it goes. */
const capture = (verb, args = []) => runEs(verb, args, { ctl: null });

/* ------------------------------------------------------------------- views */

const views = {};

/* --- Standing ------------------------------------------------------------ */

views["/"] = () => {
  const items = S.items(), checks = S.checksById();
  if (!items.size)
    return render("/", "Standing", empty(
      "Nothing stored yet — earshot has not read your profile.",
      acct()?.name
        ? runBtn("sync", "Read my profile", { primary: true })
        : `<a class="btn primary" href="/setup">Set up earshot</a>`,
    ));

  const tally = new Map();
  let unchecked = 0;
  for (const it of items.values()) {
    const h = history(checks.get(it.id) ?? []);
    if (h.state === "unchecked") { unchecked++; continue; }
    tally.set(h.state, (tally.get(h.state) ?? 0) + 1);
  }
  const seen = tally.get("visible") ?? 0;
  const hidden = (tally.get("filtered") ?? 0) + (tally.get("removed") ?? 0);
  const denom = seen + hidden;

  const moved = [];
  for (const it of items.values()) {
    const h = history(checks.get(it.id) ?? []);
    if (h.changed_at) moved.push({ it, h });
  }

  return render("/", "Standing", `
<h1>What became of the things you said</h1>
<p class="sub">${items.size} comment${items.size === 1 ? "" : "s"} stored, read back as a logged-out stranger.</p>
<div class="actions" style="margin-top:0">
  ${runBtn("sync", "Read my profile again")}
  ${runBtn("check", "Re-check my threads", { primary: unchecked > 0, title: "About a minute per thread" })}
  ${unchecked ? `<span class="muted">${unchecked} not looked at yet</span>` : ""}
</div>
${denom ? `<div class="card"><div class="big ${hidden ? "sig" : "ok"}">${Math.round((hidden / denom) * 100)}%</div>
<p style="margin-top:10px">of what a stranger could have read, they cannot.</p></div>` : ""}
<div class="card">${[...tally].sort((a, b) => b[1] - a[1]).map(([st, n]) =>
  `<div class="row"><span><b>${n}</b> &nbsp;${tag(st, st === "visible" ? "ok" : st === "filtered" || st === "removed" ? "no" : "dim")}</span>
   <span class="sub right" style="font-size:14px">${esc(STATES[st] ?? "")}</span></div>`).join("")
  || `<p class="sub">Nothing checked yet.</p>`}
${unchecked ? `<div class="row"><span><b>${unchecked}</b> &nbsp;${tag("unchecked")}</span><span class="sub" style="font-size:14px">not looked at yet</span></div>` : ""}
</div>
${moved.length ? `<h2>Changed since the first look</h2><div class="card">${moved.slice(0, 10).map(({ it, h }) =>
  `<div class="row"><span>${esc(h.changed_at.from)} → <b class="sig">${esc(h.changed_at.to)}</b></span>
   <span class="sub" style="font-size:13px">${fmt(h.changed_at.at)}</span></div>
   <div class="said" style="margin:8px 0 4px">${esc((it.body || it.url || "").slice(0, 220))}</div>`).join("")}</div>` : ""}
<p class="sub" style="font-size:14px">A change of state is the one thing a private window cannot show you.
It needs two looks, and both are on disk.</p>`);
};

/* --- Waiting ------------------------------------------------------------- */

views["/waiting"] = () => {
  const rows = S.readJsonl("replies.jsonl");
  const latest = new Map();
  for (const r of rows) latest.set(r.id, r);
  const waiting = [...latest.values()].filter((r) => r.state === "waiting");
  const items = S.items();
  if (!waiting.length)
    return render("/waiting", "Waiting", rows.length
      ? `<h1>Nobody is waiting on you</h1><p class="sub">${rows.length} conversation${rows.length === 1 ? "" : "s"} checked.</p>
         <div class="actions">${runBtn("back", "Check again")}</div>`
      : empty("No conversations checked yet.", runBtn("back", "Find who is waiting", { primary: true })));

  waiting.sort((a, b) => String(a.latest?.at ?? "").localeCompare(String(b.latest?.at ?? "")));
  return render("/waiting", "Waiting", `
<h1>${waiting.length} waiting for you</h1>
<p class="sub">Oldest first, because that is the one going cold. Membership is made of second and third replies.</p>
<div class="actions" style="margin-top:0">${runBtn("back", "Check again")}</div>
${waiting.map((r) => { const it = items.get(r.id); return `<div class="card">
<div class="meta">u/${esc(r.latest?.author ?? "?")} · ${fmt(r.latest?.at)}${r.since_you ? ` · <b class="sig">since you last spoke</b>` : ""} · ${r.replies} repl${r.replies === 1 ? "y" : "ies"}</div>
<div class="said">${esc(r.latest?.text || "(text expired — the 48-hour sweep dropped it)")}</div>
<p class="sub" style="margin:12px 0 0;font-size:14px">You said: ${esc((it?.body ?? "").slice(0, 160) || "—")}</p>
<div class="actions"><a class="btn" href="${esc(r.latest?.url || it?.url || "#")}" target="_blank" rel="noreferrer noopener">Open the thread</a></div>
</div>`; }).join("")}
<p class="sub" style="font-size:14px">You answer these yourself, in your own words. Nothing here writes or sends anything.</p>`);
};

/* --- Queue --------------------------------------------------------------- */

/** Everybody eligible for the deck, newest first. Shared with /people so the
 *  two screens can never disagree about who is in the queue. */
const queueRows = () => {
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
};

views["/queue"] = (url) => {
  const rows = queueRows();
  const pend = S.pending();
  if (!rows.length)
    return render("/queue", "Queue", empty(
      pend.length ? `${pend.length} post${pend.length === 1 ? "" : "s"} found and waiting on a verdict.` : "Nobody is waiting for an answer.",
      `${pend.length ? runBtn("judge", `Judge ${pend.length} now`, { primary: true }) : ""}
       ${runBtn("tick", "Read what is due")}
       <a class="btn" href="/sources">Watch somewhere</a>`,
    ));

  const at = Math.min(Math.max(0, Number(url.searchParams.get("i")) || 0), rows.length - 1);
  const it = rows[at];
  const draft = S.drafts().filter((d) => d.id === it.id).pop();
  const blocked = burst(S.sentLog(), it.place);
  const stand = standing([...S.items().values()], S.checksById());
  const ready = readiness(stand.get(it.place) ?? { place: it.place, comments: 0, visible: 0 }, S.roomState(it.place));

  return render("/queue", "Queue", `
<div data-deck>
<h1>One person</h1>
<p class="sub">${at + 1} of ${rows.length} · r/${esc(it.place)} · ${tag(ready.state, ready.state === "ready" ? "ok" : ready.state === "not ready" ? "no" : "dim")}
  <span class="muted"> · <kbd>j</kbd> next · <kbd>s</kbd> skip · <kbd>o</kbd> open · <kbd>d</kbd> draft</span></p>
${blocked ? `<div class="note"><b>The gate says not yet.</b> ${esc(blocked.why)}.</div>` : ""}
${ready.state === "not ready" ? `<div class="note"><b>${esc(ready.why)}</b></div>` : ""}
<div class="card">
  <div class="meta">u/${esc(it.author ?? "?")} · ${fmt(it.posted_at ?? it.seen_at)} · ${esc(ago(it.posted_at ?? it.seen_at))}</div>
  ${it.title ? `<p><b>${esc(it.title)}</b></p>` : ""}
  <div class="said">${esc(it.body || "")}</div>
  <p class="sub" style="font-size:13px;margin:12px 0 0">judged fit: ${esc(it.why || "—")}</p>
</div>
<div class="card">
  <h2 style="margin-top:0">${draft ? "Your draft" : "No draft yet"}</h2>
  ${draft ? `<div class="said">${esc(draft.text)}</div>
    ${(draft.flags?.repeat ?? 0) >= 8 ? `<div class="note" style="margin-top:14px"><b>Repeated phrasing:</b> ${draft.flags.repeat} identical consecutive words you have used before.</div>` : ""}
    ${(draft.flags?.claims ?? 0) ? `<div class="note" style="margin-top:14px"><b>${draft.flags.claims} claim(s) about your history</b> — each is either true or it is the thing that ends the account.</div>` : ""}
    ${(draft.flags?.links ?? 0) ? `<div class="note" style="margin-top:14px"><b>Invented link.</b> Not present in the thread we read.</div>` : ""}`
    : hasKey(DIR)
      ? `<p class="sub">Nothing written for this one yet.</p>
         <div class="actions">${runBtn("draft", "Write a draft", { args: [it.id], primary: true })}</div>`
      : `<p class="sub">Add an OpenRouter key on <a href="/settings">Settings</a> and this writes itself.
         Without one: <code>es draft ${esc(it.id)}</code> prints the prompt for whatever model you already pay for.</p>`}
</div>
<div class="actions">
  <a class="btn primary" data-open href="${esc(it.url)}" target="_blank" rel="noreferrer noopener">Open it on Reddit</a>
  <form method="POST" action="/mark"><input type="hidden" name="id" value="${esc(it.id)}"><input type="hidden" name="mark" value="sent">
    <button ${blocked ? `disabled title="${esc(blocked.why)}"` : ""}>I posted it</button></form>
  <form method="POST" action="/mark"><input type="hidden" name="id" value="${esc(it.id)}"><input type="hidden" name="mark" value="skip">
    <button data-skip>Not this one</button></form>
  ${at > 0 ? `<a class="btn small" data-prev href="/queue?i=${at - 1}">← back</a>` : ""}
  ${at + 1 < rows.length ? `<a class="btn small" data-next href="/queue?i=${at + 1}">next →</a>` : ""}
</div>
<p class="sub" style="font-size:13px;margin-top:20px">&ldquo;I posted it&rdquo; is the only thing here that writes anything, and what it writes is on your disk.
It retires u/${esc(it.author ?? "?")} from every future queue — undoable on <a href="/people">Prospects</a>.</p>
</div>`);
};

/* --- Prospects ----------------------------------------------------------- */

const PEOPLE_TABS = [
  ["queue", "In the queue"],
  ["sent", "Answered"],
  ["skipped", "Skipped"],
  ["pending", "Awaiting a verdict"],
  ["all", "Everyone found"],
  ["contacted", "Never show again"],
];

views["/people"] = (url) => {
  const view = PEOPLE_TABS.some(([v]) => v === url.searchParams.get("view"))
    ? url.searchParams.get("view") : "queue";
  const q = String(url.searchParams.get("q") ?? "").trim().toLowerCase();
  const all = S.found(), marks = S.marks(), verdicts = S.verdicts(), gone = S.contacted();

  let rows = [];
  if (view === "queue") rows = queueRows().map((r) => ({ ...r, status: "queued" }));
  else if (view === "pending") rows = S.pending().map((p) => ({ ...(all.get(p.id) ?? { id: p.id }), status: "unjudged" }));
  else if (view === "contacted") {
    // The permanent list, and the only screen that can take somebody off it.
    const rowsByAuthor = new Map();
    for (const r of S.readJsonl("contacted.jsonl")) {
      const a = String(r.author ?? "").toLowerCase();
      if (a) rowsByAuthor.set(a, r);
    }
    rows = [...rowsByAuthor.values()].filter((r) => !r.removed).map((r) => ({
      id: r.id, author: r.author, seen_at: r.at, status: "retired",
      ...(all.get(r.id) ?? {}),
      // The stored row wins for the fields the found table also has, but `at`
      // is when they were retired and that is what this screen is about.
      seen: r.at,
    }));
  } else {
    for (const it of all.values()) {
      const m = marks.get(it.id);
      const mark = m && m.mark !== "undo" ? m.mark : null;
      const ver = verdicts.get(it.id);
      if (view === "sent" && mark !== "sent") continue;
      if (view === "skipped" && mark !== "skip") continue;
      if (view === "all") { /* everything */ }
      rows.push({
        ...it,
        status: mark ?? (ver ? (ver.fit ? "queued" : "not a fit") : "unjudged"),
        why: ver?.why,
      });
    }
  }

  if (q) rows = rows.filter((r) =>
    `${r.author ?? ""} ${r.place ?? ""} ${r.title ?? ""} ${r.body ?? ""}`.toLowerCase().includes(q));
  rows.sort((a, b) => String(b.seen ?? b.posted_at ?? b.seen_at ?? "").localeCompare(String(a.seen ?? a.posted_at ?? a.seen_at ?? "")));

  const { at, pages, from, to } = pageWindow(url.searchParams.get("page"), rows.length);
  const shown = rows.slice(from, to);
  const base = `/people?view=${view}${q ? `&q=${encodeURIComponent(q)}` : ""}&`;

  const tone = (s) => (s === "sent" ? "ok" : s === "skip" || s === "not a fit" ? "no" : s === "queued" ? "sig" : "dim");
  const label = (s) => (s === "skip" ? "skipped" : s);

  const body = !rows.length
    ? empty(q ? `Nothing matches “${q}”.` : {
        queue: "Nobody is in the queue.",
        sent: "You have not marked anybody answered yet.",
        skipped: "Nothing skipped.",
        pending: "Nothing is waiting on a verdict.",
        all: "Nothing found yet.",
        contacted: "Nobody is retired. This fills up as you answer people.",
      }[view], view === "all" || view === "queue" ? runBtn("tick", "Read what is due", { primary: true }) : "")
    : `<table><thead><tr><th>Who</th><th>Where</th><th>What they said</th><th>When</th><th></th></tr></thead><tbody>
${shown.map((r) => `<tr>
  <td><b>u/${esc(r.author ?? "?")}</b><br>${tag(label(r.status), tone(r.status))}</td>
  <td>${r.place ? `r/${esc(r.place)}` : "<span class='muted'>—</span>"}</td>
  <td>${r.title ? `<b>${esc(String(r.title).slice(0, 90))}</b><br>` : ""}
      <span class="muted">${esc(String(r.body ?? "").slice(0, 120))}</span>
      ${r.why ? `<br><span class="muted">judged: ${esc(r.why)}</span>` : ""}</td>
  <td class="muted">${esc(ago(r.seen ?? r.posted_at ?? r.seen_at))}</td>
  <td class="right">
    ${r.url ? `<a class="btn small" href="${esc(r.url)}" target="_blank" rel="noreferrer noopener">Open</a>` : ""}
    ${view === "contacted" ? `<form method="POST" action="/people/undo">
        <input type="hidden" name="author" value="${esc(r.author ?? "")}">
        <button class="small" data-confirm="Put u/${esc(r.author ?? "?")} back in the queue?">Undo</button></form>` : ""}
    ${(view === "sent" || view === "skipped") && r.id ? `<form method="POST" action="/mark">
        <input type="hidden" name="id" value="${esc(r.id)}"><input type="hidden" name="mark" value="undo">
        <button class="small">Undo</button></form>` : ""}
  </td></tr>`).join("")}
</tbody></table>${pager(base, at, pages)}`;

  return render("/people", "Prospects", `
<h1>Prospects</h1>
<p class="sub">Everybody this account has found, judged, answered or retired — ${rows.length} here.</p>
<div class="tabs">${PEOPLE_TABS.map(([v, t]) =>
  `<a class="${v === view ? "on" : ""}" href="/people?view=${v}">${t}</a>`).join("")}</div>
<form method="GET" action="/people" class="field" style="display:flex;gap:8px;max-width:520px">
  <input type="hidden" name="view" value="${esc(view)}">
  <input type="search" name="q" value="${esc(q)}" placeholder="search names, rooms, what they said">
  <button class="small">Search</button>
</form>
${body}
${view === "contacted" ? `<p class="sub" style="font-size:13px">This list is permanent and shared across everything —
somebody on it is never offered again, in any room. Undo puts them back.</p>` : ""}`);
};

/* --- Rooms --------------------------------------------------------------- */

views["/rooms"] = () => {
  const places = [...new Set(S.readJsonl("probes.jsonl").map((r) => r.place))];
  if (!places.length)
    return render("/rooms", "Rooms", empty("No rooms probed yet.", `<a class="btn primary" href="/sources">Probe a room</a>`));
  return render("/rooms", "Rooms", `
<h1>Rooms</h1>
<p class="sub">A room stays unwatchable until its rules have been read. That is deliberate — Reddit does not serve
its rules to a logged-out reader, and the public description is not the rules list.</p>
${places.map((p) => { const st = S.roomState(p); return `<div class="card">
<div class="row" style="border:0;padding:0"><b>r/${esc(p)}</b>
${tag(st.state, st.state === "allowed" ? "ok" : st.state === "banned" ? "no" : "dim")}</div>
${st.state === "unanswered" ? `
<p class="sub" style="margin:12px 0 8px;font-size:14px">Nobody has read this room's rules. Open them, then answer here.</p>
<div class="actions">
  <a class="btn" href="${esc(sidebarUrl(p))}" target="_blank" rel="noreferrer noopener">Read the rules</a>
  <form method="POST" action="/room"><input type="hidden" name="place" value="${esc(p)}"><input type="hidden" name="answer" value="yes"><button>They permit it</button></form>
  <form method="POST" action="/room"><input type="hidden" name="place" value="${esc(p)}"><input type="hidden" name="answer" value="no"><button>They forbid it</button></form>
</div>` : `<div class="actions" style="margin-top:10px">
  ${st.state === "allowed" ? runBtn("watch", "Watch this room", { args: [p], small: true }) : ""}
  <form method="POST" action="/room"><input type="hidden" name="place" value="${esc(p)}">
    <input type="hidden" name="answer" value="${st.state === "allowed" ? "no" : "yes"}">
    <button class="small">Change to ${st.state === "allowed" ? "forbidden" : "permitted"}</button></form>
  <span class="muted">recorded in ${esc(S.roomPath(p))}</span>
</div>`}
</div>`; }).join("")}`);
};

/* --- Ready --------------------------------------------------------------- */

views["/ready"] = () => {
  const stand = standing([...S.items().values()], S.checksById());
  const sent = S.sentLog();
  const m = mix([...S.items().values()].filter((i) => i.kind === "comment").length, sent.length);
  if (!stand.size)
    return render("/ready", "Ready", empty("No standing measured yet — it is read off your own comments.",
      `${runBtn("sync", "Read my profile", { primary: true })}${runBtn("check", "Then check the threads")}`));
  return render("/ready", "Ready", `
<h1>Where you stand</h1>
<p class="sub">Read off your own comments and what a stranger can see of them. No invented threshold:
Reddit does not publish what Crowd Control requires.</p>
${[...stand.values()].map((r) => { const d = readiness(r, S.roomState(r.place)); return `<div class="card">
<div class="row" style="border:0;padding:0"><b>r/${esc(r.place)}</b>
${tag(d.state, d.state === "ready" ? "ok" : d.state === "not ready" ? "no" : "dim")}</div>
<p class="sub" style="margin:10px 0 0;font-size:14px">${esc(d.why)}</p></div>`; }).join("")}
<h2>Your mix</h2>
<div class="card">
<p style="font-size:18px;margin:0 0 10px">${m.outreach === 0
  ? `${m.seen} comment${m.seen === 1 ? "" : "s"} seen, none of them logged as outreach.`
  : `${m.ordinary} ordinary to ${m.outreach} outreach${m.ratio === null ? "" : ` — about ${m.ratio.toFixed(1)}:1`}.`}</p>
<p class="sub" style="font-size:14px;margin:0">${esc(m.note)}</p></div>
<div class="card"><p class="sub" style="font-size:14px;margin:0">${esc(CQS_NOTE)}</p></div>
<p class="sub" style="font-size:13px">Budget: ${PER_ROOM_24H} per room per day, ${OVERALL_24H} overall.</p>`);
};

/* --- Sources ------------------------------------------------------------- */

views["/sources"] = () => {
  const srcs = S.sources();
  const reads = new Map(S.readJsonl("reads.jsonl").filter((r) => r.source).map((r) => [r.source, r]));
  const found = [...S.found().values()];
  const probeForm = `
<div class="card">
  <h2 style="margin-top:0">Try a room</h2>
  <p class="sub" style="font-size:14px">One read, no commitment. A scoped search runs 42% fit against 29% for a
  bare feed, so the phrase is worth writing.</p>
  <form method="POST" action="/api/run">
    <input type="hidden" name="verb" value="probe">
    <div class="field"><label for="p-sub">Subreddit</label>
      <input id="p-sub" type="text" name="a0" placeholder="smallbusiness" required></div>
    <input type="hidden" name="a1" value="--q">
    <div class="field"><label for="p-q">The phrase somebody types when they have the problem</label>
      <input id="p-q" type="text" name="a2" placeholder="how do I get clients"></div>
    <button class="primary" type="submit">Probe it</button>
  </form>
</div>`;

  // Somebody else's machine may already be reading the rooms you care about.
  // Taking what it found costs one request; reading them yourself costs a
  // minute each.
  const pulled = existsSync(S.F("pull.json")) ? JSON.parse(readFileSync(S.F("pull.json"), "utf8")) : {};
  const pullForm = `
<div class="card">
  <h2 style="margin-top:0">Take what another machine found</h2>
  <p class="sub" style="font-size:14px">If somebody is running a hub (<code>npm run hub</code>), pull from it instead of
  spending a minute a request on the same rooms. You get public posts; they are judged here, against your own
  <code>rule.md</code>, and whoever you have already answered never reaches your queue — the hub is not told.</p>
  ${Object.entries(pulled).map(([u, s]) => `<div class="row"><span><code>${esc(u)}</code></span>
    <span class="muted">last pulled ${esc(ago(s.at))}</span></div>`).join("")}
  <form method="POST" action="/api/run" style="margin-top:14px">
    <input type="hidden" name="verb" value="pull">
    <div class="field"><label for="hub">Hub URL</label>
      <input id="hub" type="url" name="a0" placeholder="https://your-tunnel.example.com"
        value="${esc(Object.keys(pulled)[0] ?? "")}" required></div>
    <input type="hidden" name="a1" value="--token">
    <div class="field"><label for="tok">Token ${Object.keys(pulled).length ? "— leave blank to reuse the one already saved" : ""}</label>
      <input id="tok" type="password" name="a2" placeholder="es_…" autocomplete="off"></div>
    <button type="submit">Pull</button>
  </form>
</div>`;

  if (!srcs.length)
    return render("/sources", "Sources", `<h1>What is watched</h1>
<p class="sub">Nothing yet. Probe a room, judge what comes back, and if it clears the 10% floor you can commit it.</p>
${probeForm}${pullForm}`);

  return render("/sources", "Sources", `
<h1>What is watched</h1>
<p class="sub">Subreddit submissions and scoped searches only. The undirected comment firehose is refused
by shape: 4,074 reads for 173 leads in the corpus, 23.5 reads each.</p>
<div class="actions" style="margin-top:0">${runBtn("tick", "Read what is due", { primary: true })}</div>
${srcs.map((s) => { const r = reads.get(s.id); return `<div class="card">
<div class="row" style="border:0;padding:0"><b>${esc(s.id)}</b>
<span class="sub" style="font-size:13px">${found.filter((f) => f.probe === s.id).length} found</span></div>
<p class="sub" style="margin:8px 0 0;font-size:13px">${r ? (r.ok ? `last read ${fmt(r.at)} · ${esc(ago(r.at))}` : `<span class="no">error: ${esc(r.err ?? "")}</span>`) : "never read"} · every ${s.cadence_min}m</p>
<div class="actions" style="margin-top:12px">${runBtn("unwatch", "Stop watching", { args: [s.id], small: true, confirm: `Stop watching ${s.id}? What it already found is untouched.` })}</div>
</div>`; }).join("")}
${probeForm}${pullForm}`);
};

/* --- Voice --------------------------------------------------------------- */

views["/voice"] = () => {
  const raw = existsSync(S.F("voice.json")) ? JSON.parse(readFileSync(S.F("voice.json"), "utf8")) : null;
  const fp = mergeVoice(raw?.measured ?? null, raw?.user ?? null);
  const rules = voiceRules(fp), summary = voiceSummary(fp);
  if (!raw)
    return render("/voice", "Voice", empty("Voice not measured yet — it is read off your own comments.",
      runBtn("voice", "Measure my voice", { primary: true })));
  return render("/voice", "Voice", `
<h1>How you write</h1>
<p class="sub">Measured from ${raw.samples ?? 0} of your own comments. Not a persona menu.</p>
<div class="actions" style="margin-top:0">${runBtn("voice", "Measure again")}</div>
<div class="card"><p style="font-size:18px;margin:0">${esc(summary ?? "Nothing about your style is measurable yet, and nothing is being guessed.")}</p></div>
<div class="card">${rules.map((r) => `<div class="row">${esc(r)}</div>`).join("") || `<p class="sub">No rules yet.</p>`}</div>
<p class="sub" style="font-size:14px">Presence is decisive at one sample; absence is never decisive below five.
An unmeasured dimension emits no instruction at all, deliberately — the one exception is em dashes,
and one sample of you using one lifts it.</p>
<p class="sub" style="font-size:13px">Correct any line by editing <code>${esc(S.F("voice.json"))}</code>. What you say beats what was measured.</p>`);
};

/* --- Memory -------------------------------------------------------------- */

views["/memory"] = (url) => {
  const want = url.searchParams.get("file");
  const one = want ? readOne(DIR, want) : null;
  if (want && !one) return render("/memory", "Memory", `<h1>Not one of the four</h1><p><a href="/memory">Back</a></p>`);

  if (one) return render("/memory", one.title, `
<h1>${esc(one.title)}</h1>
<p class="sub">${esc(one.what)}</p>
<form method="POST" action="/memory/save">
  <input type="hidden" name="file" value="${esc(one.file)}">
  <div class="field"><textarea name="body" spellcheck="true">${esc(one.body)}</textarea></div>
  <div class="actions" style="margin-top:0">
    <button class="primary" type="submit">Save ${esc(one.file)}</button>
    <a class="btn" href="/memory">Cancel</a>
    <span class="muted">${esc(S.F(one.file))}</span>
  </div>
</form>
${one.file === "rule.md" ? `<p class="sub" style="font-size:13px;margin-top:18px">Every verdict carries a hash of this file.
Change it and the queue may change — that is the point, and it is why the hash is stored.</p>` : ""}`);

  const files = readMemory(DIR);
  return render("/memory", "Memory", `
<h1>Memory</h1>
<p class="sub">Four markdown files on your disk. They decide who reaches your queue and how a draft sounds.
The model proposes them; you press Save. Nothing here is written without a keystroke behind it.</p>
${files.map((m) => `<div class="card">
<div class="row" style="border:0;padding:0"><b>${esc(m.title)}</b>
${tag(m.filled ? "yours" : "still the seed", m.filled ? "ok" : "dim")}</div>
<p class="sub" style="margin:10px 0 0;font-size:14px">${esc(m.what)}</p>
<div class="actions" style="margin-top:12px">
  <a class="btn small" href="/memory?file=${esc(m.file)}">Edit ${esc(m.file)}</a>
  <span class="muted">${m.bytes} bytes</span></div>
</div>`).join("")}
<p class="sub" style="font-size:13px">These are also the agent's filesystem: the judge reads the same bytes you
edit here, not a copy marshalled through a prompt.</p>`);
};

/* --- Settings ------------------------------------------------------------ */

views["/settings"] = async () => {
  const key = readKey(DIR), src = keySource(DIR), pick = chosen(DIR);
  const flash = takeFlash();
  return render("/settings", "Settings", `
<h1>Settings</h1>

<h2>OpenRouter</h2>
<p class="sub">Optional. Everything that reads Reddit works without one; the scout, the judge and the writer
need a model, and this is your key on your machine for your bill. There is nothing to install —
the key is the only requirement.</p>
<div class="card">
  <form method="POST" action="/settings/key">
    <div class="field">
      <label for="k">API key ${src === "env" ? "— currently coming from <code>OPENROUTER_API_KEY</code> in your environment" : ""}</label>
      <input id="k" type="password" name="key" placeholder="${key ? "•".repeat(24) + " (saved)" : "sk-or-…"}" ${src === "env" ? "disabled" : ""}>
    </div>
    <div class="actions" style="margin-top:0">
      <button class="primary" type="submit" ${src === "env" ? "disabled" : ""}>Save key</button>
      ${key && src === "file" ? `<button type="submit" name="key" value="" data-confirm="Remove the stored key?">Remove</button>` : ""}
      <span class="muted">${key ? "a key is set" : "no key set"}</span>
    </div>
  </form>
</div>

<h2>Models</h2>
<p class="sub">Balanced means the cheap fast model does the volume work and the good writer only writes.
Prices are per million tokens, read off OpenRouter on 2026-08-30.</p>
${Object.values(ROLES).map((r) => `<div class="card">
  <div class="row" style="border:0;padding:0"><b>${esc(r.title)}</b>
    <span class="muted">${esc(MODELS[pick[r.key]]?.label ?? pick[r.key])}</span></div>
  <p class="sub" style="margin:10px 0 12px;font-size:14px">${esc(r.what)}</p>
  <form method="POST" action="/settings/model" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
    <input type="hidden" name="role" value="${esc(r.key)}">
    <select name="model" style="max-width:320px">
      ${Object.values(MODELS).map((m) => `<option value="${esc(m.id)}" ${m.id === pick[r.key] ? "selected" : ""}>
        ${esc(m.label)} — $${m.in}/$${m.out} per M</option>`).join("")}
    </select>
    <button class="small" type="submit">Use this</button>
  </form>
  <p class="muted" style="margin:10px 0 0">${esc(MODELS[pick[r.key]]?.note ?? "")}
    Falls back to ${esc(r.alternates.join(", "))} on an error.</p>
</div>`).join("")}
<p class="sub" style="font-size:14px">Judging a hundred posts on the current pick costs about
<b>${esc(money(judgeEstimate(DIR, 100)))}</b>.</p>

<h2>Sharing this machine's reading</h2>
<p class="sub">Reading a source costs a minute a request. If several people watch the same rooms, this machine
can read them once and the rest can take what it found — <b>public posts only</b>. Everyone still judges
against their own <code>rule.md</code>, on their own machine, with their own key.</p>
<div class="card">
  <p class="sub" style="font-size:14px;margin-top:0">Run the feed on its own port:
    <code>npm run hub</code> — then point a tunnel at <code>127.0.0.1:8788</code>.
    <b>Never tunnel to this dashboard</b>: 8787 has your prospects, your memory and this key form on it.</p>
  ${flash.token ? `<div class="note"><b>New token for &ldquo;${esc(flash.label ?? "client")}&rdquo;. Copy it now — it is not stored in the clear and cannot be shown again.</b>
    <div class="log" style="margin-top:10px">${esc(flash.token)}</div>
    <p class="sub" style="font-size:13px;margin:10px 0 0">On the client:
      <code>node bin/es.mjs pull https://your-tunnel --token &lt;that&gt;</code></p></div>` : ""}
  ${tokens(DIR).length ? `<table><thead><tr><th>Client</th><th>Issued</th><th></th></tr></thead><tbody>
  ${tokens(DIR).map((t) => `<tr><td><b>${esc(t.label)}</b></td><td class="muted">${esc(ago(t.added))}</td>
    <td class="right"><form method="POST" action="/settings/token/revoke">
      <input type="hidden" name="sha" value="${esc(t.sha)}"><input type="hidden" name="back" value="/settings">
      <button class="small" data-confirm="Revoke ${esc(t.label)}? That client stops receiving the feed immediately.">Revoke</button>
    </form></td></tr>`).join("")}</tbody></table>` : `<p class="sub">No clients yet.</p>`}
  <form method="POST" action="/settings/token" style="display:flex;gap:10px;align-items:center;margin-top:16px;flex-wrap:wrap">
    <input type="hidden" name="back" value="/settings">
    <input type="text" name="label" placeholder="who is this for — laptop, Sam, client-3" style="max-width:320px">
    <button class="small" type="submit">Issue a token</button>
  </form>
</div>

<h2>Account</h2>
<p class="sub">Whose comments earshot reads back as a stranger. Only your own account is ever read,
and nothing is ever posted.</p>
<div class="card">
  <form method="POST" action="/api/run">
    <input type="hidden" name="verb" value="me">
    <input type="hidden" name="back" value="/settings">
    <div class="field"><label for="u">Your Reddit username</label>
      <input id="u" type="text" name="a0" value="${esc(acct()?.name ?? "")}" placeholder="your-username"></div>
    <div class="actions" style="margin-top:0"><button class="primary" type="submit">Save</button>
      <span class="muted">${acct()?.name ? `currently u/${esc(acct().name)}` : "not set"}</span></div>
  </form>
</div>

<h2>This machine</h2>
<div class="card">
  <div class="row"><span>Data directory</span><code>${esc(S.F("").replace(/[\\/]$/, ""))}</code></div>
  <div class="row"><span>Bound to</span><code>127.0.0.1:${PORT}</code></div>
  <div class="row"><span>Reddit reads</span><span class="sub">logged out, one a minute, never posting</span></div>
</div>
<div class="actions">${runBtn("sweep", "Drop stored bodies past 48h", { confirm: "Drop stored post bodies older than 48 hours? Ids, dates and history are kept." })}
<a class="btn" href="/jobs">Job history</a></div>`);
};

/* --- Setup --------------------------------------------------------------- */

const SETUP_STEPS = ["Your account", "Your product", "Confirm", "First room"];

views["/setup"] = (url) => {
  const a = acct();
  const prog = memoryProgress(DIR);
  const scoutJob = url.searchParams.get("job");
  const job = scoutJob ? J.get(scoutJob) : null;
  const proposal = scoutJob ? J.result(scoutJob) : null;

  // Step 1 — who you are on Reddit.
  if (!a?.name) return render("/setup", "Set up", `
${steps(SETUP_STEPS, 0)}
<h1>Which account is yours?</h1>
<p>earshot reads your own public profile the way a logged-out stranger reads it, so the first thing it needs
is the name to read. Nothing is posted, nothing is sent, and only your own account is read.</p>
<div class="card"><form method="POST" action="/api/run">
  <input type="hidden" name="verb" value="me">
  <div class="field"><label for="u">Your Reddit username</label>
    <input id="u" type="text" name="a0" placeholder="your-username" required></div>
  <button class="primary" type="submit">That's me</button>
</form></div>
<p class="sub" style="font-size:14px">Do not have one to hand? You can still use the finding half —
<a href="/sources">probe a room</a> — but the visibility half needs an account to read.</p>`);

  // Step 2 — read the site.
  if (!prog.files.find((f) => f.file === "project.md").filled && !proposal) {
    const running = job?.status === "running";
    return render("/setup", "Set up", `
${steps(SETUP_STEPS, 1)}
<h1>What do you sell?</h1>
<p>Paste your own site. The scout reads it and the handful of pages it links to — pricing, product, about —
and proposes the three files every later verdict is judged by. It proposes; you press Save.</p>
${!hasKey(DIR) ? `<div class="note"><b>This step needs a model.</b>
  <a href="/settings">Add an OpenRouter key</a> and come back, or
  <a href="/memory">write the three files yourself</a> — the tool does not care which.</div>` : ""}
<div class="card">
  <form method="POST" action="/setup/scout">
    <div class="field"><label for="site">Your website</label>
      <input id="site" type="url" name="url" placeholder="https://example.com" required ${hasKey(DIR) ? "" : "disabled"}></div>
    <button class="primary" type="submit" ${hasKey(DIR) && !running ? "" : "disabled"}>${running ? "Reading…" : "Read my site"}</button>
  </form>
</div>
${job ? `<div class="card"><h2 style="margin-top:0">${esc(job.status === "running" ? "Reading" : job.status)}</h2>
  <div class="log">${esc((job.lines ?? []).slice(-40).join("\n"))}</div>
  ${job.error ? `<p class="no">${esc(job.error)}</p>` : ""}</div>` : ""}
<p class="sub" style="font-size:14px">Rather type it? <a href="/memory">Write the four files by hand.</a></p>`);
  }

  // Step 3 — confirm what it found.
  if (proposal) return render("/setup", "Set up", `
${steps(SETUP_STEPS, 2)}
<h1>Is this right?</h1>
<p>Read all three before you run anything: everything downstream is judged by them.
${proposal.unknown?.length ? `The scout could not find ${proposal.unknown.length} thing${proposal.unknown.length === 1 ? "" : "s"} on your site — they are listed at the bottom.` : ""}</p>
<form method="POST" action="/setup/save">
  <div class="card"><h2 style="margin-top:0">What you sell — project.md</h2>
    <div class="field"><textarea name="project_md" spellcheck="true">${esc(proposal.project_md ?? "")}</textarea></div></div>
  <div class="card"><h2 style="margin-top:0">Who it is for — icp.md</h2>
    <div class="field"><textarea name="icp_md" spellcheck="true">${esc(proposal.icp_md ?? "")}</textarea></div></div>
  <div class="card"><h2 style="margin-top:0">The fit rule — rule.md</h2>
    <p class="sub" style="font-size:14px">This one decides who reaches your queue. Every verdict is stamped with a hash of it.</p>
    <div class="field"><textarea name="rule_md" spellcheck="true">${esc(proposal.rule_md ?? "")}</textarea></div></div>
  ${proposal.unknown?.length ? `<div class="note"><b>The site did not say:</b><ul>${proposal.unknown.map((u) => `<li>${esc(u)}</li>`).join("")}</ul>
    Fill those in rather than letting the scout guess — a rule built on a guess drops real people for months.</div>` : ""}
  <div class="actions"><button class="primary" type="submit">Save all three</button>
    <a class="btn" href="/setup">Start over</a></div>
</form>`);

  // Step 4 — somewhere to look.
  const srcs = S.sources();
  if (!srcs.length) return render("/setup", "Set up", `
${steps(SETUP_STEPS, 3)}
<h1>Where should it look?</h1>
<p>One room to start. Probe it first — that is one read and no commitment — then read its rules, judge what came
back, and commit it if it clears the floor.</p>
<div class="card">
  <form method="POST" action="/api/run">
    <input type="hidden" name="verb" value="probe">
    <div class="field"><label for="s-sub">Subreddit</label>
      <input id="s-sub" type="text" name="a0" placeholder="smallbusiness" required></div>
    <input type="hidden" name="a1" value="--q">
    <div class="field"><label for="s-q">The phrase somebody types when they have the problem</label>
      <input id="s-q" type="text" name="a2" placeholder="how do I get clients"></div>
    <button class="primary" type="submit">Probe it</button>
  </form>
</div>
<p class="sub" style="font-size:14px">Not sure where? <a href="/memory?file=icp.md">icp.md</a> is where the answer
should be written down, and the scout usually has a guess in it.</p>`);

  return render("/setup", "Set up", `
${steps(SETUP_STEPS, 4)}
<h1>You are set up</h1>
<p>${prog.done} of ${prog.total} memory files answered, ${srcs.length} source${srcs.length === 1 ? "" : "s"} watched.</p>
<div class="actions">
  <a class="btn primary" href="/queue">Go to the queue</a>
  ${runBtn("tick", "Read what is due")}
  ${runBtn("sync", "Read my own profile")}
  <a class="btn" href="/memory">Review the memory</a>
</div>`);
};

/* --- Jobs ---------------------------------------------------------------- */

views["/jobs"] = () => {
  const live = J.list();
  const past = J.history(60);
  return render("/jobs", "Jobs", `
<h1>Jobs</h1>
<p class="sub">Everything that reads Reddit is long and rate-limited — a minute a request, measured. This is where it runs.</p>
${live.length ? `<h2>This session</h2>${live.map((j) => `<div class="card">
<div class="row" style="border:0;padding:0"><b>${esc(j.label)}</b>
${tag(j.status, j.status === "ok" ? "ok" : j.status === "error" ? "no" : "sig")}</div>
<p class="muted" style="margin:8px 0">${esc(j.note ?? "")} · started ${esc(ago(j.startedAt))}</p>
${j.lines?.length ? `<div class="log">${esc(j.lines.slice(-30).join("\n"))}</div>` : ""}
</div>`).join("")}` : `<p class="sub">Nothing has run in this session.</p>`}
${past.length ? `<h2>Earlier</h2><table><thead><tr><th>What</th><th>Status</th><th>When</th></tr></thead><tbody>
${past.map((j) => `<tr><td>${esc(j.label ?? j.verb)}</td>
<td>${tag(j.status, j.status === "ok" ? "ok" : j.status === "error" ? "no" : "dim")}</td>
<td class="muted">${esc(ago(j.startedAt))}</td></tr>`).join("")}</tbody></table>` : ""}`);
};

/* ------------------------------------------------------------------ writes */

/** Verbs the browser may start, and what to call them while they run. Anything
 *  not on this list is not startable from a page — the router does not look the
 *  name up anywhere else. */
const SPAWNABLE = {
  me: "Setting your username",
  sync: "Reading your profile",
  check: "Re-reading your threads",
  back: "Finding who is waiting",
  voice: "Measuring your voice",
  add: "Adding a permalink",
  probe: "Probing a room",
  watch: "Committing a room",
  unwatch: "Stopping a source",
  tick: "Reading what is due",
  pull: "Taking what the hub found",
  sweep: "Dropping old bodies",
};

/** Verbs that need a model, and therefore run in this process. */
const AGENTIC = { judge: "Judging what was found", draft: "Writing a draft" };

const startAgentic = (verb, args) => {
  if (verb === "judge") {
    return J.run("judge", async (ctl) => {
      const pend = S.pending();
      if (!pend.length) { ctl.log("nothing pending to judge"); return; }
      const all = S.found();
      const items = pend.map((x) => {
        const it = all.get(x.id) ?? {};
        return { n: x.n, place: it.place, author: it.author, title: it.title, body: it.body };
      });
      ctl.log(`${items.length} to judge · ${chosen(DIR).judge}`);
      const { judgeItems } = await import("../lib/agents.mjs");
      const rule = readFileSync(S.F("rule.md"), "utf8");
      const verdicts = await judgeItems(DIR, items, rule, ctl);
      if (!verdicts.length) { ctl.log("no verdicts came back — nothing written"); return; }
      // Hand them to the CLI rather than appending here: `es judge` is what
      // stamps the rubric hash, clears pending and settles the probe, and two
      // implementations of that is how a queue starts disagreeing with itself.
      ctl.log(`\nwriting ${verdicts.length} verdicts`);
      await runEs("judge", [], { stdin: JSON.stringify(verdicts), ctl });
    }, { label: AGENTIC.judge });
  }

  if (verb === "draft") {
    const id = String(args[0] ?? "");
    if (!id) return { error: "no item" };
    return J.run("draft", async (ctl) => {
      ctl.log(`assembling the prompt for ${id}`);
      // `es draft <id>` already builds the whole thing — the post, the measured
      // voice, the community's risks, the three-moves instruction. It printed
      // it for a human to paste. This sends it.
      const prompt = await capture("draft", [id]);
      const { draftReply } = await import("../lib/agents.mjs");
      const options = await draftReply(DIR, prompt, ctl);
      if (!options.length) { ctl.log("nothing came back"); return; }
      ctl.log(`\n${options.length} option${options.length === 1 ? "" : "s"}:`);
      for (const o of options) ctl.log(`\n— ${o.move}\n${o.text}`);
      // The first is saved so it lands on the card; the rest are in this log.
      // Saving runs the two refusals, which is the only reason to go through
      // the CLI rather than appending a draft row here.
      ctl.log(`\nsaving the first, and running the refusals over it`);
      await runEs("draft", [id, "--save"], { stdin: options[0].text, ctl });
    }, { label: AGENTIC.draft });
  }
  return { error: `${verb} is not a thing this can run` };
};

const writes = {
  "/mark": (form) => {
    const id = form.get("id"), mark = form.get("mark");
    if (!["sent", "skip", "undo"].includes(mark)) return "/queue";
    const it = S.found().get(id);
    if (!it) return "/queue";
    S.append("marks.jsonl", { id, mark, at: new Date().toISOString(), via: "dashboard" });
    if (mark === "sent" && it.author) S.append("contacted.jsonl", { author: it.author, id, at: new Date().toISOString() });
    // Undoing a send has to lift the retirement too, or the person stays
    // invisible forever and the undo is a lie.
    if (mark === "undo" && it.author)
      S.append("contacted.jsonl", { author: it.author, id, at: new Date().toISOString(), removed: true });
    return mark === "undo" ? "/people?view=sent" : "/queue";
  },

  "/people/undo": (form) => {
    const author = String(form.get("author") ?? "").trim();
    if (author) S.append("contacted.jsonl", { author, at: new Date().toISOString(), removed: true });
    return "/people?view=contacted";
  },

  "/room": (form) => {
    const place = String(form.get("place") ?? "").replace(/[^\w-]/g, "");
    const answer = form.get("answer") === "yes" ? "yes" : "no";
    if (!place) return "/rooms";
    const existing = existsSync(S.roomPath(place)) ? readFileSync(S.roomPath(place), "utf8") : roomFile(place, null);
    S.writeRoom(place, existing.replace(/^promotion_allowed:.*$/mi, `promotion_allowed: ${answer}`));
    return "/rooms";
  },

  "/memory/save": (form) => {
    const file = String(form.get("file") ?? "");
    try { writeMemory(DIR, file, form.get("body") ?? ""); } catch { return "/memory"; }
    return "/memory";
  },

  "/settings/key": (form) => {
    try { writeKey(DIR, form.get("key") ?? ""); } catch { /* shown by the empty state */ }
    return "/settings";
  },

  "/settings/model": (form) => {
    try { choose(DIR, String(form.get("role")), String(form.get("model"))); } catch { /* unknown ids ignored */ }
    return "/settings";
  },

  "/settings/token": (form) => {
    const label = String(form.get("label") ?? "").trim() || "client";
    // Into the flash, never into the redirect: the token must not appear in a
    // URL, and this is the one moment it exists in the clear.
    flash = { token: issueToken(DIR, label), label };
    return "/settings";
  },

  "/settings/token/revoke": (form) => {
    revokeToken(DIR, String(form.get("sha") ?? ""));
    return "/settings";
  },

  "/setup/scout": (form) => {
    const url = String(form.get("url") ?? "").trim();
    if (!/^https?:\/\//i.test(url)) return "/setup";
    const started = J.run("scout", async (ctl) => {
      const { scoutSite } = await import("../lib/agents.mjs");
      return await scoutSite(DIR, url, ctl);
    }, { label: "Reading your site" });
    return started.error ? "/setup" : `/setup?job=${started.id}`;
  },

  "/setup/save": (form) => {
    for (const [field, file] of [["project_md", "project.md"], ["icp_md", "icp.md"], ["rule_md", "rule.md"]]) {
      const body = form.get(field);
      if (body && String(body).trim()) writeMemory(DIR, file, body);
    }
    return "/setup";
  },

  "/api/run": (form) => {
    const verb = String(form.get("verb") ?? "");
    const args = [];
    for (let i = 0; i < 6; i++) {
      const v = form.get(`a${i}`);
      if (v === null) continue;
      const s = String(v).trim();
      if (s) args.push(s.slice(0, 200));
    }
    if (AGENTIC[verb]) { startAgentic(verb, args); return null; }
    if (!SPAWNABLE[verb]) return null;
    J.spawn(verb, args, { label: SPAWNABLE[verb] });
    return null;   // null means "back where you came from"
  },

  "/api/cancel": (form) => { J.cancel(String(form.get("id") ?? "")); return null; },
};

/* ------------------------------------------------------------------ server */

// same-origin, not no-referrer: the action buttons need to know which page they
// were pressed on, and a header the browser refuses to send cannot tell them.
// Reddit still learns nothing — cross-origin requests get no referrer under
// this policy, and every outbound link also carries rel="noreferrer".
const HTML = { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP, "referrer-policy": "same-origin" };

/** Where a POST should send the browser next. An explicit `back` field wins,
 *  then the referrer, then home. Anything not a local absolute path is refused
 *  outright — `//evil.example` is a valid Location and is not a local path. */
const backTo = (form, req) => {
  const want = String(form.get("back") ?? "");
  if (/^\/(?!\/)/.test(want)) return want;
  const ref = req.headers.referer ?? "";
  const origin = `http://127.0.0.1:${PORT}`;
  if (ref.startsWith(origin)) return ref.slice(origin.length) || "/";
  return "/";
};

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === "POST" && writes[url.pathname]) {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on("end", () => {
      const form = new URLSearchParams(body);
      let to = null;
      try { to = writes[url.pathname](form); } catch (e) { console.error(e); }
      // A null destination means "wherever the button was" — an action started
      // from the queue should not dump you on the home page.
      res.writeHead(303, { location: to ?? backTo(form, req) }).end();
    });
    return;
  }

  if (url.pathname === "/app.js")
    return res.writeHead(200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
      "content-security-policy": CSP,
    }).end(APP_JS);

  if (url.pathname === "/api/jobs.json")
    return res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
      .end(JSON.stringify({ jobs: J.list().slice(0, 12) }));

  const view = views[url.pathname];
  if (!view)
    return res.writeHead(404, HTML).end(render("/", "Not found", `<h1>Not found</h1><p><a href="/">Standing</a></p>`));

  Promise.resolve()
    .then(() => view(url))
    .then((html) => res.writeHead(200, HTML).end(html))
    .catch((e) => {
      console.error(e);
      res.writeHead(500, HTML).end(render("/", "Error", `<h1>Something broke</h1><pre class="log">${esc(e.stack ?? e.message)}</pre>`));
    });
});

/**
 * 127.0.0.1, never 0.0.0.0, and never the default of omitting the host —
 * which binds every interface and puts your Reddit history on the coffee-shop
 * wifi. This one argument is the whole "the user is the data controller"
 * position expressed as a bind address.
 */
export function serve(port = PORT) {
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      // The port the OS actually granted, not the one asked for — `--port 0`
      // means "any free one", and the log line is how a caller learns which.
      console.log(`earshot  http://127.0.0.1:${server.address().port}`);
      console.log(`reading ${DIR}/ — localhost only, nothing leaves this machine.`);
      console.log(hasKey(DIR) ? `OpenRouter key found — the scout, judge and writer are available.` : `no OpenRouter key — add one at /settings to turn on the scout, judge and writer.`);
      console.log(`ctrl-c to stop.`);
      resolve(server);
    });
  });
}

if (process.argv[1] && process.argv[1].endsWith("serve.mjs")) await serve();
